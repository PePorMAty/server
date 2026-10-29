// Разбор шага (POST /api/graphs/gpt/step/build) на подставных ответах модели.
//
// Модель здесь не вызывается: транспорт routes/sources/utils подменён, и
// «ответ разборщика» задаёт сам тест. Проверяются страховки build.js по
// тексту обобщения — что сервер достраивает, когда разборщик теряет или
// путает продукты, и чего не трогает.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ---------- подмена транспорта к модели ----------
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
let replies = [];
let modelCalls = 0;
require.cache[utilsPath] = {
  id: utilsPath,
  filename: utilsPath,
  loaded: true,
  exports: {
    callOpenAIResponsesRaw: async () => {
      modelCalls++;
      return { status: "completed", text: JSON.stringify(replies.shift() ?? {}) };
    },
    extractOutputText: (r) => r.text,
    explainBadAnswer: () => "bad answer",
    safeJsonParse: (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
  },
};

const router = require("../routes/step/build.js");
const handle = router.stack.find((l) => l.route?.path === "/gpt/step/build").route.stack[0].handle;

/** Вызвать обработчик как Express; вернуть { status, body }. */
function build(body, reply) {
  replies = reply ? [reply] : [];
  modelCalls = 0;
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
      end(s) {
        out += s || "";
        this.writableEnded = true;
        const json = JSON.parse(out.trim());
        resolve({ status: json.http_status ?? this.statusCode, body: json });
      },
      json(o) { resolve({ status: this.statusCode, body: o }); },
    };
    handle({ body: { existingSources: [], ...body }, on() {} }, res);
  });
}

const P = (name) => ({ name, description: "", industry: "", mainPurpose: "" });
const TR = { name: "Синтез", description: "", industry: "", mainPurpose: "", notes: [] };
const step = (inputs, outputs, byproducts = []) => ({
  transformation: TR,
  inputProducts: inputs.map(P),
  outputProducts: outputs.map(P),
  byproducts: byproducts.map(P),
});
/** Текст обобщения: основной шаг (+ необязательные альтернативы). */
const text = ({ out, inp, by = "[]", alt = "" }) =>
  `# Новый производственный шаг\n## Шаг\n- **Что производят:** ${out}\n- **Из чего производят:** ${inp}\n- **Побочные продукты:** ${by}\n${alt}`;
const names = (list) => (list || []).map((p) => p.name);

// ---------- дальняя сторона: продукт шага ----------
test("выход, потерянный разборщиком, возвращается по тексту обобщения", async () => {
  const r = await build(
    { productName: "Поликарбонат", direction: "down", existingProducts: ["Поликарбонат"],
      techText: text({ out: "[Бисфенол А]", inp: "[Поликарбонат]" }) },
    step(["Поликарбонат"], ["Диолы поликарбоната"]),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body.step.outputProducts), ["Диолы поликарбоната", "Бисфенол А"]);
});

test("выход с переставленными словами — тот же продукт, второй не добавляется", async () => {
  // Живой прогон «Полиамид-6 → нити»: обобщение «Полиамидные технические
  // нити», разборщик «Нити полиамидные технические» — было два выхода.
  const r = await build(
    { productName: "Полиамид-6", direction: "down", existingProducts: ["Полиамид-6"],
      techText: text({ out: "[Полиамидные технические нити]", inp: "[Полиамид-6, стабилизаторы]" }) },
    step(["Полиамид-6", "Стабилизаторы"], ["Нити полиамидные технические"]),
  );
  assert.deepEqual(names(r.body.step.outputProducts), ["Нити полиамидные технические"]);
  // И узел графа с тем же набором слов берётся как есть, без нового узла.
  const g = await build(
    { productName: "Полиамид-6", direction: "down",
      existingProducts: ["Полиамид-6", "Полиамидные технические нити"],
      techText: text({ out: "[Полиамидные технические нити]", inp: "[Полиамид-6]" }) },
    step(["Полиамид-6"], ["Нити полиамидные технические"]),
  );
  assert.deepEqual(names(g.body.step.outputProducts), ["Полиамидные технические нити"]);
  assert.equal(g.body.step.outputProducts[0].isExisting, true);
});

test("пустое «Что производят» — шаг не строится, модель не вызывается", async () => {
  const r = await build({ productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
    techText: text({ out: "[]", inp: "[Фенол]" }) });
  assert.equal(r.status, 422);
  assert.equal(modelCalls, 0);
});

// ---------- ближняя сторона: второе сырьё ----------
test("второе сырьё, потерянное разборщиком, возвращается (с заглавной)", async () => {
  const r = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: text({ out: "[Фенолоформальдегидные смолы]", inp: "[Фенол, формальдегид]",
        alt: "# Альтернативы\n## Альтернатива: X\n- **Из чего производят:** [Фенол, Ацетон]" }) },
    step(["Фенол"], ["Фенолоформальдегидные смолы"]),
  );
  // «Формальдегид» — не то же, что «Фенолоформальдегидные смолы»; ацетон из
  // альтернативы в основной шаг не попадает.
  assert.deepEqual(names(r.body.step.inputProducts), ["Фенол", "Формальдегид"]);
});

