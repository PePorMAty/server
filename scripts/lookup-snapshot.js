#!/usr/bin/env node
//
// Снимок того, что реестр отвечает на наши названия, — и сравнение двух таких
// снимков.
//
//   node scripts/lookup-snapshot.js --out ДО.json        снять снимок
//   node scripts/lookup-snapshot.js ДО.json ПОСЛЕ.json   сравнить два снимка
//
//   --names-from ФАЙЛ   взять названия из файла (по одному в строке) вместо
//                       справочника и графов
//   --limit N           только первые N названий — для быстрой пробы
//   --quiet             не печатать ход работы
//
// ЗАЧЕМ. База реестра меняется: её пересобирают из новой выгрузки, добавляют
// классы ОКПД2, правят правило совпадения. После каждой такой перемены надо
// ответить на три вопроса, и ни на один из них нельзя ответить, глядя только
// на новую базу:
//
//   • что нашлось ВПЕРВЫЕ — ради этого всё и затевалось;
//   • что ПРОПАЛО — этого быть не должно, и если есть, разбираться сразу;
//   • какие ЗАПИСИ добавились к уже найденному — вот здесь и прячутся ложные
//     совпадения. Расширив реестр вдвое, легко получить к верному совпадению
//     второе, неверное, и по одному лишь числу «нашлось» этого не увидеть.
//
// Отсюда порядок: снимок снимается ДО перемены. После — второй, и сравнение.
// Снимок, снятый только после, не стоит ничего.
//
// ЧТО В СНИМКЕ. Для каждого названия: нашлось ли, какой ступенью лестницы,
// код ОКПД2, сколько записей и производителей, и — главное — ИМЕНА
// подтверждённых записей. Числа говорят, что изменилось; имена говорят, чем
// именно, и только по ним видно, верное совпадение или нет.

const fs = require("fs");
const path = require("path");

const { lookupProduct, status } = require("../routes/industry/utils/store");
const { allEntries, synonymsStatus } = require("../routes/industry/utils/synonyms");

const GRAPHS_DIR = path.resolve(__dirname, "../data/saved-graphs");

/** Ступени лестницы поиска на человеческом языке — те же, что в query-gisp. */
const MATCH_LABELS = {
  exact: "точно",
  "all-words": "все слова",
  "core-words": "значимые слова",
  partial: "часть слов",
  prefix: "по началу слова",
};

/* ───────────────────────── откуда берём названия ───────────────────────── */

/** Названия продуктов из сохранённого графа. */
function productLabels(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  // Формат сохранения менялся: узлы лежат то в graph.nodes, то в корне.
  const nodes = parsed?.graph?.nodes ?? parsed?.nodes ?? [];
  const out = [];
  for (const n of nodes) {
    if (n?.type !== "product") continue;
    const label = String(n?.data?.label ?? "").trim();
    if (label) out.push(label);
  }
  return out;
}

/**
 * Набор названий, по которому снимается снимок.
 *
 * Два источника, и оба нужны. Справочник даёт устойчивый набор: он не зависит
 * от того, какие графы сегодня сохранены, поэтому снимки сравнимы между собой
 * и через месяц. Графы дают названия, которые люди пишут НА САМОМ ДЕЛЕ, — их в
 * справочнике может и не быть, а найтись они обязаны.
 */
