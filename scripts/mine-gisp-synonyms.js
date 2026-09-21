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

const {
  normalizeName,
  foldLookalikes,
  words,
  stemName,
} = require("../routes/industry/utils/normalize");
const { identify } = require("../routes/industry/utils/synonyms");

const DB_PATH =
  process.env.GISP_DB_PATH || path.resolve(__dirname, "../data/gisp.sqlite");

const key = (s) => foldLookalikes(normalizeName(s));

/** Число с единицей: «360 г/л», «5%». Значит, в скобке состав, а не имя. */
const QUANTITY = /\d[\d.,]*\s*(?:%|мг|мкг|кг|мл|г\/л|г|л|моль|ppm|шт|уп)(?![а-яёa-z])/i;

/**
 * Начала, после которых в скобке не имя, а уточнение.
 *
 * «(кроме …)», «(в том числе …)», «(для …)», «(марка А)» — всё это про то же
 * вещество, но синонимом не является: подставив такое в справочник, мы
 * объявили бы «марка А» именем продукта.
 *
 * Конец слова стережём заглядыванием, а не `\b`: в JavaScript граница слова
 * считается по латинице и на кириллице не срабатывает. Без этого «из»
 * съедало «ИЗопропиловый спирт», «при» — «ПРИродный газ», «тип» — «ТИПовой».
 * Проверка это и поймала.
 */
const NOT_A_NAME = new RegExp(
  "^(?:" +
    [
      "кроме", "включая", "в\\s+том\\s+числе", "для", "из", "с", "со", "без",
      "не", "по", "при", "согласно", "марка", "марки", "сорт", "тип", "класс",
      "гост", "ту", "артикул", "далее", "см",
    ].join("|") +
    ")(?![а-яёa-z])",
  "i",
);

/**
 * Разбить перечисление в скобке, не разрывая числа.
 *
 * Запятая в скобке обычно разделяет имена — «(изопропиловый спирт,
 * изопропанол)». Но в химических названиях она же стоит ВНУТРИ имени:
 * «1,2-диметилбензол», «пропандиол-1,2». Наивное деление давало «2-
 * диметилбензол» — имя несуществующего вещества.
 */
function splitNames(inner) {
  const GUARD = "\u0001";
  return inner
    .replace(/(\d)\s*,\s*(\d)/g, `$1${GUARD}$2`)
    .split(/[;,]/)
    .map((p) => p.split(GUARD).join(","));
}

/**
 * Одинокое прилагательное: «сжиженный», «вторичный», «технический».
 *
 * Именем вещества оно не бывает — названия в химии существительные. А в
 * скобке такое слово стоит сплошь и рядом: «Газ природный (сжиженный)»,
 * «Полиэтилен (вторичный)». Приняв его за синоним, мы объявили бы сжиженный
 * газ тем же продуктом, что и обычный, и слили бы их в один узел.
 */
const LONE_ADJECTIVE = /^[а-яё-]+(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/i;

/** Слова, которые сами по себе именем вещества не бывают. */
const JUNK = new Set([
  "прочие", "прочая", "прочий", "прочее", "другие", "остальные",
  "модификация", "исполнение", "вариант", "аналог", "серия", "партия",
]);

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

/**
 * Разобрать название записи на пару «головное имя — синоним».
 *
 * Берём ТОЛЬКО скобку, стоящую сразу за именем, не дальше третьего значимого
 * слова. Дальше по названию скобка означает уже не второе имя, а торговую
 * марку, наполнитель или количество — это выяснилось на замере совпадений:
 * «…концентрации этанола в крови (ЭТАНОЛ-ОЛЬВЕКС)» синонимом этанола не
 * является ни в каком смысле.
 */
function pairsFrom(rawName) {
  const text = String(rawName ?? "").trim();
  const open = text.indexOf("(");
  if (open < 2) return [];
  const close = text.indexOf(")", open + 1);
  if (close < 0) return [];

  const head = text.slice(0, open).trim().replace(/[,;:]+$/, "");
  const inner = text.slice(open + 1, close).trim();
  if (head.length < 3 || inner.length < 3) return [];

  const headWords = words(stemName(head));
  if (!headWords.length || headWords.length > 3) return [];
  if (QUANTITY.test(inner) || NOT_A_NAME.test(inner)) return [];
  if (headWords.some((w) => JUNK.has(w))) return [];

  const out = [];
  // Перечисление внутри скобки — несколько имён сразу: «(изопропиловый спирт,
  // изопропанол)».
  for (const part of splitNames(inner)) {
    const alt = part.trim().replace(/^["'«»]+|["'«»]+$/g, "");
    if (alt.length < 3) continue;
    const altWords = words(stemName(alt));
    if (!altWords.length || altWords.length > 3) continue;
    if (altWords.some((w) => JUNK.has(w))) continue;
    if (NOT_A_NAME.test(alt)) continue;
    if (LONE_ADJECTIVE.test(alt.trim())) continue;
    // Латиница целиком — это почти всегда торговое имя или артикул.
    if (!/[а-яё]/i.test(alt)) continue;
    if (key(alt) && key(head) && key(alt) !== key(head)) out.push([head, alt]);
  }
  return out;
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
    for (const [head, alt] of pairsFrom(row.name)) {
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
