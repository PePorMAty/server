// routes/material-balance/utils/store.js
//
// Готовые расчёты материального баланса: SQLite рядом с остальными данными
// сервера (data/material-balance.sqlite, путь — MATERIAL_BALANCE_DB).
//
// Расчёт ищется по ключу «исходный продукт + целевой продукт + технология».
// Продукты — по справочнику, как сохранённые веб-источники (productKey): расчёт
// для «ИПБ» найдётся и у «Кумола». Технология — по основам слов названия.
// Когда у преобразований появятся свои идентификаторы, ключом станут они.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { productKey } = require("../../local-sources/utils/query");
const {
  stemName,
  normalizeName,
  foldLookalikes,
} = require("../../industry/utils/normalize");

/**
 * Что берётся из базы без нового запроса. «Недостаточно данных» не берём:
 * в следующий раз модель может найти больше. Некорректный выбор и базис —
 * ошибка запроса, а не знание о технологии.
 */
const REUSABLE = ["calculated", "partial"];

let db = null;

function dbPath() {
  return (
    process.env.MATERIAL_BALANCE_DB ||
    path.resolve(__dirname, "../../../data/material-balance.sqlite")
  );
}

function getDb() {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS balances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      basis_key     TEXT NOT NULL,
      target_key    TEXT NOT NULL,
      tech_key      TEXT NOT NULL,
      basis_label   TEXT NOT NULL,
      target_label  TEXT NOT NULL,
      tech_label    TEXT NOT NULL,
      status        TEXT NOT NULL,
      answer        TEXT NOT NULL,
      parsed        TEXT NOT NULL,
      refs          TEXT NOT NULL,
      known_data    TEXT NOT NULL DEFAULT '',
      custom_prompt INTEGER NOT NULL DEFAULT 0,
      provider      TEXT,
      model         TEXT,
      took_ms       INTEGER,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS balances_pair ON balances (basis_key, target_key);
  `);
  return db;
}

/**
 * Ключ технологии: основы слов, «Получение МТБЭ» = «получения МТБЭ».
 *
 * Основы считает stemName, а он сделан для названий продуктов и отглагольные
 * существительные усекает неодинаково: «получение» → «получен», но
 * «получения» → «получени», «полимеризации» → «полимеризаци». В названии
 * технологии падеж не важен — сводим их к одной основе. Латинские двойники
 * букв («C4» и «С4») сводит foldLookalikes.
 */
function techKey(name) {
  const lower = String(name || "").toLowerCase();
  const stem = stemName(foldLookalikes(lower)) || normalizeName(lower) || "";
  return stem
    .split(" ")
    .map((w) => w.replace(/(?:ени|ани|ции|ци|ти)$/u, (m) => (m === "ции" ? "ц" : m.slice(0, -1))))
    .join(" ");
}

function keysOf({ basis, target, transformation }) {
  return {
    basis_key: productKey(basis),
    target_key: productKey(target),
    tech_key: techKey(transformation),
  };
}

/** Сохранить расчёт; возвращает его номер. */
function save(rec) {
  const keys = keysOf({
    basis: rec.basis,
    target: rec.target,
    transformation: rec.transformation,
  });
  const info = getDb()
    .prepare(
      `INSERT INTO balances (basis_key, target_key, tech_key, basis_label, target_label,
         tech_label, status, answer, parsed, refs, known_data, custom_prompt, provider,
         model, took_ms, created_at)
       VALUES (@basis_key, @target_key, @tech_key, @basis_label, @target_label, @tech_label,
         @status, @answer, @parsed, @refs, @known_data, @custom_prompt, @provider, @model,
         @took_ms, @created_at)`,
    )
    .run({
      ...keys,
      basis_label: String(rec.basis),
      target_label: String(rec.target),
      tech_label: String(rec.transformation),
      status: rec.parsed.status,
      answer: rec.answer,
      parsed: JSON.stringify(rec.parsed),
      refs: JSON.stringify(rec.refs),
      known_data: String(rec.knownData || ""),
      custom_prompt: rec.customPrompt ? 1 : 0,
      provider: rec.provider || null,
      model: rec.model || null,
      took_ms: rec.tookMs ?? null,
      created_at: new Date().toISOString(),
    });
  return Number(info.lastInsertRowid);
}

/** Краткая запись — для подсказок «есть в базе». */
function summary(row) {
  const parsed = JSON.parse(row.parsed);
  return {
    id: row.id,
    createdAt: row.created_at,
    model: row.model,
    transformation: row.tech_label,
    basis: row.basis_label,
    target: row.target_label,
    status: row.status,
    statusLabel: parsed.statusLabel || "",
  };
}

/** Полная запись — то, что клиент кладёт в граф. */
function full(row) {
  return {
    ...summary(row),
    provider: row.provider,
    knownData: row.known_data || "",
    customPrompt: Boolean(row.custom_prompt),
    tookMs: row.took_ms,
    refs: JSON.parse(row.refs),
    ...JSON.parse(row.parsed),
    answer: row.answer,
  };
}

function get(id) {
  const row = getDb().prepare("SELECT * FROM balances WHERE id = ?").get(Number(id));
  return row ? full(row) : null;
}

/**
 * Готовые расчёты пары продуктов.
 *
 * exact — та же технология и обычный запрос (без своих данных и правки
 * промпта): его берём сразу. similar — та же пара по другой технологии или
 * со своими условиями, по одному на технологию, свежие первыми: их только
 * предлагаем.
 */
function lookup({ basis, target, transformation }) {
  const keys = keysOf({ basis, target, transformation });
  const rows = getDb()
    .prepare(
      `SELECT * FROM balances
       WHERE basis_key = ? AND target_key = ? AND status IN (${REUSABLE.map(() => "?").join(", ")})
       ORDER BY created_at DESC, id DESC`,
    )
    .all(keys.basis_key, keys.target_key, ...REUSABLE);
  const plain = (r) => !r.known_data && !r.custom_prompt;
  const exact = rows.find((r) => r.tech_key === keys.tech_key && plain(r)) ?? null;
  // Похожее — по одному на технологию: старые расчёты той же технологии, что
  // и точное совпадение, — его же прошлые версии, не другой вариант.
  const kindOf = (r) => `${r.tech_key}\u0000${plain(r) ? "" : r.id}`;
  const seen = new Set(exact ? [kindOf(exact)] : []);
  const similar = [];
  for (const r of rows) {
    const k = kindOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    similar.push(summary(r));
  }
  return { exact: exact ? summary(exact) : null, similar };
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { save, get, lookup, techKey, close, REUSABLE };
