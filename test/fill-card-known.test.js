// Техописание преобразования (POST /gpt/fill-card): поле «Материальный
// баланс» — по данным ИТС из базы, а не по памяти модели. Модель подменена
// и запоминает запрос; базы — во временной папке.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fill-card-known-"));
process.env.LOCAL_SOURCES_DIR = path.join(tmp, "sources");
process.env.MATERIAL_BALANCE_DB = path.join(tmp, "balance.sqlite");

let captured = null;
const openaiPath = require.resolve(path.join(__dirname, "../routes/fill-card/utils/openai"));
const realOpenai = require(openaiPath);
require.cache[openaiPath].exports = {
  ...realOpenai,
  callOpenAIFillCard: async (args) => {
    captured = args;
    return { status: "completed", text: JSON.stringify({ material_balance: "…" }) };
  },
  extractOutputText: (r) => r.text,
};

const { addDoc, addSection } = require("./helpers/sources");
const router = require("../routes/fill-card/fill-card");
const handle = router.stack.find((l) => l.route?.path === "/gpt/fill-card").route.stack[0].handle;

function fillCard(body) {
  captured = null;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve(o); },
    };
    handle({ body }, res);
  });
}

/** Раздел ИТС: фенол — сырьё, алкилфенол — продукт, в тексте — нормы расхода. */
async function addAlkylphenolSection() {
  const doc = await addDoc({ shortTitle: "ИТС 31—2021", title: "ИТС 31" });
  const text =
    "Раздел 9. Производство алкилфенолов. Алкилирование фенола тримерами пропилена на ионообменной смоле. " +
    "Таблица 9.4 — Расход сырья: фенол 439 кг/т продукции, тримеры пропилена 626 кг/т продукции. ".repeat(3);
  await addSection(
    doc,
    "Раздел 9 Производство алкилфенолов",
    { product: ["Алкилфенол"], raw: ["Фенол", "Тримеры пропилена"] },
    { text, summary: "Алкилфенолы получают алкилированием фенола тримерами пропилена.", pages: [75, 79] },
  );
}

const graph = (inputs, output) => {
  const tr = { id: "tr", type: "transformation", data: { label: "Алкилирование фенола тримерами пропилена" } };
  const nodes = [tr, { id: "out", type: "product", data: { label: output } }, ...inputs.map((n, i) => ({ id: `in${i}`, type: "product", data: { label: n } }))];
  const edges = [{ source: "tr", target: "out" }, ...inputs.map((_, i) => ({ source: `in${i}`, target: "tr" }))];
  return { node: tr, chain: { nodes, edges } };
};

test("баланс в техописании — по ИТС: фрагмент с нормами и указание назвать источник", async () => {
  await addAlkylphenolSection();
  const { node, chain } = graph(["Фенол", "Тримеры пропилена"], "Алкилфенол");
  const r = await fillCard({ nodeType: "transformation", productName: "Фенол", node, chain, selectedFields: ["material_balance"] });
  assert.equal(r.success, true);
  assert.equal(r.knownData, true);
  assert.match(captured.userPrompt, /KNOWN_DATA/);
  assert.match(captured.userPrompt, /фенол 439 кг\/т продукции/);
  assert.match(captured.systemPrompt, /заполни по KNOWN_DATA/);
});

test("данных в базе нет — поле начинается с «Оценка модели» и проверяется стехиометрия", async () => {
  const { node, chain } = graph(["Неонол", "Триоксид серы"], "Алкилфенолэфирсульфат");
  const r = await fillCard({ nodeType: "transformation", productName: "Неонол", node, chain, selectedFields: ["material_balance"] });
  assert.equal(r.knownData, false);
  assert.doesNotMatch(captured.userPrompt, /KNOWN_DATA/);
  assert.match(captured.systemPrompt, /«Оценка модели:»/);
});

test("карточка продукта и поля без баланса — как раньше", async () => {
  const { node, chain } = graph(["Фенол", "Тримеры пропилена"], "Алкилфенол");
  const r = await fillCard({ nodeType: "transformation", productName: "Фенол", node, chain, selectedFields: ["equipment"] });
  assert.equal(r.knownData, undefined);
  assert.doesNotMatch(captured.systemPrompt, /KNOWN_DATA|Оценка модели/);
});
