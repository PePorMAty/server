#!/usr/bin/env node
//
// Проверка моделей: каждая выбранная модель проходит через настоящие маршруты
// сервера — поиск источников, карточку продукта, построение шага — и видно,
// где она отказывает, сколько идёт и какие поправки транспорту пришлось
// сделать (например, модель не выключает размышления или не знает json_schema).
//
//   node scripts/check-models.js                         # все модели, поиск+карточка+шаг
//   node scripts/check-models.js --models qwen3.6-flash,deepseek-v4-pro
//   node scripts/check-models.js --tasks card            # только карточка
//   node scripts/check-models.js --tasks graph           # граф целиком (долго)
//   node scripts/check-models.js --serial                # по одной модели за раз
//   node scripts/check-models.js --port 3210             # сервер на другом порту
//
// Нужен запущенный сервер (pm2): скрипт ходит в него по HTTP, так что
// проверяется ровно то, что получает интерфейс. Порт — из .env; если там его
// нет или сервер слушает другой (pm2 мог получить PORT при запуске), скрипт
// находит сервер сам среди портов, которые слушает node. Запросы настоящие и
// расходуют токены тарифа: полный прогон — примерно по три запроса на модель.

require("dotenv").config();

const { execFileSync } = require("child_process");

const PORT = Number(process.argv.includes("--port") ? arg("port") : process.env.PORT || 3001);

