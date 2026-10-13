#!/usr/bin/env node
//
// Собрать синонимы ОТРАСЛИ из Wikidata — предметы отрасли целиком, а не только
// названия с наших графов.
//
//   node scripts/fetch-wikidata-domain.js --list         — какие отрасли есть
//   node scripts/fetch-wikidata-domain.js metals         — собрать и показать сводку
//   node scripts/fetch-wikidata-domain.js metals --all   — показать отчёт целиком
//   node scripts/fetch-wikidata-domain.js metals --max-classes 200
//                                                        — оборвать обход раньше
//
// СПРАВОЧНИК СКРИПТ НЕ ТРОГАЕТ. Он кладёт в data/wikidata/ два файла:
//   synonyms-wikidata-<отрасль>.txt — предложенные строки, в формате справочника;
//   <отрасль>-report.txt            — полный отчёт для согласования.
// В reference/ строки попадают только после согласования — отдельным файлом с
// тем же именем, коммитом; справочник подхватывает такие файлы сам
// (routes/industry/utils/synonyms.js). Записать прямо в reference/ на сервере
// нельзя: этот файл — часть кода, и при git pull он столкнулся бы с
// согласованной версией.
//
// Чем отличается от fetch-wikidata-synonyms.js. Тот спрашивает про названия с
// графов и берёт только вещества с номером CAS. Этот берёт отрасль целиком —
// в том числе то, чего на графах ещё нет, — а признак «это материал отрасли»
// даёт не номер CAS, а место в классах Wikidata: «сталь» — подкласс «сплава».
// У сплавов номера CAS обычно нет (это смеси), и прежний отбор их отбросил бы.
//
// Как обходим классы. Публичная точка SPARQL на машине может быть закрыта, а
// API Wikidata, которым ходит прежний сборщик, проверено. Поэтому подклассы
// ищем поиском по утверждению: «haswbstatement:P279=Q37756» — все, у кого
// «подкласс от: сплав», — и так шаг за шагом вниз по дереву.
//
// Что берём. Только предметы со статьёй в русской Википедии: это и отсечение
// мелочи (марок стали без статьи сотни), и проверка, что русское название
// настоящее, а не подпись, которую кто-то вписал в Wikidata между делом.
// Написания проходят тот же отсев, что у прежнего сборщика (lib/wikidata.js):
// стоп-лист, английские слова, слишком короткое.
//
// Что показываем к согласованию — всё, что меняет поведение справочника:
//   — новые имена у веществ, которые справочник уже знает;
//   — конфликты: одно написание у двух разных веществ;
//   — названия с ваших графов, которые станут опознаваться иначе;
//   — пометки «смотреть глазами»: синоним уже или шире главного имени (подвид
//     или класс), похожий на марку, латиницей.
// Справочник при этом читается тем же кодом, что и в работе (previewWith), —
// отчёт не может разойтись с тем, что потом окажется в справочнике.

const fs = require("fs");
const path = require("path");

const { collectProducts } = require("./lib/graph-products");
const { previewWith, previewWithout } = require("../routes/industry/utils/synonyms");
const {
  isElementFormula,
  normalizeName,
  stemWord,
  words,
} = require("../routes/industry/utils/normalize");
const {
  key,
  rejectReason,
  asCanon,
  pause,
  currentDelay,
  api,
  entities,
} = require("./lib/wikidata");

const OUT_DIR = path.resolve(__dirname, "../data/wikidata");
const REFERENCE_DIR = path.resolve(__dirname, "../reference");

/** По скольку элементов забираем за раз: у химических элементов утверждений много. */
const BATCH = 25;
/** Предел длины поискового запроса у CirrusSearch — 300 знаков; держим запас. */
const QUERY_BUDGET = 280;
/** Дальше этого смещения поиск не листает. */
const SEARCH_OFFSET_MAX = 10_000;

/**
 * Не металлы и полуметаллы — по символу элемента.
 *
 * Классам Wikidata тут верить нельзя: железо там — экземпляр «химического
 * элемента», а в «металлах» числится через цепочку, которую кто-то мог и не
 * провести. Таблица Менделеева надёжнее любой разметки. Германий и сурьму
 * оставляем: в промышленности это металлы — их выплавляет цветная металлургия.
 */
const NON_METALS = new Set([
  "H", "He", "B", "C", "N", "O", "F", "Ne", "Si", "P", "S", "Cl", "Ar",
  "As", "Se", "Br", "Kr", "Te", "I", "Xe", "At", "Rn",
]);

/** Дальше фермия элементы получают атомами на ускорителе — не продукт. */
const MAX_ATOMIC_NUMBER = 100;

