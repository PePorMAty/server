#!/usr/bin/env node
//
// Почему продукта «нет в реестре»: молчит реестр или сработал отбор.
//
//   node scripts/why-missing.js                     по продуктам всех графов
//   node scripts/why-missing.js --from after4.json  по снимку lookup-snapshot
//   node scripts/why-missing.js "Бензол" "Этилен"   по названиям из команды
//
//   --names-from ФАЙЛ  названия из файла, по одному в строке
//   --limit N          разобрать только первые N
//   --all              показать поимённо и отдалённое сходство, и молчание
//
// ЗАЧЕМ. В карточке и в списке «Нет в реестре» пишется одно и то же «нет
// записи», а причин у этого две, и они противоположны по смыслу:
//
//   • РЕЕСТР МОЛЧИТ — ни одна запись не содержит слов запроса. Для
//     промежуточного вещества цепочки это нормально: реестр ПП №719 про
//     товарную продукцию, а промежуточные никто не заявляет. Делать нечего.
//
//   • ОТДАЛЁННОЕ СХОДСТВО — совпало одно слово из нескольких. «Кислота» есть
//     в тысячах записей, и отказ тут почти всегда верен. Смотреть в последнюю
//     очередь.
//
//   • СТРОГОЕ СОВПАДЕНИЕ ОТБРОШЕНО — совпали ВСЕ значимые слова, и всё равно
//     отказ. Иногда правило право («Ноутбук» не подтверждается салфетками для
//     ноутбуков), а иногда нет — и тогда это наша недоработка, которую видно
//     только здесь. Эту кучку читать первой.
//
// Разделить их на глаз нельзя, поэтому и написан этот разбор.

const fs = require("fs");
const path = require("path");

const { lookupProduct, getDb, status } = require("../routes/industry/utils/store");
const { spellingsOf, allEntries } = require("../routes/industry/utils/synonyms");
const { buildQueryLadder } = require("../routes/industry/utils/normalize");

const GRAPHS_DIR = path.resolve(__dirname, "../data/saved-graphs");

/** Ступени лестницы на человеческом языке — те же, что в query-gisp. */
const MATCH_LABELS = {
  exact: "точно",
  "all-words": "все слова",
  "core-words": "значимые слова",
  partial: "часть слов",
  prefix: "по началу слова",
};

/** Названия продуктов из сохранённого графа. */
function productLabels(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const nodes = parsed?.graph?.nodes ?? parsed?.nodes ?? [];
  return nodes
    .filter((n) => n?.type === "product")
    .map((n) => String(n?.data?.label ?? "").trim())
    .filter(Boolean);
}

function namesFromGraphs() {
  const out = new Set();
  if (!fs.existsSync(GRAPHS_DIR)) return [];
  for (const file of fs.readdirSync(GRAPHS_DIR)) {
    if (!file.endsWith(".json")) continue;
    for (const label of productLabels(path.join(GRAPHS_DIR, file))) out.add(label);
  }
  return [...out];
}

/** Названия из снимка lookup-snapshot: берём те, что там не нашлись. */
function namesFromSnapshot(file) {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!snap?.results) {
    console.error(`${file} не похож на снимок: нет поля results.`);
    process.exit(1);
  }
  return Object.entries(snap.results)
    .filter(([, r]) => !r?.found)
    .map(([name]) => name);
}

/** Ступени, на которых совпали ВСЕ значимые слова запроса. */
const STRICT = new Set(["exact", "all-words", "core-words"]);

/**
 * Что реестр вообще знает про это название.
 *
 * Спрашиваем индекс напрямую, без отбора: нам нужен не ответ «подходит ли
 * запись», а ответ «есть ли о чём говорить». Возвращаем вместе со ступенью,
 * на которой нашлось: отказ после СТРОГОЙ ступени подозрителен, после мягкой —
 * почти всегда верен, и валить их в одну кучу нельзя. На живом реестре мягкая
 * ступень находит «Кислоту терефталевую» на любой запрос со словом «кислота»,
 * и без этого разделения отчёт состоял бы из одного шума.
 */
function probeRegistry(name, limit = 4) {
  const conn = getDb();
  if (!conn) return [];
  const stmt = conn.prepare(
    `SELECT p.name FROM products_fts f JOIN products p ON p.id = f.rowid
     WHERE products_fts MATCH ? LIMIT ${limit}`,
  );
  for (const spelling of spellingsOf(name)) {
    for (const step of buildQueryLadder(spelling)) {
      try {
        const rows = stmt.all(step.query);
        if (rows.length) {
          return rows.map((r) => ({ name: r.name, level: step.level, spelling }));
        }
      } catch {
        // Кривой запрос к индексу — пробуем следующую ступень.
      }
    }
  }
  return [];
}

