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
//   --dry-run           ничего не писать: показать, как разобрались колонки,
//                       и первые строки
//
// Поддерживаются XLSX, CSV, TSV, JSON (массив) и JSONL. Книга Excel читается
// потоком: распакованный лист на сотни тысяч строк в память не помещается.
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
    "наименование организации",
    "организация",
    "заявитель",
    "наименование юридического лица",
  ],
  inn: ["инн"],
  region: ["регион", "субъект", "субъект рф", "местонахождение", "адрес"],
  okpd2: ["окпд2", "окпд 2", "код окпд2", "код окпд"],
  tnved: ["тнвэд", "тн вэд", "код тн вэд"],
  reg_number: [
    "номер реестровой записи",
    "реестровый номер",
    "номер записи",
    "реестровая запись",
    "номер заключения",
  ],
  reg_date: ["дата реестровой записи", "дата записи", "дата включения", "дата"],
  valid_until: ["срок действия", "действует до", "дата окончания"],
  status_raw: ["статус", "состояние", "статус записи"],
  url: ["ссылка", "url", "адрес записи"],
};

const REQUIRED = ["name", "producer"];

/** Опознать колонки выгрузки. Возвращает { поле: заголовок }. */
function detectMapping(header) {
  const normalized = header.map((h) => ({ raw: h, norm: normalizeName(h) }));
  const mapping = {};
  const taken = new Set();

  for (const [field, aliases] of Object.entries(ALIASES)) {
    // Сначала точное совпадение, потом вхождение — иначе «Адрес записи»
    // перехватил бы поле региона у «Адрес».
    let hit = normalized.find(
      (h) => !taken.has(h.raw) && aliases.includes(h.norm),
    );
    if (!hit) {
      hit = normalized.find(
        (h) =>
          !taken.has(h.raw) &&
          aliases.some((a) => h.norm.includes(a) || a.includes(h.norm)),
      );
    }
    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  return mapping;
}

/** «Действует» / «В архиве» → устойчивый признак. */
function normalizeStatus(raw) {
  const s = normalizeName(raw);
  if (!s) return "active";
  if (/архив|истек|аннулир|прекращ|недейств|отозв/.test(s)) return "archived";
  return "active";
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
      name_stem   TEXT NOT NULL,
      okpd2       TEXT,
      tnved       TEXT,
      producer    TEXT NOT NULL,
      inn         TEXT,
      region      TEXT,
      reg_number  TEXT,
      reg_date    TEXT,
      valid_until TEXT,
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
  const args = { file: null, out: DEFAULT_DB_PATH, dryRun: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--actual-at") args.actualAt = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]) || 0;
    else if (a === "--map") args.map = argv[++i];
    else if (!a.startsWith("--") && !args.file) args.file = a;
  }
  return args;
}

function applyManualMap(mapping, spec) {
  for (const pair of String(spec).split(",")) {
    const [field, ...rest] = pair.split("=");
    const column = rest.join("=").trim();
    if (field && column) mapping[field.trim()] = column;
  }
  return mapping;
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

    console.log("\nСтроим полнотекстовый индекс…");
    db.exec(
      "INSERT INTO products_fts(rowid, name_stem) SELECT id, name_stem FROM products",
    );
    db.exec("VACUUM");

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
        `  пропущено строк без названия или производителя: ${stats.skipped}`,
    );
  };

  let mapping = null;
  let db = null;
  let insert = null;
  const stats = { skipped: 0, written: 0 };
  const preview = [];

  const setup = (headerRow) => {
    header = headerRow;
    mapping = detectMapping(header);
    if (args.map) mapping = applyManualMap(mapping, args.map);

    console.log(`Колонок в файле: ${header.length}`);
    console.log("Соответствие полей:");
    for (const field of Object.keys(ALIASES)) {
      const col = mapping[field];
      const mark = col ? "✅" : REQUIRED.includes(field) ? "❌" : "—";
      console.log(`  ${mark} ${field.padEnd(12)} ${col ?? "(не найдено)"}`);
    }

    const missing = REQUIRED.filter((f) => !mapping[f]);
    if (missing.length) {
      console.error(
        `\nНе найдены обязательные поля: ${missing.join(", ")}.\n` +
          `Заголовки файла:\n  ${header.join("\n  ")}\n\n` +
          `Задайте вручную, например:\n` +
          `  --map "name=Наименование продукции,producer=Изготовитель"`,
      );
      process.exit(1);
    }

    if (!args.dryRun) {
      db = createDb(args.out);
      insert = db.prepare(
        `INSERT INTO products
           (name, name_norm, name_stem, okpd2, tnved, producer, inn, region,
            reg_number, reg_date, valid_until, status, status_raw, url)
         VALUES (@name, @name_norm, @name_stem, @okpd2, @tnved, @producer, @inn,
                 @region, @reg_number, @reg_date, @valid_until, @status,
                 @status_raw, @url)`,
      );
      db.exec("BEGIN");
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
      name_stem: stemName(name),
      okpd2: get("okpd2"),
      tnved: get("tnved"),
      producer,
      inn: cleanInn(get("inn")),
      region: get("region"),
      reg_number: get("reg_number"),
      reg_date: get("reg_date"),
      valid_until: get("valid_until"),
      status_raw: get("status_raw"),
      status: normalizeStatus(get("status_raw")),
      url: get("url"),
    };

    if (preview.length < 3) preview.push(record);
    if (!args.dryRun) {
      insert.run(record);
      stats.written += 1;
      if (stats.written % 100000 === 0) {
        console.log(`  обработано строк: ${stats.written}`);
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
  console.error("Импорт не удался:", e.message);
  process.exit(1);
});
