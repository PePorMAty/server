// Перенос базы источников и расчётов баланса SQLite ⇄ PostgreSQL
// (db/sourcesTransfer.js, этап 2 PG-MIGRATION.md): строка в строку, с
// прежними номерами, и база отвечает так же, как SQLite.
//
//   TEST_DATABASE_URL=postgres://… npm test   (без неё — пропускается)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PG_URL = process.env.TEST_DATABASE_URL;

const store = require("../routes/local-sources/utils/store");
const balanceStore = require("../routes/material-balance/utils/store");
const { setSourcesPool } = require("../db/sourcesDb");
const transfer = require("../db/sourcesTransfer");
const { addDoc, addSection } = require("./helpers/sources");

let pool;
let unlock;
const dirs = [];
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  dirs.push(d);
  return d;
};

before(async () => {
  if (!PG_URL) return;
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: PG_URL, max: 5, options: "-c search_path=app,public" });
  unlock = await require("./helpers/pg").lockTestDb(pool);
  await require("../db/migrate").migrate(pool);
});

after(async () => {
  if (!PG_URL) return;
  store.close();
  balanceStore.close();
  setSourcesPool(null);
  delete process.env.SOURCES_STORE;
  await pool.query(
    "TRUNCATE app.section_products, app.sections, app.documents, app.sources_meta, app.balances, app.web_documents RESTART IDENTITY CASCADE",
  );
  await unlock();
  await pool.end();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const titles = (list) => list.map((s) => `${s.docTitle} · ${s.title} · ${s.role}`);

test("SQLite → PostgreSQL → SQLite: всё на месте, номера прежние, ответы те же", { skip: !PG_URL }, async () => {
  // Исходная база — SQLite, как на боевом сервере до этапа 2.
  const src = tmp("sources-src");
  delete process.env.SOURCES_STORE;
  process.env.LOCAL_SOURCES_DIR = src;
  process.env.MATERIAL_BALANCE_DB = path.join(src, "balance.sqlite");
  store.close();
  balanceStore.close();

  const gone = await addDoc({ shortTitle: "Удалённый" });
  const its = await addDoc({ shortTitle: "ИТС 18—2023" });
  await addSection(its, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Кумол"] });
  // NUL из PDF: PostgreSQL его не хранит — при переносе он отбрасывается.
  await addSection(its, "2.1 Производство этилена", { product: ["Этилен"], raw: ["Этан"] }, { text: "этан\u0000 пиролиз" });
  await store.deleteDocument(gone); // номер 1 больше не выдаётся
  const balanceId = await balanceStore.save({
    transformation: "Кумольный способ",
    inputs: ["Кумол"],
    targets: ["Фенол"],
    basisAmount: { amount: 1, unit: "т", kg: 1000 },
    answer: "…",
    parsed: { status: "calculated", statusLabel: "Рассчитан" },
    refs: [{ ref: "P1", role: "target", name: "Фенол" }],
  });
  const before = {
    up: titles(await store.sourcesFor("Фенол", "up")),
    down: titles(await store.sourcesFor("Кумол", "down")),
    products: (await store.listProducts()).products.map((p) => `${p.label} ↑${p.up} ↓${p.down}`),
    documents: (await store.listDocuments()).map((d) => [d.id, d.shortTitle, d.sections.total]),
  };
  store.close();
  balanceStore.close();

  const snap = await transfer.readSqliteSnapshot();
  assert.equal(snap.tables.documents.length, 1);
  assert.equal(snap.sequences.documents, 2);
  await transfer.writeSnapshotToPg(pool, snap, { replace: true });
  // Повторно без --replace — отказ, данные не трогаются.
  await assert.rejects(transfer.writeSnapshotToPg(pool, snap), /--replace/);
  assert.deepEqual(transfer.compareSnapshots(snap, await transfer.readPgSnapshot(pool)), []);

  // Сервер на PostgreSQL отвечает так же.
  process.env.SOURCES_STORE = "pg";
  setSourcesPool(pool);
  store.close();
  balanceStore.close();
  assert.deepEqual(
    {
      up: titles(await store.sourcesFor("Фенол", "up")),
      down: titles(await store.sourcesFor("Кумол", "down")),
      products: (await store.listProducts()).products.map((p) => `${p.label} ↑${p.up} ↓${p.down}`),
      documents: (await store.listDocuments()).map((d) => [d.id, d.shortTitle, d.sections.total]),
    },
    before,
  );
  assert.equal((await balanceStore.get(balanceId)).title, "Кумольный способ → Фенол");
  // Новые номера — дальше прежних: удалённый документ №1 не возвращается.
  const fresh = await addDoc({ shortTitle: "Новый" });
  assert.equal(fresh, 3);

  // Откат: выгрузка в SQLite (новая папка), сверка с базой.
  const out = tmp("sources-out");
  const pgSnap = await transfer.readPgSnapshot(pool);
  const paths = { sourcesDir: out, balanceDb: path.join(out, "balance.sqlite") };
  await transfer.writeSnapshotToSqlite(pgSnap, paths);
  assert.deepEqual(transfer.compareSnapshots(pgSnap, await transfer.readSqliteSnapshot(paths)), []);
  // И в SQLite номера не переиспользуются.
  delete process.env.SOURCES_STORE;
  process.env.LOCAL_SOURCES_DIR = out;
  store.close();
  assert.equal(await addDoc({ shortTitle: "После отката" }), 4);
});