/** Металл ли элемент; иначе — причина, почему не берём. */
function metalElement(item) {
  const symbol = item.claims.P246?.[0];
  const z = item.claims.P1086?.[0];
  if (!symbol) return "нет символа элемента";
  if (Number.isFinite(z) && z > MAX_ATOMIC_NUMBER) return `синтетический, Z > ${MAX_ATOMIC_NUMBER}`;
  if (NON_METALS.has(symbol)) return "не металл";
  return null;
}

/**
 * Отрасли.
 *
 * Корень группы — элемент Wikidata, записанный кодом; при запуске сверяется
 * его русское название (expect). Код вписан руками, и ошибись он — обход ушёл
 * бы в чужое дерево и принёс сотни чужих строк. Сверка ловит это до обхода.
 *
 * walk: "instances" — только прямые экземпляры (химические элементы);
 *       "tree"      — подклассы вглубь и экземпляры на каждом уровне.
 *
 * decisions — решения согласования, по коду элемента Wikidata. Записаны
 * здесь, а не правкой готового файла: пересбор отрасли (Wikidata меняется)
 * должен давать согласованное, а не возвращать отклонённое.
 *   dropItems     — предмет не берём целиком;
 *   canon         — главное имя Wikidata неудачно, берём другое; прежнее
 *                   уходит совсем;
 *   dropSpellings — написания, которые не синонимы своего предмета;
 *   noSearch      — написания только для опознания, по реестру не искать
 *                   (в строке со звёздочкой, как в synonyms.txt).
 */
const DOMAINS = {
  metals: {
    title: "Металлы и сплавы",
    groups: [
      {
        name: "металлы",
        about: "химические элементы — металлы",
        root: { qid: "Q11344", expect: /химическ\S*\s+элемент/i },
        walk: "instances",
        keep: metalElement,
        order: (a, b) => (a.claims.P1086?.[0] ?? 999) - (b.claims.P1086?.[0] ?? 999),
      },
      {
        name: "сплавы",
        about: "«сплав» и всё, что ниже него в классах",
        root: { qid: "Q37756", expect: /сплав/i },
        walk: "tree",
      },
    ],
    // Согласовано заказчиком 2026-10-13 по отчёту первого сбора.
    decisions: {
      dropItems: {
        Q5561558: "покрытие, а не сплав; «красная латунь» в синонимах — другое",
        Q901785: "синонимы — процесс и другой продукт, без них одно имя без CAS",
      },
      canon: {
        Q725158: { name: "Конструкционная сталь", why: "«Стальной профиль» — прокат, изделие" },
      },
      dropSpellings: {
        Q925: { spellings: ["Меркурий"], why: "планета и торговые марки" },
        Q649090: {
          spellings: ["Аргентан", "Медно-никелевый сплав", "Медноникелевый сплав"],
          why: "аргентан — нейзильбер; медно-никелевые — целая группа",
        },
        Q39782: { spellings: ["Алюминиевая латунь", "Аурихалк"], why: "подвид; легендарный металл" },
        Q1127242: { spellings: ["Р6М5"], why: "одна марка, а не вся быстрорежущая сталь" },
        Q1072385: { spellings: ["Нихром х20н80", "Х20Н80"], why: "одна марка: у нихрома есть и Х15Н60" },
        Q967996: {
          spellings: ["Высокоуглеродистая сталь", "Среднеуглеродистая сталь"],
          why: "подвиды",
        },
        Q637345: { spellings: ["Тугоплавкие сплавы"], why: "другое: сплавы вольфрама, молибдена" },
        Q907347: { spellings: ["Сплав железа", "Сплавы железа"], why: "сплавы железа — и сталь, и чугун" },
        Q756257: { spellings: ["Полутомпак"], why: "другая марка (Л80)" },
        Q911380: { spellings: ["Белая медь"], why: "так зовут и мельхиор, и нейзильбер" },
        Q475736: { spellings: ["Дамаск"], why: "город и ткань" },
        Q2248028: { spellings: ["Феррит"], why: "фаза стали и магнитная керамика" },
        Q1061375: { spellings: ["NiFe"], why: "любой железоникелевый сплав" },
        Q423265: { spellings: ["Вольфрама карбиды"], why: "множественное: WC и W2C" },
        Q31576: { spellings: ["Стерлинг"], why: "валюта" },
        Q4377547: {
          spellings: [
            "ГОСТ 10994-74", "NILO", "42Н", "Инварные сплавы", "Магнитно-мягкие сплавы",
            "Магнитно-твердые сплавы", "Сплавы с заданными свойствами упругости",
            "Сверхпроводящие сплавы", "Термобиметаллы", "Магнитно-мягкий сплав",
            "Магнитно-мягкие материалы", "Магнитно-твердые материалы",
          ],
          why: "виды прецизионных сплавов, а не их имена",
        },
      },
      noSearch: {
        Q898215: ["36Н", "Н36"],
        Q1127242: ["HSS"],
      },
    },
  },
};

/** Вымышленное и легендарное: «мифрил», «орихалк» — не продукт. */
const FICTION = /вымышл|мифическ|мифологическ|легендарн|фантастическ|сказочн/i;

