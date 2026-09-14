#!/usr/bin/env node
//
// Проверка, что слой ГИСП доехал до машины целиком.
//
//   node scripts/check-setup.js
//
// Файлы на боевую машину попадают копированием, а не через git, поэтому
// подвести могут две вещи сразу: какой-то файл забыли перенести, или менеджер
// передал его в текстовом режиме и испортил кодировку. Оба случая всплывают
// уже во время импорта — стеком вызовов вместо внятного ответа. Проверяем
// заранее: что лежит на месте, что разбирается и что пакеты установлены.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Всё, без чего импорт реестра не поедет. */
const FILES = [
  "scripts/import-gisp.js",
  "scripts/lib/csv-stream.js",
  "scripts/lib/xlsx-stream.js",
  "routes/industry/industry.js",
  "routes/industry/utils/normalize.js",
  "routes/industry/utils/store.js",
];

/** better-sqlite3 нужен и серверу, exceljs — только импорту (devDependencies). */
const PACKAGES = ["better-sqlite3", "exceljs"];

const root = process.cwd();
let problems = 0;

for (const name of FILES) {
  const file = path.join(root, name);

  if (!fs.existsSync(file)) {
    problems++;
    console.log(`  НЕТ  ${name}`);
    continue;
  }

  // node --check разбирает файл, но не выполняет: так ловим файл, побитый при
  // переносе, не запуская ничего лишнего.
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ОК   ${name}`);
  } catch (e) {
    problems++;
    const line = String(e.stderr ?? "")
      .split("\n")
      .find((l) => /Error/.test(l));
    console.log(`  БИТ  ${name} — ${line ?? "не разбирается"}`);
  }
}

for (const name of PACKAGES) {
  // Ищем пакет рядом с проектом, а не рядом со скриптом: запускают его из
  // корня сервера.
  try {
    require(require.resolve(name, { paths: [root] }));
    console.log(`  ОК   пакет ${name}`);
  } catch {
    problems++;
    console.log(`  НЕТ  пакет ${name}`);
  }
}

if (problems) {
  console.log(`\n  Проблем: ${problems}.`);
  console.log("  «НЕТ» у файла — его не перенесли; «БИТ» — перенесли в");
  console.log("  текстовом режиме и испортили, нужен двоичный (binary).");
  console.log("  «НЕТ» у пакета — выполните: npm install --include=dev");
  process.exitCode = 1;
} else {
  console.log("\n  Всё на месте. Можно запускать импорт:");
  console.log("  node scripts/import-gisp.js <файл выгрузки> --dry-run");
}
