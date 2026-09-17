#!/usr/bin/env node
//
// Что мы знаем о продуктах на сохранённых графах.
//
//   node scripts/audit-products.js              — сводка
//   node scripts/audit-products.js --missing    — список для справочника
//   node scripts/audit-products.js --absent     — вещества, которых нет в реестре
//   node scripts/audit-products.js --weak       — совпадения, которым верить рано
//   node scripts/audit-products.js --twins      — подписи-близнецы (буквы-двойники)
//   node scripts/audit-products.js --graph <id> — только по одному графу
//
// Зачем. Справочник синонимов я наполнял по ходовым названиям — то есть
// наугад относительно конкретных графов. Расти он должен там, где реально
// не хватает, а не там, где показалось. Скрипт берёт названия продуктов из
// сохранённых графов и раскладывает их на четыре кучки:
//
//   • справочник знает, реестр находит  — всё хорошо;
//   • справочник знает, реестр не находит — вещества в ГИСП действительно нет
//     (в реестре ПП №719 только товарная продукция, промежуточных нет);
//   • справочник не знает, реестр находит — синоним не нужен, и так работает;
//   • не знает никто — вот это и есть работа: либо дописать в справочник,
//     либо принять, что вещество вне реестра.
//
// Названия считаются по частоте: продукт, встречающийся на пяти графах,
// важнее встретившегося однажды.

const fs = require("fs");
const path = require("path");

const { identify, synonymsStatus } = require("../routes/industry/utils/synonyms");
const { lookupProduct, status } = require("../routes/industry/utils/store");
const { foldLookalikes, normalizeName } = require("../routes/industry/utils/normalize");

const GRAPHS_DIR = path.resolve(__dirname, "../data/saved-graphs");

/** Ступени лестницы поиска на человеческом языке — те же, что в query-gisp. */
const MATCH_LABELS = {
  exact: "точно",
  "all-words": "все слова",
  "core-words": "значимые слова",
  partial: "часть слов",
  prefix: "по началу слова",
};

