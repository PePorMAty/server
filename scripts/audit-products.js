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
//   node scripts/audit-products.js --abbr       — что приносят короткие сокращения
//   node scripts/audit-products.js --coverage   — замер под порог по доле слов записи
//   node scripts/audit-products.js --near       — где справочник окупится
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

const {
  identify,
  synonymsStatus,
  allEntries,
} = require("../routes/industry/utils/synonyms");
const { lookupProduct, status } = require("../routes/industry/utils/store");
const {
  foldLookalikes,
  normalizeName,
  stemName,
  words,
} = require("../routes/industry/utils/normalize");

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

/**
 * Значимые основы названия: коротышки и цифры в сравнении только мешают.
 *
 * «1,3-Диизопропилбензол» и «1,4-Диизопропилбензол» — РАЗНЫЕ изомеры, и
 * различает их как раз отброшенная цифра. Поэтому отчёт и остаётся отчётом:
 * он показывает, куда посмотреть, а решает человек.
 */
function meaningfulStems(name) {
  return new Set(words(stemName(name)).filter((w) => w.length > 3));
}

/**
 * Метки, которыми различаются члены одного семейства: «1,3-» и «1,4-», «F» и
 * «S», «22» и «134».
 *
 * Именно их сравнение основ и отбрасывает — и без этой проверки отчёт ставил
 * бы 100% изомерам «1,3-Диизопропилбензол» и «1,4-Диизопропилбензол», то есть
 * подсказывал бы слить два РАЗНЫХ вещества. Метки разошлись — значит, это
 * семейство, а не разные имена одного.
 */
function marksOf(name) {
  // Берём слова БЕЗ отсева стоп-слов, в отличие от основ. Русские «а», «с»,
  // «о» — предлоги и союзы, и words() их выбрасывает. А в «БФ-А» и «БФ-С»
  // именно эта буква и есть всё различие: с отсевом они выглядели одинаково,
  // и отчёт предлагал слить два разных эпоксидных олигомера.
  return new Set(
    normalizeName(name)
      .split(" ")
      .filter((w) => w && w.length <= 3),
  );
}

/** Совпадают ли метки двух названий. */
function sameMarks(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Основы считаются одной, только если они СОВПАДАЮТ.
 *
 * Сперва тут было вхождение одной основы в другую — и это оказалось для химии
 * правилом наоборот. Первый же прогон на живых данных выдал «Циклогексан ≈
 * Циклогексанол», «Тетрафторэтилен ≈ Этилен», «2,4 Дихлорфенол ≈ Фенол»,
 * «Тетрагидрофуран ≈ Политетрагидрофуран»: из полусотни пар верными были
 * примерно десять. В химических названиях вхождение одного имени в другое —
 * норма, и означает оно «производное от», а не «то же самое».
 *
 * Что теряется: пары, различающиеся началом слова, — «12-оксистеариновая» и
 * «12-гидроксистеариновая». Их придётся ловить глазами. Обмен того стоит:
 * сорок ложных пар против одной верной.
 *
 * И раньше, и теперь мера не видит переставленных частей внутри слова:
 * «Хлордифторметан» и «Дифторхлорметан» — одно вещество, а общего в основах
 * ничего. Эту пару нашла добыча из реестра.
 */
function stemAlike(a, b) {
  return a === b;
}

/**
 * Насколько два названия похожи: доля общих основ от длинного из них.
 *
 * Делим на большее, а не на объединение: иначе «Смазки для шарниров» и
 * «Смазки для прокатного цеха» считались бы похожими по одному слову
 * «смазка», а это разные продукты.
 */
function closeness(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) {
    for (const y of b) {
      if (stemAlike(x, y)) {
        shared += 1;
        break;
      }
    }
  }
  return shared / Math.max(a.size, b.size);
}