function collectNames(fromFile) {
  if (fromFile) {
    return [
      ...new Set(
        fs
          .readFileSync(fromFile, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#")),
      ),
    ].sort((a, b) => a.localeCompare(b, "ru"));
  }

  const names = new Set();
  let graphs = 0;
  for (const entry of allEntries()) names.add(entry.canon);
  if (fs.existsSync(GRAPHS_DIR)) {
    for (const file of fs.readdirSync(GRAPHS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const labels = productLabels(path.join(GRAPHS_DIR, file));
      if (labels.length) graphs += 1;
      for (const label of labels) names.add(label);
    }
  }
  return Object.assign([...names].sort((a, b) => a.localeCompare(b, "ru")), {
    graphs,
  });
}

/* ────────────────────────────── снимок ────────────────────────────── */

/**
 * Что записываем про одно название.
 *
 * Имена подтверждённых записей — не украшение отчёта, а его суть: по числам
 * видно, что совпадений стало больше, и только по именам — стали они верными
 * или ложными. Сортируем, чтобы сравнение не спотыкалось о порядок строк.
 */
function probe(name) {
  const r = lookupProduct(name);
  if (!r?.found) {
    return { found: false, canon: r?.canon ?? null, cas: r?.cas ?? null };
  }
  const records = [...new Set((r.producers ?? []).map((p) => p.product))].sort(
    (a, b) => a.localeCompare(b, "ru"),
  );
  return {
    found: true,
    match: r.match ?? null,
    okpd2: r.okpd2 ?? null,
    okpd2Name: r.okpd2Name ?? null,
    okpd2Retired: Boolean(r.okpd2Retired),
    entries: r.entryCount ?? 0,
    producers: r.producerCount ?? 0,
    rejected: r.rejected ?? 0,
    canon: r.canon ?? null,
    cas: r.cas ?? null,
    records,
  };
}

function takeSnapshot(names, outFile, quiet) {
  const reg = status();
  if (!reg.ready) {
    console.error(
      "База реестра не прочитана. Снимок снимать не с чего.\n" +
        "Проверьте data/gisp.sqlite или переменную GISP_DB_PATH.",
    );
    process.exit(1);
  }

  const results = {};
  let found = 0;
  for (let i = 0; i < names.length; i++) {
    const r = probe(names[i]);
    results[names[i]] = r;
    if (r.found) found += 1;
    if (!quiet && (i + 1) % 100 === 0) {
      console.log(`  опрошено названий: ${i + 1} из ${names.length}`);
    }
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    registry: {
      entries: reg.entries ?? null,
      products: reg.products ?? null,
      producers: reg.producers ?? null,
      actualAt: reg.actualAt ?? null,
    },
    dictionary: {
      entries: synonymsStatus().entries,
      spellings: synonymsStatus().spellings,
    },
    names: names.length,
    found,
    results,
  };

  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 1), "utf8");
  console.log(
    `\nСнимок записан: ${outFile}\n` +
      `  названий: ${names.length}, нашлось: ${found}` +
      ` (${Math.round((found / Math.max(names.length, 1)) * 100)}%)\n` +
      `  реестр: ${reg.entries} записей, актуально на ${reg.actualAt ?? "—"}`,
  );
}

/* ────────────────────────────── сравнение ────────────────────────────── */