function main() {
  const argv = process.argv.slice(2);
  let from = null;
  let namesFrom = null;
  let limit = 0;
  let showAll = false;
  const direct = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i];
    else if (a === "--names-from") namesFrom = argv[++i];
    else if (a === "--limit") limit = Number(argv[++i]) || 0;
    else if (a === "--all") showAll = true;
    else if (!a.startsWith("--")) direct.push(a);
  }

  const reg = status();
  if (!reg.ready) {
    console.error("База реестра не прочитана — разбирать нечего.");
    process.exit(1);
  }
  console.log(`Реестр: ${reg.entries} записей, актуально на ${reg.actualAt ?? "—"}`);

  let names;
  if (direct.length) names = direct;
  else if (namesFrom) {
    names = fs
      .readFileSync(namesFrom, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } else if (from) names = namesFromSnapshot(from);
  else {
    // Без источника — все продукты графов и весь справочник, как в снимке.
    names = [...new Set([...allEntries().map((e) => e.canon), ...namesFromGraphs()])];
  }
  names = [...new Set(names)];
  if (limit) names = names.slice(0, limit);

  const silent = []; // реестр молчит
  const strictRejected = []; // совпали все слова — и всё равно отказ
  const looseRejected = []; // совпало одно слово из нескольких
  let found = 0;

  for (const name of names) {
    const r = lookupProduct(name);
    if (r?.found) {
      found += 1;
      continue;
    }
    const candidates = probeRegistry(name);
    if (!candidates.length) {
      silent.push(name);
      continue;
    }
    const entry = { name, candidates, weak: r?.weak ?? null };
    if (STRICT.has(candidates[0].level)) strictRejected.push(entry);
    else looseRejected.push(entry);
  }

  console.log(
    `\nРазобрано названий: ${names.length}` +
      `  ·  нашлось: ${found}  ·  не нашлось: ${names.length - found}`,
  );

  const dump = (list) => {
    for (const r of list) {
      const w = r.weak;
      console.log(
        `  «${r.name}»` +
          (w
            ? `  — ${w.entryCount} записей, ступень «${MATCH_LABELS[w.match] ?? w.match}»` +
              (w.matchedAs ? `, по написанию «${w.matchedAs}»` : "") +
              (w.offTarget ? ", слово попало в чужое название" : "")
            : ""),
      );
      // Ответ поиска пришёл по ДРУГОМУ написанию, а записи ниже — своя
      // выборка скрипта по словам самого названия. Без примера было не понять,
      // что именно нашлось: у «Каменной соли» стояло «по написанию «Галит»», а
      // под ним — записи про соль, к галиту отношения не имеющие.
      if (w?.matchedAs && w.sample) {
        console.log(`       по «${w.matchedAs}» нашлось, например: ${w.sample.slice(0, 70)}`);
        if (r.candidates.length) console.log("       а по словам самого названия:");
      }
      for (const c of r.candidates) {
        console.log(
          `       ${c.name.slice(0, 84)}` +
            (c.spelling !== r.name ? `   [искали как «${c.spelling}»]` : ""),
        );
      }
    }
  };

  console.log(
    `\n══ СТРОГОЕ СОВПАДЕНИЕ ОТБРОШЕНО: ${strictRejected.length} ══\n` +
      "Совпали ВСЕ значимые слова запроса, и всё равно отказ.\n" +
      "ЭТУ КУЧКУ ЧИТАТЬ ПЕРВОЙ: здесь либо правило право, либо наша ошибка.\n",
  );
  dump(strictRejected);

  console.log(
    `\n══ ТОЛЬКО ОТДАЛЁННОЕ СХОДСТВО: ${looseRejected.length} ══\n` +
      "Совпало одно слово из нескольких — «кислота», «эфир» и подобные есть в\n" +
      "тысячах записей. Отказ тут почти всегда верен.",
  );
  if (showAll) dump(looseRejected);
  else if (looseRejected.length) console.log("  (поимённо — ключ --all)");

  console.log(`\n══ РЕЕСТР МОЛЧИТ: ${silent.length} ══`);
  console.log(
    "Ни одна запись не содержит слов запроса. Для промежуточного вещества\n" +
      "цепочки это нормально: реестр ПП №719 про товарную продукцию.",
  );
  if (showAll) {
    for (const n of silent) console.log(`  ${n}`);
  } else if (silent.length) {
    console.log(`  (поимённо — ключ --all)`);
  }
}

main();
