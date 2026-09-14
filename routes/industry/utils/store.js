// routes/industry/utils/store.js
//
// Реестр российской промышленной продукции (ГИСП, ПП №719) в виде файла SQLite.
//
// Выгрузка весит порядка 150 МБ, поэтому в репозитории её нет и в память она не
// поднимается: скрипт scripts/import-gisp.js раскладывает её в data/gisp.sqlite
// с полнотекстовым индексом, а сервер только читает. База необязательна —
// без файла эндпоинт честно отвечает, что реестр не подключён.

const fs = require("fs");
const path = require("path");

const {
  buildQueryLadder,
  normalizeName,
  stemName,
  words,
} = require("./normalize");

const DEFAULT_DB_PATH = path.resolve(__dirname, "../../../data/gisp.sqlite");

/** Путь к базе. Переопределяется переменной окружения на случай общего диска. */
function dbPath() {
  return process.env.GISP_DB_PATH || DEFAULT_DB_PATH;
}

/** Сколько записей реестра тянем на один продукт. Больше в карточку не влезет. */
const MAX_ENTRIES_PER_PRODUCT = 200;

let db = null;
let openedPath = null;

/**
 * Разобранные ответы по названию продукта.
 *
 * Слой промышленных данных включают и выключают тумблером, а набор продуктов
 * графа при этом не меняется — без кэша каждое переключение заново гоняло бы
 * весь список по индексу. Сбрасывается вместе с переоткрытием базы.
 */
const cache = new Map();
const CACHE_LIMIT = 5000;

/**
 * Открыть базу, если она есть. Возвращает null, когда файла нет, — это штатная
 * ситуация: слой промышленных данных просто не работает.
 */
function getDb() {
  const file = dbPath();

  if (db && openedPath === file) return db;
  if (db) {
    db.close();
    db = null;
    openedPath = null;
    cache.clear();
  }

  if (!fs.existsSync(file)) return null;

  // Требуем модуль лениво: без него сервер обязан подниматься как прежде.
  const Database = require("better-sqlite3");
  db = new Database(file, { readonly: true, fileMustExist: true });
  openedPath = file;
  return db;
}

/** Сведения о подключённой базе — для интерфейса и диагностики. */
function status() {
  const conn = getDb();
  if (!conn) {
    return { ready: false, path: dbPath(), reason: "Файл базы ГИСП не найден" };
  }

  try {
    const meta = Object.fromEntries(
      conn
        .prepare("SELECT key, value FROM meta")
        .all()
        .map((r) => [r.key, r.value]),
    );
    const counts = conn
      .prepare(
        `SELECT COUNT(*) AS entries,
                COUNT(DISTINCT name_norm) AS products,
                COUNT(DISTINCT inn) AS producers
         FROM products`,
      )
      .get();

    return {
      ready: true,
      path: dbPath(),
      entries: counts.entries,
      products: counts.products,
      producers: counts.producers,
      /** Дата, на которую актуальна выгрузка (из meta при импорте). */
      actualAt: meta.actual_at || null,
      importedAt: meta.imported_at || null,
      source: meta.source || null,
    };
  } catch (e) {
    return { ready: false, path: dbPath(), reason: e.message };
  }
}

/** Строка реестра → вид, в котором её ждёт интерфейс. */
function toEntry(row) {
  return {
    producer: row.producer,
    inn: row.inn || null,
    region: row.region || null,
    product: row.name,
    okpd2: row.okpd2 || null,
    status: row.status,
    statusLabel: row.status_raw || (row.status === "active" ? "Действует" : "В архиве"),
    regNumber: row.reg_number || null,
    regDate: row.reg_date || null,
    // Дата, когда запись перестала действовать. В выгрузке ПП №719 колонки со
    // статусом нет, и признак «в архиве» выводится как раз отсюда — значит,
    // стоит показать и саму дату, а не только ярлык.
    endedAt: row.ended_at || null,
    url: row.url || null,
  };
}

