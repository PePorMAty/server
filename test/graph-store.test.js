// Хранилище библиотеки графов (routes/graph-files/store): одни и те же
// проверки на файлах и на PostgreSQL — роуты и клиент не должны видеть
// разницы (PG-MIGRATION.md, этап 1).
//
// На PostgreSQL — только если задана тестовая база: TEST_DATABASE_URL
// (например postgres://graph_app:…@localhost/gpt_graphs_test). Тест сам
// применяет миграции и чистит таблицы app.* — боевую базу сюда не давать.
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFileStore, createPgStore, ConflictError } = require("../routes/graph-files/store");

const PG_URL = process.env.TEST_DATABASE_URL;

const graph = (name, nodes = 2) => ({
  meta: { name, prompt: name, description: null, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z" },
  graph: { nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, type: "product", data: { label: `P${i}` } })), edges: [] },
  state: { leaf_nodes: ["n1"], has_more: false, sources: null },
});

const implementations = [
  {
    name: "файлы",
    async setup() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-store-"));
      return { store: createFileStore({ dataDir: dir }), reset: async () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  },
];
if (PG_URL) {
  implementations.push({
    name: "PostgreSQL",
    async setup() {
      const { Pool } = require("pg");
      const { migrate } = require("../db/migrate");
      const pool = new Pool({ connectionString: PG_URL, max: 5 });
      const unlock = await require("./helpers/pg").lockTestDb(pool);
      await migrate(pool);
      return {
        pool,
        store: createPgStore({ pool, revisionsKeep: 2 }),
        reset: () => pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE"),
        close: async () => {
          await unlock();
          await pool.end();
        },
      };
    },
  });
} else {
  test("PostgreSQL — пропущено: нет TEST_DATABASE_URL", { skip: true }, () => {});
}

for (const impl of implementations) {
  describe(`хранилище графов — ${impl.name}`, () => {
    let ctx;
    let store;
    before(async () => {
      ctx = await impl.setup();
      store = ctx.store;
    });
    beforeEach(async () => {
      if (impl.name === "файлы") {
        await ctx.reset();
        ctx = await impl.setup();
        store = ctx.store;
      } else {
        await ctx.reset();
      }
    });
    after(async () => {
      await ctx.reset?.();
      await ctx.close?.();
    });

    test("сохранить, открыть, список: мета, версия 1, листья", async () => {
      const created = await store.createGraph("a.json", graph("Фенол"));
      assert.equal(created.version, 1);
      const got = await store.getGraph("a.json");
      assert.equal(got.version, 1);
      assert.equal(got.content.meta.version, 1);
      assert.equal(got.content.meta.name, "Фенол");
      assert.equal(got.content.graph.nodes.length, 2);
      const list = await store.listGraphs();
      assert.deepEqual(
        list.map(({ id, name, leafCount, version }) => ({ id, name, leafCount, version })),
        [{ id: "a.json", name: "Фенол", leafCount: 1, version: 1 }],
      );
      assert.equal(await store.graphExists("a.json"), true);
      assert.equal(await store.getGraph("нет.json"), null);
    });

    test("перезапись: версия растёт; устаревшая версия — конфликт с метой свежей; без версии — как раньше", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      const v2 = await store.updateGraph("a.json", (c) => ({ ...c, meta: { ...c.meta, name: "Фенол 2" } }), { expectedVersion: 1 });
      assert.equal(v2.version, 2);
      await assert.rejects(
        store.updateGraph("a.json", (c) => c, { expectedVersion: 1 }),
        (e) => e instanceof ConflictError && e.current.version === 2 && e.current.meta.name === "Фенол 2",
      );
      const v3 = await store.updateGraph("a.json", (c) => c);
      assert.equal(v3.version, 3);
      // Имя и описание — без новой версии.
      const same = await store.updateGraph("a.json", (c) => ({ ...c, meta: { ...c.meta, name: "Фенол 3" } }), { bump: false });
      assert.equal(same.version, 3);
      assert.equal((await store.getGraph("a.json")).content.meta.name, "Фенол 3");
      assert.equal(await store.updateGraph("нет.json", (c) => c), null);
    });

    test("два сохранения одной версии одновременно — одно проходит, другое — конфликт", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      const results = await Promise.allSettled([
        store.updateGraph("a.json", (c) => c, { expectedVersion: 1 }),
        store.updateGraph("a.json", (c) => c, { expectedVersion: 1 }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof ConflictError));
    });

    test("удалить: граф пропадает из списка и не открывается; второй раз — нечего удалять", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      await store.upsertBookmark("a.json", "n0", { label: "P0" });
      assert.equal(await store.deleteGraph("a.json"), true);
      assert.equal(await store.getGraph("a.json"), null);
      assert.equal(await store.graphExists("a.json"), false);
      assert.deepEqual(await store.listGraphs(), []);
      assert.equal(await store.deleteGraph("a.json"), false);
    });

    test("закладки: новая — первой; правка меняет только пришедшие поля и не время; удаление", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      const first = await store.upsertBookmark("a.json", "n0", { label: "P0", kind: "product" });
      assert.equal(first.created, true);
      await new Promise((r) => setTimeout(r, 5));
      await store.upsertBookmark("a.json", "n1", { label: "P1", note: "заметка" });
      const edited = await store.upsertBookmark("a.json", "n0", { note: "новая" });
      assert.equal(edited.created, false);
      assert.equal(edited.item.label, "P0");
      assert.equal(edited.item.note, "новая");
      assert.equal(edited.item.createdAt, first.item.createdAt);
      const list = await store.listBookmarks("a.json");
      assert.deepEqual(list.map((b) => b.nodeId), ["n1", "n0"]);
      assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "graphId", "kind", "label", "nodeId", "note"]);
      assert.equal(await store.deleteBookmark("a.json", "n1"), true);
      assert.equal(await store.deleteBookmark("a.json", "n1"), false);
    });

    test("история: свежие первыми, не больше 300, очистка", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      const e = (i) => ({ id: `h${i}`, graphId: "a.json", at: new Date(Date.UTC(2026, 10, 18, 0, 0, i)).toISOString(), kind: "edit", title: `запись ${i}` });
      let all = await store.appendHistory("a.json", [e(1), e(2)]);
      assert.deepEqual(all.map((x) => x.id), ["h2", "h1"]);
      all = await store.appendHistory("a.json", Array.from({ length: 305 }, (_, i) => e(i + 3)));
      assert.equal(all.length, 300);
      assert.equal(all[0].id, "h307");
      assert.deepEqual(all[0], e(307));
      assert.equal((await store.listHistory("a.json", 5)).length, 5);
      await store.clearHistory("a.json");
      assert.deepEqual(await store.listHistory("a.json"), []);
    });

    test("расчёты баланса узлов: правки разных узлов одновременно не затирают друг друга", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      await Promise.all([
        store.putBalance("a.json", "t1", [{ id: "c1" }]),
        store.putBalance("a.json", "t2", [{ id: "c2" }]),
        store.putBalance("a.json", "t3", []),
      ]);
      assert.deepEqual(await store.getBalances("a.json"), { t1: [{ id: "c1" }], t2: [{ id: "c2" }], t3: [] });
      await store.clearBalances("a.json");
      assert.deepEqual(await store.getBalances("a.json"), {});
    });

    test("идентификаторы продуктов: пачка, null убирает, очистка", async () => {
      await store.createGraph("a.json", graph("Фенол"));
      await store.putProductIds("a.json", [
        ["n0", { productId: "108-95-2", productIdSource: "cas" }],
        ["n1", { productIdVersion: "v3" }],
      ]);
      await store.putProductIds("a.json", [["n1", null]]);
      assert.deepEqual(await store.getProductIds("a.json"), { n0: { productId: "108-95-2", productIdSource: "cas" } });
      await store.clearProductIds("a.json");
      assert.deepEqual(await store.getProductIds("a.json"), {});
    });

    test("снимки «Поделиться»: занятый токен не перезаписывается; настройки", async () => {
      const snap = { meta: { name: "Снимок" }, graph: { nodes: [{ id: "x" }], edges: [] }, state: {} };
      assert.equal(await store.createShare("Abc12345", snap), true);
      assert.equal(await store.createShare("Abc12345", { ...snap, meta: { name: "Другой" } }), false);
      assert.deepEqual(await store.getShare("Abc12345"), snap);
      assert.equal(await store.shareExists("Abc12345"), true);
      assert.equal(await store.getShare("Zzz99999"), null);
      assert.equal(await store.getSetting("prompt-layout"), null);
      await store.putSetting("prompt-layout", { promptLayout: "шаблон", updatedAt: "2026-11-18T00:00:00.000Z" });
      assert.deepEqual(await store.getSetting("prompt-layout"), { promptLayout: "шаблон", updatedAt: "2026-11-18T00:00:00.000Z" });
    });

    if (impl.name === "PostgreSQL") {
      test("PostgreSQL: прежние сохранения — в ревизиях, хранятся последние revisionsKeep", async () => {
        await store.createGraph("a.json", graph("Фенол"));
        for (let i = 0; i < 4; i++) await store.updateGraph("a.json", (c) => c);
        const { rows } = await ctx.pool.query("SELECT version FROM app.graph_revisions WHERE graph_id = 'a.json' ORDER BY version");
        assert.deepEqual(rows.map((r) => Number(r.version)), [3, 4]);
        const { rows: g } = await ctx.pool.query("SELECT version, node_count, name FROM app.graphs WHERE id = 'a.json'");
        assert.deepEqual({ ...g[0], version: Number(g[0].version) }, { version: 5, node_count: 2, name: "Фенол" });
      });
    }
  });
}

