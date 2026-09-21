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
const { regionByInn } = require("./regions");
const { shortenCompany } = require("./company");
const { okpd2Name, tnvedName } = require("./classifiers");
const { identify, spellingsOf } = require("./synonyms");

const DEFAULT_DB_PATH = path.resolve(__dirname, "../../../data/gisp.sqlite");

/** Путь к базе. Переопределяется переменной окружения на случай общего диска. */
function dbPath() {
  return process.env.GISP_DB_PATH || DEFAULT_DB_PATH;
}

/** Сколько записей реестра тянем на один продукт. Больше в карточку не влезет. */
const MAX_ENTRIES_PER_PRODUCT = 200;

/**
 * Ступени лестницы, которым можно доверять чужое написание вещества.
 *
 * Требуют совпадения всех значимых слов. Мягкие ступени («любое из слов»,
 * «по приставке») на синонимах дают ложные попадания и потому применяются
 * только к тому названию, которое спросили.
 */
const STRICT_LEVELS = new Set(["all-words", "core-words"]);

/** Ступени, где совпасть могло одно-единственное слово из запроса. */
const LOOSE_LEVELS = new Set(["partial", "prefix"]);

/**
 * Частота слова в реестре нужна теперь только для объяснения, а не для
 * решения: по ней видно, за что зацепилось мягкое совпадение. Порогом она
 * была недолго и работы не сделала — верные и ложные совпадения по редкости
 * перекрываются (см. комментарий в lookupProduct).
 */

let db = null;
let openedPath = null;
// Почему базу не удалось открыть — показываем в интерфейсе вместо пустоты.
let openError = null;

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
    // Частоты слов считаны по старой базе — к новой они отношения не имеют.
    dfCache.clear();
  }

  openError = null;
  if (!fs.existsSync(file)) return null;

  // Требуем модуль лениво: без него сервер обязан подниматься как прежде.
  const Database = require("better-sqlite3");
  try {
    const conn = new Database(file, { readonly: true, fileMustExist: true });
    // Открыть мало: недописанная база от прерванного импорта открывается, а
    // падает уже на первом запросе — рядом с ней лежит журнал, и SQLite хочет
    // его откатить, чего в режиме чтения сделать не может. Поэтому пробуем
    // прямо здесь, пока ошибку ещё есть куда деть.
    conn.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    db = conn;
    openedPath = file;
    return db;
  } catch (e) {
    // Файл есть, а открыть нельзя: чаще всего это недописанная база от
    // прерванного импорта. Слой промышленных данных должен в таком случае
    // просто не работать — а не ронять каждый запрос к продуктам.
    db = null;
    openedPath = null;
    openError = e.message;
    return null;
  }
}