/**
 * Найти продукт в реестре.
 *
 * Сначала пробуем точное совпадение нормализованных названий, затем спускаемся
 * по лестнице всё более мягких полнотекстовых запросов и останавливаемся на
 * первой ступени, что-то нашедшей. Уровень совпадения возвращаем вместе с
 * данными: «нашлось по одному слову» и «нашлось целиком» — разные вещи, и в
 * интерфейсе их стоит различать.
 */
function lookupProduct(rawName) {
  const conn = getDb();
  const empty = {
    found: false,
    match: null,
    entryCount: 0,
    producerCount: 0,
    regionCount: 0,
    status: null,
    okpd2: null,
    producers: [],
  };

  if (!conn) return empty;

  const normalized = normalizeName(rawName);
  if (!normalized) return empty;

  const cached = cache.get(normalized);
  if (cached) return cached;

  let rows = conn
    .prepare(
      `SELECT * FROM products WHERE name_norm = ? LIMIT ${MAX_ENTRIES_PER_PRODUCT}`,
    )
    .all(normalized);
  let match = rows.length ? "exact" : null;

  if (!rows.length) {
    const ftsStmt = conn.prepare(
      `SELECT p.* FROM products_fts f
       JOIN products p ON p.id = f.rowid
       WHERE products_fts MATCH ?
       ORDER BY rank
       LIMIT ${MAX_ENTRIES_PER_PRODUCT}`,
    );

    for (const step of buildQueryLadder(rawName)) {
      try {
        const found = ftsStmt.all(step.query);
        if (found.length) {
          rows = found;
          match = step.level;
          break;
        }
      } catch {
        // Кривой запрос к индексу — просто пробуем следующую ступень.
      }
    }
  }

  const result = rows.length
    ? { ...summarize(keepBestOverlap(rows, rawName)), found: true, match }
    : empty;

  // Кэш растёт только на новых названиях; когда упрётся в предел — начинаем
  // заново, вытеснять по одному тут нечего оптимизировать.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(normalized, result);

  return result;
}

/**
 * Оставить из найденного только самое похожее.
 *
 * Последняя ступень лестницы ищет по любому из слов, и на общем слове
 * цепляется лишнее: «Сжиженный нефтяной газ» подтягивал «Бензол нефтяной».
 * Считаем, сколько слов запроса есть в названии записи, и оставляем только
 * записи с наибольшим совпадением.
 */
function keepBestOverlap(rows, rawName) {
  const queryStems = new Set(words(stemName(rawName)));
  if (queryStems.size <= 1) return rows;

  let best = 0;
  const scored = rows.map((row) => {
    const rowStems = new Set(words(row.name_stem || ""));
    let score = 0;
    for (const s of queryStems) if (rowStems.has(s)) score += 1;
    if (score > best) best = score;
    return { row, score };
  });

  return scored.filter((s) => s.score === best).map((s) => s.row);
}

/** Свернуть строки реестра в сводку по продукту. */
function summarize(rows) {
  const byProducer = new Map();
  const regions = new Set();
  let anyActive = false;
  let okpd2 = null;

  for (const row of rows) {
    if (row.status === "active") anyActive = true;
    if (!okpd2 && row.okpd2) okpd2 = row.okpd2;
    if (row.region) regions.add(row.region);

    // Один производитель может стоять в нескольких записях реестра: считаем его
    // один раз, но показываем действующую запись, а не первую попавшуюся.
    const key = row.inn || row.producer;
    const prev = byProducer.get(key);
    if (!prev || (prev.status !== "active" && row.status === "active")) {
      byProducer.set(key, toEntry(row));
    }
  }

  const producers = [...byProducer.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return String(a.producer).localeCompare(String(b.producer), "ru");
  });

  return {
    entryCount: rows.length,
    producerCount: producers.length,
    regionCount: regions.size,
    status: anyActive ? "active" : "archived",
    okpd2,
    producers,
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  dbPath,
  getDb,
  status,
  lookupProduct,
};
