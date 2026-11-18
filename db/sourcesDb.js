// db/sourcesDb.js
//
// Где живут база источников и расчёты баланса (этап 2 PG-MIGRATION.md):
// SOURCES_STORE=pg — в PostgreSQL (схема app), иначе — в SQLite, как раньше.
// Откат — убрать строку из .env и pm2 restart all (прежде выгрузить новое
// из базы: scripts/export-sources-from-pg.js).

let poolOverride = null;

function sourcesStoreKind(env = process.env) {
  return env.SOURCES_STORE === "pg" ? "pg" : "sqlite";
}

/** Пул PostgreSQL для хранилищ источников: общий пул сервера или заданный тестом. */
function sourcesPool() {
  return poolOverride || require("./pool").getPool();
}

/** Тесты и скрипты переноса: свой пул (с search_path=app). null — снова общий. */
function setSourcesPool(pool) {
  poolOverride = pool;
}

/**
 * Проверка при запуске сервера: с SOURCES_STORE=pg — есть ли таблицы
 * (иначе каждый запрос к источникам отвечал бы 500) и не забыт ли перенос
 * (в базе пусто, а файл SQLite рядом есть). Возвращает { kind, warning? }.
 */
async function checkSourcesStore() {
  if (sourcesStoreKind() !== "pg") return { kind: "sqlite" };
  const { rows } = await sourcesPool().query(
    "SELECT to_regclass('app.documents') AS t",
  );
  if (!rows[0]?.t) {
    throw new Error("SOURCES_STORE=pg, но таблиц этапа 2 нет — выполните `npm run pg:migrate`");
  }
  const { rows: n } = await sourcesPool().query(
    "SELECT (SELECT COUNT(*) FROM app.documents) + (SELECT COUNT(*) FROM app.balances) AS n",
  );
  const fs = require("fs");
  const path = require("path");
  const sqlite = path.join(require("../routes/local-sources/utils/store").baseDir(), "sources.sqlite");
  if (Number(n[0].n) === 0 && fs.existsSync(sqlite)) {
    return {
      kind: "pg",
      warning: "в PostgreSQL источников и расчётов нет, а файл SQLite есть — перенесите: node scripts/migrate-sources-to-pg.js",
    };
  }
  return { kind: "pg" };
}

module.exports = { sourcesStoreKind, sourcesPool, setSourcesPool, checkSourcesStore };
