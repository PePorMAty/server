// db/sourcesTransfer.js
//
// Перенос базы источников и расчётов баланса между SQLite и PostgreSQL
// (этап 2 PG-MIGRATION.md) — для scripts/migrate-sources-to-pg.js и
// scripts/export-sources-from-pg.js.
//
// Как и у графов (graphTransfer.js), оба направления идут через снимок —
// строки всех таблиц:
//   { tables: { documents, sections, section_products, meta, balances,
//               web_documents }, sequences: { documents: n, … },
//     webSourcesSkipped }
// Снимок читается из одной базы, пишется в другую, читается обратно и
// сверяется. Номера (id) документов, разделов и расчётов — прежние: на них
// ссылаются сохранённые графы (адрес раздела, номер расчёта). Счётчики
// номеров — не меньше прежних: удалённый номер не достаётся новой записи.
//
// Связи разделов с продуктами — в порядке вставки (rowid → seq): подпись
// продукта из равных берётся по нему.
//
// PDF и копии веб-страниц — файлы на диске, их перенос не касается.

const fs = require("fs");
const path = require("path");

const localStore = require("../routes/local-sources/utils/store");
const balanceStore = require("../routes/material-balance/utils/store");
const { pgParam } = require("./sql");

/** Колонки таблиц — те же в обеих базах (db/migrations/002_sources.sql). */
const COLUMNS = {
  documents: [
    "id", "sha256", "file_name", "title", "pages", "textless", "chars", "bytes", "added_at",
    "added_via", "short_title", "structure", "page_offset", "provider", "model", "parsed_at",
  ],
  sections: [
    "id", "doc_id", "ord", "number", "title", "full_title", "path", "page_from", "page_to", "text",
    "status", "summary", "io", "extracted", "model", "error", "attempts", "claimed_by", "claimed_at",
    "decoded_at",
  ],
  section_products: ["section_id", "key", "label", "direction", "role", "origin"],
  meta: ["name", "value"],
  balances: [
    "id", "basis_key", "target_key", "tech_key", "basis_label", "target_label", "tech_label",
    "direction", "status", "answer", "parsed", "refs", "known_data", "custom_prompt", "provider",
    "model", "took_ms", "created_at", "kind", "inputs_key", "targets_key", "inputs_label",
    "targets_label", "title", "basis_amount", "local_key",
  ],
  web_documents: [
    "id", "url", "final_url", "kind", "content_type", "title", "sha256", "bytes", "chars", "fetched_at",
  ],
};
/** Таблицы с номером-счётчиком. */
const WITH_ID = ["documents", "sections", "balances", "web_documents"];
/** Имя в PostgreSQL (схема app). */
const PG_NAME = { meta: "sources_meta" };
const pgName = (t) => `app.${PG_NAME[t] || t}`;
/** Порядок записи — по ссылкам (раздел после документа). */
const ORDER = ["documents", "sections", "section_products", "meta", "balances", "web_documents"];

function emptySnapshot() {
  return {
    tables: Object.fromEntries(ORDER.map((t) => [t, []])),
    sequences: Object.fromEntries(WITH_ID.map((t) => [t, 0])),
    webSourcesSkipped: 0,
  };
}

/** Где лежат файлы SQLite: как у сервера (переменные окружения) или заданы. */
function sqlitePaths({ sourcesDir, balanceDb } = {}) {
  return {
    sourcesFile: path.join(sourcesDir || localStore.baseDir(), "sources.sqlite"),
    balanceFile:
      balanceDb ||
      process.env.MATERIAL_BALANCE_DB ||
      path.resolve(__dirname, "../data/material-balance.sqlite"),
  };
}

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

