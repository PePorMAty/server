// db/sql.js
//
// Один код хранилища — две базы: SQLite (как было) и PostgreSQL (этап 2
// PG-MIGRATION.md: база источников и расчёты баланса). Логика хранилищ —
// ключи названий, порядок разделов, издания — сложная и выверенная на
// живых данных; две её копии разошлись бы. Поэтому хранилища пишут SQL один
// раз, а этот слой отличия баз прячет:
//
//   all(sql, ...params) → строки       get(...) → строка | undefined
//   run(...) → { changes }             insert(...) → id новой строки
//   tx(async (t) => …)                 — транзакция; t — тот же интерфейс
//   dialect: "sqlite" | "pg"           rowid: порядок вставки строк
//
// Параметры — «?» в обеих базах (для PostgreSQL заменяются на $1, $2…).
// SQL пишется так, чтобы его поняли обе: COUNT — через CAST(… AS INTEGER)
// (иначе pg вернёт bigint строкой), сравнение в агрегате — через CASE,
// upsert — ON CONFLICT … DO UPDATE.
//
// Таблицы в SQL — без схемы: пул PostgreSQL ходит с search_path=app
// (db/pool.js), SQLite — свой файл.

/** «?» → «$1, $2…» (в наших запросах «?» внутри строк не бывает). */
function numbered(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/**
 * SQLite (better-sqlite3): запросы синхронные, интерфейс — тот же, что у
 * PostgreSQL, на промисах. Транзакции идут по одной: внутри tx есть await, и
 * вторая транзакция на том же соединении иначе началась бы внутри первой.
 */
function sqliteConn(db) {
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const conn = {
    dialect: "sqlite",
    rowid: "rowid",
    raw: db,
    async all(sql, ...params) {
      return prep(sql).all(...params);
    },
    async get(sql, ...params) {
      return prep(sql).get(...params);
    },
    async run(sql, ...params) {
      return { changes: prep(sql).run(...params).changes };
    },
    async insert(sql, ...params) {
      return Number(prep(sql).run(...params).lastInsertRowid);
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
  let queue = Promise.resolve();
  conn.tx = (fn) => {
    const run = queue.then(async () => {
      db.exec("BEGIN");
      try {
        const out = await fn({ ...conn, tx: (inner) => inner(conn) });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw e;
      }
    });
    queue = run.catch(() => {});
    return run;
  };
  return conn;
}

/**
 * Символ NUL в тексте PostgreSQL не хранит (SQLite — хранит): в тексте PDF
 * он изредка попадается. Убираем — для поиска и чтения он ничего не значит.
 */
function pgParam(v) {
  return typeof v === "string" && v.includes("\u0000") ? v.replace(/\u0000/g, "") : v;
}

/** PostgreSQL: пул или клиент (внутри транзакции). */
function pgConn(pool, client = null) {
  const q = (sql, params) => (client || pool).query(numbered(sql), params.map(pgParam));
  const conn = {
    dialect: "pg",
    // У PostgreSQL нет rowid: порядок вставки — колонка seq (identity).
    rowid: "seq",
    async all(sql, ...params) {
      return (await q(sql, params)).rows;
    },
    async get(sql, ...params) {
      return (await q(sql, params)).rows[0];
    },
    async run(sql, ...params) {
      return { changes: (await q(sql, params)).rowCount };
    },
    async insert(sql, ...params) {
      return Number((await q(`${sql} RETURNING id`, params)).rows[0].id);
    },
    async exec(sql) {
      await (client || pool).query(sql);
    },
    async tx(fn) {
      if (client) return fn(conn);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(pgConn(pool, c));
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
  return conn;
}

/** «?, ?, ?» — для IN (…). */
function marks(list) {
  return list.map(() => "?").join(", ");
}

module.exports = { sqliteConn, pgConn, numbered, marks, pgParam };
