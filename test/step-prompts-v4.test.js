// Промпты построения: прежние (по умолчанию с 2026-11-18) и v4
// (routes/step/prompts-v4/, STEP_PROMPTS=v4): что получает модель в поиске
// источников и в обобщении, что отдаёт обобщение.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
let captured = null;
let reply = "";
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    if (!captured) captured = payload;
    return { status: "completed", text: reply };
  },
  extractOutputText: (r) => r.text,
};

const prompts = require("../routes/step/utils/prompts");
const router = require("../routes/step/aggregate.js");
const handle = router.stack.find((l) => l.route?.path === "/gpt/step/aggregate" && l.route.methods.post).route.stack[0].handle;

function aggregate(body) {
  captured = null;
  return new Promise((resolve) => {
    let out = "";
    const res = {
      statusCode: 200,
      writableEnded: false,
      status(c) { this.statusCode = c; return this; },
      setHeader() {},
      flushHeaders() {},
      on() {},
      write(s) { out += s; },
      end(s) { out += s || ""; this.writableEnded = true; resolve(JSON.parse(out.trim())); },
      json(o) { resolve(o); },
    };
    handle({ body, on() {} }, res);
  });
}

const withVersion = async (v, fn) => {
  const prev = process.env.STEP_PROMPTS;
  if (v === undefined) delete process.env.STEP_PROMPTS;
  else process.env.STEP_PROMPTS = v;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.STEP_PROMPTS;
    else process.env.STEP_PROMPTS = prev;
  }
};

test("STEP_PROMPTS=v4: обобщение вниз и вверх, плейсхолдеры USER заполнены, правила SYSTEM — как есть", () =>
  withVersion("v4", () => {
    for (const direction of ["down", "up"]) {
      const p = prompts.buildStepAggregatePrompts({ productName: "Фенол", existingChain: [], blocks: ["Блок о феноле"], ancestorProducts: ["Кумол"], direction });
      assert.equal(p.version, "v4");
      assert.match(p.SYSTEM, /единый контракт шага/);
      assert.match(p.SYSTEM, /Если <<<EXPAND_PRODUCT>>> реально подставлен сервером/);
      assert.doesNotMatch(p.USER_PROMPT, /<<<[A-Z_]+>>>/);
      assert.match(p.USER_PROMPT, /# Текущий раскрываемый продукт\n\nФенол\n/);
      assert.match(p.USER_PROMPT, /# Поисковый продукт Sources[^\n]*\n\nне передан\n/);
      assert.match(p.USER_PROMPT, /- Кумол/);
      assert.match(p.USER_PROMPT, /Источник 1\n\nБлок о феноле$/);
    }
    assert.match(prompts.stepAggregateDefaults("up").system, /Смысл направления UP/);
  }));

test("v4: поиск источников — параметры строками перед правилами, {N} — число; короткая задача — с search_product и строками стадий", () =>
  withVersion("v4", () => {
    const up = prompts.buildStepSourcesPromptUp("Фенол", 4);
    assert.match(up, /^Параметры сервера:\nEXPAND_PRODUCT: Фенол\nПРОДУКТ: Фенол\nN: 4\n/);
    assert.match(up, /Найди 4 лучших источников с описанием промышленного процесса получения CURRENT_PRODUCT/);
    assert.match(up, /если `\{EXPAND_PRODUCT\}` реально подставлен сервером/);
    assert.match(prompts.buildStepSourcesPromptDown("Фенол", 3), /используется как сырьё, feedstock/);
    const brief = prompts.stepSearchBrief("Фенол", "down", 5);
    assert.match(brief, /первой строкой «search_product: Фенол»/);
    // Адрес и продукт поиска сервер дописывает в строки сам (utils/searchHints.js).
    assert.match(brief, /Маршрут R1 \| Стадия S1 \| industrial_status=/);
    assert.match(brief, /Адрес страницы и продукт поиска в строках не пиши/);
  }));

test("по умолчанию и при STEP_PROMPTS=legacy — прежние промпты целиком", () =>
  withVersion(undefined, () => {
    const p = prompts.buildStepAggregatePrompts({ productName: "Фенол", existingChain: [], blocks: ["Блок"], direction: "down" });
    assert.equal(p.version, "legacy");
    assert.doesNotMatch(p.SYSTEM, /единый контракт шага/);
    assert.doesNotMatch(p.USER_PROMPT, /<<<[A-Z_]+>>>/);
    assert.match(p.USER_PROMPT, /\*\*Побочные продукты:\*\*/);
    assert.doesNotMatch(prompts.stepSearchBrief("Фенол", "down", 5), /search_product/);
    assert.doesNotMatch(prompts.buildStepSourcesPromptUp("Фенол", 4), /^Параметры сервера/);
  }));

test("обобщение отдаёт версию промптов и «Достаточность данных» из примечаний v4", async () => {
  reply = [
    "# Раскрываемый продукт",
    "**Продукт:** Фенол",
    "# Новый производственный шаг",
    "## Шаг",
    "- **Что производят:** [Бисфенол А]",
    "- **Из чего производят:** [Фенол, Ацетон]",
    "- **Краткая формула шага:** Бисфенол А производят из фенола и ацетона",
    "- **Описание:** Конденсация фенола с ацетоном.",
    "# Альтернативы",
    "**Альтернативы: []**",
    "# Примечания",
    "- **Достаточность данных:** partial — не использовать как полный шаг до проверки",
  ].join("\n");
  const r = await withVersion("v4", () =>
    aggregate({ productName: "Фенол", direction: "down", sources: [{ title: "Бисфенол", url: "https://example.com/bpa", technology_description: "Бисфенол А получают из фенола и ацетона." }] }),
  );
  assert.equal(r.success, true);
  assert.equal(r.promptsVersion, "v4");
  assert.equal(r.sufficiency, "partial");
  assert.match(captured.instructions, /единый контракт шага/);

  const legacy = await withVersion("legacy", () =>
    aggregate({ productName: "Фенол", direction: "down", sources: [{ title: "Бисфенол", url: "https://example.com/bpa", technology_description: "Бисфенол А получают из фенола и ацетона." }] }),
  );
  assert.equal(legacy.promptsVersion, "legacy");
  assert.doesNotMatch(captured.instructions, /единый контракт шага/);
});

test("GET /gpt/step/sources/prompt — промпт поиска действующей версии для окна клиента", async () => {
  const sources = require("../routes/step/sources.js");
  const get = sources.stack.find((l) => l.route?.path === "/gpt/step/sources/prompt" && l.route.methods.get).route.stack[0].handle;
  const call = (query) => new Promise((resolve) => get({ query }, { json: resolve }));
  const v4 = await withVersion("v4", () => call({ direction: "up", productName: "Фенол", maxItems: "4" }));
  assert.equal(v4.version, "v4");
  assert.equal(v4.direction, "up");
  assert.match(v4.prompt, /^Параметры сервера:\nEXPAND_PRODUCT: Фенол\nПРОДУКТ: Фенол\nN: 4\n/);
  const legacy = await withVersion("legacy", () => call({ direction: "down", productName: "Фенол", maxItems: "99" }));
  assert.equal(legacy.version, "legacy");
  assert.doesNotMatch(legacy.prompt, /Параметры сервера/);
  assert.match(legacy.prompt, /Фенол/);
});
