// routes/local-sources/utils/decode.js
//
// Разбор разделов моделью — в фоне.
//
// Раздел документа — десятки тысяч знаков: текст, таблицы (из PDF они
// приходят перемешанными), выбросы и отходы. В обобщение шага от источника
// уходит 2500 знаков — начало раздела было бы случайным обрывком. Поэтому
// каждый раздел один раз разбирает модель:
//   • сжатое описание: способы получения, сырьё, стадии, условия, продукты;
//   • целевые, попутные и промежуточные продукты и сырьё — по ним раздел
//     связывается с продуктами графа «вверх» и «вниз».
// Разбор идёт очередью в фоне: загрузка не ждёт модель, а перезапуск сервера
// не теряет очередь — недоразобранные разделы подхватываются снова.

const store = require("./store");
const {
  callOpenAIResponsesRaw,
  extractOutputText,
  safeJsonParse,
} = require("../../sources/utils");

/** Столько текста раздела отдаём модели (≈ 30–35 тыс. токенов). */
const MAX_INPUT_CHARS = 90000;
/** Сколько разделов разбирается одновременно. */
const CONCURRENCY = Math.max(1, Number(process.env.SOURCES_DECODE_CONCURRENCY) || 2);
/** Длина описания раздела — столько обобщение шага берёт от источника. */
const SUMMARY_CHARS = 2500;
/** Больше стольких названий в одном списке — это уже не продукты раздела. */
const MAX_NAMES = 30;

const SYSTEM = `Ты — инженер-технолог химической промышленности. Тебе дают раздел технического документа (например, информационно-технического справочника по наилучшим доступным технологиям). Текст извлечён из PDF: таблицы и схемы в нём могут быть перемешаны.

Задача — понять, какие производственные процессы описаны в разделе, и вернуть JSON по схеме:
- describes_production — описывает ли раздел получение веществ (процессы, сырьё, продукты). Общие сведения об отрасли, экология, экономика, перечни мер — это false.
- summary — связное описание до ${SUMMARY_CHARS} знаков по-русски: какими способами получают продукты, из какого сырья, основные стадии и аппараты, условия (температура, давление, катализатор), выходы, целевые и попутные продукты. Только то, что есть в тексте. Если describes_production = false — одно-два предложения, о чём раздел.
- products — целевые продукты: вещества, способы получения которых описаны в разделе.
- byproducts — попутные и побочные продукты этих процессов.
- intermediates — промежуточные потоки, которые получают и тут же перерабатывают внутри процесса.
- raw_materials — сырьё и основные реагенты. Вспомогательное (вода, пар, воздух, азот, катализаторы, энергоносители) — только если это действительно сырьё.
- processes — процессы раздела: название, входы, выходы.

Правила для названий веществ:
- в именительном падеже, как их называют в промышленности: «Этилен», «Оксид этилена», «Пропан-пропиленовая фракция», «Сжиженные углеводородные газы»;
- без формул, концентраций и марок в названии;
- только вещества, которые реально есть в тексте. Ничего не добавляй от себя.
Верни СТРОГО JSON по схеме, без текста вокруг.`;

const nameList = { type: "array", items: { type: "string" } };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "describes_production",
    "summary",
    "products",
    "byproducts",
    "intermediates",
    "raw_materials",
    "processes",
  ],
  properties: {
    describes_production: { type: "boolean" },
    summary: { type: "string" },
    products: nameList,
    byproducts: nameList,
    intermediates: nameList,
    raw_materials: nameList,
    processes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "inputs", "outputs"],
        properties: { name: { type: "string" }, inputs: nameList, outputs: nameList },
      },
    },
  },
};

/** Какой провайдер у сервера: DashScope, если ключ есть, иначе из настроек. */
function defaultProvider() {
  if (process.env.QWEN_API_KEY) return "qwen";
  return process.env.AI_PROVIDER || "openai";
}

function names(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = String(x ?? "")
      .replace(/\s+/g, " ")
      .replace(/^[«"'\s]+|[»"'.\s]+$/g, "")
      .trim();
    const key = s.toLowerCase();
    if (!s || s.length > 120 || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, MAX_NAMES);
}

/** Ответ модели → то, что пишем в базу. */
function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== "object" || typeof parsed.summary !== "string") {
    return null;
  }
  const production = parsed.describes_production !== false;
  const processes = (Array.isArray(parsed.processes) ? parsed.processes : [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      name: String(p.name || "").trim(),
      inputs: names(p.inputs),
      outputs: names(p.outputs),
    }))
    .filter((p) => p.name || p.inputs.length || p.outputs.length)
    .slice(0, 15);
  let summary = parsed.summary.trim();
  if (summary.length > SUMMARY_CHARS + 500) summary = `${summary.slice(0, SUMMARY_CHARS)}…`;
  return {
    summary,
    // Раздел не о производстве — продуктов у него нет, чтобы общие сведения
    // и перечни мер не всплывали источниками.
    products: production ? names(parsed.products) : [],
    byproducts: production ? names(parsed.byproducts) : [],
    intermediates: production ? names(parsed.intermediates) : [],
    raw: production ? names(parsed.raw_materials) : [],
    io: processes
      .map((p) =>
        [p.name, p.inputs.length || p.outputs.length ? `${p.inputs.join(", ")} → ${p.outputs.join(", ")}` : ""]
          .filter(Boolean)
          .join(": "),
      )
      .filter(Boolean)
      .slice(0, 10),
    extracted: { describes_production: production, processes },
  };
}