/**
 * Предприятие, а не материал: «Металлургический завод в Аджаокуте» размечен
 * в Wikidata как сталь. \b с кириллицей в JS не работает — граница слова
 * записана явно.
 */
const ENTERPRISE = /(?:^|[^а-яё])(?:завод|комбинат|компани|предприяти|корпораци|фабрик)/i;

/**
 * Написание, которое не имя предмета, хотя стоит в синонимах Wikidata.
 * Возвращает причину или null.
 */
function aliasReject(alias, label) {
  // Заголовок статьи с уточнением: «Уран (элемент)», «Победит (сплав)» —
  // то же имя плюс пометка Википедии, а не второе название.
  const paren = /^(.+?)\s*\([^)]*\)$/.exec(alias);
  if (paren && key(paren[1]) === key(label)) return "заголовок статьи с уточнением в скобках";
  // «Элемент 27» — номер в таблице, а не название.
  if (/^элемент\s+\d+$/i.test(alias.trim())) return "номер элемента, не название";
  return null;
}

/** Ключ сравнения слов: «Оловянная бронза» и «бронза оловянная» — одно. */
const stems = (s) => new Set(words(normalizeName(s)).map(stemWord));

/** Все ли слова a есть в b. */
const within = (a, b) => [...a].every((w) => b.has(w));

/** Символы элементов — чтобы отличить формулу от марки латиницей. */
const ELEMENT_SYMBOLS = new Set(
  ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni " +
    "Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I " +
    "Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt " +
    "Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm").split(" "),
);

/**
 * Настоящая химическая формула: «Nb3Sn», «Fe2O3».
 *
 * isElementFormula смотрит только на вид — заглавная, строчная, цифры, — и
 * под него подходят марки и обозначения: «X20H80», «AISI 321». Здесь каждый
 * символ должен быть элементом.
 */
function realFormula(name) {
  const bare = String(name ?? "").replace(/\s+/g, "");
  if (!isElementFormula(bare)) return false;
  const symbols = bare.match(/[A-Z][a-z]?/g) ?? [];
  return symbols.length > 0 && symbols.every((s) => ELEMENT_SYMBOLS.has(s));
}

/**
 * Пометки «смотреть глазами» для строки.
 *
 * Wikidata кладёт в синонимы не только другие имена того же, но и соседей:
 * подвид («оловянная бронза» у «бронзы»), класс («сталь» у «нержавеющей
 * стали»), марку («08Х18Н10Т» у «12Х18Н10Т»). В справочнике любое из них
 * сольёт РАЗНЫЕ продукты в один узел — показываем поимённо, решает человек.
 */
function flagsOf(entry) {
  const flags = [];
  const canonStems = stems(entry.canon);
  const canonDigits = /\d/.test(entry.canon);
  for (const s of entry.spellings.slice(1)) {
    const why = [];
    const st = stems(s);
    if (st.size > canonStems.size && within(canonStems, st)) why.push("уже главного имени: подвид?");
    else if (st.size && st.size < canonStems.size && within(st, canonStems)) {
      why.push("шире главного имени: класс?");
    }
    if (/\d/.test(s)) why.push(canonDigits ? "другое обозначение с цифрами: другая марка?" : "с цифрами: марка?");
    if (!/[а-яё]/i.test(s) && !realFormula(s)) why.push("латиницей, не формула");
    if (why.length) flags.push(`«${s}» — ${why.join("; ")}`);
  }
  return flags;
}

/** Сколько предметов нашёл поиск и какие — со всех страниц. */
async function searchAll(query) {
  const ids = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const data = await api({
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: "0",
      srlimit: "500",
      sroffset: String(offset),
      srprop: "",
      srinfo: "totalhits",
    });
    await pause();
    total = data?.query?.searchinfo?.totalhits ?? total;
    for (const r of data?.query?.search ?? []) {
      if (/^Q\d+$/.test(r?.title ?? "")) ids.push(r.title);
    }
    const next = Number(data?.continue?.sroffset);
    if (!Number.isFinite(next) || next <= offset || next >= SEARCH_OFFSET_MAX) break;
    offset = next;
  }
  return { ids, total };
}

async function searchCount(query) {
  const data = await api({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: "1",
    srprop: "",
    srinfo: "totalhits",
  });
  await pause();
  return Number(data?.query?.searchinfo?.totalhits ?? 0);
}

/**
 * Понимает ли поиск «или» внутри haswbstatement («P279=Q1|P31=Q1»).
 *
 * С ним уровень дерева спрашивается парой запросов, без него — двумя на
 * каждый класс. Не знаем наверняка, как поведёт себя живой поиск, поэтому
 * проверяем на корне: «или» не может найти меньше, чем одна его половина.
 * Не понял — ответит нулём, и мы спокойно пойдём медленным путём.
 */