function readSnapshot(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Не прочитать снимок ${file}: ${e.message}`);
    process.exit(1);
  }
  if (!parsed?.results) {
    console.error(`${file} не похож на снимок: нет поля results.`);
    process.exit(1);
  }
  return parsed;
}

/** Строки, которых нет во втором списке. */
const added = (before, after) => after.filter((x) => !before.includes(x));

function compare(fileA, fileB) {
  const a = readSnapshot(fileA);
  const b = readSnapshot(fileB);

  console.log(
    `ДО:    ${path.basename(fileA)} — реестр ${a.registry?.entries ?? "?"} записей,` +
      ` нашлось ${a.found} из ${a.names}\n` +
      `ПОСЛЕ: ${path.basename(fileB)} — реестр ${b.registry?.entries ?? "?"} записей,` +
      ` нашлось ${b.found} из ${b.names}`,
  );

  const names = [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].sort(
    (x, y) => x.localeCompare(y, "ru"),
  );

  const gained = [];
  const lost = [];
  const codeChanged = [];
  const newRecords = [];
  const onlyInB = [];
  const onlyInA = [];
  let same = 0;

  for (const name of names) {
    const x = a.results[name];
    const y = b.results[name];
    // Набор названий мог измениться между снимками — справочник растёт, графы
    // добавляются. Считаем такие отдельно: сравнивать их не с чем.
    if (!x) {
      onlyInB.push(name);
      continue;
    }
    if (!y) {
      onlyInA.push(name);
      continue;
    }

    if (!x.found && y.found) {
      gained.push([name, y]);
      continue;
    }
    if (x.found && !y.found) {
      lost.push([name, x]);
      continue;
    }
    if (!x.found && !y.found) {
      same += 1;
      continue;
    }

    const fresh = added(x.records ?? [], y.records ?? []);
    const gone = added(y.records ?? [], x.records ?? []);
    const codeMoved = x.okpd2 !== y.okpd2;

    if (codeMoved) codeChanged.push([name, x, y]);
    if (fresh.length || gone.length) newRecords.push([name, x, y, fresh, gone]);
    if (!codeMoved && !fresh.length && !gone.length) same += 1;
  }

  const head = (title, n) => console.log(`\n── ${title}: ${n} ──`);

  // Пропажи — первыми и всегда целиком. Это единственная категория, которой
  // быть не должно: расширение реестра не может отнять то, что находилось.
  head("ПРОПАЛО (не должно быть ничего)", lost.length);
  if (!lost.length) console.log("  пусто — хорошо");
  for (const [name, x] of lost) {
    console.log(`  «${name}» — было ${x.entries} записей, код ${x.okpd2 ?? "—"}`);
    for (const r of (x.records ?? []).slice(0, 3)) console.log(`      ${r.slice(0, 90)}`);
  }

  head("ЗАПИСИ ИЗМЕНИЛИСЬ у уже найденного — СМОТРЕТЬ ГЛАЗАМИ", newRecords.length);
  if (!newRecords.length) console.log("  пусто");
  console.log(
    newRecords.length
      ? "  Здесь прячутся ложные совпадения: к верной записи могла добавиться\n" +
          "  чужая. Читайте названия — числа тут ничего не скажут.\n" +
          "  «+» прибавилось, «−» убыло.\n"
      : "",
  );
  for (const [name, x, y, fresh, gone] of newRecords) {
    console.log(`  «${name}»  ${x.entries} → ${y.entries} записей`);
    for (const r of fresh.slice(0, 6)) console.log(`      + ${r.slice(0, 90)}`);
    if (fresh.length > 6) console.log(`      + … и ещё ${fresh.length - 6}`);
    for (const r of gone.slice(0, 3)) console.log(`      − ${r.slice(0, 90)}`);
  }

  head("ДРУГОЙ КОД ОКПД2", codeChanged.length);
  for (const [name, x, y] of codeChanged) {
    console.log(
      `  «${name}»: ${x.okpd2 ?? "—"} → ${y.okpd2 ?? "—"}` +
        `\n      было:  ${x.okpd2Name ?? "—"}` +
        `\n      стало: ${y.okpd2Name ?? "—"}`,
    );
  }

  head("НАШЛОСЬ ВПЕРВЫЕ — тоже смотреть глазами", gained.length);
  if (gained.length) {
    console.log(
      "  Найтись можно и неверно: вещества в реестре по-прежнему может не быть,\n" +
        "  а совпасть — чужая запись. Читайте названия.\n",
    );
  }
  for (const [name, y] of gained) {
    console.log(
      `  «${name}» → ${y.entries} записей, ${y.producers} производителей,` +
        ` код ${y.okpd2 ?? "—"} [${MATCH_LABELS[y.match] ?? y.match ?? "—"}]`,
    );
    for (const r of (y.records ?? []).slice(0, 3)) console.log(`      ${r.slice(0, 90)}`);
    if ((y.records ?? []).length > 3) {
      console.log(`      … и ещё ${y.records.length - 3}`);
    }
  }

  if (onlyInB.length) {
    head("названия, которых не было в первом снимке", onlyInB.length);
    console.log(`  ${onlyInB.slice(0, 20).join(", ")}${onlyInB.length > 20 ? " …" : ""}`);
  }
  if (onlyInA.length) {
    head("названия, пропавшие из набора", onlyInA.length);
    console.log(`  ${onlyInA.slice(0, 20).join(", ")}${onlyInA.length > 20 ? " …" : ""}`);
  }

  console.log(
    `\n══ ИТОГ ══\n` +
      `  без изменений:      ${same}\n` +
      `  нашлось впервые:    ${gained.length}\n` +
      `  пропало:            ${lost.length}${lost.length ? "   ← разобраться" : ""}\n` +
      `  новые записи:       ${newRecords.length}${newRecords.length ? "   ← прочитать названия" : ""}\n` +
      `  сменился код ОКПД2: ${codeChanged.length}`,
  );

  // Ненулевой код — только на пропажах: это единственное, что заведомо плохо.
  // Новые записи бывают и верными, и решает их человек, а не выход скрипта.
  process.exit(lost.length ? 1 : 0);
}

/* ────────────────────────────── запуск ────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  let out = null;
  let namesFrom = null;
  let limit = 0;
  let quiet = false;
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--names-from") namesFrom = argv[++i];
    else if (a === "--limit") limit = Number(argv[++i]) || 0;
    else if (a === "--quiet") quiet = true;
    else if (!a.startsWith("--")) files.push(a);
  }

  if (files.length === 2 && !out) return compare(files[0], files[1]);

  if (!out) {
    console.error(
      "Снять снимок:   node scripts/lookup-snapshot.js --out ДО.json\n" +
        "Сравнить:       node scripts/lookup-snapshot.js ДО.json ПОСЛЕ.json\n\n" +
        "Снимок снимается ДО перемены в базе. Снятый только после — бесполезен:\n" +
        "сравнивать его будет не с чем.",
    );
    process.exit(1);
  }

  let names = collectNames(namesFrom);
  const graphs = names.graphs;
  if (limit) names = names.slice(0, limit);
  if (!names.length) {
    console.error("Не набралось ни одного названия.");
    process.exit(1);
  }
  if (!quiet) {
    console.log(
      namesFrom
        ? `Названий из файла: ${names.length}`
        : `Названий: ${names.length}` +
            ` (справочник + продукты с ${graphs ?? 0} сохранённых графов)`,
    );
  }
  takeSnapshot(names, out, quiet);
}

main();
