// db/pool.js
//
// Подключение к PostgreSQL для хранилищ на pg (PG-MIGRATION.md).
//
// Параметры — те же DB_* из .env, что у Sequelize и scripts/db-info.js:
// сервер ходит в базу одним пользователем (graph_app). DATABASE_URL, если
// задан, главнее — так удобнее тестам и пробным прогонам.
//
// Пул один на процесс и создаётся при первом обращении: с GRAPH_STORE=files
// (по умолчанию) к базе за графами не ходим вовсе.

const { Pool } = require("pg");

function poolConfig(env = process.env) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, max: 5 };
  return {
    host: env.DB_HOST,
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    // Сервер один, людей десятки: пяти соединений хватает с запасом, а
    // память на сервере (2 ГБ рядом с API и VPN) не тратим.
    max: 5,
  };
}

let shared = null;

function getPool() {
  if (!shared) {
    shared = new Pool(poolConfig());
    // Оборванное соединение в простое не должно ронять процесс.
    shared.on("error", (e) => console.error("[db] соединение с PostgreSQL:", e.message));
  }
  return shared;
}

module.exports = { getPool, poolConfig };