/** Разобрать один раздел. Бросает Error с понятной причиной. */
async function decodeSection({ section, document }) {
  const provider = document.provider || defaultProvider();
  const model = document.model || undefined;
  let text = section.text;
  let cut = "";
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS);
    cut = "\n\n(Текст раздела сокращён — дальше идут в основном таблицы.)";
  }
  const where = [section.path, section.full_title || section.title].filter(Boolean).join(" › ");
  const input = `Документ: ${document.title}
Раздел: ${where}

Текст раздела:
<<<
${text}${cut}
>>>`;

  const resp = await callOpenAIResponsesRaw({
    payload: {
      model: "gpt-5-mini",
      instructions: SYSTEM,
      input,
      truncation: "auto",
      max_output_tokens: 6000,
      text: {
        format: { type: "json_schema", name: "section_decode", strict: true, schema: SCHEMA },
      },
    },
    timeoutMs: 10 * 60 * 1000,
    provider,
    model,
  });
  const out = extractOutputText(resp);
  const result = normalizeResult(safeJsonParse(out));
  if (!result) {
    const who = resp?.ai?.model || model || "по умолчанию";
    throw new Error(
      out
        ? `Модель «${who}» ответила не по схеме${resp?.status === "incomplete" ? " (ответ оборвался)" : ""}.`
        : `Модель «${who}» вернула пустой ответ.`,
    );
  }
  return { result, model: resp?.ai?.model || model || null };
}

let active = 0;
let timer = null;
const listeners = new Set();

/** Подписка на события разбора (скрипт показывает по ним прогресс). */
function onProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function worker() {
  for (;;) {
    let job;
    try {
      job = store.claimSection();
    } catch (e) {
      console.error(`[local-sources] очередь разбора: ${e.message}`);
      return;
    }
    if (!job) return;
    const label = `${job.document.short_title || job.document.title} · ${job.section.full_title || job.section.title}`;
    const t0 = Date.now();
    try {
      const { result, model } = await decodeSection(job);
      store.finishSection(job.section.id, result, model);
      const msg = `разобран за ${Math.round((Date.now() - t0) / 1000)} с: ${result.products.length} продукт., ${result.raw.length} сырья`;
      console.log(`[local-sources] ${label} — ${msg}`);
      for (const fn of listeners) fn({ ok: true, section: job.section, document: job.document, result });
    } catch (e) {
      store.failSection(job.section.id, e.message);
      console.error(`[local-sources] ${label} — не разобран: ${e.message}`);
      for (const fn of listeners) fn({ ok: false, section: job.section, document: job.document, error: e.message });
    }
  }
}

/** Запустить разбор, если есть что разбирать. Возвращает промис до конца очереди. */
function kick() {
  const runs = [];
  while (active < CONCURRENCY) {
    active++;
    runs.push(
      worker().finally(() => {
        active--;
      }),
    );
  }
  return Promise.all(runs);
}

let started = false;
/**
 * Разбор на сервере: разделы, брошенные прошлым процессом, — в очередь;
 * документы из старой базы (без разделов) — разобрать из файлов; раз в
 * минуту — проверить очередь (её пополняет и скрипт загрузки).
 */
function start() {
  if (started) return;
  started = true;
  (async () => {
    try {
      const reset = store.resetStale();
      if (reset) console.log(`[local-sources] в очередь разбора возвращено разделов: ${reset}`);
      const reparsed = await store.reparseLegacyDocuments();
      if (reparsed) console.log(`[local-sources] документов разобрано на разделы заново: ${reparsed}`);
    } catch (e) {
      console.error(`[local-sources] запуск разбора: ${e.message}`);
    }
    kick();
    timer = setInterval(() => {
      try {
        store.resetStale();
      } catch {}
      kick();
    }, 60 * 1000);
    timer.unref?.();
  })();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = { start, stop, kick, onProgress, decodeSection, normalizeResult, SCHEMA };
