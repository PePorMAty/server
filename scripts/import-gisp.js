#!/usr/bin/env node
//
// Импорт выгрузки реестра российской промышленной продукции (ГИСП, ПП №719)
// в файл SQLite, по которому ищет сервер.
//
//   node scripts/import-gisp.js <файл> [ключи]
//
//   --out <путь>        куда писать базу (по умолчанию data/gisp.sqlite)
//   --actual-at <дата>  на какую дату актуальна выгрузка (пишем в мету и
//                       показываем в карточке продукта)
//   --map поле=Колонка  задать соответствие вручную, через запятую
//   --limit <N>         обработать только первые N строк
//   --only-active       не брать записи, прекратившие действие: реестр хранит
//                       и старые, а для счётчика производителей нужны те, кто
//                       выпускает продукт сейчас. Заметно уменьшает базу
//   --stats             прочитать файл целиком и сказать, сколько в нём строк
//                       и сколько места займёт база. Ничего не записывает —
//                       можно запускать на переполненном диске
//   --dry-run           ничего не писать: показать, как разобрались колонки,
//                       и первые строки
//
// Поддерживаются XLSX, CSV, TSV, JSON (массив) и JSONL. Книга Excel читается
// потоком, без временных файлов: распакованный лист весит в восемь раз больше
// самой книги и не помещается ни в память, ни на диск небольшого сервера.
//
// Первым делом прогоните с --dry-run: скрипт покажет найденные заголовки и то,
// как он их понял. Если поле не опознано — добавьте его в ALIASES ниже или
// передайте --map.

const fs = require("fs");
const path = require("path");

const { detectDelimiter, peek, forEachRow } = require("./lib/csv-stream");
const { forEachXlsxRow } = require("./lib/xlsx-stream");
const { normalizeName, stemName } = require("../routes/industry/utils/normalize");
const { DEFAULT_DB_PATH } = require("../routes/industry/utils/store");

/* ───────────────────────── соответствие колонок ───────────────────────── */

/**
 * Как называются нужные поля в выгрузках. Сравнение идёт по нормализованному
 * заголовку и по вхождению, поэтому «Наименование продукции (товара)» тоже
 * опознается. Список наращиваем по мере встречи новых выгрузок.
 */
const ALIASES = {
  name: [
    "наименование продукции",
    "наименование товара",
    "наименование продукта",
    "продукция",
    "наименование",
  ],
  producer: [
    "наименование производителя",
    "производитель",
    "предприятие",
    "наименование предприятия",
    "изготовитель",
    "наименование организации",
    "организация",
    "заявитель",
    "наименование юридического лица",
  ],
  inn: ["инн"],
  // Отдельной колонки региона в выгрузке ПП №719 нет: субъект приходится брать
  // из адреса производителя. Точные названия идут первыми, чтобы совпадение
  // считалось надёжным, а не догадкой по слову «адрес».
  region: [
    "регион",
    "субъект",
    "субъект рф",
    "фактический адрес производителя",
    "адрес производителя",
    "юридический адрес",
    "местонахождение",
    "адрес",
  ],
  // Запасной адрес. В выгрузке их два, и «фактический адрес производителя»
  // заполнен не всегда: у части записей место указано только адресом
  // производственных помещений. Берём его, когда основной пуст.
  region_alt: [
    "адрес производственных помещений",
    "адрес производства",
    "адрес места производства",
  ],
  okpd2: ["окпд2", "окпд 2", "код окпд2", "код окпд"],
  tnved: ["тнвэд", "тн вэд", "код тн вэд"],
  reg_number: [
    "номер реестровой записи",
    "реестровый номер",
    "номер записи",
    "реестровая запись",
    "номер заключения",
  ],
  reg_date: [
    "дата реестровой записи",
    "дата внесения в реестр",
    "дата записи",
    "дата включения",
    "дата",
  ],
  valid_until: ["срок действия", "действует до", "дата окончания"],
  // Колонки со статусом в выгрузке ПП №719 тоже нет. Зато есть дата, когда
  // запись прекратила действовать: заполнена — значит, запись уже не работает.
  ended_at: [
    "фактическая дата прекращения действия реестровой записи",
    "дата прекращения действия",
    "дата прекращения",
  ],
  status_raw: ["статус", "состояние", "статус записи"],
  url: ["ссылка", "url", "адрес записи"],
};

const REQUIRED = ["name", "producer"];