function main() {
  const args = process.argv.slice(2);
  const wantMissing = args.includes("--missing");
  const wantAbsent = args.includes("--absent");
  const wantWeak = args.includes("--weak");
  const wantTwins = args.includes("--twins");
  const wantMerged = args.includes("--merged");
  const wantAbbr = args.includes("--abbr");
  const wantCoverage = args.includes("--coverage");
  const wantNear = args.includes("--near");
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

  // Тревоги по номерам CAS печатаются всегда, как и конфликты: неверный
  // международный номер хуже отсутствующего, и прятать его за флагом нельзя.
  if (syn.badCas?.length) {
    console.log("\n── НОМЕРА CAS С ОПЕЧАТКОЙ (не сошлась контрольная цифра) ──");
    for (const b of syn.badCas) {
      console.log(`  «${b.canon}»: ${b.cas} (${b.from}) — номер отброшен`);
    }
  }
  if (syn.casConflicts?.length) {
    console.log("\n── ОДНОМУ ВЕЩЕСТВУ ДВА РАЗНЫХ НОМЕРА CAS ──");
    for (const c of syn.casConflicts) {
      console.log(`  «${c.canon}»: оставлен ${c.kept}, отброшен ${c.ignored} (${c.ignoredFrom})`);
    }
  }
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
      /** Сколько записей отбор отбросил как «слово попало в чужое название». */
      rejected: hit?.rejected ?? 0,
      /** Нашлось только в составе препарата. */
      viaFormulation: hit?.viaFormulation ?? false,
      /** Записи нашлись, но ни одна не про этот продукт. */
      offTarget: hit?.weak?.offTarget ?? false,
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

  // Короткие сокращения справочника: что они приносят из реестра.
  //
  // «МЭК» — метилэтилкетон, но ещё и Международная электротехническая
  // комиссия, и по нему находились трубы «ГОСТ МЭК». «ПЭС» — полиэфирсульфон,
  // но ещё и полиэтилсилоксан, то есть ДРУГОЕ вещество. «D4» — циклосилоксан,
  // но ещё и шины Nokian WR D4.
  //
  // Шапка справочника запрещает класть такие сокращения, но запрет держится на
  // внимательности: глазами «ПЭС» от «ПВХ» не отличить, разница только в том,
  // что лежит в реестре. Поэтому судим по данным — что каждое сокращение
  // приносит НА САМОМ ДЕЛЕ, если узел графа назвать ровно так.
  if (wantAbbr) {
    const LIMIT = 4;
    console.log(
      `\n── Что приносят сокращения короче ${LIMIT + 1} знаков ──\n` +
        "  Подтверждённые записи должны быть про само вещество. Если это\n" +
        "  посторонний товар — сокращение надо убрать из справочника.\n",
    );
    const seen = new Set();
    const short = [];
    for (const e of allEntries()) {
      for (const spelling of e.spellings) {
        const bare = spelling.replace(/[^0-9a-zа-яё]/gi, "");
        if (bare.length > LIMIT || seen.has(spelling)) continue;
        seen.add(spelling);
        short.push([spelling, e.canon]);
      }
    }
    short.sort((a, b) => a[0].localeCompare(b[0], "ru"));

    let noisy = 0;
    for (const [spelling, canon] of short) {
      const r = lookupProduct(spelling);
      if (!r?.found) continue;
      const names = [...new Set((r.producers ?? []).map((p) => p.product))];
      // Тревога, когда ни в одном подтверждённом названии нет самого
      // канонического слова: значит, сокращение привело куда-то не туда.
      const stem = stemName(canon).split(" ")[0];
      const onTarget = names.some((n) => stemName(n).includes(stem));
      if (!onTarget) noisy += 1;
      console.log(
        `  ${onTarget ? "   " : "!!!"} «${spelling}» → ${canon}` +
          `   ${r.entryCount} записей, ${r.producerCount} производителей`,
      );
      for (const n of names.slice(0, 3)) console.log(`         ${n.slice(0, 80)}`);
    }
    console.log(
      `\n  Сокращений проверено: ${short.length}, нашли записи и увели не туда: ${noisy}` +
        (noisy ? "   (помечены !!!)" : ""),
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

    // Чем подтвердилось — и что отбор отбросил.
    //
    // Правило теперь работает в самом отборе (store.js, confirms), так что
    // это уже не примерка, а отчёт о сделанном: по какому основанию каждый
    // продукт удержался и сколько чужих записей отброшено.
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
    const offTarget = rows.filter((r) => r.offTarget);
    const trimmed = confirmed.filter((r) => r.rejected > 0);

    console.log("── ЧЕМ ПОДТВЕРДИЛОСЬ И ЧТО ОТБРОШЕНО ──\n");

    const byReason = new Map();
    for (const r of confirmed) {
      const v = verdict(r.coverage);
      if (v) byReason.set(v, (byReason.get(v) ?? 0) + 1);
    }
    console.log(
      `  Подтверждено: ${confirmed.length}` +
        `  (${[...byReason].map(([k, n]) => `${k}: ${n}`).join(", ")})`,
    );
    console.log(
      `  Отброшено целиком: ${offTarget.length}` +
        " — записи нашлись, но ни одна не про этот продукт",
    );
    console.log(
      `  Отброшено частично: ${trimmed.length}` +
        " — часть записей чужая, остальные подтверждают",
    );

    console.log("\n  ОТБРОШЕНО ЦЕЛИКОМ — проверьте, нет ли тут нужного:");
    if (!offTarget.length) console.log("    пусто");
    for (const r of offTarget) {
      console.log(`    «${r.label}»  →  «${String(r.weak?.sample ?? "").slice(0, 80)}»`);
    }

    // Удержавшиеся не первым словом — место, где правило может ошибаться.
    console.log("\n  УДЕРЖАЛОСЬ не первым словом — проверьте, нет ли тут мусора:");
    let shown = 0;
    for (const r of confirmed) {
      const v = verdict(r.coverage);
      if (!v || v === "первое слово") continue;
      shown += 1;
      console.log(
        `    ${v.padEnd(19)}  «${r.label}»` +
          `  →  «${String(evidence(r.coverage)).slice(0, 80)}»`,
      );
    }
    if (!shown) console.log("    пусто");
    console.log("");
  }

  // Где справочник окупится.
  //
  // Список «не знает никто» отвечает на вопрос «чего нет», а это не тот
  // вопрос. Голая запись без синонимов поднимает счётчик и не даёт НИЧЕГО:
  // два узла с одинаковой подписью сходятся и без справочника, а поиск по
  // реестру по единственному написанию идёт и так. Польза ровно там, где одно
  // вещество названо ПО-РАЗНОМУ, — вот это здесь и ищется.
  if (wantNear) {
    const unknown = rows.filter((r) => !r.canon);

    console.log("\n── ПОХОЖИЕ ДРУГ НА ДРУГА среди неопознанных ──");
    console.log("   (одна запись в справочнике свела бы их в один узел)\n");

    const stemmed = unknown.map((r) => ({
      row: r,
      key: foldLookalikes(normalizeName(r.label)),
      stems: meaningfulStems(r.label),
      marks: marksOf(r.label),
    }));
    const pairs = [];
    let families = 0;
    let cosmetic = 0;
    for (let i = 0; i < stemmed.length; i++) {
      for (let j = i + 1; j < stemmed.length; j++) {
        // Подписи, совпадающие после приведения, сходятся на полотне и без
        // справочника: «1,3-Диизопропилбензол» и «1,3- Диизопропилбензол»
        // различает лишний пробел. Аудит считает по сырым подписям, поэтому
        // видит их порознь, — но работы тут нет, и в отчёте им не место.
        if (stemmed[i].key === stemmed[j].key) {
          cosmetic += 1;
          continue;
        }
        const score = closeness(stemmed[i].stems, stemmed[j].stems);
        if (score < 0.6) continue;
        if (!sameMarks(stemmed[i].marks, stemmed[j].marks)) {
          families += 1;
          continue;
        }
        pairs.push({ a: stemmed[i].row, b: stemmed[j].row, score });
      }
    }
    pairs.sort((x, y) => y.score - x.score || y.a.freq - x.a.freq);
    if (!pairs.length) console.log("   пусто");
    for (const p of pairs.slice(0, 60)) {
      console.log(
        `   ${Math.round(p.score * 100)}%  «${p.a.label}»  ≈  «${p.b.label}»` +
          `   (графов: ${p.a.freq} и ${p.b.freq})`,
      );
    }
    if (pairs.length > 60) console.log(`   … и ещё ${pairs.length - 60}`);
    if (cosmetic) {
      console.log(
        `\n   Пропущено как разнобой в подписи: ${cosmetic}` +
          " — различаются пробелом или регистром,\n   на полотне сходятся и так.",
      );
    }
    if (families) {
      console.log(
        `\n   Отброшено как семейства, а не синонимы: ${families}` +
          " — названия похожи, но различаются меткой" +
          "\n   («1,3-» против «1,4-», «F» против «S»), то есть это РАЗНЫЕ вещества.",
      );
    }

    // Второй случай: название почти совпадает с тем, что в справочнике уже
    // есть. Ключ справочника точный, без усечения окончаний, поэтому
    // «Базовые масла» мимо «Базового масла» проходит молча.
    const dict = allEntries().flatMap((e) =>
      e.spellings.map((s) => ({ canon: e.canon, spelling: s, stems: meaningfulStems(s) })),
    );
    const nearDict = [];
    let dictFamilies = 0;
    for (const u of stemmed) {
      let best = null;
      for (const d of dict) {
        const score = closeness(u.stems, d.stems);
        if (score < 0.8) continue;
        // Отсев семейств нужен и здесь, не только в списке пар. Без него
        // «Фракция С5» подсказывала дописать себя в «Фракцию C4», а все шесть
        // бисфенолов — в «Бисфенол А»: основы у них те же, а метка разная.
        if (!sameMarks(u.marks, marksOf(d.spelling))) {
          dictFamilies += 1;
          continue;
        }
        if (!best || score > best.score) best = { ...d, score };
      }
      if (best) nearDict.push({ row: u.row, ...best });
    }
    nearDict.sort((x, y) => y.row.freq - x.row.freq || y.score - x.score);

    console.log("\n── ПОЧТИ СОВПАДАЮТ С ТЕМ, ЧТО В СПРАВОЧНИКЕ УЖЕ ЕСТЬ ──");
    console.log("   (хватит дописать написание в существующую строку)\n");
    if (!nearDict.length) console.log("   пусто");
    for (const n of nearDict.slice(0, 60)) {
      console.log(
        `   ${Math.round(n.score * 100)}%  «${n.row.label}»  →  «${n.spelling}»` +
          (n.spelling === n.canon ? "" : ` (запись «${n.canon}»)`) +
          `   графов: ${n.row.freq}`,
      );
    }
    if (nearDict.length > 60) console.log(`   … и ещё ${nearDict.length - 60}`);
    if (dictFamilies) {
      console.log(
        `\n   Отброшено как семейства: ${dictFamilies} — например «Фракция С5»` +
          " при «Фракции C4»,\n   «Бисфенол F» при «Бисфеноле А»: основы те же, метка разная.",
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
    !wantCoverage &&
    !wantNear
  ) {
    console.log(
      "\nСписки: --missing (дописать в справочник), --absent (нет в реестре)," +
        " --weak (сомнительные совпадения), --twins (подписи-близнецы)," +
        " --merged (слитые строки справочника)," +
        " --coverage (замер под порог по доле слов записи)," +
        " --near (где справочник окупится)",
    );
  }
}

main();