/** Снимок из файлов SQLite (нет файла — его таблицы пустые). */
async function readSqliteSnapshot(paths = {}) {
  const { sourcesFile, balanceFile } = sqlitePaths(paths);
  const snap = emptySnapshot();
  const seqOf = (raw) => {
    try {
      return Object.fromEntries(raw.prepare("SELECT name, seq FROM sqlite_sequence").all().map((r) => [r.name, r.seq]));
    } catch {
      return {};
    }
  };
  if (fs.existsSync(sourcesFile)) {
    // Через хранилище: прежние колонки и разовые пересчёты — как при открытии сервером.
    const { conn, raw } = await localStore.openSqliteAt(sourcesFile);
    try {
      const all = (sql) => raw.prepare(sql).all();
      snap.tables.documents = all("SELECT * FROM documents ORDER BY id").map((r) => pick(r, COLUMNS.documents));
      snap.tables.sections = all("SELECT * FROM sections ORDER BY id").map((r) => pick(r, COLUMNS.sections));
      snap.tables.section_products = all("SELECT * FROM section_products ORDER BY rowid").map((r) =>
        pick(r, COLUMNS.section_products),
      );
      snap.tables.meta = all("SELECT * FROM meta ORDER BY name").map((r) => pick(r, COLUMNS.meta));
      snap.webSourcesSkipped = raw.prepare("SELECT COUNT(*) AS n FROM web_sources").get().n;
      const seq = seqOf(raw);
      snap.sequences.documents = seq.documents || 0;
      snap.sequences.sections = seq.sections || 0;
      void conn;
    } finally {
      raw.close();
    }
  }
  if (fs.existsSync(balanceFile)) {
    const Database = require("better-sqlite3");
    const raw = new Database(balanceFile);
    try {
      balanceStore.createSqliteTables(raw);
      snap.tables.balances = raw.prepare("SELECT * FROM balances ORDER BY id").all().map((r) => pick(r, COLUMNS.balances));
      snap.tables.web_documents = raw
        .prepare("SELECT * FROM web_documents ORDER BY id")
        .all()
        .map((r) => pick(r, COLUMNS.web_documents));
      const seq = seqOf(raw);
      snap.sequences.balances = seq.balances || 0;
      snap.sequences.web_documents = seq.web_documents || 0;
    } finally {
      raw.close();
    }
  }
  return snap;
}

/** Есть ли в PostgreSQL что-то из этих таблиц. */
async function pgHasData(pool) {
  const counts = await pgCounts(pool);
  return Object.values(counts).some((n) => n > 0);
}