/**
 * Опознать колонки выгрузки.
 *
 * Возвращает { поле: заголовок } и отдельно набор полей, опознанных только по
 * вхождению слова. Такое совпадение — догадка: в выгрузке реестра «Фактический
 * адрес производителя» ничем не хуже подходит под слово «адрес», чем настоящая
 * колонка региона. Помечаем их, чтобы в сухом прогоне было видно, чему верить.
 */
function detectMapping(header) {
  const normalized = header.map((h) => ({ raw: h, norm: normalizeName(h) }));
  const mapping = {};
  const loose = new Set();
  const taken = new Set();

  for (const [field, all] of Object.entries(ALIASES)) {
    // Пустой псевдоним содержится в любом заголовке, поэтому одно поле забрало
    // бы первую попавшуюся колонку, второе — вторую, и так по порядку. Сам по
    // себе список такой не бывает — но станет, если файл скрипта испортить при
    // переносе: кириллица превратится в мусор, и от названий ничего не
    // останется. Молча сопоставлять колонки после этого нельзя.
    const aliases = all.filter((a) => a.length >= 3);
    if (aliases.length !== all.length) {
      throw new Error(
        "Таблица названий колонок повреждена — в ней пустые значения.\n" +
          "Скорее всего, файл scripts/import-gisp.js перенесли на сервер в\n" +
          "текстовом режиме и кириллица в нём испорчена. Перенесите заново в\n" +
          "двоичном (binary) режиме или заберите через git.",
      );
    }
    // Сначала точное совпадение по всем полям сразу было бы правильнее, но
    // порядок полей в ALIASES и так идёт от самых узких названий к широким.
    let hit = normalized.find(
      (h) => !taken.has(h.raw) && h.norm && aliases.includes(h.norm),
    );

    if (!hit) {
      hit = normalized.find(
        (h) =>
          !taken.has(h.raw) &&
          // Пустой заголовок содержится в любом псевдониме, а короткий —
          // в слишком многих. Без этого условия первое же поле забирало бы
          // себе безымянную колонку.
          h.norm.length >= 4 &&
          aliases.some(
            (a) => h.norm.includes(a) || (a.includes(h.norm) && h.norm.length >= 4),
          ),
      );
      if (hit) loose.add(field);
    }

    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  return { mapping, loose };
}

/**
 * «Действует» / «В архиве» → устойчивый признак.
 *
 * Колонки со статусом в выгрузке может не быть вовсе — в реестре ПП №719 её
 * нет. Тогда смотрим на дату прекращения действия записи: заполнена — запись
 * уже не работает. Признак важен не только для показа: по нему из нескольких
 * записей одного производителя выбирается действующая.
 */
function normalizeStatus(raw, endedAt) {
  const s = normalizeName(raw);
  if (!s) return String(endedAt ?? "").trim() ? "archived" : "active";
  if (/архив|истек|аннулир|прекращ|недейств|отозв/.test(s)) return "archived";
  return "active";
}

// Города федерального значения субъектами не выглядят: у них нет слова
// «область» или «край», по которому субъект узнаётся в адресе.
const FEDERAL_CITIES = ["москва", "санкт петербург", "севастополь", "байконур"];

// Сравниваем по целым словам, а не выражением с \b: в JavaScript эта граница
// считается по латинице, и «\bкрай\b» с кириллицей просто никогда не совпадёт.
const SUBJECT_WORDS = new Set([
  "республика", "республике", "респ",
  "край", "крае",
  "область", "обл", "области",
  "округ", "округе", "ао",
  "автономная", "автономный", "автономного",
]);

/**
 * Субъект РФ из адреса производителя.
 *
 * Отдельной колонки региона в выгрузке ПП №719 нет — есть только полный адрес
 * вида «453256, Республика Башкортостан, г. Салават, ул. Молодогвардейцев, 30».
 * В карточке продукта нужен субъект, а не улица с индексом.
 *
 * Если разобрать адрес не вышло, возвращаем его целиком: показать лишнее лучше,
 * чем молча потерять единственное указание на место.
 */
function extractRegion(address) {
  const raw = String(address ?? "").trim();
  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    // Почтовый индекс и страна субъект не называют.
    .filter((p) => !/^\d{6}$/.test(p) && !/^росси/i.test(normalizeName(p)));

  const hit = parts.find((p) => {
    const norm = normalizeName(p);
    return (
      norm.split(" ").some((w) => SUBJECT_WORDS.has(w)) ||
      FEDERAL_CITIES.some((c) => norm === c || norm === `г ${c}`)
    );
  });

  return hit ?? raw;
}

/**
 * ИНН в выгрузках приходит и числом, и с пробелами.
 *
 * У ИНН ровно 10 цифр (организация) или 12 (ИП), и он вполне может начинаться
 * с нуля: Башкортостан — 02, Бурятия — 03. Excel хранит такую ячейку числом и
 * ведущий ноль теряет, поэтому 0266010001 приезжает как 266010001. Возвращаем
 * недостающий ноль, если длина отличается от нормы ровно на единицу: по ИНН мы
 * склеиваем производителей между собой, и обрезанный номер разводит одну
 * компанию на две.
 */
function cleanInn(raw) {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 9 || digits.length === 11) return digits.padStart(digits.length + 1, "0");
  return digits;
}

