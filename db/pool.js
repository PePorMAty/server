// db/pool.js
//
// Подключение к PostgreSQL для хранилищ на pg (PG-MIGRATION.md).
//
// Параметры — те же DB_* из .env, что у Sequelize и scripts/db-info.js:
// сервер ходит в базу одним пользователем (graph_app). DATABASE_URL, если
// задан, главнее — так удобнее тестам и пробным прогонам.
//
// Пул один на процесс и создаётся при первом обращении: с GRAPH_STORE=files
// и SOURCES_STORE=sqlite (по умолчанию) к базе не ходим вовсе.

const { Pool } = require("pg");

// Пределы ожидания: запрос к базе не должен висеть вечно. 18.11 на боевом
// сервере сохранение графа ждало минуту и обрывалось («Network Error»):
// без пределов зависший запрос держит соединение, остальные встают в
// очередь за ним — и даже открыть граф становится долго. С пределами такой
// запрос через секунды получает ошибку, а очередь идёт дальше.
const LIMITS = {
  // Свободного соединения нет столько времени — ошибка, а не вечная очередь.
  connectionTimeoutMillis: 15_000,
  // Один запрос (граф на 687 узлов пишется за доли секунды).
  statement_timeout: 30_000,
  // Ждать блокировку строки (чужое сохранение того же графа).
  lock_timeout: 15_000,
  // Транзакция открыта и молчит — сервер базы её закрывает и отпускает
  // блокировки.
  idle_in_transaction_session_timeout: 60_000,
};

// Таблицы без схемы в запросах — из app: так база источников и расчёты
// баланса (db/sql.js) пишут один SQL и для SQLite, и для PostgreSQL. Графы,
// миграции и перенос пишут схему явно (app., public.) — им это не мешает.
const SEARCH_PATH = { options: "-c search_path=app,public" };

function poolConfig(env = process.env) {
  // Сервер один, людей десятки: десяти соединений хватает с запасом (на
  // сохранение клиент шлёт сразу несколько запросов), а память на сервере
  // (2 ГБ рядом с API и VPN) не тратим — соединение базы — несколько МБ.
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, max: 10, ...LIMITS, ...SEARCH_PATH };
  return {
    host: env.DB_HOST,
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    max: 10,
    ...LIMITS,
    ...SEARCH_PATH,
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
