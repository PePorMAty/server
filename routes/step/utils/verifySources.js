// routes/step/utils/verifySources.js
//
// Источники шага, найденные моделью в интернете, — проверка сервером.
//
// Модель называет источники сама и порой выдумывает: в живом прогоне
// 2026-10-29 шаг «неонол → алкилфенолэфирсульфат» опирался на «Patent
// US4560176A — Process for preparing alkylphenol polyglycol ether sulfates»,
// а по этому адресу — «Inverted cone stuffing box» (сальник); ещё одна
// страница отдавала 404. А когда найти нечего, модель возвращает «источник»
// с адресом https://N/A и текстом «источников нет» — и обобщение строило по
// нему шаг «X → X». Поэтому:
//   • заглушки «источников нет» — не источники;
//   • страницы нет (404, нет такого сайта) — источник выбрасывается;
//   • страница есть, но не о том (в ней нет ключевых слов названия
//     источника) — выбрасывается;
//   • сайт не пускает сервер (403, капча, таймаут) — источник остаётся с
//     пометкой «не проверен»: закрытые журналы бывают и настоящими.

const { fetchSource } = require("../../material-balance/utils/fetch-source");

/** Сколько страниц грузим одновременно и сколько всего ждём. */
const CONCURRENCY = 4;
const TOTAL_TIMEOUT_MS = 60 * 1000;

/** Заглушка вместо источника: «нет источников», адрес-пустышка. */
function isPlaceholder(item) {
  const url = String(item?.url || "").trim();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (!host.includes(".") || /(^|\.)(n\/?a|none|null|example\.(com|org))$/i.test(host)) return true;
  const hint = String(item?.access_hint || "");
  const title = String(item?.title || "").trim();
  return (
    /no_?valid|not_?found|no_?source|нет\s+источник/i.test(hint) ||
    /^(отсутстви|нет\s|не\s+найден|источник(и|ов)?\s+не\s+найден|no\s+(valid\s+)?sources?)/i.test(title)
  );
}

/** Общие слова названий источников: по ним «о том ли страница» не понять. */
const STOP = new Set(
  (
    "process processes production producing preparation preparing method methods industrial industry " +
    "applications application properties property review overview introduction chemistry chemical " +
    "technology technologies using based their which about other patent handbook chapter journal " +
    "производство получение способ процесс технология применение свойства обзор метод"
  ).split(" "),
);

/** Ключевые слова названия: от 5 букв, без общих, основой (без окончаний). */
function keyTerms(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w) && !/^[a-z]{1,3}\d/.test(w));
  return [...new Set(words.map((w) => w.slice(0, Math.max(5, w.length - 2))))];
}

/**
 * О том ли страница: доля ключевых слов названия, нашедшихся в заголовке и
 * тексте. Меньше двух ключевых слов — судить не по чему, считаем «о том».
 */
function relevant(item, page) {
  const terms = keyTerms(item?.title);
  if (terms.length < 2) return true;
  const hay = `${page.title || ""}\n${page.text || ""}`.toLowerCase().replace(/ё/g, "е");
  const found = terms.filter((t) => hay.includes(t)).length;
  return found / terms.length >= 0.34;
}

/** Причина отказа загрузчика → нет страницы (выбросить) или не проверить. */
const GONE = /страницы нет|неверный адрес|адрес не http|адрес сайта не найден|сайт недоступен \((ENOTFOUND|EAI_AGAIN)/;

async function checkOne(item, { signal, fetchPage }) {
  try {
    const page = await fetchPage(item.url, { signal });
    return relevant(item, page)
      ? { status: "ok" }
      : { status: "unrelated", reason: `по адресу — другая страница${page.title ? `: «${String(page.title).slice(0, 120)}»` : ""}` };
  } catch (e) {
    const reason = String(e?.message || e);
    return GONE.test(reason) ? { status: "missing", reason } : { status: "unchecked", reason };
  }
}

/**
 * Проверить источники. Возвращает { kept, dropped }: kept — с полем
 * server_check { status: "ok" | "unchecked", reason? }; dropped — заглушки,
 * несуществующие и чужие страницы, с причиной. Источники из базы документов
 * (origin: local) не трогаем: их загрузил человек.
 */
async function verifyStepSources(items, { signal, fetchPage = fetchSource } = {}) {
  const list = Array.isArray(items) ? items : [];
  const dropped = [];
  const todo = [];
  for (const it of list) {
    if (it?.origin === "local") continue;
    if (isPlaceholder(it)) {
      dropped.push({ title: it?.title || "", url: it?.url || "", reason: "заглушка «источников нет», а не источник" });
    } else {
      todo.push(it);
    }
  }
  const results = new Map();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TOTAL_TIMEOUT_MS);
  const stop = () => deadline.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        results.set(it, await checkOne(it, { signal: deadline.signal, fetchPage }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  const kept = [];
  for (const it of list) {
    if (it?.origin === "local") {
      kept.push(it);
      continue;
    }
    const r = results.get(it);
    if (!r) continue; // заглушка
    if (r.status === "missing" || r.status === "unrelated") {
      dropped.push({ title: it.title || "", url: it.url || "", reason: r.reason });
    } else {
      kept.push({ ...it, server_check: r.status === "ok" ? { status: "ok" } : { status: "unchecked", reason: r.reason } });
    }
  }
  return { kept, dropped };
}

module.exports = { verifyStepSources, isPlaceholder, keyTerms, relevant };