// Запись в данные одного графа идёт по очереди: при сохранении клиент шлёт
// сразу граф и идентификаторы продуктов, а сервер после графа чистит
// идентификаторы — без очереди PostgreSQL ловил взаимную блокировку
// (deadlock, боевой сервер 18.11).
if (PG_URL) {
  test("PostgreSQL: сохранение графа, очистка и запись идентификаторов одновременно — без взаимной блокировки", async () => {
    const { Pool } = require("pg");
    const { migrate } = require("../db/migrate");
    const pool = new Pool({ connectionString: PG_URL, max: 10 });
    const unlock = await require("./helpers/pg").lockTestDb(pool);
    try {
      await migrate(pool);
      await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE");
      const store = createPgStore({ pool });
      await store.createGraph("a.json", graph("Фенол", 40));
      const ids = Array.from({ length: 200 }, (_, i) => [`n${i}`, { productId: `id-${i}` }]);
      for (let round = 0; round < 10; round++) {
        await Promise.all([
          store.updateGraph("a.json", (c) => c),
          store.clearProductIds("a.json"),
          store.putProductIds("a.json", ids),
          store.putProductIds("a.json", [...ids].reverse()),
          store.clearBalances("a.json"),
          store.putBalance("a.json", "t1", []),
          store.appendHistory("a.json", [{ id: `h${round}`, kind: "save", title: "Сохранён" }]),
        ]);
      }
      assert.equal((await store.getGraph("a.json")).version, 11);
    } finally {
      await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE").catch(() => {});
      await unlock();
      await pool.end();
    }
  });
}
