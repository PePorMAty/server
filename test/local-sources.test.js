// База источников: что отдаётся продукту (routes/local-sources/utils/store.js).
//
// База — во временной папке (LOCAL_SOURCES_DIR), документы и разделы
// записываются прямо в таблицы: PDF и модель не нужны.
//
//   npm test

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-sources-test-"));
process.env.LOCAL_SOURCES_DIR = dir;

const store = require("../routes/local-sources/utils/store");
const { isServiceSection } = require("../routes/local-sources/utils/structure");
const { isFileBookmark } = require("../routes/local-sources/utils/pdf");

let db;
const open = () => {
  store.close();
  db = new (require("better-sqlite3"))(path.join(store.baseDir(), "sources.sqlite"));
};

function addDoc(shortTitle, addedAt) {
  // Схему создаёт store при первом обращении.
  store.listDocuments();
  open();
  const id = db
    .prepare(
      `INSERT INTO documents (sha256, file_name, title, short_title, pages, chars, bytes, added_at, added_via)
       VALUES (?, ?, ?, ?, 100, 1000, 1000, ?, 'ui')`,
    )
    .run(`${shortTitle}-${Math.random()}`, `${shortTitle}.pdf`, shortTitle, shortTitle, addedAt)
    .lastInsertRowid;
  db.close();
  return Number(id);
}

/** Раздел с продуктами по ролям: { product: [...], byproduct: [...], raw: [...] }. */
function addSection(docId, title, roles = {}, { path: p = "" } = {}) {
  store.listDocuments();
  open();
  const id = Number(
    db
      .prepare(
        `INSERT INTO sections (doc_id, ord, title, path, page_from, page_to, text, status, summary)
         VALUES (?, 0, ?, ?, 1, 10, ?, 'done', ?)`,
      )
      .run(docId, title, p, "текст раздела ".repeat(30), `Описание: ${title}`).lastInsertRowid,
  );
  const link = db.prepare(
    `INSERT OR IGNORE INTO section_products (section_id, key, label, direction, role, origin)
     VALUES (?, ?, ?, ?, ?, 'model')`,
  );
  for (const [role, names] of Object.entries(roles)) {
    const dirs = role === "raw" ? ["down"] : role === "intermediate" ? ["up", "down"] : ["up"];
    for (const name of names) for (const key of store.nameKeys(name)) for (const d of dirs) link.run(id, key, name, d, role);
  }
  db.close();
  return id;
}

const titles = (list) => list.map((s) => `${s.docTitle} · ${s.title}`);

