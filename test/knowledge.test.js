// Слой знаний, этап 3а PG-MIGRATION.md: куски разделов и поиск по их тексту
// (routes/knowledge/). Нарезка — без базы; поиск — на PostgreSQL
// (TEST_DATABASE_URL), без неё пропускается.
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { chunkText, ensureSectionChunks, CHUNK_SIZE } = require("../routes/knowledge/chunks");
const store = require("../routes/local-sources/utils/store");
const knowledge = require("../routes/knowledge/knowledge");
const { addDoc, addSection, backends } = require("./helpers/sources");

// ---------- нарезка ----------
test("нарезка: строки не теряются, куски около заданного размера, стык перекрыт", () => {
  // Строки PDF по ~40 знаков; предложение — каждые четыре строки.
  const lines = Array.from({ length: 400 }, (_, i) => `Строка раздела номер ${i}${i % 4 === 3 ? "." : ""}`);
  const chunks = chunkText(lines.join("\n"));
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= CHUNK_SIZE * 1.5, `кусок ${c.length} знаков`);
  for (const c of chunks.slice(0, -1)) assert.match(c, /\.$/, "рвётся на конце предложения");
  const all = new Set(chunks.flatMap((c) => c.split("\n")));
  for (const l of lines) assert.ok(all.has(l), `потеряна «${l}»`);
  // Хвост куска — в начале следующего: последняя строка первого куска
  // есть и во втором, а второй начинается со строки из первого.
  const first = chunks[0].split("\n");
  assert.ok(chunks[1].split("\n").includes(first.at(-1)));
  assert.ok(first.includes(chunks[1].split("\n")[0]));
});

test("нарезка: пустой текст — без кусков, сплошная строка — по словам", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("Короткий раздел."), ["Короткий раздел."]);
  const long = chunkText("слово ".repeat(2000));
  assert.ok(long.length >= 6);
  for (const c of long) assert.ok(c.length <= CHUNK_SIZE * 1.5);
});

/** Вызвать обработчик роутера как Express. */
function search(body) {
  const layer = knowledge.stack.find((l) => l.route?.path === "/knowledge/search");
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(o) {
        resolve({ status: this.statusCode, body: o });
      },
    };
    layer.route.stack[0].handle({ body }, res);
  });
}

