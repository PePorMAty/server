// База источников: что отдаётся продукту (routes/local-sources/utils/store.js).
//
// Документы и разделы записываются прямо в таблицы: PDF и модель не нужны.
// Одни и те же проверки — на SQLite (во временной папке) и, при
// TEST_DATABASE_URL, на PostgreSQL (этап 2 PG-MIGRATION.md).
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../routes/local-sources/utils/store");
const { isServiceSection } = require("../routes/local-sources/utils/structure");
const { isFileBookmark } = require("../routes/local-sources/utils/pdf");
const { addDoc: addDocument, addSection, backends } = require("./helpers/sources");

const addDoc = (shortTitle, addedAt) => addDocument({ shortTitle, addedAt });
const titles = (list) => list.map((s) => `${s.docTitle} · ${s.title}`);

// ---------- издания одного справочника ----------
test("издание по короткому названию", () => {
  assert.deepEqual(store.editionOf("ИТС 18—2023"), { series: "итс 18", year: 2023 });
  assert.deepEqual(store.editionOf("ИТС 18—202_"), { series: "итс 18", year: null });
  assert.deepEqual(store.editionOf("ИТС 32–2022"), { series: "итс 32", year: 2022 });
  assert.equal(store.editionOf("НДТ 03"), null);
});

// ---------- служебные разделы ----------
test("служебные разделы распознаются", () => {
  assert.ok(isServiceSection({ title: "Краткое содержание справочника" }));
  assert.ok(isServiceSection({ title: "В.3 Уровни потребления основных видов ресурсов и энергии" }));
  assert.ok(isServiceSection({ title: "1.2 Производство полимеров", path: "Раздел 1 Общая информация о производстве полимеров" }));
  assert.ok(!isServiceSection({ title: "2.1 Производство этилена", path: "Раздел 2 Производство низших олефинов" }));
  assert.ok(!isServiceSection({ title: "Раздел 3. Текущие уровни потребления ресурсов и эмиссии" }));
});

// ---------- склеенный PDF ----------
test("закладки — имена файлов склеенного PDF — не разметка", () => {
  assert.ok(isFileBookmark("‎C:\\Users\\v.ivanova\\Desktop\\Поправки итс 31.pdf‎"));
  assert.ok(isFileBookmark("ИТС 31-2021 (8).pdf"));
  assert.ok(!isFileBookmark("Раздел 9 Производство алкилфенолов"));
});

// ---------- разметка: пункты «Производственных процессов» ----------
test("пункты «Производственных процессов» — источники, хоть и не «Производство X»", () => {
  const { buildUnits } = require("../routes/local-sources/utils/structure");
  // 12 страниц по одной строке текста; заголовки — закладки на страницах.
  const pages = Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    lines: [{ y: 500, text: `Текст страницы ${i + 1}. `.repeat(20) }],
  }));
  const toc = (raw, page, level) => ({ raw, page, level, y: 700 });
  const doc = {
    pages,
    toc: {
      kind: "outline",
      entries: [
        toc("1 Общая информация об отрасли", 1, 1),
        toc("1.2 Производство меди", 2, 2),
        toc("2 Технологические решения", 3, 1),
        toc("2.1 Системы менеджмента", 3, 2),
        toc("2.4 Производственные процессы", 4, 2),
        { ...toc("2.4.1 Пирометаллургические технологии производства меди", 4, 3), y: 650 },
        toc("2.4.2 Электролитическое рафинирование меди", 6, 3),
        toc("2.4.4 Производство катанки", 8, 3),
        toc("2.5 Неорганизованные эмиссии", 10, 2),
        toc("Приложение А. Перечень маркерных веществ", 11, 1),
      ],
    },
  };
  const titles = buildUnits(doc)
    .units.filter((u) => !isServiceSection(u))
    .map((u) => u.title);
  assert.deepEqual(titles, [
    "Пирометаллургические технологии производства меди",
    "Электролитическое рафинирование меди",
    "Производство катанки",
  ]);
});