async function orSupported(qid) {
  const one = await searchCount(`haswbstatement:P279=${qid}`);
  const both = await searchCount(`haswbstatement:P279=${qid}|P31=${qid}`);
  return both > 0 && both >= one;
}

/** Запросы «чьи подклассы и экземпляры» для списка классов. */
function childQueries(qids, orOk) {
  if (!orOk) {
    return qids.flatMap((q) => [`haswbstatement:P279=${q}`, `haswbstatement:P31=${q}`]);
  }
  const queries = [];
  let cur = [];
  const text = (parts) => `haswbstatement:${parts.join("|")}`;
  for (const q of qids) {
    const pair = [`P279=${q}`, `P31=${q}`];
    if (cur.length && text([...cur, ...pair]).length > QUERY_BUDGET) {
      queries.push(text(cur));
      cur = [];
    }
    cur.push(...pair);
  }
  if (cur.length) queries.push(text(cur));
  return queries;
}

const CLAIMS = ["P31", "P279", "P246", "P1086"];

/** Сведения о предметах — пачками. */
async function fetchItems(ids, progress) {
  const info = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const got = await entities(ids.slice(i, i + BATCH), { claims: CLAIMS });
      for (const [id, item] of got) info.set(id, item);
    } catch (e) {
      console.error(`\n  пачка со смещения ${i}: ${e.message}`);
    }
    await pause();
    if (progress) progress(Math.min(i + BATCH, ids.length), ids.length);
  }
  return info;
}

/**
 * Обойти дерево класса вниз.
 *
 * Вглубь идём только от ПОДКЛАССОВ: у экземпляра («марка 12Х18Н10Т —
 * экземпляр нержавеющей стали») своих подклассов почти не бывает. И только от
 * тех, у кого есть статья в русской Википедии, — кроме первого уровня:
 * «медные сплавы» могут жить без статьи, а «мельхиор» под ними — со статьёй.
 * Без этого отсечения обход уходит в тысячи марок и стандартов.
 */
async function walkTree(root, { orOk, maxDepth, maxClasses }) {
  const found = new Map();
  const asked = new Set([root.qid]);
  let frontier = [root.qid];
  let cut = false;
  let requests = 0;

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const children = new Set();
    for (const q of childQueries(frontier, orOk)) {
      const { ids } = await searchAll(q);
      requests += 1;
      for (const id of ids) children.add(id);
      process.stdout.write(`\r  уровень ${depth}: запросов ${requests}, найдено ${found.size + children.size}   `);
    }
    const fresh = [...children].filter((q) => !found.has(q) && !asked.has(q));
    const info = await fetchItems(fresh);
    const next = [];
    for (const q of fresh) {
      const item = info.get(q);
      if (!item) continue;
      item.depth = depth;
      item.parents = [...item.claims.P279, ...item.claims.P31].filter((p) => asked.has(p));
      found.set(q, item);
      const subclass = item.claims.P279.some((p) => asked.has(p));
      if (!subclass || (!item.ruwiki && depth > 1)) continue;
      if (asked.size >= maxClasses) {
        cut = true;
        continue;
      }
      asked.add(q);
      next.push(q);
    }
    frontier = next;
    if (depth === maxDepth && frontier.length) cut = true;
  }
  process.stdout.write("\n");
  return { found, classes: asked.size, cut };
}

/** Прямые экземпляры класса: «железо — экземпляр химического элемента». */
async function walkInstances(root) {
  const { ids } = await searchAll(`haswbstatement:P31=${root.qid}`);
  const info = await fetchItems(ids, (n, of) =>
    process.stdout.write(`\r  разобрано предметов: ${n} из ${of}   `),
  );
  process.stdout.write("\n");
  for (const item of info.values()) {
    item.depth = 1;
    item.parents = [root.qid];
  }
  return { found: info, classes: 1, cut: false };
}

/** Строка справочника: имена через «|», в хвосте — группа, CAS и код элемента. */
function lineOf(e) {
  const names = e.spellings.map((s, i) => (i > 0 && e.noSearch?.has(key(s)) ? `*${s}` : s));
  return `${names.join(" | ")}   # ${e.group}${e.cas ? `, CAS ${e.cas}` : ""} ${e.id}`;
}

