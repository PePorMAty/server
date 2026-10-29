// «Что делают из продукта» (POST /gpt/step/end-use): модель и загрузка
// страниц подменены, ответы задаёт тест.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ---------- подмены: модель и загрузчик страниц ----------
let reply = {};
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async () => ({ status: "completed", text: JSON.stringify(reply) }),
  extractOutputText: (r) => r.text,
};
const pages = {};
const fetchPath = require.resolve(path.join(__dirname, "../routes/material-balance/utils/fetch-source"));
const realFetch = require(fetchPath);
require.cache[fetchPath].exports = {
  ...realFetch,
  fetchSource: async (url) => {
    const p = pages[url];
    if (!p) throw new realFetch.SourceError("страницы нет (HTTP 404)");
    return p;
  },
};

const router = require("../routes/step/endUse");
const handle = router.stack.find((l) => l.route?.path === "/gpt/step/end-use").route.stack[0].handle;

function endUse(body) {
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

const page = (title, text) => ({ title, text: `${text} `.repeat(30) });

test("переработка нашлась и страница о том — processed, источник для шага", async () => {
  pages["https://surfactants.org/neutralization"] = page(
    "Neutralization of alkylphenol ether sulfuric acid",
    "The alkylphenol ether sulfuric acid is neutralized with sodium hydroxide to the sodium salt.",
  );
  reply = {
    chemical_conversions: [
      { product: "Натриевая соль алкилфенолэфирсульфата", process: "Нейтрализация гидроксидом натрия", co_reactants: ["Гидроксид натрия"],
        title: "Neutralization of alkylphenol ether sulfuric acid", url: "https://surfactants.org/neutralization", quote: "is neutralized with sodium hydroxide" },
    ],
    uses_as_is: [],
    summary: "Кислоту нейтрализуют до соли.",
  };
  const r = await endUse({ productName: "Алкилфенолэфирсульфат" });
  assert.equal(r.success, true);
  assert.equal(r.verdict, "processed");
  assert.equal(r.sources.length, 1);
  assert.match(r.sources[0].technology_description, /Из «Алкилфенолэфирсульфат» и Гидроксид натрия получают «Натриевая соль/);
  assert.deepEqual(r.sources[0].inputs_outputs_hint, ["Нейтрализация гидроксидом натрия: Алкилфенолэфирсульфат, Гидроксид натрия → Натриевая соль алкилфенолэфирсульфата"]);
});

test("«переработка» со ссылкой на чужую страницу отброшена — остаётся применение как есть", async () => {
  pages["https://patents.google.com/patent/US4560176A/en"] = page("US4560176A - Inverted cone stuffing box", "A stuffing box for a pump shaft.");
  pages["https://detergents.org/formulations"] = page("Alkylphenol ether sulfates in detergent formulations", "Alkylphenol ether sulfates are blended into detergent formulations as anionic surfactants.");
  reply = {
    chemical_conversions: [
      { product: "Сульфонат", process: "…", co_reactants: [], title: "Process for preparing alkylphenol polyglycol ether sulfates",
        url: "https://patents.google.com/patent/US4560176A/en", quote: "…" },
    ],
    uses_as_is: [
      { use: "Моющие средства", how: "компонент рецептуры", title: "Alkylphenol ether sulfates in detergent formulations",
        url: "https://detergents.org/formulations", quote: "blended into detergent formulations" },
    ],
    summary: "Готовое ПАВ.",
  };
  const r = await endUse({ productName: "Алкилфенолэфирсульфат" });
  assert.equal(r.verdict, "end_product");
  assert.equal(r.conversions.length, 0);
  assert.equal(r.uses[0].server_check.status, "ok");
  assert.match(r.dropped[0].reason, /Inverted cone stuffing box/);
});

test("ничего подтверждённого — unknown", async () => {
  reply = { chemical_conversions: [], uses_as_is: [{ use: "Где-то", how: "…", title: "Нет страницы", url: "https://nowhere.org/x", quote: "" }], summary: "" };
  const r = await endUse({ productName: "Вещество Х" });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.dropped.length, 1);
});