/** Сведения о подключённой базе — для интерфейса и диагностики. */
function status() {
  const conn = getDb();
  if (!conn) {
    return {
      ready: false,
      path: dbPath(),
      reason: openError
        ? `Файл базы ГИСП не читается: ${openError}. Похоже на недописанную базу — повторите импорт.`
        : "Файл базы ГИСП не найден",
    };
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
    // Показываем сокращённое название, полное отдаём рядом: в таблице
    // «ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТЕХНОКЕРАМИКА"» занимает три
    // строки, но в подсказке оно нужно как есть — это официальное имя.
    producer: shortenCompany(row.producer),
    producerFull: row.producer,
    inn: row.inn || null,
    // Регион берём из выгрузки, а если там пусто — выводим из ИНН. В реестре
    // ПП №719 адрес не заполнен ни у одной записи, так что на деле работает
    // второй путь; признак regionFromInn говорит интерфейсу, что это место
    // учёта организации, а не обязательно место производства.
    region: row.region || regionByInn(row.inn),
    regionFromInn: !row.region && Boolean(regionByInn(row.inn)),
    product: row.name,
    // Код и его расшифровка рядом: «20.16.10.110» сам по себе ничего не
    // говорит, а название классификатора объясняет, к чему запись отнесена.
    okpd2: row.okpd2 || null,
    okpd2Name: okpd2Name(row.okpd2),
    tnved: row.tnved || null,
    tnvedName: tnvedName(row.tnved)?.name ?? null,
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
 *
 * Ищем не только по спрошенному названию, но и по всем известным написаниям
 * вещества: реестр заполняют люди, и запись стоит под тем названием, какое было
 * у заявителя. По «ПЭНД» не находится ничего, по «полиэтилену низкого давления»
 * — находится, а вещество одно.
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

  const spellings = spellingsOf(rawName);
  const known = identify(rawName);

  const exactStmt = conn.prepare(
    `SELECT * FROM products WHERE name_norm = ? LIMIT ${MAX_ENTRIES_PER_PRODUCT}`,
  );
  const ftsStmt = conn.prepare(
    `SELECT p.* FROM products_fts f
     JOIN products p ON p.id = f.rowid
     WHERE products_fts MATCH ?
     ORDER BY rank
     LIMIT ${MAX_ENTRIES_PER_PRODUCT}`,
  );

  let rows = [];
  let match = null;
  // Написание, которым нашли: по нему же считается отбор. Искали «ПЭНД», нашли
  // по «полиэтилену низкого давления» — сверять найденное надо со вторым,
  // иначе совпадений слов не будет ни одного и отбор выбросит всё.
  let matchedAs = rawName;

  // Точное совпадение по любому из написаний — самое надёжное, что есть.
  for (const spelling of spellings) {
    const found = exactStmt.all(normalizeName(spelling));
    if (found.length) {
      rows = found;
      match = "exact";
      matchedAs = spelling;
      break;
    }
  }

  // Лестницу проходим по написаниям целиком: сперва все точные (выше), потом
  // все мягкие. Иначе «похоже» по первому написанию побеждало бы «точно» по
  // второму.
  if (!rows.length) {
    outer: for (const spelling of spellings) {
      const own = normalizeName(spelling) === normalized;
      for (const step of buildQueryLadder(spelling)) {
        // Мягкие ступени ищут по любому из слов, и на синонимах это даёт
        // ложные попадания: «Незамерзайка» через «стеклоомывающую жидкость»
        // цеплялась за «Жидкость тормозная» по общему слову. Нечёткость
        // допустима один раз, а не дважды подряд — по чужим написаниям идём
        // только строгими ступенями.
        if (!own && !STRICT_LEVELS.has(step.level)) continue;
        try {
          const found = ftsStmt.all(step.query);
          if (found.length) {
            rows = found;
            match = step.level;
            matchedAs = spelling;
            break outer;
          }
        } catch {
          // Кривой запрос к индексу — просто пробуем следующую ступень.
        }
      }
    }
  }

  // Отбор может отклонить всё найденное: полнотекстовый индекс ищет по словам
  // и не знает, что слово было частью сложного прилагательного.
  const picked = rows.length
    ? keepBestOverlap(rows, matchedAs)
    : { rows: [], shared: [] };

  const kept = picked.rows;

  // Совпадение по части слов подтверждением не считается.
  //
  // Мягкая ступень ищет по ЛЮБОМУ из слов запроса, и на живом реестре это
  // почти всегда мусор: «Синтез-газ» приводил к «Заглушке ПЭ 100 — ГАЗ»,
  // «Элементарная сера» — к «Краске художественной серой», «Адипиновая
  // кислота» — к «Молочной кислоте» и ещё двум сотням записей. На 662
  // продуктах живых графов так «находилось» 327 из 455.
  //
  // Отсеять это порогом редкости слова не вышло, и дело не в подборе числа:
  // верные и ложные совпадения по редкости ПЕРЕКРЫВАЮТСЯ. «хладон» — 72
  // записи и попадание верное, «легк» — 61 и мусор, «кумол» — 2 и верное,
  // «остаток» — 1 и мусор. Одной границы между ними не существует.
  //
  // Поэтому мягкие ступени больше не дают «найдено». Записи не выбрасываем —
  // возвращаем отдельным полем weak, чтобы разбор был виден и в аудите, и
  // потом в карточке отдельной строкой «возможно». Но число подтверждённых по
  // реестру должно означать «совпали все значимые слова», иначе узлу графа
  // приписываются чужие производители, чужой ОКПД2 и чужой регион.
  const loose = LOOSE_LEVELS.has(match);

  let result;
  if (!kept.length) {
    result = { ...empty, canon: known?.canon ?? null };
  } else if (loose) {
    // Самое редкое из совпавших слов оставляем в разборе: по нему сразу
    // видно, за что зацепились — за название вещества или за «кислоту».
    const freqs = picked.shared
      .map((s) => ({ stem: s, df: docFreq(conn, s) }))
      .sort((a, b) => a.df - b.df);
    result = {
      ...empty,
      canon: known?.canon ?? null,
      weak: {
        match,
        entryCount: kept.length,
        sharedWords: picked.shared,
        rarestWord: freqs[0]?.stem ?? null,
        rarestFreq: freqs[0]?.df ?? null,
        matchedAs: normalizeName(matchedAs) === normalized ? null : matchedAs,
        // Запись в порядке выдачи индекса, а не по алфавиту: показывать надо
        // ту, за которую зацепились.
        sample: kept[0]?.name ?? null,
      },
    };
  } else {
    result = {
      ...summarize(kept),
      found: true,
      match,
      sharedWords: picked.shared,
      // Нашли под другим названием — скажем, под каким: иначе в карточке
      // непонятно, почему на «ПЭНД» приехали записи про полиэтилен.
      matchedAs: normalizeName(matchedAs) === normalized ? null : matchedAs,
      canon: known?.canon ?? null,
    };
  }

  // Кэш растёт только на новых названиях; когда упрётся в предел — начинаем
  // заново, вытеснять по одному тут нечего оптимизировать.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(normalized, result);

  return result;
}

/**
 * Сложное прилагательное через дефис: «изобутилен-изопреновый».
 *
 * Такое слово называет не вещество, а его происхождение, и первая половина
 * отдельным веществом не является. Различаем по второй половине: если она
 * прилагательное — перед нами сложное определение, а если существительное
 * («н-бутан», «орто-ксилол»), то это приставка номенклатуры, и слово целое.
 */
const COMPOUND_MODIFIER =
  /([а-яё]{3,})-([а-яё]{3,}(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ых|их|ую|юю))(?![а-яё])/gi;

/**
 * Убрать из названия первые половины сложных прилагательных.
 *
 * «Бутилкаучук (изобутилен-изопреновый каучук)» — это каучук. Завод продаёт
 * каучук, а не изобутилен, и подставлять его в ответ на «Изобутилен» нельзя.
 * Сополимерные каучуки названы именно так, поэтому случай не единичный:
 * бутадиен-стирольный, этилен-пропиленовый и далее по списку.
 */
function dropCompoundModifiers(name) {
  return String(name ?? "").replace(COMPOUND_MODIFIER, " $2 ");
}

/**
 * В скольких записях реестра встречается слово.
 *
 * Считается по полнотекстовому индексу, один раз на слово и на всё время
 * работы: слова запросов повторяются от продукта к продукту, а база между
 * переоткрытиями не меняется.
 */
const dfCache = new Map();
function docFreq(conn, stem) {
  const cached = dfCache.get(stem);
  if (cached !== undefined) return cached;
  let n = 0;
  try {
    n = conn
      .prepare("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH ?")
      .get(`"${stem.replace(/"/g, '""')}"`).n;
  } catch {
    // Слово, которое индекс не принимает как запрос. Считаем редким: пусть
    // решает совпадение, а не сбой разбора.
    n = 0;
  }
  dfCache.set(stem, n);
  return n;
}

/**
 * Оставить из найденного только самое похожее.
 *
 * Последняя ступень лестницы ищет по любому из слов, и на общем слове
 * цепляется лишнее: «Сжиженный нефтяной газ» подтягивал «Бензол нефтяной».
 * Считаем, сколько слов запроса есть в названии записи, и оставляем только
 * записи с наибольшим совпадением. Не совпало ни одного — значит, запись
 * нашлась по слову внутри сложного прилагательного, и это не наш продукт.
 *
 * Возвращает вместе с записями слова, по которым они совпали: на мягких
 * ступенях по ним решается, значит ли совпадение хоть что-нибудь.
 */
function keepBestOverlap(rows, rawName) {
  const queryStems = new Set(words(stemName(rawName)));
  if (!queryStems.size) return { rows, shared: [] };

  let best = 0;
  const scored = rows.map((row) => {
    // Усечённые слова считаем из названия на месте: колонки name_stem в базе
    // нет — она нужна была только полнотекстовому индексу и место занимала
    // впустую. Строк тут не больше двух сотен, и ответ кладётся в кэш.
    const rowStems = new Set(words(stemName(dropCompoundModifiers(row.name || ""))));
    const shared = [];
    for (const s of queryStems) if (rowStems.has(s)) shared.push(s);
    if (shared.length > best) best = shared.length;
    return { row, shared };
  });

  if (!best) return { rows: [], shared: [] };
  const kept = scored.filter((s) => s.shared.length === best);
  return {
    rows: kept.map((s) => s.row),
    // Слова, по которым совпало: объединение по оставшимся записям.
    shared: [...new Set(kept.flatMap((s) => s.shared))],
  };
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
    // Считаем по тому же региону, что показываем: в выгрузке адреса нет, и
    // регион выводится из ИНН — иначе счётчик регионов всегда был бы нулём.
    const region = row.region || regionByInn(row.inn);
    if (region) regions.add(region);

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
    okpd2Name: okpd2Name(okpd2),
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
