// Коды ОКПД2 и ТН ВЭД моделью по файлам классификаторов (POST
// /graphs/gpt/product-codes) и их выдача в /industry/lookup. Модель
// подменена: отвечает функция теста по тексту запроса; классификаторы —
// настоящие файлы reference/.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codes-")), "product-codes.json");
process.env.PRODUCT_CODES_FILE = store;

let answer = () => "NONE";
const asked = [];
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    const messages = payload.input;
    asked.push(messages);
    return { status: "completed", text: answer(messages[messages.length - 1].content, messages), ai: { model: "test-model" } };
  },
  extractOutputText: (r) => r.text,
};

const codes = require("../routes/industry/codes");
const industry = require("../routes/industry/industry");
const handlerOf = (router, p) => router.stack.find((l) => l.route?.path === p).route.stack[0].handle;
const determine = handlerOf(codes, "/graphs/gpt/product-codes");
const lookup = handlerOf(industry, "/industry/lookup");

function call(handle, body) {
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
      json(o) { resolve({ ...o, http_status: this.statusCode }); },
    };
    handle({ body, on() {} }, res);
  });
}

const isGroup = (text) => /^Ты — эксперт по классификатору/.test(text);
const isLeaf = (kind, text) => (kind === "okpd2" ? /Known OKPD2 subgroup/ : /Known TN VED heading/).test(text);

test("позиция названа как товар: подгруппа без модели, код — промптом владельца; сохранён", async () => {
  asked.length = 0;
  answer = (text) => (isLeaf("okpd2", text) ? "20.14.61.110" : isLeaf("tnved", text) ? "2912 11 000" : "NONE");
  const r = await call(determine, { name: "Формальдегид" });
  assert.equal(r.success, true);
  assert.equal(r.okpd2.status, "found");
  assert.equal(r.okpd2.code, "20.14.61.110");
  assert.equal(r.okpd2.name, "Формальдегид");
  assert.equal(r.okpd2.subgroup, "20.14");
  // Десятая цифра ТН ВЭД — 0: в файле конечные коды записаны девятью.
  assert.equal(r.tnved.code, "2912110000");
  assert.equal(r.tnved.display, "2912 11 000 0");
  assert.equal(r.requests, 2);
  // Фрагмент — все коды подгруппы из файла, с соседями.
  const okpd2Prompt = asked.flat().find((m) => isLeaf("okpd2", m.content)).content;
  assert.match(okpd2Prompt, /^Product name: Формальдегид\.\nKnown OKPD2 subgroup: 20\.14/);
  assert.match(okpd2Prompt, /20\.14\.61\.120\tАцетальдегид/);
  assert.doesNotMatch(okpd2Prompt, /<<<|20\.13\./);
  // Сохранено — и приходит в /industry/lookup само.
  assert.equal(r.saved.okpd2.model, "test-model");
  const l = await call(lookup, { products: ["Формальдегид", "Бензол"] });
  assert.equal(l.modelCodes["Формальдегид"].okpd2.code, "20.14.61.110");
  assert.equal(l.modelCodes["Формальдегид"].tnved.display, "2912 11 000 0");
  assert.equal(l.modelCodes["Бензол"], undefined);
});

test("несколько подгрупп: модель выбирает подгруппу из найденных поиском", async () => {
  asked.length = 0;
  answer = (text) => {
    if (isGroup(text)) return /подгруппу ОКПД2/.test(text) ? "30.30" : "8411";
    return isLeaf("okpd2", text) ? "30.30.12.110" : "8411 12 100 1";
  };
  const r = await call(determine, { name: "Двигатель (Самолёт)", description: "Турбовентиляторный двигатель пассажирского самолёта" });
  const group = asked.flat().find((m) => isGroup(m.content) && /ОКПД2/.test(m.content)).content;
  assert.match(group, /Товар: «Двигатель \(Самолёт\)»\.\nОписание товара: Турбовентиляторный/);
  assert.match(group, /30\.30 Аппараты летательные/);
  assert.match(group, /28\.11 Двигатели и турбины/);
  assert.equal(r.okpd2.code, "30.30.12.110");
  assert.equal(r.okpd2.subgroup, "30.30");
  // Кода 8411 12 100 1 в файле нет: переспросили один раз, ответа нет — не определён.
  assert.equal(r.tnved.status, "none");
  assert.match(r.tnved.reason, /нет в номенклатуре/);
  assert.equal(r.saved.tnved, undefined);
  const retry = asked.find((ms) => ms.length === 3 && isLeaf("tnved", ms[0].content));
  assert.match(retry[2].content, /^Проверка по файлу: кода 8411 12 100 1 нет в номенклатуре/);
});

test("группа вместо конечного кода и чужая подгруппа — переспрос; верный ответ принят", async () => {
  answer = (text, ms) => {
    if (!isLeaf("okpd2", ms[0].content)) return "NONE";
    return ms.length === 1 ? "20.14.61.100" : "20.14.61.110";
  };
  const r = await call(determine, { name: "Формальдегид", kinds: ["okpd2"] });
  assert.equal(r.okpd2.code, "20.14.61.110");
  assert.equal(r.tnved, undefined);
  assert.equal(r.requests, 2);
  const retry = asked[asked.length - 1];
  assert.match(retry[2].content, /20\.14\.61\.100 — группа, под ним есть более подробные коды/);

  answer = () => "20.13.24.122";
  const wrong = await call(determine, { name: "Формальдегид", kinds: ["okpd2"] });
  assert.equal(wrong.okpd2.status, "none");
  assert.match(wrong.okpd2.reason, /не из подгруппы 20\.14/);
});

test("поиск по названию не нашёл ничего — сперва класс, потом подгруппа", async () => {
  asked.length = 0;
  answer = (text) => {
    if (isGroup(text) && /класс ОКПД2/.test(text)) return "20";
    if (isGroup(text)) return "20.16";
    return isLeaf("okpd2", text) ? "20.16.56.120" : "NONE";
  };
  const r = await call(determine, { name: "Фенолоформальдегидные смолы", kinds: ["okpd2"] });
  assert.equal(r.okpd2.code, "20.16.56.120");
  assert.equal(r.requests, 3);
  const top = asked[0][0].content;
  assert.match(top, /все варианты этого уровня/);
  assert.match(top, /\n20 Вещества химические и продукты химические/);
});

test("свой промпт без фрагмента — фрагмент дописан; синоним получает сохранённые коды", async () => {
  asked.length = 0;
  answer = (text) => (/Мой промпт/.test(text) ? "20.14.12.180" : "NONE");
  const r = await call(determine, { name: "Кумол", kinds: ["okpd2"], prompts: { okpd2: "Мой промпт для <<<PRODUCT>>>." } });
  assert.equal(r.okpd2.code, "20.14.12.180");
  assert.equal(r.saved.okpd2.customPrompt, true);
  const text = asked[0][0].content;
  assert.match(text, /^Мой промпт для Кумол\.\n\nФрагмент файла классификатора \(file_search, 20\.14\):\n20\.14\t/);
  // «Изопропилбензол» — то же вещество по справочнику синонимов.
  const l = await call(lookup, { products: ["Изопропилбензол"] });
  assert.equal(l.modelCodes["Изопропилбензол"].okpd2.code, "20.14.12.180");
});

test("без названия или видов кодов — 400", async () => {
  assert.equal((await call(determine, {})).http_status, 400);
  assert.equal((await call(determine, { name: "Фенол", kinds: ["cas"] })).http_status, 400);
});