function parseArgs(argv) {
  const opts = { all: false, list: false, domain: null, maxClasses: 400, maxDepth: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--max-classes") opts.maxClasses = Number(argv[++i]);
    else if (a === "--max-depth") opts.maxDepth = Number(argv[++i]);
    else if (!a.startsWith("--") && !opts.domain) opts.domain = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list || !opts.domain) {
    console.log("Отрасли:");
    for (const [name, d] of Object.entries(DOMAINS)) {
      console.log(`  ${name.padEnd(10)} ${d.title} — ${d.groups.map((g) => g.about).join("; ")}`);
    }
    console.log("\nЗапуск: node scripts/fetch-wikidata-domain.js metals");
    return;
  }
  const domain = DOMAINS[opts.domain];
  if (!domain) {
    console.error(`Отрасли «${opts.domain}» нет. Список: node scripts/fetch-wikidata-domain.js --list`);
    process.exit(2);
  }
  if (!(opts.maxClasses > 0) || !(opts.maxDepth > 0)) {
    console.error("--max-classes и --max-depth — положительные числа.");
    process.exit(2);
  }

  // Отчёт пишется целиком в файл, а на экран — с сокращениями (кроме --all).
  const full = [];
  const say = (line = "", { capped = false } = {}) => {
    full.push(line);
    if (opts.all || !capped) console.log(line);
  };
  /** Список с сокращением на экране: в файл идёт целиком. */
  const list = (items, cap, indent = "  ") => {
    items.forEach((it, i) => say(`${indent}${it}`, { capped: i >= cap }));
    if (!opts.all && items.length > cap) {
      console.log(`${indent}… и ещё ${items.length - cap} — в отчёте целиком`);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  say(`══ ${domain.title} — сбор из Wikidata, ${today} ══`);

  // ── 1) корни: сверить, что код ведёт туда, куда мы думаем ──
  const roots = await entities(domain.groups.map((g) => g.root.qid));
  await pause();
  say("\nКорни:");
  for (const g of domain.groups) {
    const r = roots.get(g.root.qid);
    if (!r || !g.root.expect.test(r.label)) {
      console.error(
        `\nКорень группы «${g.name}» (${g.root.qid}) называется «${r?.label ?? "—"}», ` +
          `а ждали ${g.root.expect}. Код в DOMAINS неверен — обход ушёл бы не туда.`,
      );
      process.exit(1);
    }
    g.rootLabel = r.label;
    say(`  ${g.name.padEnd(9)} ← «${r.label}» (${g.root.qid}): ${g.about}`);
  }

  const orOk = await orSupported(domain.groups.find((g) => g.walk === "tree")?.root.qid ?? domain.groups[0].root.qid);
  console.log(
    orOk
      ? "Поиск понимает «или» — уровень дерева спрашиваем парой запросов."
      : "Поиск «или» не понимает — спрашиваем по классу; это дольше.",
  );

  const decisions = domain.decisions ?? {};
  /** Решения, которые пригодились: прочие устарели — Wikidata поменялась. */
  const used = new Set();
  const fileName = `synonyms-wikidata-${opts.domain}.txt`;
  // Точка отсчёта — справочник без этой отрасли: при пересборе её прежняя
  // версия уже лежит в reference/, и сравнение с ней самой показало бы, что
  // ничего нового нет.
  const baseline = previewWithout(fileName);

  // ── 2) обход ──
  const items = new Map(); // код → предмет (первая группа, где нашёлся)
  const skipped = [];
  const walkNotes = [];
  for (const g of domain.groups) {
    console.log(`\nГруппа «${g.name}»…`);
    const walked = g.walk === "tree"
      ? await walkTree(g.root, { orOk, maxDepth: opts.maxDepth, maxClasses: opts.maxClasses })
      : await walkInstances(g.root);
    let taken = 0;
    let noArticle = 0;
    const labels = new Map([[g.root.qid, g.rootLabel]]);
    for (const it of walked.found.values()) labels.set(it.id, it.label || it.id);
    const ordered = [...walked.found.values()].sort(
      g.order ?? ((a, b) => a.label.localeCompare(b.label, "ru")),
    );
    for (const it of ordered) {
      if (items.has(it.id)) continue;
      // Без статьи в русской Википедии — не берём и поимённо не перечисляем:
      // русского названия у таких чаще всего нет вовсе.
      if (!it.ruwiki) {
        noArticle += 1;
        continue;
      }
      // Подписи по-русски в Wikidata нет, а статья есть: её заголовок и есть
      // русское название — без уточнения в скобках («Бронза (сплав)»).
      if (!it.label) it.label = it.ruwiki.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const decided = decisions.dropItems?.[it.id];
      if (decided) used.add(it.id);
      const why =
        (!it.label && "нет русского названия") ||
        (FICTION.test(it.description) && "вымышленное") ||
        (ENTERPRISE.test(it.label) && "предприятие, а не материал") ||
        (decided && `решение согласования: ${decided}`) ||
        (g.keep && g.keep(it)) ||
        null;
      if (why) {
        skipped.push({ group: g.name, why, what: `${asCanon(it.label) || it.id} (${it.id})` });
        continue;
      }
      const rename = decisions.canon?.[it.id];
      if (rename) {
        used.add(it.id);
        it.renamedFrom = { label: it.label, why: rename.why };
        it.aliases = it.aliases.filter((a) => key(a) !== key(rename.name));
        it.label = rename.name;
      }
      it.group = g.name;
      it.parentLabel = asCanon(it.parents.map((p) => labels.get(p)).filter(Boolean)[0] ?? "") || null;
      items.set(it.id, it);
      taken += 1;
    }
    walkNotes.push(
      `  ${g.name}: найдено ${walked.found.size}, без статьи в русской Википедии ${noArticle}, ` +
        `взято ${taken}` +
        (g.walk === "tree" ? `; классов опрошено ${walked.classes}` : "") +
        (walked.cut ? " — ОБХОД ОБОРВАН по --max-classes/--max-depth" : ""),
    );
  }
  say("\nОбход:");
  for (const n of walkNotes) say(n);

  // ── 3) строки ──
  const entries = [];
  const dropped = [];
  const byCanon = new Map();
  const live = new Map(baseline.entries.map((e) => [key(e.canon), e]));
  let silent = 0;
  let nothingNew = 0;
  // Главное имя одного предмета в синонимах другого — почти всегда класс или
  // подвид: «сталь» у «нержавеющей стали». В справочнике строка, прочитанная
  // первой, забрала бы это имя себе, и «Сталь» на графе стала бы нержавеющей
  // — смотря по алфавиту. Такое имя остаётся только у своего предмета.
  const canonOwner = new Map();
  for (const it of items.values()) {
    const k = key(it.label);
    if (k && !canonOwner.has(k)) canonOwner.set(k, it.id);
  }
  for (const it of items.values()) {
    const canonBad = rejectReason(it.label);
    if (canonBad) {
      dropped.push({ why: `${canonBad} (главное имя — строка не взята)`, what: `${asCanon(it.label)} (${it.id})` });
      continue;
    }
    if (it.renamedFrom) {
      dropped.push({
        why: `решение согласования: ${it.renamedFrom.why}`,
        what: `${asCanon(it.renamedFrom.label)} (было главным у ${it.id}, стало «${asCanon(it.label)}»)`,
      });
    }
    const decidedDrop = decisions.dropSpellings?.[it.id];
    const dropKeys = new Set((decidedDrop?.spellings ?? []).map(key));
    const spellings = [];
    const seen = new Set();
    const ownKey = key(it.label);
    for (const s of [it.label, ...it.aliases]) {
      const why =
        rejectReason(s) ||
        (s !== it.label && aliasReject(s, it.label)) ||
        (s !== it.label && dropKeys.has(key(s)) && `решение согласования: ${decidedDrop.why}`) ||
        null;
      if (dropKeys.has(key(s))) used.add(`${it.id}|${key(s)}`);
      if (why) {
        dropped.push({ why, what: `${s} (у «${asCanon(it.label)}»)` });
        continue;
      }
      const k = key(s);
      if (k && k !== ownKey && canonOwner.has(k) && canonOwner.get(k) !== it.id) {
        dropped.push({ why: "главное имя другого предмета отрасли", what: `${s} (у «${asCanon(it.label)}»)` });
        continue;
      }
      if (!k || seen.has(k)) continue;
      seen.add(k);
      spellings.push(asCanon(s));
    }
    const noSearch = new Set((decisions.noSearch?.[it.id] ?? []).map(key));
    for (const s of spellings) if (noSearch.has(key(s))) used.add(`${it.id}|*${key(s)}`);
    const e = {
      id: it.id,
      group: it.group,
      canon: spellings[0],
      spellings,
      cas: it.cas,
      noSearch,
      parentLabel: it.parentLabel,
    };
    // Два предмета Wikidata с одним русским названием («Бронза» — сплав и
    // «Бронза» — что-то ещё) справочник слил бы молча: канон тот же. Берём
    // первый, второй показываем.
    const ck = key(e.canon);
    if (byCanon.has(ck)) {
      const first = byCanon.get(ck);
      skipped.push({
        group: e.group,
        why: "то же русское название, что у другого предмета",
        what: `${e.canon} (${e.id}; взят ${first.id})`,
      });
      continue;
    }
    // Одно имя без номера CAS справочнику ничего не даёт: одинаковые названия
    // схлопываются и без него.
    if (spellings.length < 2 && !e.cas) {
      silent += 1;
      continue;
    }
    // Справочник уже знает вещество под тем же именем, и новое ничего не
    // добавляет — ни имени, ни номера.
    const known = live.get(ck);
    if (known) {
      const knownKeys = new Set(known.spellings.map(key));
      const adds = spellings.some((s) => !knownKeys.has(key(s))) || (e.cas && !known.cas);
      if (!adds) {
        nothingNew += 1;
        continue;
      }
    }
    byCanon.set(ck, e);
    entries.push(e);
  }

  if (!entries.length) {
    say("\nПредлагать нечего.");
    writeReport(opts.domain, full);
    return;
  }

  // ── 4) предложение — в data/, и как его прочтёт справочник ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const proposal = path.join(OUT_DIR, fileName);
  const head = [
    `# Синонимы отрасли «${domain.title}», собранные из Wikidata.`,
    "#",
    `# СОБРАН МАШИНОЙ: node scripts/fetch-wikidata-domain.js ${opts.domain}`,
    "# Согласован по отрасли целиком; решения согласования — в DOMAINS сборщика.",
    "# Нашли ошибку — поправьте запись в reference/synonyms.txt (тот файл",
    "# читается первым и побеждает), лишнее написание — в synonyms-stop.txt.",
    "#",
    "# В хвосте строки — группа, номер CAS, если он есть, и код элемента",
    "# Wikidata: https://www.wikidata.org/wiki/Q…",
    "#",
    `# Собрано: ${today}, строк: ${entries.length}`,
  ];
  const body = [];
  for (const g of domain.groups) {
    const rows = entries.filter((e) => e.group === g.name);
    if (!rows.length) continue;
    body.push("", `# ── ${g.name}: ${g.about} ──`, ...rows.map(lineOf));
  }
  fs.writeFileSync(proposal, `${[...head, ...body].join("\n")}\n`, "utf8");

  const preview = previewWith(proposal);
  const st = preview.stats;
  const conflicts = st.conflicts.filter((c) => c.ignoredFrom === fileName || c.keptFrom === fileName);
  const casClashes = st.casConflicts.filter((c) => c.ignoredFrom === fileName);
  const stopDropped = st.dropped.filter((d) => d.from === fileName);

  // Чем дополнятся записи, которые справочник уже знает: сравниваем
  // справочник до и после — так видны и слияния по двум общим именам, и
  // молчаливые по одинаковому главному имени.
  const extended = [];
  const after = new Map(preview.entries.map((e) => [e.canon, e]));
  for (const before of baseline.entries) {
    const now = after.get(before.canon);
    if (!now) continue;
    const had = new Set(before.spellings.map(key));
    const added = now.spellings.filter((s) => !had.has(key(s)));
    const casAdded = !before.cas && now.cas ? now.cas : null;
    if (added.length || casAdded) {
      extended.push(
        `«${before.canon}» (${before.source})` +
          (added.length ? ` ← ${added.map((s) => `«${s}»`).join(", ")}` : "") +
          (casAdded ? ` ← номер CAS ${casAdded}` : ""),
      );
    }
  }
  const fresh = preview.entries.filter((e) => e.source === fileName);

  // Названия с графов, которые справочник опознает иначе.
  const graphChanges = { gained: [], changed: [], lost: [] };
  const { counts } = collectProducts();
  for (const label of counts.keys()) {
    const was = baseline.identify(label)?.canon ?? null;
    const will = preview.identify(label)?.canon ?? null;
    if (was === will) continue;
    if (!was) graphChanges.gained.push(`«${label}» → «${will}»`);
    else if (!will) graphChanges.lost.push(`«${label}»: было «${was}», станет — никак`);
    else graphChanges.changed.push(`«${label}»: было «${was}», станет «${will}»`);
  }

  const flagged = [];
  for (const e of entries) {
    for (const f of flagsOf(e)) flagged.push(`${e.canon}: ${f}   (${e.id})`);
  }

  say("\n── СВОДКА ──");
  say(`  строк в предложении:            ${entries.length}`);
  say(`    новых веществ:                ${fresh.length}`);
  say(`    дополнят записи справочника:  ${extended.length}   ← смотреть: новые имена старых веществ`);
  say(`    одно имя и номер CAS:         ${entries.filter((e) => e.spellings.length === 1).length}`);
  say(`  конфликтов:                     ${conflicts.length}   ← смотреть все`);
  say(`  разные номера CAS:              ${casClashes.length}`);
  say(`  пометок «смотреть глазами»:     ${flagged.length}`);
  say(
    `  на графах опознается иначе:     ${graphChanges.changed.length + graphChanges.lost.length}` +
      `   (впервые опознаются: ${graphChanges.gained.length})`,
  );
  say(`  не взято: одно имя без CAS ${silent}, уже в справочнике без нового ${nothingNew}, ` +
    `прочее ${skipped.length}, отсеяно написаний ${dropped.length + stopDropped.length}`);

  if (extended.length) {
    say("\n── ДОПОЛНЯТ ЗАПИСИ СПРАВОЧНИКА ──");
    list(extended, Infinity);
  }
  if (conflicts.length) {
    say("\n── КОНФЛИКТЫ: одно написание у разных веществ — справочник оставит прежнее ──");
    list(
      conflicts.map((c) => `«${c.spelling}»: у «${c.kept}» (${c.keptFrom}) и у «${c.ignored}» (${c.ignoredFrom})`),
      Infinity,
    );
  }
  if (casClashes.length) {
    say("\n── РАЗНЫЕ НОМЕРА CAS у одного вещества ──");
    list(casClashes.map((c) => `«${c.canon}»: ${c.kept}, а здесь ${c.ignored}`), Infinity);
  }
  if (graphChanges.changed.length || graphChanges.lost.length) {
    say("\n── НА ВАШИХ ГРАФАХ ОПОЗНАЕТСЯ ИНАЧЕ ──");
    list([...graphChanges.changed, ...graphChanges.lost], Infinity);
  }
  if (graphChanges.gained.length) {
    say("\n── НА ВАШИХ ГРАФАХ ОПОЗНАЮТСЯ ВПЕРВЫЕ ──");
    list(graphChanges.gained, 20);
  }
  if (flagged.length) {
    say("\n── СМОТРЕТЬ ГЛАЗАМИ ──");
    list(flagged, Infinity);
  }
  if (skipped.length) {
    say("\n── НЕ ВЗЯТО ──");
    const byWhy = new Map();
    for (const s of skipped) {
      const k = `${s.group}: ${s.why}`;
      if (!byWhy.has(k)) byWhy.set(k, []);
      byWhy.get(k).push(s.what);
    }
    for (const [why, what] of byWhy) {
      say(`  ${why} — ${what.length}`);
      list(what, 15, "      ");
    }
  }
  const allDropped = [
    ...dropped,
    ...stopDropped.map((d) => ({ why: "в стоп-листе", what: `${d.spelling} (у «${d.canon}»)` })),
  ];
  if (allDropped.length) {
    say("\n── ОТСЕЯНО ИЗ СИНОНИМОВ ──");
    const byWhy = new Map();
    for (const d of allDropped) {
      if (!byWhy.has(d.why)) byWhy.set(d.why, []);
      byWhy.get(d.why).push(d.what);
    }
    for (const [why, what] of byWhy) {
      say(`  ${why} — ${what.length}`);
      list(what, 10, "      ");
    }
  }

  // Что изменится против файла, который уже лежит в reference/: при пересборе
  // это и есть предмет согласования.
  const current = readEntryLines(path.join(REFERENCE_DIR, fileName));
  if (current) {
    const proposed = body.filter((l) => l && !l.startsWith("#"));
    const had = new Set(current);
    const will = new Set(proposed);
    const plus = proposed.filter((l) => !had.has(l));
    const minus = current.filter((l) => !will.has(l));
    say(`\n── ПО СРАВНЕНИЮ С reference/${fileName} ──`);
    if (!plus.length && !minus.length) say("  совпадает строка в строку");
    list([...plus.map((l) => `+ ${l}`), ...minus.map((l) => `− ${l}`)], Infinity);
  }

  // Решение, которому не нашлось предмета или написания, устарело: Wikidata
  // поменялась. Само по себе не вредно, но решения надо держать в порядке.
  const stale = [];
  for (const q of Object.keys(decisions.dropItems ?? {})) if (!used.has(q)) stale.push(`dropItems ${q}`);
  for (const q of Object.keys(decisions.canon ?? {})) if (!used.has(q)) stale.push(`canon ${q}`);
  for (const [q, d] of Object.entries(decisions.dropSpellings ?? {})) {
    for (const sp of d.spellings) if (!used.has(`${q}|${key(sp)}`)) stale.push(`dropSpellings ${q} «${sp}»`);
  }
  for (const [q, list2] of Object.entries(decisions.noSearch ?? {})) {
    for (const sp of list2) if (!used.has(`${q}|*${key(sp)}`)) stale.push(`noSearch ${q} «${sp}»`);
  }
  if (stale.length) {
    say("\n── РЕШЕНИЯ СОГЛАСОВАНИЯ, КОТОРЫЕ НЕ ПРИГОДИЛИСЬ (Wikidata поменялась?) ──");
    list(stale, Infinity);
  }

  say("\n── СТРОКИ ──");
  for (const g of domain.groups) {
    const rows = entries.filter((e) => e.group === g.name);
    if (!rows.length) continue;
    say(`  # ${g.name} — ${rows.length}`, { capped: false });
    list(
      rows.map((e) => lineOf(e) + (e.parentLabel && g.walk === "tree" ? `   ← под «${e.parentLabel}»` : "")),
      25,
    );
  }

  const report = writeReport(opts.domain, full);
  console.log(`\nПредложение: ${proposal}`);
  console.log(`Полный отчёт: ${report}`);
  console.log("Справочник не тронут. Пришлите отчёт на согласование:");
  console.log(`  cat ${path.relative(process.cwd(), report) || report}`);
  console.log(`(пауза между запросами к концу работы: ${currentDelay()} мс)`);
}

/** Строки записей файла справочника — без шапки и пустых; null, если файла нет. */
function readEntryLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("#"));
}

function writeReport(domainName, lines) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${domainName}-report.txt`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

main().catch((e) => {
  console.error("\nСорвалось:", e.message);
  process.exit(1);
});
