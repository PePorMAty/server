// База источников и расчётов баланса в тестах — на SQLite и, при
// TEST_DATABASE_URL, на PostgreSQL (этап 2 PG-MIGRATION.md).
//
// Записи кладутся через адаптер хранилища (db/sql.js), а не прямо в файл
// SQLite: так те же тесты проверяют обе базы.

const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../routes/local-sources/utils/store");
const balanceStore = require("../../routes/material-balance/utils/store");
const { setSourcesPool } = require("../../db/sourcesDb");

const PG_URL = process.env.TEST_DATABASE_URL;

const ROLE_DIRS = { raw: ["down"], intermediate: ["up", "down"] };

/** Документ без PDF: { shortTitle, title?, addedAt? } → id. */
async function addDoc({ shortTitle, title = shortTitle, addedAt = "2026-10-29T00:00:00Z", fileName } = {}) {
  const c = await store.connection();
  return c.insert(
    `INSERT INTO documents (sha256, file_name, title, short_title, pages, chars, bytes, added_at, added_via)
     VALUES (?, ?, ?, ?, 100, 1000, 1000, ?, 'ui')`,
    `${shortTitle}-${Math.random()}`,
    fileName || `${shortTitle}.pdf`,
    title,
    shortTitle,
    addedAt,
  );
}

/**
 * Раздел, разобранный моделью, и его связи с продуктами: roles —
 * { product: [...], raw: [...], intermediate: [...] }; направление — по роли,
 * как у разбора (raw — «вниз», intermediate — в обе стороны), или dirs.
 */
async function addSection(
  docId,
  title,
  roles = {},
  { path: p = "", text = "текст раздела ".repeat(30), summary = `Описание: ${title}`, pages = [1, 10], dirs } = {},
) {
  const c = await store.connection();
  const id = await c.insert(
    `INSERT INTO sections (doc_id, ord, title, path, page_from, page_to, text, status, summary)
     VALUES (?, 0, ?, ?, ?, ?, ?, 'done', ?)`,
    docId,
    title,
    p,
    pages[0],
    pages[1],
    text,
    summary,
  );
  for (const [role, names] of Object.entries(roles)) {
    for (const name of names) {
      for (const key of store.nameKeys(name)) {
        for (const d of dirs?.[role] ?? ROLE_DIRS[role] ?? ["up"]) {
          await c.run(
            `INSERT INTO section_products (section_id, key, label, direction, role, origin)
             VALUES (?, ?, ?, ?, ?, 'model') ON CONFLICT DO NOTHING`,
            id,
            key,
            name,
            d,
            role,
          );
        }
      }
    }
  }
  return id;
}

/**
 * Базы, на которых гонять тесты: SQLite во временной папке всегда,
 * PostgreSQL — с TEST_DATABASE_URL. open() включает базу и чистит её,
 * close() — отпускает.
 */
function backends() {
  const list = [
    {
      name: "SQLite",
      async open() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sources-test-"));
        delete process.env.SOURCES_STORE;
        process.env.LOCAL_SOURCES_DIR = dir;
        process.env.MATERIAL_BALANCE_DB = path.join(dir, "balance.sqlite");
        store.close();
        balanceStore.close();
        return async () => {
          store.close();
          balanceStore.close();
          fs.rmSync(dir, { recursive: true, force: true });
        };
      },
    },
  ];
  if (PG_URL) {
    list.push({
      name: "PostgreSQL",
      async open() {
        const { Pool } = require("pg");
        const { migrate } = require("../../db/migrate");
        const pool = new Pool({ connectionString: PG_URL, max: 5, options: "-c search_path=app,public" });
        const unlock = await require("./pg").lockTestDb(pool);
        await migrate(pool);
        await truncate(pool);
        process.env.SOURCES_STORE = "pg";
        // PDF и копии страниц — по-прежнему на диске.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sources-test-pg-"));
        process.env.LOCAL_SOURCES_DIR = dir;
        process.env.MATERIAL_BALANCE_DB = path.join(dir, "balance.sqlite");
        setSourcesPool(pool);
        store.close();
        balanceStore.close();
        return async () => {
          await truncate(pool);
          store.close();
          balanceStore.close();
          setSourcesPool(null);
          delete process.env.SOURCES_STORE;
          await unlock();
          await pool.end();
          fs.rmSync(dir, { recursive: true, force: true });
        };
      },
    });
  }
  return list;
}

function truncate(pool) {
  return pool.query(
    `TRUNCATE app.section_products, app.sections, app.documents, app.sources_meta,
              app.balances, app.web_documents RESTART IDENTITY CASCADE`,
  );
}

module.exports = { addDoc, addSection, backends, PG_URL };