test("всё на месте — ничего не добавляется", async () => {
  const r = await build(
    { productName: "Бисфенол А", direction: "down", existingProducts: ["Бисфенол А"],
      techText: text({ out: "[Поликарбонат]", inp: "[Бисфенол А, Фосген]" }) },
    step(["Бисфенол А", "Фосген (COCl2)"], ["Поликарбонат"]),
  );
  assert.deepEqual(names(r.body.step.inputProducts), ["Бисфенол А", "Фосген (COCl2)"]);
});

test("сырьё, которое разборщик положил в выходы, не дублируется во входах", async () => {
  const r = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: text({ out: "[Бисфенол А]", inp: "[Фенол, Ацетон]" }) },
    step(["Фенол"], ["Бисфенол А", "Ацетон"]),
  );
  assert.deepEqual(names(r.body.step.inputProducts), ["Фенол"]);
});

test("возвращённое сырьё, которое уже есть на графе, берёт имя узла", async () => {
  const r = await build(
    { productName: "Дифенилкарбонат", direction: "down", existingProducts: ["Бисфенол А", "Дифенилкарбонат"],
      techText: text({ out: "[Поликарбонат]", inp: "[Дифенилкарбонат, бисфенол А]", by: "[Фенол]" }) },
    step(["Дифенилкарбонат"], ["Поликарбонат"], ["Фенол"]),
  );
  const added = r.body.step.inputProducts.find((p) => p.name === "Бисфенол А");
  assert.ok(added, names(r.body.step.inputProducts).join(", "));
  assert.equal(added.isExisting, true);
});

test("сравнение по целым словам: «Ацетон технический» — это ацетон, «Бисфенол А» — не фенол", async () => {
  const a = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: text({ out: "[Бисфенол А]", inp: "[Фенол, ацетон]" }) },
    step(["Фенол", "Ацетон технический"], ["Бисфенол А"]),
  );
  assert.deepEqual(names(a.body.step.inputProducts), ["Фенол", "Ацетон технический"]);
  const b = await build(
    { productName: "Дифенилкарбонат", direction: "down", existingProducts: ["Дифенилкарбонат"],
      techText: text({ out: "[Поликарбонат]", inp: "[Дифенилкарбонат, Бисфенол А, Фенол]" }) },
    step(["Дифенилкарбонат", "Бисфенол А"], ["Поликарбонат"]),
  );
  assert.deepEqual(names(b.body.step.inputProducts), ["Дифенилкарбонат", "Бисфенол А", "Фенол"]);
});

test("шаг «вверх»: на ближней стороне только раскрываемый продукт", async () => {
  const r = await build(
    { productName: "Фенол", direction: "up", existingProducts: ["Фенол"],
      techText: text({ out: "Фенол", inp: "[Кумол]", by: "[Ацетон]" }) },
    step(["Кумол"], ["Фенол"], ["Ацетон"]),
  );
  assert.deepEqual(names(r.body.step.inputProducts), ["Кумол"]);
  assert.deepEqual(names(r.body.step.outputProducts), ["Фенол"]);
  assert.deepEqual(names(r.body.step.byproducts), ["Ацетон"]);
});

// ---------- побочные продукты ----------
test("побочный продукт, потерянный разборщиком, возвращается (с заглавной)", async () => {
  const r = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: text({ out: "[Дифенилкарбонат]", inp: "[Фенол, Диметилкарбонат]", by: "[метанол]" }) },
    step(["Фенол", "Диметилкарбонат"], ["Дифенилкарбонат"]),
  );
  assert.deepEqual(names(r.body.step.byproducts), ["Метанол"]);
});

test("вода и безымянные отходы — не побочные продукты", async () => {
  const r = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: text({ out: "[Фенолоформальдегидные смолы]", inp: "[Фенол, Формальдегид]", by: "[вода, отходы]" }) },
    step(["Фенол", "Формальдегид"], ["Фенолоформальдегидные смолы"], ["Вода"]),
  );
  assert.deepEqual(names(r.body.step.byproducts), []);
});

test("побочный продукт, положенный в выходы, переезжает в побочные", async () => {
  const r = await build(
    { productName: "Дифенилкарбонат", direction: "down", existingProducts: ["Дифенилкарбонат"],
      techText: text({ out: "[Поликарбонат]", inp: "[Дифенилкарбонат, Бисфенол А]", by: "[Фенол]" }) },
    step(["Дифенилкарбонат", "Бисфенол А"], ["Поликарбонат", "Фенол"]),
  );
  assert.deepEqual(names(r.body.step.outputProducts), ["Поликарбонат"]);
  assert.deepEqual(names(r.body.step.byproducts), ["Фенол"]);
});

test("старый текст без «Побочных продуктов» — шаг как раньше, побочных нет", async () => {
  const r = await build(
    { productName: "Фенол", direction: "down", existingProducts: ["Фенол"],
      techText: "## Шаг\n- **Что производят:** [Бисфенол А]\n- **Из чего производят:** [Фенол, Ацетон]" },
    { transformation: TR, inputProducts: [P("Фенол"), P("Ацетон")], outputProducts: [P("Бисфенол А")] },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body.step.inputProducts), ["Фенол", "Ацетон"]);
  assert.deepEqual(names(r.body.step.outputProducts), ["Бисфенол А"]);
  assert.deepEqual(names(r.body.step.byproducts), []);
});
