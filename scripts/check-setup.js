#!/usr/bin/env node
//
// Проверка, что исходники на машине целы.
//
//   node scripts/check-setup.js
//
// Файлы сюда попадают копированием, а не через git, и подводят двумя способами.
// Файл могли не перенести — это заметно сразу. Хуже второй случай: файл
// сохранён в однобайтовой кодировке вместо UTF-8. Тогда кириллица внутри
// превращается в мусор, скрипт продолжает работать и молча выдаёт неверный
// результат — так однажды разъехалось сопоставление колонок реестра.
//
// Проверяем всё разом: что файлы на месте, что они в UTF-8, что разбираются и
// что нужные пакеты установлены.

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
for (const name of noPackage) console.log(`  НЕТ ПАКЕТА  ${name}`);

const problems = missing.length + badText.length + broken.length + noPackage.length;

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
  if (noPackage.length) console.log("  НЕТ ПАКЕТА — выполните: npm install");

  // Эта строка нарочно без кириллицы: её будет видно, даже если испорчен сам
  // этот файл — а именно так и выглядит проблема, которую он ищет.
  if (badText.length) {
    console.log(`\n!!! NOT UTF-8 (${badText.length}): ${badText.join(", ")}`);
    console.log("!!! Re-copy these files. They must stay UTF-8.");
  }
  process.exitCode = 1;
}
