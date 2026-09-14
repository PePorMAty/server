#!/usr/bin/env node
//
// Проверка, что исходники на машине целы.
//
//   node scripts/check-setup.js
//
// Файлы сюда попадают копированием, а не через git, и подводят тремя способами.
// Файл могли не перенести — это заметно сразу. Файл могли сохранить в
// однобайтовой кодировке вместо UTF-8: тогда кириллица внутри превращается в
// мусор, скрипт продолжает работать и молча выдаёт неверный результат — так
// однажды разъехалось сопоставление колонок реестра. И третье: файл могли
// положить не туда, и по нужному пути окажется чужое содержимое — на месте,
// в UTF-8, синтаксически верное, но не то.
//
// Проверяем всё разом: что файлы на месте, что они в UTF-8, что разбираются,
// что это именно те файлы и что нужные пакеты установлены.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Без этих файлов импорт реестра не поедет. */
const REQUIRED = [
  "scripts/import-gisp.js",
  "scripts/lib/csv-stream.js",
  "scripts/lib/xlsx-stream.js",
  "scripts/lib/zip-read.js",
  "routes/industry/industry.js",
  "routes/industry/utils/normalize.js",
  "routes/industry/utils/store.js",
];

/** Единственный внешний пакет слоя: и серверу для поиска, и импорту для записи. */
const PACKAGES = ["better-sqlite3"];

/**
 * Чем каждый файл обязан быть.
 *
 * Модули загружаем и смотрим, что они отдают: подменённый файл может быть и на
 * месте, и в UTF-8, и без синтаксических ошибок — отличает его только
 * содержимое. Сами модули при загрузке ничего не делают, поэтому проверка
 * безопасна.
 */
const EXPORTS = {
  "scripts/lib/csv-stream.js": ["detectDelimiter", "peek", "forEachRow"],
  "scripts/lib/xlsx-stream.js": ["forEachXlsxRow"],
  "scripts/lib/zip-read.js": ["readDirectory", "openEntry", "hasEntry"],
  "routes/industry/utils/normalize.js": ["normalizeName", "stemName", "buildQueryLadder"],
  "routes/industry/utils/store.js": ["lookupProduct", "status", "DEFAULT_DB_PATH"],
};

/**
 * Скрипт запуска модулем не является: загрузить его — значит выполнить. Узнаём
 * по строке, которая есть только в нём.
 */
const MARKERS = {
  "scripts/import-gisp.js": "const ALIASES = {",
  "routes/industry/industry.js": "/industry/lookup",
};

/** Где вообще искать исходники: кодировку проверяем у всех, не только у списка. */
const ROOTS = ["scripts", "routes", "config", "server.js"];
const SKIP = new Set(["node_modules", ".git", "data", "graphs"]);

const root = process.cwd();
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Все .js под указанными путями. */
function collect(rel, out = []) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (rel.endsWith(".js")) out.push(rel);
    return out;
  }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    collect(path.join(rel, e.name), out);
  }
  return out;
}

/**
 * Файл в UTF-8?
 *
 * Node читает исходники как UTF-8 и на неподходящий байт подставляет символ
 * замены. Если он появился — файл сохранён в другой кодировке, и всё русское
 * внутри уже потеряно.
 */
function isUtf8(file) {
  return !fs.readFileSync(file).toString("utf8").includes(REPLACEMENT);
}

const missing = [];
const broken = [];
const badText = [];
const wrongFile = [];

for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
}

const all = new Set(REQUIRED.filter((r) => fs.existsSync(path.join(root, r))));
for (const r of ROOTS) for (const f of collect(r)) all.add(f);

for (const rel of [...all].sort()) {
  const file = path.join(root, rel);
  if (!isUtf8(file)) {
    badText.push(rel);
    continue;
  }
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    const line = String(e.stderr ?? "")
      .split("\n")
      .find((l) => /Error/.test(l));
    broken.push(`${rel} — ${line ?? "не разбирается"}`);
    continue;
  }

  // Тот ли это файл. Проверяем только те, про которые знаем, чем они обязаны
  // быть: остальные исходники сюда попадают ради проверки кодировки.
  const marker = MARKERS[rel];
  if (marker) {
    if (!fs.readFileSync(file, "utf8").includes(marker)) {
      wrongFile.push(`${rel} — внутри не то содержимое`);
    }
    continue;
  }

  const expected = EXPORTS[rel];
  if (!expected) continue;
  try {
    const mod = require(file);
    const absent = expected.filter((name) => mod?.[name] === undefined);
    if (absent.length) {
      wrongFile.push(`${rel} — нет ${absent.join(", ")}; похоже, это другой файл`);
    }
  } catch (e) {
    wrongFile.push(`${rel} — не загружается: ${e.message.split("\n")[0]}`);
  }
}

const noPackage = PACKAGES.filter((name) => {
  try {
    require(require.resolve(name, { paths: [root] }));
    return false;
  } catch {
    return true;
  }
});

console.log(`Проверено файлов: ${all.size}`);

for (const rel of missing) console.log(`  НЕТ ФАЙЛА   ${rel}`);
for (const rel of badText) console.log(`  НЕ UTF-8    ${rel}`);
for (const rel of broken) console.log(`  НЕ ЧИТАЕТСЯ  ${rel}`);
for (const rel of wrongFile) console.log(`  НЕ ТОТ ФАЙЛ ${rel}`);
for (const name of noPackage) console.log(`  НЕТ ПАКЕТА  ${name}`);

const problems =
  missing.length + badText.length + broken.length + wrongFile.length + noPackage.length;

if (!problems) {
  console.log("\nВсё на месте. Можно запускать импорт:");
  console.log("  node scripts/import-gisp.js <файл выгрузки> --dry-run");
} else {
  console.log("\nЧто это значит:");
  if (missing.length) console.log("  НЕТ ФАЙЛА  — файл не перенесли на машину.");
  if (badText.length) {
    console.log("  НЕ UTF-8   — файл сохранён в другой кодировке, русский");
    console.log("               текст внутри потерян. Перенесите заново.");
  }
  if (broken.length) console.log("  НЕ ЧИТАЕТСЯ — файл повреждён, перенесите заново.");
  if (wrongFile.length) {
    console.log("  НЕ ТОТ ФАЙЛ — по этому пути лежит содержимое другого файла.");
    console.log("               При копировании его положили не туда.");
  }
  if (noPackage.length) console.log("  НЕТ ПАКЕТА — выполните: npm install");

  // Эта строка нарочно без кириллицы: её будет видно, даже если испорчен сам
  // этот файл — а именно так и выглядит проблема, которую он ищет.
  if (badText.length) {
    console.log(`\n!!! NOT UTF-8 (${badText.length}): ${badText.join(", ")}`);
    console.log("!!! Re-copy these files. They must stay UTF-8.");
  }
  process.exitCode = 1;
}
