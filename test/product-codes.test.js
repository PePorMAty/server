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

test("код xx.xx.xx.000 без уточнений — конечный, группа над ним — нет", () => {
  const cs = require("../routes/industry/utils/codeSearch");
  assert.equal(cs.isLeaf("okpd2", "29.10.21.000"), true);
  assert.equal(cs.isLeaf("okpd2", "29.10.21"), false);
  assert.equal(cs.isLeaf("okpd2", "20.14.61.100"), false);
  assert.equal(cs.isLeaf("okpd2", "20.14.61.110"), true);
  assert.equal(cs.isLeaf("tnved", "291211000"), true);
  assert.equal(cs.isLeaf("tnved", "291211"), false);
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

test("общее название с изделием по графу: контекст в запросах, код не хранится по имени", async () => {
  asked.length = 0;
  answer = (text) => {
    if (isGroup(text)) return /подгруппу ОКПД2/.test(text) ? "29.10" : "8407";
    return isLeaf("okpd2", text) ? "29.10.12.000" : "8407 34 910 0";
  };
  const r = await call(determine, { name: "Двигатель", usedFor: ["Автомобиль"], madeFrom: ["Блок цилиндров"] });
  const group = asked.flat().find((m) => isGroup(m.content) && /ОКПД2/.test(m.content)).content;
  assert.match(group, /Где используется \(по графу\): идёт на производство: Автомобиль; получают из: Блок цилиндров/);
  // Подгруппы изделия — среди кандидатов, хоть «Двигатель» в них и не назван.
  assert.match(group, /29\.10 Средства автотранспортные/);
  const leaf = asked.flat().find((m) => isLeaf("okpd2", m.content)).content;
  assert.match(leaf, /\nProduct usage: идёт на производство: Автомобиль; получают из: Блок цилиндров\n/);
  assert.equal(r.okpd2.status, "found");
  assert.equal(r.shared, false);
  const l = await call(lookup, { products: ["Двигатель"] });
  assert.equal(l.modelCodes["Двигатель"], undefined);
});

test("деталь: подгруппа не берётся по точному названию; модель отвергла найденное — поиск сверху", async () => {
  asked.length = 0;
  answer = (text) => {
    if (isGroup(text) && /класс ОКПД2/.test(text)) return "30";
    if (isGroup(text) && /найденный поиском/.test(text)) return "NONE";
    if (isGroup(text)) return "30.30";
    return isLeaf("okpd2", text) ? "30.30.50.110" : "NONE";
  };
  const r = await call(determine, { name: "Крылья", usedFor: ["Самолёт"], kinds: ["okpd2"] });
  assert.equal(r.okpd2.code, "30.30.50.110");
  assert.deepEqual(asked.map((ms) => (isGroup(ms[0].content) ? (/Определи класс/.test(ms[0].content) ? "top" : /найденный/.test(ms[0].content) ? "found" : "under") : "leaf")), ["found", "top", "under", "leaf"]);
});

test("NONE с причиной — в ответе; повтор без кода стирает прежний сохранённый", async () => {
  answer = (text) => (isLeaf("okpd2", text) ? "20.14.61.110" : "NONE");
  await call(determine, { name: "Формальдегид", kinds: ["okpd2"] });
  assert.equal((await call(lookup, { products: ["Формальдегид"] })).modelCodes["Формальдегид"].okpd2.code, "20.14.61.110");

  answer = (text) => (isLeaf("okpd2", text) ? "NONE: код зависит от концентрации раствора." : "NONE");
  const r = await call(determine, { name: "Формальдегид", kinds: ["okpd2"] });
  assert.equal(r.okpd2.status, "none");
  assert.equal(r.okpd2.missing, "код зависит от концентрации раствора");
  assert.equal(r.okpd2.reason, "код зависит от концентрации раствора");
  assert.equal(r.okpd2.subgroup, "20.14");
  assert.deepEqual(r.cleared, ["okpd2"]);
  const l = await call(lookup, { products: ["Формальдегид"] });
  assert.equal(l.modelCodes["Формальдегид"]?.okpd2, undefined);
  // ТН ВЭД, найденный раньше, остался.
  assert.equal(l.modelCodes["Формальдегид"].tnved.code, "2912110000");
});

test("записанное раньше по общему названию не отдаётся", async () => {
  const data = JSON.parse(fs.readFileSync(store, "utf8"));
  data["name:шасси"] = { name: "Шасси", tnved: { code: "8716901000", subgroup: "8716" } };
  fs.writeFileSync(store, JSON.stringify(data));
  const l = await call(lookup, { products: ["Шасси", "Шасси (Автомобиль)"] });
  assert.equal(l.modelCodes["Шасси"], undefined);
});

// ---------- контекст продукта из графа (routes/shared/productContext.js) ----------
const { readProductContext, productContextText } = require("../routes/shared/productContext");

test("контекст из графа: процессы и путь до изделия — в запросах вместо одной строки usage", async () => {
  asked.length = 0;
  // Найдёт ли поиск «волокно» — неважно: класс, подгруппа, конечный код.
  answer = (text) => {
    if (isGroup(text) && /класс ОКПД2/.test(text)) return "20";
    if (isGroup(text)) return "20.60";
    return isLeaf("okpd2", text) ? "20.60.12.110" : "NONE";
  };
  const context = {
    description: "Полиамид 6,6 в виде комплексных нитей для текстиля и шинного корда.",
    madeBy: [{ name: "Формование волокна", description: "Расплав полимера продавливают через фильеры и вытягивают.", inputs: ["Нейлон 6,6"], outputs: ["Волокно нейлона 6,6"] }],
    usedIn: [{ name: "Изготовление корда", inputs: ["Волокно нейлона 6,6"], outputs: ["Шинный корд"] }],
    downstream: [["Шинный корд", "Шина"]],
  };
  const r = await call(determine, { name: "Волокно нейлона 6,6", kinds: ["okpd2"], context });
  const prompts = asked.flat().map((m) => m.content);
  const group = prompts.find((t) => isGroup(t));
  assert.match(group, /Контекст из графа:\nОписание: Полиамид 6,6 в виде комплексных нитей/);
  assert.match(group, /- «Формование волокна»: Нейлон 6,6 → Волокно нейлона 6,6\. Расплав полимера/);
  assert.match(group, /Дальше по цепочке: Шинный корд → Шина/);
  assert.doesNotMatch(group, /Где используется \(по графу\)/);
  const leaf = prompts.find((t) => isLeaf("okpd2", t));
  assert.match(leaf, /Product context \(из графа\):\n/);
  assert.match(leaf, /Во что идёт \(по графу\):\n- «Изготовление корда»: Волокно нейлона 6,6 → Шинный корд/);
  assert.equal(r.okpd2.status, "found");
});

test("контекст: чужие поля и лишняя длина отброшены, текст укладывается в бюджет", () => {
  assert.equal(readProductContext(null), null);
  assert.equal(readProductContext({ junk: 1 }), null);
  const long = "очень длинное описание процесса ".repeat(40);
  const ctx = readProductContext({
    description: "x".repeat(2000),
    madeBy: Array.from({ length: 9 }, (_, i) => ({ name: `Процесс ${i}`, description: long, inputs: ["A", "B"], outputs: ["C"] })),
    usedIn: [{ name: "", inputs: [], outputs: [] }, "мусор"],
    downstream: [["Деталь", "Узел", "Изделие"], []],
  });
  assert.equal(ctx.description.length, 600);
  assert.equal(ctx.madeBy.length, 4);
  assert.equal(ctx.madeBy[0].description.length, 400);
  assert.equal(ctx.usedIn, undefined);
  assert.deepEqual(ctx.downstream, [["Деталь", "Узел", "Изделие"]]);
  const text = productContextText(ctx, { budget: 900 });
  assert.ok(text.length <= 900, `длина ${text.length}`);
  assert.match(text, /Как получают \(по графу\):\n- «Процесс 0»: A \+ B → C/);
  // Без описания карточки — когда промпт дал его своей строкой.
  assert.doesNotMatch(productContextText(ctx, { withDescription: false }), /^Описание:/);
});
