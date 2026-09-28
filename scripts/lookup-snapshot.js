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
//   --full              при сравнении показать все пришедшие записи, а не
//                       первые названия каждой группы (ушедшие — всегда все)
//
// ЗАЧЕМ. База реестра меняется: её пересобирают из новой выгрузки, добавляют
// классы ОКПД2, правят правило совпадения. После каждой такой перемены надо
// ответить на три вопроса, и ни на один из них нельзя ответить, глядя только
// на новую базу:
//
//   • что нашлось ВПЕРВЫЕ — ради этого всё и затевалось;
//   • что ПРОПАЛО — этого быть не должно, и если есть, разбираться сразу.
//     Особняком стоит подпись, которая перестала считаться названием
//     вещества («Новый продукт», «Новый»): по ней реестр не спрашивают
//     намеренно, и в пропажи она не идёт;
//   • какие ЗАПИСИ добавились к уже найденному — вот здесь и прячутся ложные
//     совпадения. Расширив реестр вдвое, легко получить к верному совпадению
//     второе, неверное, и по одному лишь числу «нашлось» этого не увидеть.
//
// Отсюда порядок: снимок снимается ДО перемены. После — второй, и сравнение.
// Снимок, снятый только после, не стоит ничего.
//
// ЧТО В СНИМКЕ. Для каждого названия: нашлось ли, какой ступенью лестницы,
// код ОКПД2, сколько записей и производителей, и — главное — ИМЕНА
// подтверждённых записей, все до одной, и основание отбора по каждой. Числа
// говорят, что изменилось; имена говорят, чем именно, и только по ним видно,
// верное совпадение или нет. Основание говорит, почему: запись ушла по
// запрету отбора или поиск перестал её находить.

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
 * Записи снимка — все подтверждённые, или по одной на производителя.
 *
 * Раньше в снимок шло по одной записи от каждого производителя, как их отдаёт
 * карточке lookupProduct, да ещё без повторов. На сравнении это прятало
 * большую часть перемен: у «Изопропанола» ушло 65 записей из 80, а в отчёте
 * стояла одна строка «−». Одинаковые названия сливались в одно, а от
 * производителя с десятком записей в снимок попадала одна. Теперь
 * записи берутся из разбора (explain) — все до одной, с повторами. Разбор есть
 * у кода начиная с 3851ba0; снимок более старым кодом записывает по-старому и
 * так и помечается, чтобы сравнение не приняло разницу способов за перемену
 * поиска.
 */
let perProducer = false;

/**
 * Основания отбора по названиям записей: why — чем подтверждены, whyNot —
 * почему отброшены.
 *
 * Порознь, потому что у одного названия бывают обе судьбы сразу: из двух
 * записей «Кислород газообразный медицинский» одна стоит под кодом лекарства,
 * другая нет. Когда основание было одно на название, отчёт видел только
 * подтверждённую и писал про ушедшую «одинаковых записей стало меньше» —
 * без причины, которую как раз и надо было проверить.
 *
 * Map, а не объект: названия записей — чужие строки, и «constructor» среди
 * них не должен ничего сломать.
 */
function reasonsOf(explained) {
  const kept = new Map();
  const dropped = new Map();
  for (const e of explained) {
    if (!e?.why) continue;
    const m = e.confirmed ? kept : dropped;
    if (!m.has(e.name)) m.set(e.name, e.why);
  }
  return {
    why: kept.size ? Object.fromEntries(kept) : null,
    whyNot: dropped.size ? Object.fromEntries(dropped) : null,
  };
}

/**
 * Что записываем про одно название.
 *
 * Имена подтверждённых записей — не украшение отчёта, а его суть: по числам
 * видно, что совпадений стало больше, и только по именам — стали они верными
 * или ложными. Сортируем, чтобы сравнение не спотыкалось о порядок строк.
 *
 * why и whyNot — основания по названиям записей: чем подтверждена («первое
 * слово») и каким запретом отброшена («изделие «из» вещества»). По ним
 * сравнение говорит, почему запись пришла или ушла.
 */
