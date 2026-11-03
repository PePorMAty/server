#!/usr/bin/env node
//
// Что за PostgreSQL у сервера — для этапа 0 плана PG-MIGRATION.md.
//
//   node scripts/db-info.js
//
// Подключается так же, как сервер (DB_* из .env), и печатает версию базы,
// какие нужные плану расширения можно поставить (pgvector — для поиска по
// смыслу на этапе 4), может ли пользователь приложения создать свою схему,
// настройки памяти, размер базы и что в ней уже лежит. Ничего не меняет.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
const { Client } = require("pg");

const EXTENSIONS = [
  ["vector", "pgvector: поиск по смыслу, этап 4"],
  ["pg_trgm", "поиск по похожему написанию названий"],
  ["pgcrypto", "нужен только на версиях до 13 (gen_random_uuid)"],
];

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await client.connect();
  const rows = async (sql, args) => (await client.query(sql, args)).rows;

  const [{ server_version: version }] = await rows("SHOW server_version");
  const major = parseInt(version, 10);
  console.log(`PostgreSQL ${version}`);
  console.log(
    major >= 13
      ? "  Версия подходит."
      : "  Версия старше 13: понадобится pgcrypto, и pgvector под неё может не собраться — лучше обновить.",
  );

  const available = await rows(
    "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = ANY($1)",
    [EXTENSIONS.map(([name]) => name)],
  );
  console.log("\nРасширения:");
  for (const [name, why] of EXTENSIONS) {
    const e = available.find((a) => a.name === name);
    const state = !e ? "пакета нет" : e.installed_version ? `уже включено (${e.installed_version})` : `можно включить (${e.default_version})`;
    console.log(`  ${name}: ${state} — ${why}`);
  }
  if (!available.some((a) => a.name === "vector")) {
    console.log(`  pgvector ставится пакетом: sudo apt install postgresql-${major}-pgvector`);
    console.log("  (нет такого пакета — репозиторий apt.postgresql.org; нужен только к этапу 4)");
  }

  const [me] = await rows(
    `SELECT current_user AS name, current_database() AS db, r.rolsuper AS super,
            has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
            pg_size_pretty(pg_database_size(current_database())) AS size
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  console.log(`\nБаза «${me.db}», пользователь «${me.name}»${me.super ? " (суперпользователь)" : ""}, размер ${me.size}.`);
  console.log(
    me.can_create_schema
      ? "  Схему app создать может."
      : `  Схему создать не может — один раз: sudo -u postgres psql -d ${me.db} -c 'GRANT CREATE ON DATABASE ${me.db} TO ${me.name};'`,
  );
  if (!me.super) console.log("  Расширения включает суперпользователь: sudo -u postgres psql -d <база> -c 'CREATE EXTENSION vector;'");

  const [mem] = await rows(
    "SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('max_connections') AS max_connections, current_setting('work_mem') AS work_mem",
  );
  console.log(`\nНастройки: shared_buffers ${mem.shared_buffers}, work_mem ${mem.work_mem}, max_connections ${mem.max_connections}.`);

  const tables = await rows(
    "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY schemaname, relname",
  );
  console.log(tables.length ? "\nТаблицы (строк примерно):" : "\nТаблиц нет.");
  for (const t of tables) console.log(`  ${t.schemaname}.${t.relname}: ${t.n_live_tup}`);

  await client.end();
}

main().catch((e) => {
  console.error(`Не получилось: ${e.message}`);
  console.error("Подключение берётся из .env: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.");
  process.exit(1);
});