let draft, final, polymers;
before(() => {
  draft = addDoc("ИТС 18—202_", "2026-09-30T10:00:00Z");
  final = addDoc("ИТС 18—2023", "2026-10-06T10:00:00Z");
  polymers = addDoc("ИТС 32–2022", "2026-10-06T11:00:00Z");
  for (const d of [draft, final]) {
    addSection(d, "2.1 Производство этилена", { product: ["Этилен"], raw: ["Этан", "Этилен"] });
    addSection(d, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Кумол"] });
  }
  addSection(polymers, "10.1 Поликарбонаты", {
    product: ["Поликарбонат", "Бисфенол А"],
    raw: ["Бисфенол А", "Фосген", "Фенол", "Ацетон"],
  });
  addSection(polymers, "10.6 Полиарилат ДВ-524", { product: ["Полиарилат"], raw: ["Бисфенол А"] });
});
after(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- издания одного справочника ----------
test("издание по короткому названию", () => {
  assert.deepEqual(store.editionOf("ИТС 18—2023"), { series: "итс 18", year: 2023 });
  assert.deepEqual(store.editionOf("ИТС 18—202_"), { series: "итс 18", year: null });
  assert.deepEqual(store.editionOf("ИТС 32–2022"), { series: "итс 32", year: 2022 });
  assert.equal(store.editionOf("НДТ 03"), null);
});

test("черновик заменён изданием 2023: его разделы не отдаются", () => {
  const up = titles(store.sourcesFor("Этилен", "up"));
  assert.deepEqual(up, ["ИТС 18—2023 · 2.1 Производство этилена"]);
  const docs = Object.fromEntries(store.listDocuments().map((d) => [d.id, d.supersededBy]));
  assert.deepEqual(docs[draft], { id: final, title: "ИТС 18—2023" });
  assert.equal(docs[final], null);
  assert.equal(store.countsFor("Этилен").localDir.up, 1);
  const eth = store.listProducts().products.find((p) => p.label === "Этилен");
  assert.equal(eth.up, 1);
});

// ---------- «вниз» и совмещённое производство ----------
test("«вниз»: раздел, где продукт делают и тут же перерабатывают, — источник", () => {
  const down = titles(store.sourcesFor("Бисфенол А", "down"));
  assert.ok(down.includes("ИТС 32–2022 · 10.1 Поликарбонаты"), down.join("; "));
  assert.ok(down.includes("ИТС 32–2022 · 10.6 Полиарилат ДВ-524"), down.join("; "));
  const bpa = store.listProducts().products.find((p) => p.label === "Бисфенол А");
  assert.equal(bpa.down, 2);
});

test("«вниз»: раздел, где продукт только производят (и рециркулируют), — не источник", () => {
  assert.deepEqual(titles(store.sourcesFor("Этилен", "down")), []);
});

test("«вниз» для сырья — как раньше", () => {
  assert.deepEqual(titles(store.sourcesFor("Кумол", "down")), ["ИТС 18—2023 · 3.6 Производство фенола и ацетона"]);
  assert.ok(titles(store.sourcesFor("Фенол", "down")).includes("ИТС 32–2022 · 10.1 Поликарбонаты"));
});

// ---------- найденное моделью ----------
test("найденное моделью в базе не отдаётся и удаляется по команде", () => {
  store.listDocuments();
  open();
  db.prepare(
    `INSERT INTO web_sources (product_key, product_label, direction, url, title, found_at)
     VALUES (?, 'Этилен', 'up', 'https://example.org/ethylene', 'Ethylene', '2026-10-01')`,
  ).run(store.nameKeys("Этилен")[0]);
  db.close();
  assert.deepEqual(store.countsFor("Этилен").web, { up: 0, down: 0 });
  assert.deepEqual(store.productSources(store.productKeys("Этилен")).web, { up: [], down: [] });
  assert.deepEqual(store.listProducts().products.find((p) => p.label === "Этилен").web, { up: 0, down: 0 });
  assert.equal(store.purgeWebSources({ dryRun: true }), 1);
  assert.equal(store.stats().webSources, 1);
  assert.equal(store.purgeWebSources(), 1);
  assert.equal(store.stats().webSources, 0);
});

// ---------- служебные разделы ----------
test("служебные разделы распознаются", () => {
  assert.ok(isServiceSection({ title: "Краткое содержание справочника" }));
  assert.ok(isServiceSection({ title: "В.3 Уровни потребления основных видов ресурсов и энергии" }));
  assert.ok(isServiceSection({ title: "1.2 Производство полимеров", path: "Раздел 1 Общая информация о производстве полимеров" }));
  assert.ok(!isServiceSection({ title: "2.1 Производство этилена", path: "Раздел 2 Производство низших олефинов" }));
  assert.ok(!isServiceSection({ title: "Раздел 3. Текущие уровни потребления ресурсов и эмиссии" }));
});

test("служебные разделы, записанные раньше, удаляются один раз при открытии базы", () => {
  const doc = addDoc("НДТ 03", "2026-09-30T12:00:00Z");
  addSection(doc, "Краткое содержание справочника", { product: ["Медь"] });
  addSection(doc, "1.2 Производство меди", { product: ["Медь"] }, { path: "Раздел 1. Общая информация рассматриваемой отрасли" });
  addSection(doc, "2.4.9 Производство медного купороса", { product: ["Медный купорос"], raw: ["Медь"] });
  open();
  db.prepare("DELETE FROM meta WHERE name = 'service_removed'").run();
  db.close();
  store.close(); // следующее обращение откроет базу заново — с переносом
  const left = store.listSections(doc).map((s) => s.title);
  assert.deepEqual(left, ["2.4.9 Производство медного купороса"]);
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
