#!/usr/bin/env node
//
// Добыть синонимы из названий самого реестра ГИСП.
//
//   node scripts/mine-gisp-synonyms.js                 — сводка и выборка
//   node scripts/mine-gisp-synonyms.js --all           — весь список
//   node scripts/mine-gisp-synonyms.js --min 2         — только встреченные N раз
//   node scripts/mine-gisp-synonyms.js --out файл.txt  — записать кандидатов
//
// Зачем. Справочник синонимов наполнялся по ходовым названиям, то есть наугад
// относительно того, что реально бывает. А в реестре 84 тысячи названий,
// которые писали сами производители, и второе имя вещества у них сплошь и
// рядом стоит в скобках сразу после первого:
//
//   Изопропилбензол (кумол) Марка А
//   2-Пропанол (изопропиловый спирт, изопропанол) ОСЧ 11-5
//   Мел химически осажденный (карбонат кальция) по ГОСТ 8253-79
//
// Это готовые пары «имя — синоним», и добывать их не надо ниоткуда: база уже
// лежит на сервере.
//
// ВАЖНО. Скрипт НИЧЕГО не добавляет в справочник сам. Он печатает кандидатов,
// а решение за человеком: ошибочный синоним молча сливает два разных вещества
// в один узел графа, и заметить это потом нечем. Отсев ниже намеренно строгий
// — лучше упустить пару, чем протащить неверную.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { identify } = require("../routes/industry/utils/synonyms");
// Разбор скобки — общий с mine-graph-synonyms.js: правила там куплены
// ошибками, и во втором экземпляре они бы разъехались.
const { parenPairs, key } = require("./lib/paren-pairs");

const DB_PATH =
  process.env.GISP_DB_PATH || path.resolve(__dirname, "../data/gisp.sqlite");

function parseArgs(argv) {
  const args = argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    all: args.includes("--all"),
    min: Number(at("--min") ?? 1) || 1,
    out: at("--out"),
  };
}

function main() {
  const opts = parseArgs(process.argv);

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error(`Базу ГИСП не открыть (${DB_PATH}): ${e.message}`);
    process.exit(1);
  }

  const total = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  console.log(`Реестр: ${total} записей\n`);

  // Ключ пары → { head, alt, count }. Считаем, сколько записей её подтвердили:
  // пара, встреченная у разных производителей, надёжнее одиночной.
  const found = new Map();
  let withParens = 0;

  for (const row of db.prepare("SELECT name FROM products").iterate()) {
    if (String(row.name ?? "").includes("(")) withParens += 1;
    for (const [head, alt] of parenPairs(row.name)) {
      const k = `${key(head)}\u0000${key(alt)}`;
      const prev = found.get(k);
      if (prev) prev.count += 1;
      else found.set(k, { head, alt, count: 1 });
    }
  }

  // Что справочник уже знает — не кандидат.
  const fresh = [];
  let known = 0;
  for (const p of found.values()) {
    if (p.count < opts.min) continue;
    const a = identify(p.head);
    const b = identify(p.alt);
    if (a && b && a.id === b.id) {
      known += 1;
      continue;
    }
    fresh.push({ ...p, knownAs: a?.id ?? b?.id ?? null });
  }
  fresh.sort((a, b) => b.count - a.count || a.head.localeCompare(b.head, "ru"));

  console.log(`Названий со скобкой:      ${withParens}`);
  console.log(`Пар «имя — синоним»:      ${found.size}`);
  console.log(`Справочник уже знает:     ${known}`);
  console.log(`Кандидатов:               ${fresh.length}`);

  const shown = opts.all ? fresh : fresh.slice(0, 40);
  console.log(
    `\n── кандидаты${opts.all ? "" : ` (первые ${shown.length}, весь список — --all)`} ──`,
  );
  for (const p of shown) {
    console.log(
      `  ${String(p.count).padStart(4)}×  ${p.head}  |  ${p.alt}` +
        (p.knownAs ? `   (одну половину знаем как «${p.knownAs}»)` : ""),
    );
  }

  if (opts.out) {
    const lines = [
      "# Кандидаты в синонимы, добытые из названий реестра ГИСП.",
      "#",
      "# СОБРАНО МАШИНОЙ И НЕ ПРОВЕРЕНО. Это не справочник, а список на разбор:",
      "# перенесите верные строки в reference/synonyms.txt руками, остальные",
      "# выбросьте. Ошибочный синоним молча сольёт два разных вещества в один",
      "# узел графа, и заметить это будет нечем.",
      "#",
      "# В хвосте строки — сколько записей реестра эту пару подтвердили.",
      `# Собрано: ${new Date().toISOString().slice(0, 10)}, пар: ${fresh.length}`,
      "",
      ...fresh.map((p) => `${p.head} | ${p.alt}   # записей: ${p.count}`),
    ];
    fs.writeFileSync(opts.out, lines.join("\n") + "\n", "utf8");
    console.log(`\nЗаписано в ${opts.out}: ${fresh.length} строк.`);
    console.log("Это СПИСОК НА РАЗБОР, а не справочник — смотрите шапку файла.");
  } else {
    console.log("\nЗаписать кандидатов в файл: --out reference/synonyms-gisp-candidates.txt");
  }
}

main();
