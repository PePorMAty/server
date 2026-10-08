// routes/material-balance/utils/store.js
//
// Готовые расчёты материального баланса: SQLite рядом с остальными данными
// сервера (data/material-balance.sqlite, путь — MATERIAL_BALANCE_DB).
//
// Расчёт — преобразование целиком: всё его сырьё и выбранные продукты
// (kind = 'transformation'). Название записи — «Преобразование → Продукт 1,
// Продукт 2»: продукты, для которых посчитано (title). Ищется по ключу
// «технология + набор сырья + набор продуктов». Продукты — по справочнику,
// как сохранённые веб-источники (productKey): расчёт для «ИПБ» найдётся и у
// «Кумола». Технология — по основам слов названия. Когда у преобразований
// появятся свои идентификаторы, ключом станут они.
//
// Записи прежних версий — расчёты пары «сырьё → продукт» (kind = 'pair'):
// тот же вид с одним продуктом, только считались всегда на 1 т сырья.
// Колонки basis_key и target_key — их ключ; у новых записей там опорное
// сырьё и первый продукт.
//
// Колонка direction осталась от недолгой версии с расчётами «вверх» (на 1 т
// продукта): такие строки, если успели появиться, в ответы не идут — их
// числа посчитаны на другой базис.

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
      direction     TEXT NOT NULL DEFAULT 'down',
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
  const columns = new Set(db.prepare("PRAGMA table_info(balances)").all().map((c) => c.name));
  const add = (name, def) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE balances ADD COLUMN ${name} ${def}`);
  };
  // База до направлений: все её расчёты — на 1 т сырья.
  add("direction", "TEXT NOT NULL DEFAULT 'down'");
  // База до расчётов по преобразованию целиком: все её расчёты — пары.
  add("kind", "TEXT NOT NULL DEFAULT 'pair'");
  add("inputs_key", "TEXT NOT NULL DEFAULT ''");
  add("targets_key", "TEXT NOT NULL DEFAULT ''");
  add("inputs_label", "TEXT NOT NULL DEFAULT '[]'");
  add("targets_label", "TEXT NOT NULL DEFAULT '[]'");
  add("title", "TEXT NOT NULL DEFAULT ''");
  add("basis_amount", "TEXT");
  fillPairColumns(db);
  return db;
}

/**
 * Расчёты пар из прежних версий — в новые колонки: их сырьё и продукт по
 * обозначениям (refs), название «Преобразование → Продукт», количество 1 т.
 * Так они ищутся тем же запросом, что и новые.
 */
function fillPairColumns(conn) {
  const rows = conn.prepare("SELECT id, refs, tech_label, target_label FROM balances WHERE title = ''").all();
  if (!rows.length) return;
  const update = conn.prepare(
    `UPDATE balances SET inputs_key = @inputs_key, targets_key = @targets_key,
       inputs_label = @inputs_label, targets_label = @targets_label, title = @title,
       basis_amount = @basis_amount WHERE id = @id`,
  );
  conn.transaction(() => {
    for (const row of rows) {
      let refs = [];
      try {
        refs = JSON.parse(row.refs);
      } catch {}
      const names = (roles) => refs.filter((r) => roles.includes(r.role)).map((r) => r.name);
      const inputs = names(["basis", "input"]);
      const targets = names(["target"]);
      if (!targets.length) targets.push(row.target_label);
      update.run({
        id: row.id,
        ...setKeys(inputs, targets),
        inputs_label: JSON.stringify(inputs),
        targets_label: JSON.stringify(targets),
        title: titleOf(row.tech_label, targets),
        basis_amount: JSON.stringify({ amount: 1, unit: "т", kg: 1000 }),
      });
    }
  })();
}

/** «Окислительный аммонолиз пропилена → Акрилонитрил, Синильная кислота». */
function titleOf(transformation, targets) {
  return `${String(transformation).trim()} → ${targets.map((t) => String(t).trim()).join(", ")}`;
}

/** Ключ набора продуктов: порядок и повторы не важны. */
function setKey(names) {
  return JSON.stringify([...new Set(names.map((n) => productKey(n)))].sort());
}

function setKeys(inputs, targets) {
  return { inputs_key: setKey(inputs), targets_key: setKey(targets) };
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

/**
 * Сохранить расчёт; возвращает его номер. rec.inputs — всё сырьё (первым —
 * опорное), rec.targets — продукты, для которых посчитано, rec.basisAmount —
 * количество опорного сырья ({ amount, unit, kg }).
 */
function save(rec) {
  const inputs = rec.inputs.map(String);
  const targets = rec.targets.map(String);
  const keys = keysOf({
    basis: inputs[0],
    target: targets[0],
    transformation: rec.transformation,
  });
  const info = getDb()
    .prepare(
      `INSERT INTO balances (basis_key, target_key, tech_key, basis_label, target_label,
         tech_label, direction, kind, inputs_key, targets_key, inputs_label, targets_label,
         title, basis_amount, status, answer, parsed, refs, known_data, custom_prompt,
         provider, model, took_ms, created_at)
       VALUES (@basis_key, @target_key, @tech_key, @basis_label, @target_label, @tech_label,
         @direction, @kind, @inputs_key, @targets_key, @inputs_label, @targets_label,
         @title, @basis_amount, @status, @answer, @parsed, @refs, @known_data, @custom_prompt,
         @provider, @model, @took_ms, @created_at)`,
    )
    .run({
      ...keys,
      ...setKeys(inputs, targets),
      basis_label: inputs[0],
      target_label: targets[0],
      tech_label: String(rec.transformation),
      direction: "down",
      kind: "transformation",
      inputs_label: JSON.stringify(inputs),
      targets_label: JSON.stringify(targets),
      title: titleOf(rec.transformation, targets),
      basis_amount: JSON.stringify(rec.basisAmount),
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

const list = (json) => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * Краткая запись — для подсказок «есть в базе». basis и target — опорное
 * сырьё и первый продукт: их читает клиент прежней версии.
 */
function summary(row) {
  const parsed = JSON.parse(row.parsed);
  let basisAmount = null;
  try {
    basisAmount = JSON.parse(row.basis_amount || "null");
  } catch {}
  return {
    id: row.id,
    createdAt: row.created_at,
    model: row.model,
    kind: row.kind,
    title: row.title || titleOf(row.tech_label, [row.target_label]),
    transformation: row.tech_label,
    inputs: list(row.inputs_label),
    targets: list(row.targets_label),
    basisAmount,
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

const plain = (r) => !r.known_data && !r.custom_prompt;
const REUSABLE_SQL = `direction = 'down' AND status IN (${REUSABLE.map(() => "?").join(", ")})`;

/**
 * Готовые расчёты преобразования.
 *
 * exact — расчёт по преобразованию целиком (не прежней пары) той же
 * технологии, с тем же сырьём и теми же продуктами, обычный запрос (без
 * своих данных и правки промпта): его берём сразу. Количество сырья не в
 * ключе: массы пропорциональны, клиент пересчитывает.
 *
 * similar — расчёты, где посчитаны все нужные продукты (и, может быть,
 * ещё какие-то), хотя бы с одним общим сырьём: по другой технологии, с
 * другим сырьём, со своими условиями или прежние расчёты пар. По одному на
 * вариант, свежие первыми; их только предлагаем.
 */
function lookup({ transformation, inputs, targets }) {
  const tech = techKey(transformation);
  const ins = new Set(inputs.map((n) => productKey(n)));
  const want = [...new Set(targets.map((n) => productKey(n)))];
  const keys = setKeys(inputs, targets);
  const rows = getDb()
    .prepare(
      `SELECT * FROM balances WHERE ${REUSABLE_SQL} ORDER BY created_at DESC, id DESC`,
    )
    .all(...REUSABLE);
  const candidates = rows.filter((r) => {
    const has = new Set(list(r.targets_key));
    return want.every((k) => has.has(k)) && list(r.inputs_key).some((k) => ins.has(k));
  });
  const exact =
    candidates.find(
      (r) =>
        r.kind === "transformation" &&
        r.tech_key === tech &&
        r.inputs_key === keys.inputs_key &&
        r.targets_key === keys.targets_key &&
        plain(r),
    ) ?? null;
  // Похожее — по одному на вариант: старые расчёты того же варианта, что и
  // точное совпадение, — его же прошлые версии.
  const kindOf = (r) =>
    [r.kind, r.tech_key, r.inputs_key, r.targets_key, plain(r) ? "" : r.id].join("\u0000");
  const seen = new Set(exact ? [kindOf(exact)] : []);
  const similar = [];
  for (const r of candidates) {
    const k = kindOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    similar.push(summary(r));
    if (similar.length >= 10) break;
  }
  return { exact: exact ? summary(exact) : null, similar };
}

/**
 * Готовые расчёты пары «сырьё → продукт» — запрос клиента прежней версии.
 * Пара — это и расчёт преобразования с одним продуктом и тем же опорным
 * сырьём.
 */
function lookupPair({ basis, target, transformation }) {
  const keys = keysOf({ basis, target, transformation });
  const targetsKey = setKey([target]);
  const rows = getDb()
    .prepare(
      `SELECT * FROM balances
       WHERE basis_key = ? AND targets_key = ? AND ${REUSABLE_SQL}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(keys.basis_key, targetsKey, ...REUSABLE);
  const exact = rows.find((r) => r.tech_key === keys.tech_key && plain(r)) ?? null;
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

module.exports = { save, get, lookup, lookupPair, techKey, titleOf, close, REUSABLE };
