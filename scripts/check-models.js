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
//
// Нужен запущенный сервер (pm2): скрипт ходит в него по HTTP на порт из .env,
// так что проверяется ровно то, что получает интерфейс. Запросы настоящие и
// расходуют токены тарифа: полный прогон — примерно по три запроса на модель.

require("dotenv").config();

const PORT = process.env.PORT || 3001;

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
const BASE = arg("url", `http://127.0.0.1:${PORT}/api/graphs`);

if (!MODELS.length) {
  console.error("Не заданы модели: --models имя1,имя2");
  process.exit(1);
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

const STEP_TEXT = `## Пиролиз пропана

Пропан подвергают термическому пиролизу в трубчатых печах при 800–850 °C в
присутствии водяного пара. Продукты: этилен, пропилен, водородсодержащий газ,
пироконденсат. Этилен и пропилен выделяют ректификацией.`;

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
    judge: (res) =>
      res.success && Array.isArray(res.sources) && res.sources.length
        ? { ok: true, detail: `${res.sources.length} ист.` }
        : res.success
          ? { ok: false, detail: "ни одного источника" }
          : { ok: false, detail: errorText(res) },
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
    console.log(
      `${verdict.ok ? "✓" : "✗"} ${model} · ${def.title}: ${verdict.detail} — ${secs} с` +
        (think ? `, размышления ${think} симв.` : "") +
        (fixes.length ? `\n    поправки: ${fixes.join("; ")}` : ""),
    );
  }
}

(async () => {
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