/* ───────────────────────────── чтение файла ───────────────────────────── */

/** Прочитать JSON или JSONL целиком (такие выгрузки обычно заметно меньше). */
function readJsonRows(file) {
  // U+FEFF — метка кодировки в начале файла. Пишем её escape-последовательностью,
  // а не самим символом: символ невидим, и любой инструмент, который тронет
  // кодировку файла, молча превратит его в вопросительный знак — регулярное
  // выражение станет /^?/, и скрипт перестанет разбираться целиком.
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const trimmed = text.trimStart();

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("В JSON ожидался массив строк");
    return parsed;
  }

  // JSONL: по объекту на строку.
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/* ────────────────────────────── база ────────────────────────────── */

function createDb(out) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) fs.unlinkSync(out);

  const db = new Database(out);
  // Импорт одноразовый и последовательный: отключаем гарантии долговечности
  // ради скорости — при сбое файл просто собирается заново.
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");

  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE products (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      name_norm   TEXT NOT NULL,
      okpd2       TEXT,
      tnved       TEXT,
      producer    TEXT NOT NULL,
      inn         TEXT,
      region      TEXT,
      reg_number  TEXT,
      reg_date    TEXT,
      valid_until TEXT,
      ended_at    TEXT,
      status      TEXT NOT NULL,
      status_raw  TEXT,
      url         TEXT
    );

    -- Поиск по точному названию идёт мимо полнотекстового индекса.
    CREATE INDEX idx_products_name_norm ON products(name_norm);

    -- В индексе лежат усечённые слова: иначе «бутаны» из графа не находили
    -- «бутан технический» из реестра.
    -- content='' — индекс без копии текста: из него нужен только rowid,
    -- сами строки берём из products. На выгрузке в сотни тысяч записей это
    -- заметная разница в размере файла.
    CREATE VIRTUAL TABLE products_fts
      USING fts5(name_stem, content='', tokenize='unicode61 remove_diacritics 2');
  `);

  return db;
}

/* ────────────────────────────── запуск ────────────────────────────── */

function parseArgs(argv) {
  const args = {
    file: null,
    out: DEFAULT_DB_PATH,
    dryRun: false,
    stats: false,
    onlyActive: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--only-active") args.onlyActive = true;
    else if (a === "--stats") args.stats = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--actual-at") args.actualAt = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]) || 0;
    else if (a === "--map") args.map = argv[++i];
    else if (!a.startsWith("--") && !args.file) args.file = a;
  }
  return args;
}

/** Разобрать --map. Возвращает поля, заданные вручную: им догадки не нужны. */
function applyManualMap(mapping, spec) {
  const set = new Set();
  for (const pair of String(spec).split(",")) {
    const [field, ...rest] = pair.split("=");
    const column = rest.join("=").trim();
    if (field && column) {
      mapping[field.trim()] = column;
      set.add(field.trim());
    }
  }
  return set;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error(
      "Укажите файл выгрузки:\n" +
        "  node scripts/import-gisp.js <файл> [--dry-run] [--out путь]\n" +
        "        [--actual-at ГГГГ-ММ-ДД] [--map поле=Колонка,...] [--limit N]",
    );
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`Файл не найден: ${args.file}`);
    process.exit(1);
  }

  const ext = path.extname(args.file).toLowerCase();
  if (ext === ".xls") {
    console.error(
      "Старый формат .xls скрипт не читает. Сохраните файл как .xlsx или\n" +
        "как CSV (UTF-8).",
    );
    process.exit(1);
  }

  const isXlsx = ext === ".xlsx";
  const isJson = ext === ".json" || ext === ".jsonl" || ext === ".ndjson";

  /* ── заголовки и соответствие колонок ── */

  let header;
  let delimiter = ";";
  let jsonRows = null;

  if (isXlsx) {
    header = null; // заголовок придёт с первой непустой строкой листа
  } else if (isJson) {
    jsonRows = readJsonRows(args.file);
    header = Object.keys(jsonRows[0] ?? {});
  } else {
    const sample = await peek(args.file);
    delimiter = detectDelimiter(sample);
    header = null; // заполнится на первой строке
  }

  const finish = (mapping, rowsSeen, db, stats) => {
    if (args.stats) {
      // Размер базы примерно в полтора раза больше объёма текста в ней:
      // остальное — служебные байты строк, индекс точных названий и
      // полнотекстовый индекс. Множитель снят с готовых баз — 1,41 и 1,40 на
      // двух разных. Оценка нужна, чтобы решить вопрос «влезет ли», не записав
      // на диск ни байта.
      const mb = (n) => (n / 1048576).toFixed(0);
      const archived = tally.rows - tally.active;

      console.log("\nЧто в файле:");
      console.log(`  строк реестра:        ${tally.rows}`);
      console.log(`  из них действующих:   ${tally.active}`);
      console.log(`  прекращённых:         ${archived}` +
        (tally.rows ? `  (${Math.round((archived * 100) / tally.rows)}%)` : ""));
      console.log(`  уникальных продуктов: ${tally.names.size}`);

      // Поле, пустое у большинства строк, обычно значит не «данных нет», а
      // «взяли не ту колонку»: в выгрузке одно и то же сведение бывает
      // разложено по двум, и заполнена вторая.
      const sparse = Object.entries(tally.empty)
        .filter(([, n]) => n > tally.rows / 2)
        .sort((a, b) => b[1] - a[1]);

      if (sparse.length) {
        console.log("\nПоля, пустые больше чем у половины строк:");
        for (const [field, n] of sparse) {
          console.log(
            `  ${field.padEnd(12)} пусто у ${n} из ${tally.rows}` +
              ` (${Math.round((n * 100) / tally.rows)}%)`,
          );
        }
      }

      console.log("\nСколько займёт база:");
      console.log(`  со всеми записями:    ~${mb(tally.bytes * 1.41)} МБ`);
      if (archived) {
        const activeShare = tally.rows ? tally.active / tally.rows : 1;
        console.log(`  только действующие:   ~${mb(tally.bytes * 1.41 * activeShare)} МБ   (ключ --only-active)`);
      }
      console.log(
        "\nВ конце импорт пробует сжать базу — на это нужно столько же места\n" +
          "сверху. Места не хватит — импорт не упадёт, база просто останется\n" +
          "несжатой.",
      );
      return;
    }

    if (args.dryRun) {
      console.log("\nЭто сухой прогон: база не записана.");
      console.log("Если соответствие колонок верное — повторите без --dry-run.");
      return;
    }

    db.exec("COMMIT");
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      "imported_at",
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      "source",
      path.basename(args.file),
    );
    if (args.actualAt) {
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
        "actual_at",
        args.actualAt,
      );
    }

    // Сжатие переписывает базу целиком во временный файл, то есть на время
    // требует места вдвое больше её размера. Если места нет — не беда: база уже
    // собрана и работает, просто занимает больше, чем могла бы.
    try {
      db.exec("VACUUM");
    } catch (e) {
      if (e.code === "SQLITE_FULL" || /disk|space|ENOSPC/i.test(e.message)) {
        console.log("  (не хватило места на сжатие — база готова, но не уплотнена)");
      } else {
        throw e;
      }
    }

    const counts = db
      .prepare(
        `SELECT COUNT(*) entries, COUNT(DISTINCT name_norm) products,
                COUNT(DISTINCT inn) producers FROM products`,
      )
      .get();
    db.close();

    const size = (fs.statSync(args.out).size / 1024 / 1024).toFixed(1);
    console.log(
      `\nГотово: ${args.out} (${size} МБ)\n` +
        `  строк реестра: ${counts.entries}\n` +
        `  уникальных продуктов: ${counts.products}\n` +
        `  производителей (по ИНН): ${counts.producers}\n` +
        `  пропущено строк без названия или производителя: ${stats.skipped}` +
        (stats.skippedArchived
          ? `\n  пропущено прекращённых записей: ${stats.skippedArchived}`
          : ""),
    );
  };

  let mapping = null;
  let db = null;
  let insert = null;
  let ftsInsert = null;
  const stats = { skipped: 0, skippedArchived: 0, written: 0 };
  const writing = !args.dryRun && !args.stats;

  // Импорт долгий, и его вполне могут прервать с клавиатуры. Недописанная база
  // остаётся на диске, но открыть её нельзя: сервер на такой файл отвечал бы
  // ошибкой на каждый запрос к продуктам. Убираем за собой сами.
  let done = false;
  const cleanup = (signal) => {
    if (done || !writing) process.exit(130);
    done = true;
    try {
      if (db) db.close();
    } catch {
      // Соединение уже нерабочее — файл всё равно удаляем.
    }
    try {
      if (fs.existsSync(args.out)) fs.unlinkSync(args.out);
      console.log(`\n\nИмпорт прерван (${signal}). Недописанная база удалена.`);
    } catch (e) {
      console.error(`\n\nИмпорт прерван. Удалите ${args.out} вручную: ${e.message}`);
    }
    process.exit(130);
  };
  process.on("SIGINT", () => cleanup("Ctrl+C"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  const tally = { rows: 0, active: 0, bytes: 0, names: new Set(), empty: {} };
  const preview = [];

  const setup = (headerRow) => {
    header = headerRow;
    const detected = detectMapping(header);
    mapping = detected.mapping;
    const loose = detected.loose;
    if (args.map) {
      for (const field of applyManualMap(mapping, args.map)) loose.delete(field);
    }

    // Сначала — все колонки файла, как они названы. Без этого списка, когда
    // сопоставление уехало, не из чего составить --map: выгрузки бывают на
    // три десятка колонок, и глазами в файл лезть неоткуда.
    const byColumn = new Map();
    for (const [field, col] of Object.entries(mapping)) byColumn.set(col, field);

    console.log(`Колонок в файле: ${header.length}`);
    console.log("\nКолонки и то, чем они признаны:");
    header.forEach((col, i) => {
      const field = byColumn.get(col);
      const tail = field
        ? loose.has(field)
          ? `→ ${field}  (догадка, проверьте)`
          : `→ ${field}`
        : "";
      console.log(`  ${String(i + 1).padStart(2)}. ${col || "(без названия)"}   ${tail}`);
    });

    console.log("\nПоля импорта:");
    for (const field of Object.keys(ALIASES)) {
      const col = mapping[field];
      const mark = col ? (loose.has(field) ? "?" : "+") : REQUIRED.includes(field) ? "!" : "-";
      const note = col ? (loose.has(field) ? `${col}   (догадка)` : col) : "(не найдено)";
      console.log(`  ${mark} ${field.padEnd(12)} ${note}`);
    }

    const missing = REQUIRED.filter((f) => !mapping[f]);
    if (missing.length) {
      console.error(
        `\nНе найдены обязательные поля: ${missing.join(", ")}.\n` +
          `Задайте их вручную по списку колонок выше, например:\n` +
          `  --map "name=Наименование продукции,producer=Предприятие"`,
      );
      process.exit(1);
    }

    if (loose.size) {
      console.log(
        `\nПометка «догадка» значит, что колонка подошла лишь по части названия.\n` +
          `Если поле определено неверно — поправьте: --map "поле=Точное название колонки"`,
      );
    }

    if (writing) {
      db = createDb(args.out);
      insert = db.prepare(
        `INSERT INTO products
           (name, name_norm, okpd2, tnved, producer, inn, region,
            reg_number, reg_date, valid_until, ended_at, status, status_raw, url)
         VALUES (@name, @name_norm, @okpd2, @tnved, @producer, @inn,
                 @region, @reg_number, @reg_date, @valid_until, @ended_at,
                 @status, @status_raw, @url)`,
      );
      // Усечённые слова нужны только полнотекстовому индексу. Раньше они лежали
      // ещё и колонкой в products, откуда индекс собирался одним запросом в
      // конце — это примерно десятая часть текста базы, хранимая впустую.
      // Пишем прямо в индекс: тогда колонку не приходится ни заводить, ни потом
      // выбрасывать (а выбросить её без сжатия базы всё равно не вышло бы, а
      // сжатие требует места вдвое больше самой базы).
      ftsInsert = db.prepare(
        "INSERT INTO products_fts(rowid, name_stem) VALUES (?, ?)",
      );
      db.exec("BEGIN");
      // Выгрузка на 150 МБ читается с полминуты, и до первой сотни тысяч строк
      // экран молчал — со стороны это неотличимо от зависшей программы.
      console.log(`\nПишем базу в ${args.out}. Это займёт минуту-две.`);
    }
  };

  const handleRow = (row, index) => {
    const get = (field) => {
      const col = mapping[field];
      const value = col ? row[col] : undefined;
      const text = String(value ?? "").trim();
      return text || null;
    };

    const name = get("name");
    const producer = get("producer");
    if (!name || !producer) {
      stats.skipped += 1;
      return true;
    }

    const record = {
      name,
      name_norm: normalizeName(name),
      okpd2: get("okpd2"),
      tnved: get("tnved"),
      producer,
      inn: cleanInn(get("inn")),
      region: extractRegion(get("region") || get("region_alt")),
      reg_number: get("reg_number"),
      reg_date: get("reg_date"),
      valid_until: get("valid_until"),
      ended_at: get("ended_at"),
      status_raw: get("status_raw"),
      status: normalizeStatus(get("status_raw"), get("ended_at")),
      url: get("url"),
    };

    // Прекращённые записи в счётчике производителей всё равно не участвуют:
    // важно, кто выпускает продукт сейчас. На тесном диске их можно не хранить.
    if (args.onlyActive && record.status !== "active") {
      stats.skippedArchived += 1;
      return true;
    }

    if (preview.length < 3) preview.push(record);

    if (args.stats) {
      tally.rows += 1;
      if (record.status === "active") tally.active += 1;
      tally.names.add(record.name_norm);
      for (const [k, v] of Object.entries(record)) {
        if (v) tally.bytes += Buffer.byteLength(String(v), "utf8");
        // Пустое поле у большинства строк — повод перепроверить колонку:
        // в выгрузке одно и то же сведение бывает разложено по двум.
        else tally.empty[k] = (tally.empty[k] ?? 0) + 1;
      }
      if (tally.rows % 25000 === 0) {
        console.log(`  прочитано строк: ${tally.rows}`);
      }
      return true;
    }

    if (writing) {
      const { lastInsertRowid } = insert.run(record);
      ftsInsert.run(lastInsertRowid, stemName(name));
      stats.written += 1;
      if (stats.written % 25000 === 0) {
        console.log(`  записано строк: ${stats.written}`);
      }
    }

    if (args.limit && index >= args.limit) return false;
    if (args.dryRun && index >= 20) return false;
    return true;
  };

  if (isXlsx) {
    await forEachXlsxRow(args.file, { onHeader: setup, onRow: handleRow });
  } else if (isJson) {
    setup(header);
    for (let i = 0; i < jsonRows.length; i++) {
      if (handleRow(jsonRows[i], i + 1) === false) break;
    }
  } else {
    await forEachRow(args.file, {
      delimiter,
      onHeader: setup,
      onRow: handleRow,
    });
    console.log(`\nРазделитель: ${JSON.stringify(delimiter)}`);
  }

  console.log("\nПервые строки после разбора:");
  for (const p of preview) {
    console.log(
      `  • ${p.name}\n    ${p.producer}${p.inn ? ` · ИНН ${p.inn}` : ""}` +
        `${p.region ? ` · ${p.region}` : ""} · ${p.status}` +
        `${p.okpd2 ? ` · ОКПД2 ${p.okpd2}` : ""}`,
    );
  }

  finish(mapping, stats.written, db, stats);
}

main().catch((e) => {
  // Место на диске кончается тихо и в самом неожиданном месте, а сообщение
  // системы («no space left on device») не подсказывает ни сколько нужно, ни
  // где смотреть. Объясняем.
  if (e.code === "ENOSPC" || e.code === "SQLITE_FULL") {
    console.error(
      "На диске кончилось место.\n\n" +
        "Импорту нужно примерно вдвое больше места, чем займёт готовая база:\n" +
        "выгрузка на 150 МБ даёт базу около 300 МБ, и ещё столько же уходит\n" +
        "на её сжатие в конце.\n\n" +
        "Посмотрите, сколько свободно и чем занято:\n" +
        "  df -h .\n" +
        "  du -sh ~/.npm ~/.pm2/logs /var/log /tmp 2>/dev/null\n\n" +
        "Базу можно положить на другой раздел: --out /путь/gisp.sqlite\n" +
        "и указать его серверу переменной GISP_DB_PATH.",
    );
    process.exit(1);
  }

  console.error("Импорт не удался:", e.message);
  process.exit(1);
});