/** Сохранённый граф → список названий продуктов (с повторами внутри графа не считаем). */
function productLabels(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { name: path.basename(file), labels: [] };
  }

  // Формат сохранения менялся: узлы лежат то в graph.nodes, то в корне.
  const nodes = parsed?.graph?.nodes ?? parsed?.nodes ?? [];
  const name =
    parsed?.meta?.name ?? parsed?.name ?? parsed?.prompt ?? path.basename(file);

  const seen = new Set();
  const labels = [];
  for (const n of nodes) {
    if (n?.type !== "product") continue;
    const label = String(n?.data?.label ?? "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return { name, labels };
}

function collect(onlyGraph) {
  if (!fs.existsSync(GRAPHS_DIR)) return { graphs: [], counts: new Map() };

  const graphs = [];
  // Название → на скольких графах встретилось.
  const counts = new Map();

  for (const entry of fs.readdirSync(GRAPHS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    if (onlyGraph && !entry.includes(onlyGraph)) continue;
    const { name, labels } = productLabels(path.join(GRAPHS_DIR, entry));
    if (!labels.length) continue;
    graphs.push({ file: entry, name, count: labels.length });
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return { graphs, counts };
}

function main() {
  const args = process.argv.slice(2);
  const wantMissing = args.includes("--missing");
  const wantAbsent = args.includes("--absent");
  const wantWeak = args.includes("--weak");
  const wantTwins = args.includes("--twins");
  const graphArg = args.indexOf("--graph");
  const onlyGraph = graphArg >= 0 ? args[graphArg + 1] : null;

  const syn = synonymsStatus();
  const reg = status();

  console.log(
    syn.loaded
      ? `Справочник: ${syn.entries} веществ, ${syn.spellings} написаний` +
          (syn.conflicts.length ? `, конфликтов: ${syn.conflicts.length}` : "")
      : "Справочник не прочитан — проверьте reference/synonyms.txt",
  );
  console.log(
    reg.ready
      ? `Реестр: ${reg.entries} записей${reg.actualAt ? `, актуально на ${reg.actualAt}` : ""}` +
          `; слово считается общим от ${reg.rareWordLimit} записей`
      : `Реестр не подключён: ${reg.reason}`,
  );

  const { graphs, counts } = collect(onlyGraph);
  if (!graphs.length) {
    console.log(`\nГрафов с продуктами не нашлось в ${GRAPHS_DIR}`);
    return;
  }

  console.log(`\nГрафов: ${graphs.length}, различных названий продуктов: ${counts.size}\n`);

  const rows = [];
  for (const [label, freq] of counts) {
    const known = identify(label);
    // Реестр спрашиваем только если он подключён: без базы все были бы
    // «не найдено», и картина вышла бы ложной.
    const hit = reg.ready ? lookupProduct(label) : null;
    rows.push({
      label,
      freq,
      canon: known?.canon ?? null,
      found: hit ? hit.found : null,
      match: hit?.match ?? null,
      matchedAs: hit?.matchedAs ?? null,
      // Слова, по которым совпало, и самое редкое из них. Название записи
      // показывать бессмысленно: производители отсортированы по алфавиту, и
      // первый из них может быть вовсе не тем, за кого зацепились. А слова —
      // ровно то, на чём поиск и держится.
      shared: hit?.sharedWords ?? [],
      rarestWord: hit?.rarestWord ?? null,
      rarestFreq: hit?.rarestFreq ?? null,
      sample: hit?.producers?.[0]?.product ?? null,
      entryCount: hit?.entryCount ?? 0,
    });
  }
  rows.sort((a, b) => b.freq - a.freq || a.label.localeCompare(b.label, "ru"));

  const knownCount = rows.filter((r) => r.canon).length;
  const foundCount = rows.filter((r) => r.found).length;
  const neither = rows.filter((r) => !r.canon && !r.found);
  const absent = rows.filter((r) => r.canon && r.found === false);

  // Совпадения по самым мягким ступеням лестницы — «нашлось по одному из
  // слов» и «по началу слова». Они и ошибаются чаще всего: на общем слове
  // вроде «жидкость» цепляется чужая запись. Их надо смотреть глазами.
  const WEAK = new Set(["partial", "prefix"]);
  const weak = rows.filter((r) => r.found && WEAK.has(r.match));

  console.log(`Справочник знает:  ${knownCount} из ${rows.length}`);
  if (reg.ready) {
    console.log(`Реестр находит:    ${foundCount} из ${rows.length}`);
    console.log(`Не знает никто:    ${neither.length}`);
    console.log(
      `Знаем, но в реестре нет: ${absent.length}` +
        " — это нормально: в ГИСП только товарная продукция",
    );

    const byLevel = new Map();
    for (const r of rows) {
      if (!r.found) continue;
      byLevel.set(r.match, (byLevel.get(r.match) ?? 0) + 1);
    }
    const order = ["exact", "all-words", "core-words", "partial", "prefix"];
    const levels = order
      .filter((l) => byLevel.has(l))
      .map((l) => `${MATCH_LABELS[l] ?? l}: ${byLevel.get(l)}`)
      .join(", ");
    if (levels) console.log(`Как нашлось:       ${levels}`);
    if (weak.length) {
      console.log(
        `Верить рано:       ${weak.length}` +
          " — нашлось по части слов, смотрите --weak",
      );
    }
  }

  if (wantMissing) {
    console.log("\n── Не знает никто (кандидаты в справочник) ──");
    if (!neither.length) console.log("  пусто");
    for (const r of neither) {
      console.log(`  ${String(r.freq).padStart(2)} граф(ов)  ${r.label}`);
    }
  }

  if (wantAbsent) {
    console.log("\n── Опознаны, но записи в реестре нет ──");
    if (!absent.length) console.log("  пусто");
    for (const r of absent) {
      const via = r.canon === r.label ? "" : `  (канон: ${r.canon})`;
      console.log(`  ${String(r.freq).padStart(2)} граф(ов)  ${r.label}${via}`);
    }
  }

  if (wantWeak) {
    console.log("\n── Нашлось по части слов: проверьте, то ли это вещество ──");
    if (!weak.length) console.log("  пусто");
    for (const r of weak) {
      const via = r.matchedAs ? ` через «${r.matchedAs}»` : "";
      const rare =
        r.rarestWord != null
          ? `совпало по «${r.rarestWord}» (в ${r.rarestFreq} запис.)`
          : `совпало по: ${r.shared.join(", ")}`;
      console.log(`  ${r.label}${via}`);
      console.log(`      ${rare}; записей: ${r.entryCount}`);
      if (r.sample) console.log(`      напр. «${String(r.sample).slice(0, 90)}»`);
    }
  }

  // Подписи, различающиеся только неотличимыми на вид буквами: «Бисфенол A» с
  // латинской A и «Бисфенол А» с кириллической. Такие узлы не схлопнутся
  // никогда, а увидеть разницу на экране невозможно — только так и найдёшь.
  const twins = new Map();
  for (const r of rows) {
    const key = foldLookalikes(normalizeName(r.label));
    if (!key) continue;
    if (!twins.has(key)) twins.set(key, new Set());
    twins.get(key).add(r.label);
  }
  const twinGroups = [...twins.values()].filter((set) => set.size > 1);
  if (twinGroups.length) {
    console.log(
      `Подписи-близнецы:  ${twinGroups.length}` +
        " — различаются невидимой буквой, смотрите --twins",
    );
  }

  if (wantTwins) {
    console.log("\n── Различаются только неотличимыми на вид буквами ──");
    if (!twinGroups.length) console.log("  пусто");
    for (const set of twinGroups) {
      console.log(`  ${[...set].map((s) => `«${s}»`).join("  =  ")}`);
    }
  }

  if (!wantMissing && !wantAbsent && !wantWeak && !wantTwins) {
    console.log(
      "\nСписки: --missing (дописать в справочник), --absent (нет в реестре)," +
        " --weak (сомнительные совпадения), --twins (подписи-близнецы)",
    );
  }
}

main();