for (const backend of backends()) {
  describe(`база источников — ${backend.name}`, () => {
    let close;
    let draft, final, polymers;
    before(async () => {
      close = await backend.open();
      draft = await addDoc("ИТС 18—202_", "2026-09-30T10:00:00Z");
      final = await addDoc("ИТС 18—2023", "2026-10-06T10:00:00Z");
      polymers = await addDoc("ИТС 32–2022", "2026-10-06T11:00:00Z");
      for (const d of [draft, final]) {
        await addSection(d, "2.1 Производство этилена", { product: ["Этилен"], raw: ["Этан", "Этилен"] });
        await addSection(d, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Кумол"] });
      }
      await addSection(polymers, "10.1 Поликарбонаты", {
        product: ["Поликарбонат", "Бисфенол А"],
        raw: ["Бисфенол А", "Фосген", "Фенол", "Ацетон"],
      });
      await addSection(polymers, "10.6 Полиарилат ДВ-524", { product: ["Полиарилат"], raw: ["Бисфенол А"] });
    });
    after(() => close());

    // ---------- издания одного справочника ----------
    test("черновик заменён изданием 2023: его разделы не отдаются", async () => {
      const up = titles(await store.sourcesFor("Этилен", "up"));
      assert.deepEqual(up, ["ИТС 18—2023 · 2.1 Производство этилена"]);
      const docs = Object.fromEntries((await store.listDocuments()).map((d) => [d.id, d.supersededBy]));
      assert.deepEqual(docs[draft], { id: final, title: "ИТС 18—2023" });
      assert.equal(docs[final], null);
      assert.equal((await store.countsFor("Этилен")).localDir.up, 1);
      const eth = (await store.listProducts()).products.find((p) => p.label === "Этилен");
      assert.equal(eth.up, 1);
    });

    // ---------- «вниз» и совмещённое производство ----------
    test("«вниз»: раздел, где продукт делают и тут же перерабатывают, — источник", async () => {
      const down = titles(await store.sourcesFor("Бисфенол А", "down"));
      assert.ok(down.includes("ИТС 32–2022 · 10.1 Поликарбонаты"), down.join("; "));
      assert.ok(down.includes("ИТС 32–2022 · 10.6 Полиарилат ДВ-524"), down.join("; "));
      const bpa = (await store.listProducts()).products.find((p) => p.label === "Бисфенол А");
      assert.equal(bpa.down, 2);
    });

    test("«вниз»: раздел, где продукт только производят (и рециркулируют), — не источник", async () => {
      assert.deepEqual(titles(await store.sourcesFor("Этилен", "down")), []);
    });

    test("«вниз» для сырья — как раньше", async () => {
      assert.deepEqual(titles(await store.sourcesFor("Кумол", "down")), ["ИТС 18—2023 · 3.6 Производство фенола и ацетона"]);
      assert.ok(titles(await store.sourcesFor("Фенол", "down")).includes("ИТС 32–2022 · 10.1 Поликарбонаты"));
    });

    // ---------- найденное моделью ----------
    test("найденное моделью в базе не отдаётся и удаляется по команде", async () => {
      const c = await store.connection();
      // В PostgreSQL таблицы найденного моделью нет — при переносе его не берём.
      const stored = c.dialect === "sqlite" ? 1 : 0;
      if (stored) {
        await c.run(
          `INSERT INTO web_sources (product_key, product_label, direction, url, title, found_at)
           VALUES (?, 'Этилен', 'up', 'https://example.org/ethylene', 'Ethylene', '2026-10-01')`,
          store.nameKeys("Этилен")[0],
        );
      }
      assert.deepEqual((await store.countsFor("Этилен")).web, { up: 0, down: 0 });
      assert.deepEqual((await store.productSources(store.productKeys("Этилен"))).web, { up: [], down: [] });
      assert.deepEqual((await store.listProducts()).products.find((p) => p.label === "Этилен").web, { up: 0, down: 0 });
      assert.equal(await store.purgeWebSources({ dryRun: true }), stored);
      assert.equal((await store.stats()).webSources, stored);
      assert.equal(await store.purgeWebSources(), stored);
      assert.equal((await store.stats()).webSources, 0);
    });

    // ---------- служебные разделы ----------
    test("служебные разделы, записанные раньше, удаляются один раз при открытии базы", async () => {
      const doc = await addDoc("НДТ 03", "2026-09-30T12:00:00Z");
      await addSection(doc, "Краткое содержание справочника", { product: ["Медь"] });
      await addSection(doc, "1.2 Производство меди", { product: ["Медь"] }, { path: "Раздел 1. Общая информация рассматриваемой отрасли" });
      await addSection(doc, "2.4.9 Производство медного купороса", { product: ["Медный купорос"], raw: ["Медь"] });
      const c = await store.connection();
      await c.run(`DELETE FROM ${c.dialect === "pg" ? "sources_meta" : "meta"} WHERE name = 'service_removed'`);
      store.close(); // следующее обращение откроет базу заново — с переносом
      const left = (await store.listSections(doc)).map((s) => s.title);
      assert.deepEqual(left, ["2.4.9 Производство медного купороса"]);
    });

    test("«Целевой алкилфенол» — тот же алкилфенол, «Технический углерод» — не углерод", async () => {
      const its31 = await addDoc("ИТС 31—2021", "2026-10-06T12:00:00Z");
      await addSection(its31, "Раздел 47 Производство алкилсалицилатных присадок", {
        product: ["Алкилсалицилатные присадки"],
        intermediate: ["Целевой алкилфенол", "Сырой алкилфенол"],
        raw: ["Фенол", "Олигомеры этилена"],
      });
      await addSection(its31, "Производство технического углерода", { product: ["Технический углерод"], raw: ["Тяжёлое сырьё"] });
      assert.ok(titles(await store.sourcesFor("Алкилфенол", "down")).some((t) => /алкилсалицилатных/.test(t)));
      assert.ok(!titles(await store.sourcesFor("Углерод", "up")).some((t) => /технического углерода/.test(t)));
    });

    // ---------- без текста разделов (ready баланса, подсчёт источников) ----------
    test("разделы без текста — те же номера и порядок, что с текстом; ключ готового расчёта тот же", async () => {
      const { findLocalSources, localSectionKey, localKey } = require("../routes/material-balance/utils/local");
      const cases = [
        { inputs: ["Кумол"], targets: ["Фенол", "Ацетон"] },
        { inputs: ["Бисфенол А", "Фосген"], targets: ["Поликарбонат"] },
        { inputs: ["Этан"], targets: ["Этилен"] },
        { inputs: ["Неизвестное"], targets: ["Тоже неизвестное"] },
      ];
      for (const c of cases) {
        const full = await store.sectionsForTransformation(c, { limit: 5 });
        const light = await store.sectionsForTransformation(c, { limit: 5, withText: false });
        assert.deepEqual(light.map((s) => s.id), full.map((s) => s.id), JSON.stringify(c));
        assert.equal(light[0]?.text, undefined);
        const nodes = (l) => l.map((name) => ({ name }));
        const args = { inputs: nodes(c.inputs), targets: nodes(c.targets) };
        assert.equal(await localSectionKey(args), localKey(await findLocalSources(args)), JSON.stringify(c));
      }
      // Подсчёт источников продукта — без текста; издание-черновик не в счёт.
      assert.deepEqual((await store.countsFor("Фенол")).localDir, { up: 1, down: 2 });
    });

    // ---------- подсчёт для всего графа разом ----------
    test("countsForMany — те же числа, что countsFor по одному продукту", async () => {
      const names = [
        ...(await store.listProducts()).products.map((p) => p.label),
        "Фенол", "Бисфенол А", "Этилен", "Алкилфенол", "Углерод", "Неизвестное вещество",
      ];
      const many = await store.countsForMany(names);
      for (const n of names) assert.deepEqual(many[n], await store.countsFor(n), n);
      // Совмещённое производство и «только производят» — как в sourcesFor.
      assert.equal(many["Бисфенол А"].localDir.down, 2);
      assert.equal(many["Этилен"].localDir.down, 0);
    });
  });
}
