#!/usr/bin/env node
//
// Что мы знаем о продуктах на сохранённых графах.
//
//   node scripts/audit-products.js              — сводка
//   node scripts/audit-products.js --missing    — список для справочника
//   node scripts/audit-products.js --absent     — вещества, которых нет в реестре
//   node scripts/audit-products.js --weak       — совпадения, которым верить рано
//   node scripts/audit-products.js --twins      — подписи-близнецы (буквы-двойники)
//   node scripts/audit-products.js --merged     — какие строки справочника слились
//   node scripts/audit-products.js --coverage   — замер под порог по доле слов записи
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
  const wantMerged = args.includes("--merged");
  const wantCoverage = args.includes("--coverage");
  const graphArg = args.indexOf("--graph");
  const onlyGraph = graphArg >= 0 ? args[graphArg + 1] : null;

  const syn = synonymsStatus();
  const reg = status();

  console.log(
    syn.loaded
      ? `Справочник: ${syn.entries} веществ, ${syn.spellings} написаний` +
          ` (${(syn.sources ?? []).map((s) => `${s.file}: ${s.entries}`).join(", ")})` +
          (syn.conflicts.length ? `, КОНФЛИКТОВ: ${syn.conflicts.length}` : "") +
          (syn.merged?.length ? `, слито строк: ${syn.merged.length}` : "")
      : "Справочник не прочитан — проверьте reference/synonyms.txt",
  );
  // Конфликт — одно написание у двух РАЗНЫХ веществ, то есть готовое слияние
  // несовместимого в один узел. Прятать его за флагом нельзя: тревога, которую
  // нельзя прочитать, — не тревога. Печатаем всегда и поимённо.
  if (syn.conflicts?.length) {
    console.log("\n── КОНФЛИКТЫ: одно написание у разных веществ ──");
    for (const c of syn.conflicts.slice(0, 20)) {
      console.log(
        `  «${c.spelling}»: оставлено «${c.kept}» (${c.keptFrom}),` +
          ` отброшено «${c.ignored}» (${c.ignoredFrom})`,
      );
    }
    if (syn.conflicts.length > 20) {
      console.log(`  … и ещё ${syn.conflicts.length - 20}`);
    }
    console.log(
      "  Побеждает запись из файла, прочитанного первым. Если победил не тот —" +
        "\n  поправьте reference/synonyms.txt: он читается раньше собранного машиной.\n",
    );
  }

  // Слияние тише конфликта, но последствие у него то же: два названия станут
  // одним узлом. Прячем за флагом, а не за молчанием — счётчик в шапке уже
  // сказал, что слияния были, и посмотреть их должно быть чем.
  if (wantMerged && syn.merged?.length) {
    console.log("\n── СЛИТО: одно вещество под разными главными именами ──");
    for (const m of syn.merged) {
      console.log(
        `  «${m.ignored}» (${m.ignoredFrom}) → «${m.kept}» (${m.keptFrom}),` +
          ` общих написаний: ${m.shared}`,
      );
    }
    console.log(
      "  Если слились РАЗНЫЕ вещества — уберите общие написания из строки в" +
        "\n  reference/synonyms.txt: родство считается по их числу.\n",
    );
  }

  console.log(
    reg.ready
      ? `Реестр: ${reg.entries} записей${reg.actualAt ? `, актуально на ${reg.actualAt}` : ""}`
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
      // Разбор мягкого совпадения: подтверждением оно не считается, но
      // посмотреть, за что зацепилось, полезно.
      weak: hit?.weak ?? null,
      // Какую долю слов записи покрыло совпадение — для выбора порога.
      coverage: hit?.coverage ?? null,
    });
  }
  rows.sort((a, b) => b.freq - a.freq || a.label.localeCompare(b.label, "ru"));

  const knownCount = rows.filter((r) => r.canon).length;
  const foundCount = rows.filter((r) => r.found).length;
  const neither = rows.filter((r) => !r.canon && !r.found);
  const absent = rows.filter((r) => r.canon && r.found === false);

  // Мягкие совпадения подтверждением больше не считаются, но остаются
  // видимыми: иногда среди них попадается верное.
  const weak = rows.filter((r) => r.weak);

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
    const order = ["exact", "all-words", "core-words"];
    const levels = order
      .filter((l) => byLevel.has(l))
      .map((l) => `${MATCH_LABELS[l] ?? l}: ${byLevel.get(l)}`)
      .join(", ");
    if (levels) console.log(`Как подтвердилось: ${levels}`);
    if (weak.length) {
      console.log(
        `Похоже, но не в счёт: ${weak.length}` +
          " — совпала часть слов, подтверждением не считается, смотрите --weak",
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
    console.log("\n── Совпала часть слов: в подтверждённые не идёт ──");
    if (!weak.length) console.log("  пусто");
    for (const r of weak) {
      const w = r.weak;
      const via = w.matchedAs ? ` через «${w.matchedAs}»` : "";
      const rare =
        w.rarestWord != null
          ? `зацепилось за «${w.rarestWord}» (в ${w.rarestFreq} запис.)`
          : `зацепилось за: ${w.sharedWords.join(", ")}`;
      console.log(`  ${r.label}${via}`);
      console.log(`      ${rare}; записей: ${w.entryCount}`);
      if (w.sample) console.log(`      напр. «${String(w.sample).slice(0, 90)}»`);
    }
  }

  // Подписи, сходящиеся к одному названию. Важно разделить два случая:
  //
  //   • регистр, дефисы, лишние пробелы — сходились и раньше, это не проблема,
  //     а просто разнобой в подписях;
  //   • неотличимые на вид буквы («Бисфенол A» с латинской A против
  //     «Бисфенол А» с кириллической) — вот это ломало схлопывание, и увидеть
  //     разницу на экране невозможно.
  //
  // Валить их в одну кучу нечестно: получилось бы, будто свод букв починил и
  // то, что и без него работало.
  const twins = new Map();
  for (const r of rows) {
    const key = foldLookalikes(normalizeName(r.label));
    if (!key) continue;
    if (!twins.has(key)) twins.set(key, []);
    twins.get(key).push(r.label);
  }

  const lookalikeGroups = [];
  let plainGroups = 0;
  for (const labels of twins.values()) {
    if (labels.length < 2) continue;
    // Если без свода букв подписи тоже сходятся — дело в регистре и знаках.
    const plain = new Set(labels.map((l) => normalizeName(l)));
    if (plain.size > 1) lookalikeGroups.push(labels);
    else plainGroups += 1;
  }

  if (lookalikeGroups.length) {
    console.log(
      `Буквы-двойники:    ${lookalikeGroups.length}` +
        " — подписи не сходились бы без свода букв, смотрите --twins",
    );
  }
  if (plainGroups) {
    console.log(
      `Разнобой в подписи: ${plainGroups}` +
        " — регистр и знаки; сходятся и так, чинить нечего",
    );
  }

  if (wantTwins) {
    console.log("\n── Различаются неотличимыми на вид буквами ──");
    if (!lookalikeGroups.length) console.log("  пусто");
    for (const labels of lookalikeGroups) {
      console.log(`  ${labels.map((s) => `«${s}»`).join("  =  ")}`);
    }
  }

  // Замер под будущий порог: какую долю слов записи покрыло совпадение.
  //
  // Печатаем по возрастанию доли — именно снизу и надо смотреть, где мусор
  // сменяется настоящими совпадениями. Число порога подбираем по этому списку
  // и никак иначе: прошлый раз отсев по редкости слова провалился ровно
  // потому, что границу угадали, а верные и ложные совпадения по ней
  // перекрывались.
  if (wantCoverage) {
    // Сортируем по МЕСТУ совпадения: это и есть проверяемая догадка. Доля
    // рядом — видно, различают ли они одно и то же.
    const scored = rows
      .filter((r) => r.found && r.coverage)
      .sort(
        (a, b) => b.coverage.at - a.coverage.at || a.coverage.share - b.coverage.share,
      );

    console.log("\n── ПОКРЫТИЕ: чем именно подтвердилось совпадение ──");
    if (!scored.length) console.log("  нечего мерить");

    const atBands = [1, 2, 3, 5, 9, 1e9];
    const atCounts = new Map(atBands.map((b) => [b, 0]));
    for (const r of scored) {
      const band = atBands.find((b) => r.coverage.at < b);
      atCounts.set(band, atCounts.get(band) + 1);
    }
    // Полоса b накрывает at из [prev, b-1], то есть слова с prev+1 по b.
    console.log("\n  На каком слове записи совпадение началось:");
    let prev = 0;
    for (const b of atBands) {
      const from = prev + 1;
      const label =
        b > 1e8
          ? `слова ${from} и дальше`
          : from === b
            ? `слово ${from}`
            : `слова ${from}–${b}`;
      console.log(`    ${label.padEnd(20)} ${String(atCounts.get(b)).padStart(4)}`);
      prev = b;
    }

    const shareBands = [0.1, 0.2, 0.3, 0.5, 0.75, 1.01];
    const shareCounts = new Map(shareBands.map((b) => [b, 0]));
    for (const r of scored) {
      const band = shareBands.find((b) => r.coverage.share < b) ?? 1.01;
      shareCounts.set(band, shareCounts.get(band) + 1);
    }
    console.log("\n  Какую долю слов записи объяснило:");
    prev = 0;
    for (const b of shareBands) {
      const to = b > 1 ? "100%" : `${Math.round(b * 100)}%`;
      console.log(
        `    ${String(Math.round(prev * 100)).padStart(3)}–${to.padStart(4)}` +
          `          ${String(shareCounts.get(b)).padStart(4)}`,
      );
      prev = b;
    }

    console.log("\n  Поимённо, начиная с самых подозрительных:");
    for (const r of scored) {
      const pct = `${Math.round(r.coverage.share * 100)}%`;
      console.log(
        `    слово ${String(r.coverage.at + 1).padStart(2)}, ${pct.padStart(4)}` +
          `  «${r.label}»  →  «${(r.coverage.name ?? "").slice(0, 80)}»` +
          `  (${r.coverage.matchedWords} из ${r.coverage.rowWords}` +
          `, записей ${r.coverage.records})`,
      );
    }
    console.log("");

    // Примерка правила. Ничего не меняет — только показывает, что было бы.
    //
    // Подтверждаем продукт, если нашлась запись, где выполнено хотя бы одно:
    //   — совпадение с ПЕРВОГО слова названия («Полиэтилен высокого давления»);
    //   — совпадение внутри короткой скобки, то есть с синонимом продукта
    //     («Изопропилбензол (кумол)»);
    //   — совпали два и более значимых слова в начале названия («Фракция
    //     альфа-олефинов C₈»).
    // Иначе это слово, случайно оказавшееся в середине чужого названия.
    const REASONS = [
      ["первое слово", (c) => c.head],
      ["скобка-синоним", (c) => c.parens],
      ["два слова", (c) => c.pair],
      ["второе слово", (c) => c.second],
      ["в составе препарата", (c) => c.formulation],
    ];
    const verdict = (c) => REASONS.find(([, has]) => has(c))?.[0] ?? null;
    const evidence = (c) => REASONS.find(([, has]) => has(c))?.[1](c) ?? "";

    const confirmed = rows.filter((r) => r.found && r.coverage);
    const dropped = confirmed.filter((r) => !verdict(r.coverage));

    console.log("── ПРИМЕРКА ПРАВИЛА (ничего не меняет) ──\n");
    console.log(
      `  Было подтверждено: ${confirmed.length}` +
        `   ·   осталось бы: ${confirmed.length - dropped.length}` +
        `   ·   отсеялось бы: ${dropped.length}`,
    );

    const byReason = new Map();
    for (const r of confirmed) {
      const v = verdict(r.coverage);
      if (v) byReason.set(v, (byReason.get(v) ?? 0) + 1);
    }
    console.log(
      `  Чем удержались: ${[...byReason].map(([k, n]) => `${k}: ${n}`).join(", ")}`,
    );

    console.log("\n  ОТСЕЯЛОСЬ БЫ — проверьте, нет ли тут нужного:");
    for (const r of dropped) {
      console.log(
        `    слово ${String(r.coverage.at + 1).padStart(2)}  «${r.label}»` +
          `  →  «${(r.coverage.name ?? "").slice(0, 80)}»`,
      );
    }

    // Удержавшиеся не первым словом — второе место, где правило может ошибаться.
    console.log("\n  УДЕРЖАЛОСЬ БЫ не первым словом — проверьте, нет ли тут мусора:");
    for (const r of confirmed) {
      const v = verdict(r.coverage);
      if (!v || v === "первое слово") continue;
      console.log(
        `    ${v.padEnd(19)}  «${r.label}»` +
          `  →  «${String(evidence(r.coverage)).slice(0, 80)}»`,
      );
    }
    console.log("");
  }

  if (
    !wantMissing &&
    !wantAbsent &&
    !wantWeak &&
    !wantTwins &&
    !wantMerged &&
    !wantCoverage
  ) {
    console.log(
      "\nСписки: --missing (дописать в справочник), --absent (нет в реестре)," +
        " --weak (сомнительные совпадения), --twins (подписи-близнецы)," +
        " --merged (слитые строки справочника)," +
        " --coverage (замер под порог по доле слов записи)",
    );
  }
}

main();