function probe(name) {
  const r = lookupProduct(name, { explain: true });
  const explained = Array.isArray(r?.explain) ? r.explain : null;
  const { why = null, whyNot = null } = explained ? reasonsOf(explained) : {};
  const reasons = { ...(why ? { why } : {}), ...(whyNot ? { whyNot } : {}) };
  if (!r?.found) {
    return {
      found: false,
      // Реестр по такому названию не спрашивали вовсе: оно не называет
      // вещества («Новый продукт», «Новый»). Пропажа по этой причине — не
      // потеря, и в одну кучу с настоящей её класть нельзя.
      ...(r?.placeholder ? { placeholder: true } : {}),
      canon: r?.canon ?? null,
      cas: r?.cas ?? null,
      ...reasons,
    };
  }
  if (!explained) perProducer = true;
  const records = (
    explained
      ? explained.filter((e) => e.confirmed).map((e) => e.name)
      : [...new Set((r.producers ?? []).map((p) => p.product))]
  ).sort((a, b) => a.localeCompare(b, "ru"));
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
    ...reasons,
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
    /** «all» — все подтверждённые записи с повторами; иначе по одной на производителя. */
    recordsMode: perProducer ? "per-producer" : "all",
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

/** Сколько раз встречается каждое название в списке записей. */
function tally(list) {
  const m = new Map();
  for (const x of list ?? []) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/**
 * Каких записей во втором списке больше, чем в первом: [[название, на сколько]].
 *
 * Считаем с повторами: одно название стоит в реестре записью на каждого
 * производителя и каждую регистрацию, и «Средство дезинфицирующее ОЗАЛИЗ
 * (изопропанол)» уходит десятками записей, а не одной.
 */
function surplus(before, after) {
  const was = tally(before);
  const out = [];
  for (const [name, n] of tally(after)) {
    const d = n - (was.get(name) ?? 0);
    if (d > 0) out.push([name, d]);
  }
  return out.sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0], "ru"));
}

/** Поле объекта — только собственное: названия записей — чужие строки. */
const own = (obj, key) =>
  obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;

/** «1 запись», «3 записи», «65 записей». */
function recordsWord(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} запись`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} записи`;
  return `${n} записей`;
}

/**
 * Почему запись ушла — по снимку ПОСЛЕ.
 *
 * Три случая, и смысл у них разный. Запись нашлась, но её отбросил запрет —
 * тогда в снимке есть основание, и проверять надо запрет. Запись не нашлась
 * вовсе — поиск перестал её доставать (написание получило звёздочку, ступень
 * сменилась). Название осталось, одинаковых записей стало меньше, а
 * основания отказа нет — редкий случай, когда запрос упёрся в предел выдачи.
 *
 * Снимки прежнего образца держали одно основание на название, и отказ
 * лежал в why; его берём, только если название ушло целиком.
 */
function goneReasonOf(y, reasonsKnown) {
  const still = new Set(y?.records ?? []);
  return (name) => {
    const not = own(y?.whyNot, name) ?? (still.has(name) ? undefined : own(y?.why, name));
    if (not) return `отбор: ${not}`;
    if (still.has(name)) return "одинаковых записей стало меньше";
    return reasonsKnown ? "больше не находится поиском" : undefined;
  };
}

/**
 * Напечатать записи группами по основанию.
 *
 * Группа — одно решение: «отбор: продукт с веществом внутри», «больше не
 * находится поиском». Так сотня строк читается как три решения, и проверять
 * надо решение, а не каждую строку порознь. Крупные группы — первыми.
 * cap — сколько названий показать в группе; 0 — все.
 */
function printGrouped(sign, items, reasonOf, cap) {
  const groups = new Map();
  for (const [name, n] of items) {
    const why = reasonOf(name) ?? "основание неизвестно";
    if (!groups.has(why)) groups.set(why, []);
    groups.get(why).push([name, n]);
  }
  const total = (list) => list.reduce((s, [, n]) => s + n, 0);
  const ordered = [...groups].sort((p, q) => total(q[1]) - total(p[1]));
  for (const [why, list] of ordered) {
    console.log(`      ${sign} ${why} — ${recordsWord(total(list))}:`);
    const shown = cap ? list.slice(0, cap) : list;
    for (const [name, n] of shown) {
      console.log(`          ${n > 1 ? `×${n} ` : ""}${name.slice(0, 90)}`);
    }
    if (shown.length < list.length) {
      console.log(`          … и ещё названий: ${list.length - shown.length} (все — ключ --full)`);
    }
  }
}