/** Модели из выпадающего списка интерфейса (src/hooks/useAiConfig.ts). */
const DEFAULT_MODELS = [
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.6-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-0731",
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const provider = arg("provider", "qwen");
const models = arg("models", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = models.length ? models : provider === "qwen" ? DEFAULT_MODELS : [];
const TASKS = arg("tasks", "search,card,build")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERIAL = process.argv.includes("--serial");
const TIMEOUT_MIN = Number(arg("timeout", "12"));
/** Адрес указан явно — искать сервер на других портах не надо. */
const EXPLICIT = process.argv.includes("--url") || process.argv.includes("--port");
let BASE = arg("url", `http://127.0.0.1:${PORT}/api/graphs`);

if (!MODELS.length) {
  console.error("Не заданы модели: --models имя1,имя2");
  process.exit(1);
}

/** Наш ли это сервер и жив ли он: у него есть шаблон промта графа. */
async function isOurServer(base) {
  try {
    const r = await fetch(`${base}/prompt-layout`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return typeof j?.promptLayout === "string";
  } catch {
    return false;
  }
}

/** Порты, которые слушает node на этой машине (Linux), или null. */
function nodePorts() {
  try {
    const out = execFileSync("ss", ["-ltnp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ports = new Set();
    for (const line of out.split("\n")) {
      if (!/users:\(\("node"/.test(line)) continue;
      const addr = line.trim().split(/\s+/)[3] || "";
      const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
      if (port) ports.add(port);
    }
    return [...ports];
  } catch {
    return nodePortsFromProc();
  }
}

/**
 * То же без ss — по /proc: сокеты процессов node и таблица слушающих портов.
 * ss есть не везде (в минимальных образах его нет).
 */
function nodePortsFromProc() {
  const fs = require("fs");
  try {
    const inodes = new Set();
    for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      let comm = "";
      try {
        comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {
        continue;
      }
      if (!comm.startsWith("node")) continue;
      let fds = [];
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
          if (m) inodes.add(m[1]);
        } catch {}
      }
    }
    const ports = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let lines = [];
      try {
        lines = fs.readFileSync(file, "utf8").split("\n").slice(1);
      } catch {
        continue;
      }
      for (const line of lines) {
        // local_address · rem_address · st · … · inode; 0A — LISTEN
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10 || cols[3] !== "0A" || !inodes.has(cols[9])) continue;
        const port = parseInt(cols[1].split(":").pop(), 16);
        if (port) ports.add(port);
      }
    }
    return [...ports];
  } catch {
    return null;
  }
}

/**
 * Найти сервер до начала проверок.
 *
 * Без этого при неверном порте все проверки падали одна за другой с одинаковым
 * «сервер недоступен», и было непонятно — сервер лёг или просто не тот порт.
 */
async function locateServer() {
  if (await isOurServer(BASE)) return true;
  if (EXPLICIT) {
    console.error(`Сервер не отвечает по адресу ${BASE}.`);
    return false;
  }
  const ports = nodePorts();
  for (const p of (ports ?? []).filter((x) => x !== PORT)) {
    const base = `http://127.0.0.1:${p}/api/graphs`;
    if (await isOurServer(base)) {
      console.log(`На порту ${PORT} сервера нет — нашёл его на порту ${p}.\n`);
      BASE = base;
      return true;
    }
  }
  console.error(`Сервер не отвечает на порту ${PORT}.`);
  if (ports && ports.length) {
    console.error(`node слушает порты: ${ports.join(", ")} — но нашего сервера среди них нет.`);
  } else if (ports) {
    console.error("node не слушает ни одного порта: похоже, сервер не запущен или упал.");
  }
  console.error(
    "\nЧто проверить:\n" +
      "  pm2 status                                   — сервер online? не растёт ли ↺ (перезапуски)?\n" +
      "  pm2 logs --lines 40 --nostream               — ошибка при запуске?\n" +
      "  node scripts/check-models.js --port <порт>   — если сервер на другом порту",
  );
  return false;
}

/** POST к серверу. Долгие маршруты шлют пробелы, пока ждут модель, — срезаем. */
async function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MIN * 60 * 1000);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = (await r.text()).trim();
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: `ответ не JSON (HTTP ${r.status}): ${text.slice(0, 200)}` };
    }
  } catch (e) {
    return {
      success: false,
      error:
        e.name === "AbortError"
          ? `нет ответа за ${TIMEOUT_MIN} мин`
          : `сервер недоступен: ${e.cause?.code || e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorText(res) {
  const e = res?.error;
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  return e ? JSON.stringify(e).slice(0, 300) : "отказ без причины";
}

const CARD_NODE = { id: "p1", type: "product", data: { label: "Пропан" } };
const CARD_CHAIN = {
  nodes: [
    CARD_NODE,
    { id: "t1", type: "transformation", data: { label: "Пиролиз" } },
    { id: "p2", type: "product", data: { label: "Этилен" } },
  ],
  edges: [
    { source: "p1", target: "t1" },
    { source: "t1", target: "p2" },
  ],
};

// Шаг строится из Markdown обобщения, поэтому и проверка — на его шаблоне
// (routes/step/utils/prompts.js, направление «вниз»). Свободный текст без
// разделов «Что производят» / «Из чего производят» Qwen Plus и Max честно
// разбирали по правилу «в выход — раскрываемый продукт» и возвращали шаг
// «Пропан → Пропан»: отказ был в тесте, а не в модели.
const STEP_TEXT = `# Раскрываемый продукт
**Продукт:** Пропан

# Новый производственный шаг

## Шаг
- **Что производят:** Этилен, Пропилен
- **Из чего производят:** Пропан
- **Краткая формула шага:** Этилен и пропилен производят из пропана
- **Описание:** Пропан подвергают термическому пиролизу в трубчатых печах при 800–850 °C в присутствии водяного пара. Из пирогаза ректификацией выделяют этилен и пропилен; побочно получают водородсодержащий газ и пироконденсат.

# Альтернативы
**Альтернативы: []**`;

/** Задачи проверки: что отправить и как понять, что ответ годный. */
const TASK_DEFS = {
  search: {
    title: "поиск",
    run: (model) =>
      post("/gpt/step/sources", {
        productName: "Полипропилен",
        direction: "down",
        maxItems: 5,
        provider,
        model,
      }),
    judge: (res) => {
      if (res.success && Array.isArray(res.sources) && res.sources.length) {
        return { ok: true, detail: `${res.sources.length} ист.` };
      }
      if (!res.success) return { ok: false, detail: errorText(res) };
      const raw = res.debug?.raw_items;
      return {
        ok: false,
        detail:
          raw > 0
            ? `ни одного источника: модель вернула ${raw}, но без ссылки или описания`
            : "ни одного источника: модель вернула пустой список",
      };
    },
  },
  card: {
    title: "карточка",
    run: (model) =>
      post("/gpt/fill-card", {
        nodeType: "product",
        productName: "Пропан",
        node: CARD_NODE,
        chain: CARD_CHAIN,
        provider,
        model,
      }),
    judge: (res) => {
      if (!res.success) return { ok: false, detail: errorText(res) };
      const values = Object.values(res.productCard || {});
      const filled = values.filter((v) => String(v).trim()).length;
      return { ok: filled > 0, detail: `${filled}/${values.length} полей` };
    },
  },
  build: {
    title: "шаг",
    run: (model) =>
      post("/gpt/step/build", {
        productName: "Пропан",
        direction: "down",
        techText: STEP_TEXT,
        provider,
        model,
      }),
    judge: (res) =>
      res.success && res.step
        ? {
            ok: true,
            detail: `${res.step.inputProducts?.length ?? 0}→${res.step.outputProducts?.length ?? 0} продуктов`,
          }
        : { ok: false, detail: errorText(res) },
  },
  graph: {
    title: "граф",
    run: async (model) => {
      const layout = await fetch(`${BASE}/prompt-layout`)
        .then((r) => r.json())
        .catch(() => ({}));
      return post("/gpt", {
        userPrompt: "Производство полипропилена из пропана",
        promptLayout: layout?.promptLayout || "",
        provider,
        model,
      });
    },
    judge: (res) => {
      if (!res.success) return { ok: false, detail: errorText(res) };
      const n = Array.isArray(res.nodes) ? res.nodes.length : 0;
      return n
        ? { ok: true, detail: `${n} узлов` }
        : { ok: false, detail: "в ответе нет узлов графа" };
    },
  },
};

const unknown = TASKS.filter((t) => !TASK_DEFS[t]);
if (unknown.length) {
  console.error(`Неизвестные проверки: ${unknown.join(", ")}. Есть: ${Object.keys(TASK_DEFS).join(", ")}`);
  process.exit(1);
}

const results = [];

async function checkModel(model) {
  for (const task of TASKS) {
    const def = TASK_DEFS[task];
    const t0 = Date.now();
    const res = await def.run(model);
    const secs = Math.round((Date.now() - t0) / 1000);
    const verdict = def.judge(res);
    const fixes = res?.ai?.fixes ?? [];
    const think = res?.ai?.reasoningChars ?? 0;
    results.push({ model, task, secs, ...verdict, fixes, think });
    // При отказе показываем, что модель ответила на самом деле: без этого
    // «ни одного источника» не отличить от ответа по памяти или пустого текста.
    const preview = !verdict.ok && res?.debug?.output_text_preview;
    console.log(
      `${verdict.ok ? "✓" : "✗"} ${model} · ${def.title}: ${verdict.detail} — ${secs} с` +
        (think ? `, размышления ${think} симв.` : "") +
        (fixes.length ? `\n    поправки: ${fixes.join("; ")}` : "") +
        (preview
          ? `\n    ответ модели: ${String(preview).replace(/\s+/g, " ").slice(0, 400)}`
          : ""),
    );
  }
}

(async () => {
  if (!(await locateServer())) {
    process.exitCode = 2;
    return;
  }

  console.log(
    `Сервер: ${BASE}\nПровайдер: ${provider}; модели: ${MODELS.join(", ")}\n` +
      `Проверки: ${TASKS.map((t) => TASK_DEFS[t].title).join(", ")}` +
      `${SERIAL ? "; по одной модели" : "; модели параллельно"}\n`,
  );

  if (SERIAL) {
    for (const m of MODELS) await checkModel(m);
  } else {
    await Promise.all(MODELS.map(checkModel));
  }

  // Сводка: модель × проверка.
  const width = Math.max(...MODELS.map((m) => m.length), 6) + 2;
  const col = 26;
  console.log(
    `\n${"Модель".padEnd(width)}${TASKS.map((t) => TASK_DEFS[t].title.padEnd(col)).join("")}`,
  );
  for (const m of MODELS) {
    const cells = TASKS.map((t) => {
      const r = results.find((x) => x.model === m && x.task === t);
      const cell = r.ok ? `✓ ${r.detail}, ${r.secs} с` : `✗ ${r.secs} с`;
      return cell.slice(0, col - 2).padEnd(col);
    });
    console.log(`${m.padEnd(width)}${cells.join("")}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nОтказы:");
    for (const r of failed) {
      console.log(`  ${r.model} · ${TASK_DEFS[r.task].title}: ${r.detail}`);
    }
  }
  console.log(
    "\nПодробности каждого запроса — в логе сервера: pm2 logs --lines 200 --nostream",
  );
  process.exitCode = failed.length ? 1 : 0;
})();
