// Разбор раздела моделью (routes/local-sources/utils/decode.js): названия
// по-русски. Модель не вызывается — транспорт подменён, ответы задаёт тест.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.LOCAL_SOURCES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "decode-test-"));

const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
let replies = [];
let calls = [];
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    calls.push(payload);
    return { status: "completed", text: JSON.stringify(replies.shift() ?? {}) };
  },
  extractOutputText: (r) => r.text,
};

const { decodeSection } = require("../routes/local-sources/utils/decode");

const decoded = (raw, processes) => ({
  describes_production: true,
  summary: "Поликарбонат получают фосгенированием дифенилолпропана.",
  products: ["Поликарбонат"],
  byproducts: [],
  intermediates: [],
  raw_materials: raw,
  auxiliaries: [],
  wastes: [],
  processes,
});
const job = (text) => ({ section: { title: "10.1 Поликарбонаты", text }, document: { title: "ИТС 32" } });

test("названия транслитом — раздел разбирается ещё раз, по-русски", async () => {
  calls = [];
  replies = [
    decoded(["Difenylopropan", "Fosgen"], [{ name: "Синтез", inputs: ["Difenylopropan", "Fosgen"], outputs: ["Policarbonat"] }]),
    decoded(["Дифенилолпропан", "Фосген"], [{ name: "Синтез", inputs: ["Дифенилолпропан", "Фосген"], outputs: ["Поликарбонат"] }]),
  ];
  const { result } = await decodeSection(job("Поликарбонат получают фосгенированием дифенилолпропана в метиленхлориде."));
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /латиницей \(транслитерацией\): Difenylopropan, Fosgen/);
  assert.deepEqual(result.raw, ["Дифенилолпропан", "Фосген"]);
  assert.deepEqual(result.io, ["Синтез: Дифенилолпропан, Фосген → Поликарбонат"]);
});

test("латиница из самого текста (название процесса) — не транслит, повтора нет", async () => {
  calls = [];
  replies = [decoded(["Пропилен"], [{ name: "Процесс Spheripol", inputs: ["Пропилен"], outputs: ["Полипропилен"] }])];
  const { result } = await decodeSection(job("Полипропилен получают по технологии Spheripol из пропилена."));
  assert.equal(calls.length, 1);
  assert.deepEqual(result.io, ["Процесс Spheripol: Пропилен → Полипропилен"]);
});

test("повтор не лучше — остаётся первый ответ", async () => {
  calls = [];
  const latin = decoded(["Fosgen"], []);
  replies = [latin, latin];
  const { result } = await decodeSection(job("Фосген."));
  assert.equal(calls.length, 2);
  assert.deepEqual(result.raw, ["Fosgen"]);
});
