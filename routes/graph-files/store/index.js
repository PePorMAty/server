// routes/graph-files/store/index.js
//
// Какое хранилище у библиотеки графов: файлы (по умолчанию) или PostgreSQL —
// GRAPH_STORE=pg в .env и `pm2 restart all` (PG-MIGRATION.md, этап 1).
// Откат — убрать переменную (или GRAPH_STORE=files): графы снова из data/.
// Двойной записи нет: работает одно хранилище, перенос между ними — скриптами
// scripts/migrate-graphs-to-pg.js и scripts/export-graphs-from-pg.js.
//
// Роуты берут хранилище через getStore() на каждый запрос — тесты подменяют
// его через setStore().

const path = require("path");

const { createFileStore } = require("./files");
const { createPgStore } = require("./pg");
const { ConflictError, metaOf, versionOf } = require("./common");

const DATA_DIR = path.resolve(__dirname, "../../../data");

let current = null;

function storeKind(env = process.env) {
  return String(env.GRAPH_STORE || "").trim().toLowerCase() === "pg" ? "pg" : "files";
}

function getStore() {
  if (!current) {
    current =
      storeKind() === "pg"
        ? createPgStore({ pool: require("../../../db/pool").getPool() })
        : createFileStore({ dataDir: DATA_DIR });
  }
  return current;
}

function setStore(store) {
  current = store;
}

/**
 * Проверка при запуске сервера с GRAPH_STORE=pg: есть ли схема. Без неё
 * библиотека отвечала бы 500 на каждый запрос — лучше сказать в журнале
 * сразу, что делать.
 */
async function checkPgStore() {
  if (storeKind() !== "pg") return { kind: "files" };
  const { rows } = await require("../../../db/pool").getPool().query("SELECT to_regclass('app.graphs') AS t");
  if (!rows[0]?.t) {
    throw new Error("GRAPH_STORE=pg, но схемы app нет — выполните `npm run pg:migrate`");
  }
  return { kind: "pg" };
}

module.exports = {
  getStore,
  setStore,
  storeKind,
  checkPgStore,
  createFileStore,
  createPgStore,
  ConflictError,
  metaOf,
  versionOf,
  DATA_DIR,
};