async function pgCounts(pool) {
  const out = {};
  for (const t of ORDER) {
    out[t] = (await pool.query(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${pgName(t)}`)).rows[0].n;
  }
  return out;
}

/** Строки — пачками: десятки тысяч связей по одной писались бы минутами. */
async function insertRows(client, table, cols, rows, batch = 500) {
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const values = [];
    const tuples = part.map((row) => {
      const marks = cols.map((c) => {
        values.push(pgParam(row[c]));
        return `$${values.length}`;
      });
      return `(${marks.join(", ")})`;
    });
    await client.query(`INSERT INTO ${pgName(table)} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}

/**
 * Записать снимок в PostgreSQL одной транзакцией. В базе уже есть данные —
 * ошибка, если не replace (тогда таблицы очищаются).
 */
async function writeSnapshotToPg(pool, snap, { replace = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (replace) {
      await client.query(`TRUNCATE ${ORDER.map(pgName).join(", ")} RESTART IDENTITY CASCADE`);
    } else if (await pgHasData(client)) {
      throw new Error("в PostgreSQL уже есть источники или расчёты — заменить их: --replace");
    }
    for (const t of ORDER) await insertRows(client, t, COLUMNS[t], snap.tables[t]);
    // Счётчики номеров — дальше и записанных, и когда-либо выданных SQLite.
    for (const t of WITH_ID) {
      const maxId = snap.tables[t].reduce((m, r) => Math.max(m, r.id), 0);
      const next = Math.max(maxId, snap.sequences[t] || 0);
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${pgName(t)}', 'id'), $1, $2)`,
        next > 0 ? [next, true] : [1, false],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Снимок из PostgreSQL. */
async function readPgSnapshot(pool) {
  const snap = emptySnapshot();
  for (const t of ORDER) {
    const order = t === "section_products" ? "seq" : t === "meta" ? "name" : "id";
    const { rows } = await pool.query(`SELECT ${COLUMNS[t].join(", ")} FROM ${pgName(t)} ORDER BY ${order}`);
    snap.tables[t] = rows.map((r) => pick(r, COLUMNS[t]));
  }
  for (const t of WITH_ID) {
    const { rows } = await pool.query(
      `SELECT last_value, is_called FROM ${pgSequence(t)}`,
    );
    snap.sequences[t] = rows[0]?.is_called ? Number(rows[0].last_value) : 0;
  }
  return snap;
}

/** Имя последовательности identity (app.documents_id_seq). */
function pgSequence(t) {
  return `app.${PG_NAME[t] || t}_id_seq`;
}

/**
 * Записать снимок в новые файлы SQLite (откат с PostgreSQL). Прежние файлы
 * не удаляются: переименовываются в <файл>.before-export-<время>.
 * Возвращает { sourcesFile, balanceFile, kept: [прежние файлы] }.
 */
async function writeSnapshotToSqlite(snap, paths = {}) {
  const { sourcesFile, balanceFile } = sqlitePaths(paths);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kept = [];
  const Database = require("better-sqlite3");

  const write = (file, tables, createTables) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.new`;
    fs.rmSync(tmp, { force: true });
    const raw = new Database(tmp);
    try {
      createTables(raw);
      raw.transaction(() => {
        for (const t of tables) {
          const cols = COLUMNS[t];
          const stmt = raw.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
          for (const row of snap.tables[t]) stmt.run(...cols.map((c) => row[c]));
        }
        // AUTOINCREMENT: счётчик — не меньше выданного в PostgreSQL.
        for (const t of tables.filter((x) => WITH_ID.includes(x))) {
          const seq = snap.sequences[t] || 0;
          if (!seq) continue;
          raw.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(t);
          raw.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(t, seq);
        }
      })();
    } finally {
      raw.close();
    }
    // Прежний файл — в сторону вместе с журналом WAL (сначала сбросить
    // журнал в файл, чтобы копия была целой).
    if (fs.existsSync(file)) {
      try {
        const old = new Database(file);
        old.pragma("wal_checkpoint(TRUNCATE)");
        old.close();
      } catch {
        // повреждённый или занятый файл — переименуем как есть
      }
      const aside = `${file}.before-export-${stamp}`;
      fs.renameSync(file, aside);
      kept.push(aside);
      for (const ext of ["-wal", "-shm"]) fs.rmSync(file + ext, { force: true });
    }
    fs.renameSync(tmp, file);
  };

  write(sourcesFile, ["documents", "sections", "section_products", "meta"], (raw) =>
    localStore.createSqliteTables(raw),
  );
  write(balanceFile, ["balances", "web_documents"], (raw) => balanceStore.createSqliteTables(raw));
  return { sourcesFile, balanceFile, kept };
}

/** NUL PostgreSQL не хранит (db/sql.js) — при сверке его не учитываем. */
const norm = (v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v);

/**
 * Сверить два снимка: [{ table, problem }]. Пусто — совпало всё, вплоть до
 * порядка связей разделов с продуктами.
 */
function compareSnapshots(a, b) {
  const diffs = [];
  for (const t of ORDER) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (x.length !== y.length) {
      diffs.push({ table: t, problem: `строк ${x.length} и ${y.length}` });
      continue;
    }
    let bad = 0;
    let first = null;
    for (let i = 0; i < x.length; i++) {
      const col = COLUMNS[t].find((c) => norm(x[i][c]) !== norm(y[i][c]));
      if (col) {
        bad++;
        first = first || `${t}[${i}].${col}: ${JSON.stringify(x[i][col])?.slice(0, 80)} ≠ ${JSON.stringify(y[i][col])?.slice(0, 80)}`;
      }
    }
    if (bad) diffs.push({ table: t, problem: `не совпали строки: ${bad} (первая — ${first})` });
  }
  return diffs;
}

/** Сводка для отчёта. */
function summarize(snap) {
  const t = snap.tables;
  const byStatus = {};
  for (const s of t.sections) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  return {
    documents: t.documents.length,
    sections: t.sections.length,
    sectionsByStatus: byStatus,
    links: t.section_products.length,
    balances: t.balances.length,
    webDocuments: t.web_documents.length,
    meta: t.meta.length,
    webSourcesSkipped: snap.webSourcesSkipped,
  };
}

module.exports = {
  COLUMNS,
  readSqliteSnapshot,
  writeSnapshotToPg,
  readPgSnapshot,
  writeSnapshotToSqlite,
  compareSnapshots,
  summarize,
  pgCounts,
  pgHasData,
  sqlitePaths,
};
