#!/usr/bin/env node
// scripts/db-migrate.js — применить миграции схемы app (db/migrations).
//
//   npm run pg:migrate            — применить недостающие
//   npm run pg:migrate -- --dry   — только показать, какие применятся
//
// Подключается так же, как сервер (DB_* из .env; DATABASE_URL главнее).
// Нужен владелец базы — так и есть у graph_app (PG-MIGRATION.md, этап 0).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { Pool } = require("pg");
const { poolConfig } = require("../db/pool");
const { migrate } = require("../db/migrate");

(async () => {
  const dry = process.argv.includes("--dry");
  const pool = new Pool(poolConfig());
  try {
    const r = await migrate(pool, { dry, log: (s) => console.log(s) });
    if (dry) {
      console.log(r.pending.length ? `применятся: ${r.pending.join(", ")}` : "всё уже применено");
    } else {
      console.log(r.applied.length ? `применено: ${r.applied.join(", ")}` : "всё уже применено — менять нечего");
    }
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