// ---------- поиск ----------
for (const backend of backends()) {
  describe(`поиск по разделам — ${backend.name}`, () => {
    let close;
    let its, draft, phenolSection;
    before(async () => {
      close = await backend.open();
      if (backend.name !== "PostgreSQL") return;
      require("../routes/knowledge/chunks").resetChunksReady();
      draft = await addDoc({ shortTitle: "ИТС 18—202_", addedAt: "2026-09-30T10:00:00Z" });
      its = await addDoc({ shortTitle: "ИТС 18—2023", addedAt: "2026-10-06T10:00:00Z" });
      const phenolText = [
        "Фенол получают кумольным способом.",
        "Кумол окисляют кислородом воздуха до гидропероксида кумола.",
        "Гидропероксид разлагают серной кислотой на фенол и ацетон.",
        ...Array.from({ length: 80 }, (_, i) => `Строка описания установки ${i}.`),
        "Сточные воды, содержащие фенолы, направляются на биологическую очистку.",
      ].join("\n");
      for (const d of [draft, its]) {
        const id = await addSection(d, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Кумол"] }, { text: phenolText });
        if (d === its) phenolSection = id;
      }
      await addSection(its, "2.1 Производство этилена", { product: ["Этилен"], raw: ["Этан"] }, {
        text: "Этилен получают пиролизом этана и пропана в трубчатых печах.\nПирогаз охлаждают в закалочно-испарительных аппаратах.",
      });
    });
    after(() => close());

    test("на SQLite — понятный отказ, а не ошибка", { skip: backend.name !== "SQLite" }, async () => {
      const r = await search({ q: "фенол" });
      assert.equal(r.status, 501);
      assert.match(r.body.error, /SOURCES_STORE=pg/);
    });

    test("куски строятся при запуске у разделов без них", { skip: backend.name !== "PostgreSQL" }, async () => {
      const conn = await store.connection();
      const built = await ensureSectionChunks(conn);
      assert.equal(built.sections, 3);
      assert.ok(built.chunks >= 4);
      // Второй раз — нечего достраивать.
      assert.equal((await ensureSectionChunks(conn)).sections, 0);
    });

    test("слова — по основам; от раздела — лучший кусок с выдержкой; черновик не ищется", { skip: backend.name !== "PostgreSQL" }, async () => {
      const r = await search({ q: "сточных вод фенола" });
      assert.equal(r.status, 200);
      assert.equal(r.body.results.length, 1, JSON.stringify(r.body.results.map((x) => x.docTitle)));
      const hit = r.body.results[0];
      assert.equal(hit.sectionId, phenolSection);
      assert.equal(hit.docTitle, "ИТС 18—2023");
      assert.match(hit.excerpt, /\*\*Сточные\*\* \*\*воды\*\*/);
      assert.match(hit.url, new RegExp(`section=${phenolSection}#page=1$`));
      // Пиролиз — в другом разделе.
      const p = await search({ q: "пиролиз этана" });
      assert.deepEqual(p.body.results.map((x) => x.title), ["2.1 Производство этилена"]);
    });

    test("вопрос обычным языком: всех слов нет в одном куске — добираются куски с частью, где больше слов — выше", { skip: backend.name !== "PostgreSQL" }, async () => {
      // «кумол» и «серной кислотой» — в фенольном разделе, «пиролиз» — в этиленовом.
      const r = await search({ q: "разложение гидропероксида кумола серной кислотой при пиролизе" });
      assert.deepEqual(r.body.results.map((x) => [x.title, x.match]), [
        ["3.6 Производство фенола и ацетона", "some"],
        ["2.1 Производство этилена", "some"],
      ]);
      // С «-словом» не добираем: «или без слова» нашло бы что угодно.
      assert.deepEqual((await search({ q: "кумол пиролиз -этилен" })).body.results, []);
      // Дефис внутри слова — не исключение.
      assert.ok((await search({ q: "закалочно-испарительных аппаратах пирогаза кумола" })).body.results.length >= 1);
    });

    test("фильтр по продукту и направлению — через связи разделов", { skip: backend.name !== "PostgreSQL" }, async () => {
      const up = await search({ q: "получают", product: "Этилен", direction: "up" });
      assert.deepEqual(up.body.results.map((x) => x.title), ["2.1 Производство этилена"]);
      // Кумол — сырьё фенольного раздела: «вниз» находится, «вверх» — нет.
      assert.equal((await search({ q: "получают", product: "Кумол", direction: "down" })).body.results.length, 1);
      assert.equal((await search({ q: "получают", product: "Кумол", direction: "up" })).body.results.length, 0);
    });

    test("разбор моделью — краткое содержание первым куском; удаление документа — без кусков", { skip: backend.name !== "PostgreSQL" }, async () => {
      await store.finishSection(
        phenolSection,
        { summary: "Кумольный процесс Сергеева: совместное получение фенола и ацетона.", products: ["Фенол"], raw: ["Кумол"] },
        "test",
      );
      const r = await search({ q: "Сергеева" });
      assert.equal(r.body.results[0]?.chunk, 0);
      assert.match(r.body.results[0].excerpt, /Краткое содержание раздела/);
      await store.deleteDocument(its);
      assert.equal((await search({ q: "фенол" })).body.results.length, 1); // остался черновик — уже не заменённый
      const conn = await store.connection();
      const left = await conn.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM section_chunks WHERE section_id = ?", phenolSection);
      assert.equal(left.n, 0);
    });

    test("запрос из одних служебных слов — пусто, без запроса — 400", { skip: backend.name !== "PostgreSQL" }, async () => {
      assert.deepEqual((await search({ q: "и в на" })).body.results, []);
      assert.equal((await search({})).status, 400);
    });
  });
}
