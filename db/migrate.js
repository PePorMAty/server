// db/migrate.js
//
// Миграции схемы app: файлы db/migrations/NNN_*.sql по порядку номеров.
// Применённые записываются в public.schema_migrations; каждая — в своей
// транзакции, так что оборванная миграция не оставляет полсхемы.
//
// Запуск — `npm run pg:migrate` (scripts/db-migrate.js). Сервер миграции сам
// не применяет: схему меняет владелец, когда выкладывает этап.

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "migrations");

// Два запуска одновременно (два окна терминала) не должны применить одну
// миграцию дважды: держим рекомендательную блокировку на всё время.
const LOCK_KEY = 726_154_001;

function migrationFiles(dir = DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function applied(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query("SELECT version FROM public.schema_migrations");
  return new Set(rows.map((r) => r.version));
}

/**
 * Применить недостающие миграции. dry — только сказать, какие.
 * Возвращает { pending: [], applied: [] }.
 */
async function migrate(pool, { dir = DIR, dry = false, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    const done = await applied(client);
    const pending = migrationFiles(dir).filter((f) => !done.has(f));
    const result = { pending, applied: [] };
    if (dry) return result;
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      log(`применяю ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`миграция ${file} не применилась: ${e.message}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate, migrationFiles, DIR };
