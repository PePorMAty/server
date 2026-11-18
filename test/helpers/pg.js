// Тесты на PostgreSQL (TEST_DATABASE_URL) — по очереди.
//
// node --test запускает файлы параллельно, а тестовая база одна: три файла,
// которые чистят app.* и пишут туда, иначе мешают друг другу. Каждый файл
// держит рекомендательную блокировку базы на всё время своих тестов.

const LOCK_KEY = 726_154_100;

/** Взять блокировку; вернуть функцию, которая её отпускает. */
async function lockTestDb(pool) {
  const client = await pool.connect();
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  };
}

module.exports = { lockTestDb };
