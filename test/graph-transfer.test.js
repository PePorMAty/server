// Перенос библиотеки графов файлы → PostgreSQL → файлы (db/graphTransfer.js,
// scripts/migrate-graphs-to-pg.js, scripts/export-graphs-from-pg.js): всё
// доезжает и сверяется, повторный перенос ничего не задваивает. Нужна
// тестовая база — TEST_DATABASE_URL; без неё тест пропускается.
//
//   TEST_DATABASE_URL=postgres://… npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PG_URL = process.env.TEST_DATABASE_URL;

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

test("файлы → PostgreSQL → файлы: всё совпадает, повтор пропускает, --replace заменяет", { skip: !PG_URL && "нет TEST_DATABASE_URL" }, async () => {
  const { Pool } = require("pg");
  const { migrate } = require("../db/migrate");
  const t = require("../db/graphTransfer");
  const pool = new Pool({ connectionString: PG_URL, max: 5 });
  const unlock = await require("./helpers/pg").lockTestDb(pool);
  try {
    await migrate(pool);
    await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE");

    const src = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-src-"));
    const id = "-_2026-11-17T17-44-53-248Z.json";
    write(path.join(src, "saved-graphs", id), {
      meta: { name: "фенол", prompt: "фенол", description: null, createdAt: "2026-11-17T17:44:53.248Z", updatedAt: "2026-11-17T18:11:46.487Z" },
      graph: { nodes: [{ id: "p1", type: "product", data: { label: "Фенол", modelCodes: { okpd2: { code: "20.14.24.111" } } } }], edges: [] },
      state: { leaf_nodes: [], has_more: false, sources: null },
    });
    write(path.join(src, "bookmarks", id), { graphId: id, items: [{ graphId: id, nodeId: "p1", label: "Фенол", kind: "product", note: "", createdAt: "2026-11-17T18:00:00.000Z" }] });
    write(path.join(src, "history", id), { graphId: id, entries: [{ id: "h2", at: "2026-11-17T18:02:00.000Z", kind: "save", title: "два" }, { id: "h1", at: "2026-11-17T18:01:00.000Z", kind: "edit", title: "раз" }] });
    write(path.join(src, "material-balances", id), { graphId: id, items: { t1: { calcs: [{ id: "c1" }], updatedAt: "2026-11-17T18:03:00.000Z" } } });
    write(path.join(src, "product-ids", id), { graphId: id, items: { p1: { productId: "108-95-2", productIdSource: "cas" } } });
    write(path.join(src, "shared-graphs", "Abc12345.json"), { meta: { name: "Снимок", createdAt: "2026-11-01T00:00:00.000Z" }, graph: { nodes: [{ id: "x" }], edges: [] }, state: {} });
    write(path.join(src, "prompt-layout.json"), { promptLayout: "шаблон", updatedAt: "2026-11-01T00:00:00.000Z" });
    fs.writeFileSync(path.join(src, "saved-graphs", "битый.json"), "{не json");

    const snap = await t.readFilesSnapshot(src);
    assert.deepEqual(snap.problems.map((p) => p.where), ["saved-graphs/битый.json"]);
    const first = await t.writeSnapshotToPg(pool, snap);
    assert.deepEqual(first.written, [id]);
    assert.deepEqual(t.compareSnapshots(snap, await t.readPgSnapshot(pool)), []);
    // Даты — прежние, а не время переноса.
    const { rows } = await pool.query("SELECT created_at, updated_at, version FROM app.graphs WHERE id = $1", [id]);
    assert.equal(rows[0].created_at.toISOString(), "2026-11-17T17:44:53.248Z");
    assert.equal(rows[0].updated_at.toISOString(), "2026-11-17T18:11:46.487Z");
    assert.equal(Number(rows[0].version), 1);

    // Повтор — пропускает; --replace — заменяет файлом.
    const again = await t.writeSnapshotToPg(pool, snap);
    assert.deepEqual(again.skipped, [id]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.graph_history")).rows[0].n, 2);
    const replaced = await t.writeSnapshotToPg(pool, snap, { replace: true });
    assert.deepEqual(replaced.written, [id]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.graph_history")).rows[0].n, 2);

    // Обратно в файлы — совпадает с исходными.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-out-"));
    await t.writeSnapshotToFiles(out, await t.readPgSnapshot(pool));
    const back = await t.readFilesSnapshot(out);
    assert.deepEqual(t.compareSnapshots(snap, back), []);
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  } finally {
    await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE").catch(() => {});
    await unlock();
    await pool.end();
  }
});
