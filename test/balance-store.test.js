// Хранилище готовых расчётов баланса и копий веб-источников
// (routes/material-balance/utils/store.js) — на SQLite и, при
// TEST_DATABASE_URL, на PostgreSQL (этап 2 PG-MIGRATION.md): что записано,
// то и читается, готовый расчёт находится по тем же правилам.
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../routes/material-balance/utils/store");
const { backends } = require("./helpers/sources");

/** Расчёт «кумол → фенол, ацетон» в том виде, в каком его пишет calculate. */
const record = (over = {}) => ({
  transformation: "Кумольный способ",
  inputs: ["Кумол", "Кислород"],
  targets: ["Фенол", "Ацетон"],
  basisAmount: { amount: 1, unit: "т", kg: 1000 },
  localKey: "",
  answer: "# Материальный баланс\n…",
  parsed: {
    status: "calculated",
    statusLabel: "Рассчитан",
    products: [
      { ref: "P1", massKg: 610 },
      { ref: "P2", massKg: 380 },
    ],
  },
  refs: [
    { ref: "B1", role: "basis", name: "Кумол" },
    { ref: "I1", role: "input", name: "Кислород" },
    { ref: "P1", role: "target", name: "Фенол" },
    { ref: "P2", role: "target", name: "Ацетон" },
  ],
  knownData: "",
  customPrompt: false,
  provider: "qwen",
  model: "test",
  tookMs: 1234,
  ...over,
});

for (const backend of backends()) {
  describe(`расчёты баланса — ${backend.name}`, () => {
    let close;
    before(async () => {
      close = await backend.open();
    });
    after(() => close());

    test("записанный расчёт читается целиком и находится как готовый", async () => {
      const id = await store.save(record());
      assert.equal(typeof id, "number");
      const r = await store.get(id);
      assert.equal(r.id, id);
      assert.equal(r.title, "Кумольный способ → Фенол, Ацетон");
      assert.deepEqual(r.inputs, ["Кумол", "Кислород"]);
      assert.deepEqual(r.basisAmount, { amount: 1, unit: "т", kg: 1000 });
      assert.equal(r.customPrompt, false);
      assert.equal(r.tookMs, 1234);
      assert.equal(r.statusLabel, "Рассчитан");

      // Порядок сырья и продуктов не важен; другие разделы базы — не тот расчёт.
      const q = { transformation: "кумольного способа", inputs: ["Кислород", "Кумол"], targets: ["Ацетон", "Фенол"] };
      assert.equal((await store.lookup(q)).exact?.id, id);
      const other = await store.lookup({ ...q, localKey: "1,2" });
      assert.equal(other.exact, null);
      assert.equal(other.similar[0]?.id, id);
      // Пара прежнего клиента: опорное сырьё и один продукт.
      const pair = await store.lookupPair({ transformation: "Кумольный способ", basis: "Кумол", target: "Фенол" });
      assert.equal(pair.exact, null); // расчёт на два продукта — не пара
    });

    test("свежий расчёт того же варианта главнее старого; свои данные — только похожее", async () => {
      const older = (await store.lookup({ transformation: "Кумольный способ", inputs: ["Кумол", "Кислород"], targets: ["Фенол", "Ацетон"] })).exact.id;
      const newer = await store.save(record());
      const custom = await store.save(record({ knownData: "свои нормы" }));
      const { exact, similar } = await store.lookup({ transformation: "Кумольный способ", inputs: ["Кумол", "Кислород"], targets: ["Фенол", "Ацетон"] });
      assert.equal(exact.id, newer);
      assert.ok(newer > older);
      assert.ok(similar.some((s) => s.id === custom));
      assert.ok(!similar.some((s) => s.id === older));
    });

    test("копия веб-источника: запись, свежая копия по адресу, текст с диска", async () => {
      const doc = await store.saveWebDocument({
        url: "https://example.org/phenol",
        finalUrl: "https://example.org/phenol?x=1",
        kind: "html",
        contentType: "text/html",
        title: "Phenol",
        body: Buffer.from("<p>фенол 610 кг</p>"),
        text: "фенол 610 кг",
      });
      assert.equal(doc.url, "https://example.org/phenol");
      assert.equal(doc.chars, 12);
      assert.equal((await store.recentWebDocument("https://example.org/phenol", 30))?.id, doc.id);
      assert.equal(await store.recentWebDocument("https://example.org/other", 30), null);
      assert.equal(await store.webDocumentText(doc.id), "фенол 610 кг");
      assert.equal(await store.webDocumentText(999999), "");
    });
  });
}