function compare(fileA, fileB, { full = false } = {}) {
  const a = readSnapshot(fileA);
  const b = readSnapshot(fileB);
  // Прибавки режем, убыль — никогда: пропавшая верная запись — потеря, и
  // спрятать её за «… и ещё» нельзя. Прибавок бывает сотни, когда поиск
  // расширяют, и там хватает первых названий каждой группы.
  const capPlus = full ? 0 : 10;

  console.log(
    `ДО:    ${path.basename(fileA)} — реестр ${a.registry?.entries ?? "?"} записей,` +
      ` нашлось ${a.found} из ${a.names}\n` +
      `ПОСЛЕ: ${path.basename(fileB)} — реестр ${b.registry?.entries ?? "?"} записей,` +
      ` нашлось ${b.found} из ${b.names}`,
  );

  // Записи сравнимы, только если оба снимка записаны одним способом.
  const comparable = (a.recordsMode ?? "per-producer") === (b.recordsMode ?? "per-producer");
  if (!comparable) {
    console.log(
      "\n⚠ Снимки записаны по-разному: один — всеми записями, другой — по одной\n" +
        "  на производителя. Записи не сравниваю: разница была бы в способе, а не\n" +
        "  в поиске. Снимите оба заново одной командой:\n" +
        "  bash scripts/snapshot-check.sh <коммит «до»>",
    );
  }
  // Основания есть только у снимка текущим кодом; у старого — нет, и тогда
  // «не находится поиском» утверждать нельзя: мы просто не знаем.
  const reasonsKnown = Object.values(b.results).some((r) => r?.why || r?.whyNot);

  const names = [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].sort(
    (x, y) => x.localeCompare(y, "ru"),
  );

  const gained = [];
  const lost = [];
  /** Пропало, потому что название перестало считаться названием вещества. */
  const refused = [];
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
      // Разные вещи: «находилось и перестало» — беда, а «спрашивать
      // перестали, потому что это не название вещества» — ровно то, чего
      // добивались.
      (y.placeholder ? refused : lost).push([name, x, y]);
      continue;
    }
    if (!x.found && !y.found) {
      same += 1;
      continue;
    }

    const fresh = comparable ? surplus(x.records, y.records) : [];
    const gone = comparable ? surplus(y.records, x.records) : [];
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
  for (const [name, x, y] of lost) {
    console.log(`  «${name}» — было ${recordsWord(x.entries)}, код ${x.okpd2 ?? "—"}`);
    printGrouped("−", surplus([], x.records), goneReasonOf(y, reasonsKnown), 0);
  }

  // Отдельно от пропаж: это не потеря, а отказ отвечать на вопрос, которого
  // задавать не следовало. Узел назван «Новый» или ещё не назван вовсе —
  // реестр по такой подписи не спрашивают. Записи показываем: по ним видно,
  // какой мусор перестал приезжать.
  if (refused.length) {
    head("ПЕРЕСТАЛО СЧИТАТЬСЯ НАЗВАНИЕМ ВЕЩЕСТВА — это не потеря", refused.length);
    for (const [name, x] of refused) {
      console.log(
        `  «${name}» — приносило ${recordsWord(x.entries)}, код ${x.okpd2 ?? "—"}`,
      );
      for (const [r, n] of surplus([], x.records).slice(0, 3)) {
        console.log(`      ${n > 1 ? `×${n} ` : ""}${r.slice(0, 90)}`);
      }
    }
    console.log(
      "\n  Такой узел стоит переименовать: пока он подписан так, вещества за\n" +
        "  ним нет ни в реестре, ни в справочнике.",
    );
  }

  head("ЗАПИСИ ИЗМЕНИЛИСЬ у уже найденного — СМОТРЕТЬ ГЛАЗАМИ", newRecords.length);
  if (!newRecords.length) console.log("  пусто");
  console.log(
    newRecords.length
      ? "  Здесь прячутся ложные совпадения: к верной записи могла добавиться\n" +
          "  чужая. Читайте названия — числа тут ничего не скажут.\n" +
          "  «+» пришло, «−» ушло; после знака — основание отбора.\n" +
          "  «×N» — столько одинаковых записей (разные производители, регистрации).\n"
      : "",
  );
  let plusTotal = 0;
  let minusTotal = 0;
  for (const [name, x, y, fresh, gone] of newRecords) {
    console.log(`  «${name}»  ${x.entries} → ${recordsWord(y.entries)}`);
    printGrouped("+", fresh, (n) => own(y.why, n), capPlus);
    printGrouped("−", gone, goneReasonOf(y, reasonsKnown), 0);
    plusTotal += fresh.reduce((s, [, n]) => s + n, 0);
    minusTotal += gone.reduce((s, [, n]) => s + n, 0);
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
      `  «${name}» → ${recordsWord(y.entries)}, ${y.producers} производителей,` +
        ` код ${y.okpd2 ?? "—"} [${MATCH_LABELS[y.match] ?? y.match ?? "—"}]`,
    );
    printGrouped("+", surplus([], y.records), (n) => own(y.why, n), capPlus);
  }

  // Новые названия — пополнение справочника или графов. Сравнивать их не с
  // чем, но смотреть их надо так же, как «нашлось впервые»: нашлось ли то
  // вещество. Раньше здесь был голый перечень, и проверить полсотни новых
  // написаний было нечем — ложное совпадение прошло бы молча.
  //
  // Написания одного вещества ищут одно и то же, поэтому идут группой:
  // вещество — его новые написания — что нашлось.
  const freshFound = onlyInB.filter((n) => b.results[n]?.found);
  const freshMissing = onlyInB.filter((n) => !b.results[n]?.found);
  if (onlyInB.length) {
    head("НОВЫЕ НАЗВАНИЯ — что нашли, смотреть глазами", freshFound.length);
    const groups = new Map();
    for (const name of freshFound) {
      const y = b.results[name];
      const k = `${y.canon ?? name}\u0000${(y.records ?? []).join("\u0001")}`;
      if (!groups.has(k)) groups.set(k, { canon: y.canon ?? name, names: [], y });
      groups.get(k).names.push(name);
    }
    for (const { canon, names, y } of groups.values()) {
      const listed = names.map((n) => `«${n}»`).join(", ");
      const alone = names.length === 1 && names[0] === canon;
      console.log(
        `  ${listed}${alone ? "" : ` — вещество «${canon}»`}` +
          `\n      → ${recordsWord(y.entries)}, ${y.producers} производителей,` +
          ` код ${y.okpd2 ?? "—"} [${MATCH_LABELS[y.match] ?? y.match ?? "—"}]`,
      );
      printGrouped("+", surplus([], y.records), (n) => own(y.why, n), full ? 0 : 3);
    }
    if (freshMissing.length) {
      console.log(
        `\n  не нашли ничего (${freshMissing.length}): ` +
          `${freshMissing.slice(0, 20).join(", ")}${freshMissing.length > 20 ? " …" : ""}`,
      );
    }
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
      (refused.length
        ? `  не спрашивали:      ${refused.length}   (подпись не называет вещество — так и задумано)\n`
        : "") +
      `  новые записи:       ${newRecords.length}${newRecords.length ? "   ← прочитать названия" : ""}\n` +
      (newRecords.length
        ? `    из них записей пришло: ${plusTotal}, ушло: ${minusTotal}\n`
        : "") +
      `  сменился код ОКПД2: ${codeChanged.length}` +
      (onlyInB.length
        ? `\n  новые названия:     ${onlyInB.length}, нашли ${freshFound.length}` +
          (freshFound.length ? "   ← прочитать названия" : "")
        : ""),
  );

  // Ненулевой код — только на пропажах: это единственное, что заведомо плохо.
  // Новые записи бывают и верными, и решает их человек, а не выход скрипта.
  // Отказ отвечать на подпись, не называющую вещество, сюда не идёт: он и
  // был целью правки, а не её побочным ущербом.
  process.exit(lost.length ? 1 : 0);
}

/* ────────────────────────────── запуск ────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  let out = null;
  let namesFrom = null;
  let limit = 0;
  let quiet = false;
  let full = false;
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--names-from") namesFrom = argv[++i];
    else if (a === "--limit") limit = Number(argv[++i]) || 0;
    else if (a === "--quiet") quiet = true;
    else if (a === "--full") full = true;
    else if (!a.startsWith("--")) files.push(a);
  }

  if (files.length === 2 && !out) return compare(files[0], files[1], { full });

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
