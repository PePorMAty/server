#!/usr/bin/env node
//
// Собрать синонимы ОТРАСЛИ из Wikidata — предметы отрасли целиком, а не только
// названия с наших графов.
//
//   node scripts/fetch-wikidata-domain.js --list         — какие отрасли есть
//   node scripts/fetch-wikidata-domain.js metals         — собрать и показать сводку
//   node scripts/fetch-wikidata-domain.js metals --all   — показать отчёт целиком
//   node scripts/fetch-wikidata-domain.js drugs          — лекарственные вещества
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

/**
 * Код АТХ действующего вещества: семь знаков, «N02BE01». Короче — группа
 * («N02» — анальгетики, «N02BE» — анилиды), а не вещество.
 */
const ATC_SUBSTANCE = /^[A-Z]\d\d[A-Z][A-Z]\d\d$/;

const atcCodes = (item) => (item.claims.P267 ?? []).filter((c) => ATC_SUBSTANCE.test(c));

/**
 * Лекарственное ли вещество; иначе — причина, почему не берём.
 *
 * Поиск уже просит и код АТХ, и номер CAS, но его указатель отстаёт от правок
 * Wikidata — проверяем по самим утверждениям.
 */
function drugSubstance(item) {
  if (!atcCodes(item).length) return "код АТХ группы, а не вещества";
  if (!item.cas) return "без номера CAS: смесь, комбинация или биопрепарат";
  // Номер CAS бывает и у комбинации: «Абакавир/Ламивудин». «+» в скобках —
  // обозначение изомера («(+)-псевдоэфедрин»), не комбинация.
  if (/[/+]/.test(item.label.replace(/\([^)]*\)/g, ""))) return "комбинация веществ";
  if (/препарат|средств/i.test(item.label)) return "группа препаратов, а не вещество";
  return null;
}

/** Коды АТХ в хвост строки — по ним видно, что это за лекарство. */
function atcTag(item) {
  const codes = atcCodes(item);
  return `АТХ ${codes.slice(0, 2).join(" ")}${codes.length > 2 ? " …" : ""}`;
}

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
 *       "tree"      — подклассы вглубь и экземпляры на каждом уровне;
 *       "statement" — все, у кого есть утверждение (у лекарств — код АТХ):
 *                     корень тогда — свойство (pid), а не класс, и поисковый
 *                     запрос задан в query.
 *
 * keep(item)      — причина не брать предмет или null;
 * tag(item)       — что дописать в хвост строки (коды АТХ);
 * brands          — торговые названия (brandsOf): "drop" — не брать,
 *                   "noSearch" — только для опознания;
 * abbrNoSearch    — латинские сокращения («DMSO») только для опознания;
 * aliasChecks     — свои проверки написаний: функция → причина или null;
 * joinKnown       — строка о веществе, которое справочник уже знает под другим
 *                   главным именем (тот же номер CAS или наше главное имя у
 *                   него среди написаний), вливается в его запись.
 *
 * decisions — решения согласования, по коду элемента Wikidata. Записаны
 * здесь, а не правкой готового файла: пересбор отрасли (Wikidata меняется)
 * должен давать согласованное, а не возвращать отклонённое.
 *   dropItems     — предмет не берём целиком;
 *   canon         — главное имя Wikidata неудачно, берём другое; прежнее
 *                   уходит совсем;
 *   dropSpellings — написания, которые не синонимы своего предмета;
 *   noSearch      — написания только для опознания, по реестру не искать
 *                   (в строке со звёздочкой, как в synonyms.txt);
 *   notBrand      — написания, которые brandsOf ошибочно счёл торговыми.
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
    // Согласовано заказчиком 2026-10-13 по отчёту первого сбора; «Голда» и
    // «Нержавейка» — по снимку реестра 9a360e4 → 680bec9, «Глиний» — по
    // снимку 680bec9 → 18a6990.
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
        Q897: { spellings: ["Голда"], why: "жаргон; в реестре находит пестицид «Шанс Голд»" },
        Q663: {
          spellings: ["Глиний"],
          why: "основа «глин» — глины: код бентонита в карточке, «Глина» опознавалась алюминием",
        },
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
        // В реестре «нержавейка» — только краска «Быстроэмаль нержавейка».
        Q172587: ["Нержавейка"],
      },
    },
  },
  drugs: {
    title: "Лекарственные вещества",
    groups: [
      {
        name: "лекарства",
        about: "действующие вещества: код АТХ и номер CAS",
        root: { pid: "P267", expect: /АТХ|ATC/i },
        walk: "statement",
        // И код АТХ, и номер CAS: без номера — группы АТХ, комбинации
        // («амоксициллин + клавулановая кислота»), смеси и биопрепараты.
        query: "haswbstatement:P267 haswbstatement:P231",
        keep: drugSubstance,
        tag: atcTag,
        brands: "drop",
        abbrNoSearch: true,
        aliasChecks: [researchCode, organicGrossFormula],
        joinKnown: true,
      },
    ],
    // Предложено 2026-10-15 по первому и второму сбору — ждёт согласования
    // заказчиком.
    decisions: {
      dropItems: {
        Q98270627: "вакцина, а не вещество",
        Q898623: "комбинация: сульфаметоксазол + триметоприм",
      },
      canon: {
        Q421297: { name: "Артикаин", why: "«Ультракаин» — торговое название" },
        Q418274: { name: "Глатирамера ацетат", why: "«Копаксон» — торговое название" },
        Q219626: { name: "Эфедрин", why: "на графах пишут без обозначения изомера" },
        Q263958: { name: "Псевдоэфедрин", why: "на графах пишут без обозначения изомера" },
      },
      dropSpellings: {
        Q41576: { spellings: ["Кокс"], why: "жаргон; кокс — продукт коксования угля, он есть на графах" },
        Q2409: { spellings: ["Ашхлор"], why: "жаргонное прочтение формулы" },
        Q831929: { spellings: ["Дроверин"], why: "торговое название" },
        Q19484: { spellings: ["Формин плива"], why: "торговое название (близко к «метформину» — правило не узнало)" },
        Q409501: { spellings: ["Фосфат натрия"], why: "так зовут и моно-, и ди-, и тринатрийфосфат" },
        Q412515: { spellings: ["CIBIS"], why: "название клинического исследования" },
        Q155685: { spellings: ["А.Т.10"], why: "торговое обозначение" },
        Q421297: { spellings: ["Ультракаин Д-С"], why: "с адреналином — комбинация" },
        Q418274: { spellings: ["Копаксон-тева"], why: "торговое название" },
        Q207843: { spellings: ["Оксид азота"], why: "так зовут и NO, и N2O, и NO2" },
        Q214863: { spellings: ["Сульфат железа", "Железа сульфат"], why: "без валентности — и сульфат железа(III)" },
        Q407867: { spellings: ["Хлорид железа", "Железа хлорид"], why: "в промышленности «хлорид железа» — обычно FeCl3" },
        Q143200: { spellings: ["Хлорид ртути"], why: "так зовут и каломель Hg2Cl2" },
        Q422071: { spellings: ["Камедь"], why: "класс: камеди бывают разные" },
        Q412082: { spellings: ["Cироп из инвертного сахара"], why: "продукт, а не вещество" },
        Q411347: { spellings: ["S-амлодипин"], why: "отдельное вещество — левамлодипин" },
        Q180623: { spellings: ["Холинолитик"], why: "класс веществ противоположного действия" },
        Q410922: { spellings: ["FITC"], why: "флуоресцеинизотиоцианат — другое вещество" },
        Q252251: { spellings: ["Кобаламин", "Кобаламины"], why: "класс: все кобаламины, не только циано-" },
        Q339940: { spellings: ["Экзотермический лёд"], why: "применение, а не имя" },
      },
      // Не торговые названия, хотя по виду похожи: промышленные, аптечные
      // русские и химические имена того же вещества.
      notBrand: {
        Q177342: ["Глинозём"],
        Q48318: ["Карбамид"],
        Q71969: ["Уротропин", "Гексамин"],
        Q214863: ["Железный купорос"],
        Q143200: ["Сулема"],
        Q423005: ["Малатион"],
        Q409665: ["Тетурам"],
        Q190865: ["Марганцовка"],
        Q905750: ["Веселящий газ"],
        Q189334: ["Пентрит"],
        Q421894: [
          "Нейблау", "Турнбульская синь", "Турнбулева синь", "Прусский синий",
          "Гамбургская синь", "Милори", "Прусская синь",
        ],
        Q410922: ["Уранин", "Диоксифлуоран"],
        Q410083: ["Макрогол"],
        Q245280: ["Глюцит"],
        Q321285: ["Убихинон", "Убихиноны"],
        Q192423: ["Ниацинамид"],
        Q130365: ["Лактофлавин", "Овофлавин"],
        Q83187: ["Аневрин"],
        Q32089: ["Рапамицин"],
        Q420682: ["Глицерил гваяколат"],
        Q60168: ["Диацетилморфин"],
        Q190067: ["Дронабинол"],
        Q335099: ["Эдаравон"],
        Q417194: ["Метандростенолон"],
        Q12910980: ["Тиреотропин-рилизинг-гормон", "Тиреорелин", "Тирорелин", "Тиреотропин-рилизинг-фактор"],
        Q424378: ["Суксаметония йодид", "Диацетилхолин"],
        Q410595: ["Эзерин"],
        Q414986: ["Фолликулин"],
        Q422745: ["Анестезин"],
        Q423741: ["Новокаин"],
        Q417597: ["Новокаинамид"],
        Q274515: ["Левомицетин"],
        Q407972: ["Аминазин"],
        Q423364: ["Анаприлин"],
        Q554881: ["Дионин"],
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

const isLower = (c) => c !== c.toUpperCase();
const isUpper = (c) => c !== c.toLowerCase();

/** Первая буква: цифры, скобки и знаки пропускаем — «2-фенилфенол» → «ф». */
const firstLetter = (s) => /\p{L}/u.exec(String(s ?? ""))?.[0] ?? "";

/** Сколько правок отделяет одно слово от другого (Левенштейн). */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Родственны ли два написания: есть слово с той же основой, одно слово внутри
 * другого или они отличаются на одну-две буквы. Так связаны соль и основание
 * («Амлодипина бесилат» — «амлодипин»), множественное число («Гентамицины»),
 * разные транскрипции («Альпразолам» — «алпразолам»).
 */
function related(a, b) {
  const aw = words(normalizeName(a)).filter((w) => w.length >= 3);
  const bw = words(normalizeName(b)).filter((w) => w.length >= 3);
  return aw.some((x) =>
    bw.some((y) => {
      if (stemWord(x) === stemWord(y)) return true;
      if (Math.min(x.length, y.length) < 5) return false;
      return x.includes(y) || y.includes(x) || editDistance(x, y) <= 2;
    }),
  );
}

/**
 * Части химических названий: «Ортогидроксидифенил», «Натрия ацетат» с
 * заглавной — это не торговые названия, а систематические.
 */
const CHEMICAL_PART =
  /гидрокс|оксид|фенил|метил|этил|пропил|бутил|хлор|бром|фтор|амино|нитро|карбокс|сульф|фосф|кислот|натри|кали[йя]|кальци|магни|ацетат/i;

/**
 * Похоже на торговое название по виду: начинается с буквы, дальше не одни
 * заглавные («АСК» — сокращение), не приставка изомера («L-тироксин»,
 * «N-ацетилцистеин»), не формула, не «Витамин B12», не систематическое
 * название. Регистр первой буквы смотрит brandsOf.
 */
function brandShape(alias) {
  const a = alias.trim();
  const first = firstLetter(a);
  if (!first || a.charAt(0) !== first) return false;
  if (![...a.slice(1)].some(isLower)) return false;
  if (/^[A-Z]-/.test(a) || realFormula(a)) return false;
  if (/^(?:про)?витамин|^кофермент|^коэнзим/i.test(a)) return false;
  return !CHEMICAL_PART.test(a);
}

/**
 * Препарат производителя: имя вещества плюс марка через дефис или пробел —
 * «Веро-Индапамид», «Хлоропирамин-ЭСКОМ», «Ультракаин Д-С». Приставка из
 * одной буквы — изомер («L-триптофан»), не марка.
 */
function makerVariant(alias, label) {
  const at = alias.trim().split(/[\s-]+/).filter(Boolean);
  const lt = label.trim().split(/[\s-]+/).filter(Boolean);
  if (at.length <= lt.length) return false;
  const same = (xs) => xs.length === lt.length && xs.every((t, i) => key(t) === key(lt[i]));
  let rest = null;
  if (same(at.slice(0, lt.length))) rest = at.slice(lt.length);
  else if (same(at.slice(at.length - lt.length))) rest = at.slice(0, at.length - lt.length);
  if (!rest) return false;
  if (rest.length === 1 && rest[0].length === 1) return false;
  return rest.every((t) => isUpper(firstLetter(t)) && t.charAt(0) === firstLetter(t));
}

/**
 * Торговые названия среди синонимов предмета — ключ → почему.
 *
 * В Wikidata русские названия веществ пишутся со строчной («парацетамол»), а
 * торговые — с заглавной («Панадол»). Синоним торгового вида, не родственный
 * главному имени, у предмета со строчным главным именем — торговое название.
 * Если главное имя с заглавной (или взято из заголовка статьи), по регистру
 * не понять; тогда торговыми считаем, только если таких синонимов три и
 * больше: настоящих вторых имён с другим корнем у вещества одно-два
 * («Адреналин» — «Эпинефрин»), а марок — десятки. Марки бывают записаны и
 * со строчной («сиофор» у метформина) — поэтому пять и больше несвязанных
 * имён в любом регистре тоже марки.
 *
 * Торговое название — не имя вещества: по реестру оно находит препараты одной
 * марки, часто комбинированные («Андипал» — метамизол с тремя другими), а
 * опознание сливало бы такой препарат с одним из его веществ.
 */
function brandsOf(item, keepKeys) {
  const out = new Map();
  const label = item.label;
  const labelLower = Boolean(item.wikidataLabel) && !item.renamedFrom && isLower(firstLetter(item.wikidataLabel));
  const loose = []; // с заглавной, не родственные главному имени
  const looseAnyCase = [];
  const seen = new Set([key(label)]);
  for (const a of item.aliases) {
    const k = key(a);
    if (!k || seen.has(k) || keepKeys.has(k)) continue;
    seen.add(k);
    if (makerVariant(a, label)) out.set(k, "препарат производителя");
    else if (brandShape(a) && !related(a, label)) {
      looseAnyCase.push(k);
      if (isUpper(firstLetter(a))) loose.push(k);
    }
  }
  if (labelLower) for (const k of loose) out.set(k, "с заглавной при строчном главном имени");
  else if (loose.length >= 3) for (const k of loose) out.set(k, "много несвязанных имён с заглавной");
  if (looseAnyCase.length >= 5) {
    for (const k of looseAnyCase) if (!out.has(k)) out.set(k, "много несвязанных имён");
  }
  return out;
}

/**
 * Шифр соединения латиницей: «BMS-562247-01», «MK-3475», «T-705» — не
 * название, и в реестре его нет.
 */
function researchCode(name) {
  if (/[а-яё]/i.test(name) || !/\d/.test(name) || realFormula(name)) return null;
  return "шифр соединения латиницей, не название";
}

/**
 * Брутто-формула органического вещества: «C21H23NO5» — одна на все изомеры
 * (у «C3H6O3» и молочная кислота, и глицеральдегид). Формулы, где элемент
 * повторяется («CH3COONa»), — структурные, их оставляем.
 */
function organicGrossFormula(name) {
  const bare = String(name).replace(/\s+/g, "");
  if (!realFormula(bare)) return null;
  const symbols = bare.match(/[A-Z][a-z]?/g) ?? [];
  if (symbols[0] !== "C" || symbols[1] !== "H" || new Set(symbols).size !== symbols.length) return null;
  const carbons = Number(/^C(\d*)/.exec(bare)[1] || 1);
  return carbons >= 2 ? "брутто-формула органического вещества — одна на все изомеры" : null;
}

/** Латинское сокращение: «DMSO», «GABA» — для опознания, но не для поиска. */
const LATIN_ABBREVIATION = /^[A-Z]{3,6}$/;

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

const CLAIMS = ["P31", "P279", "P246", "P1086", "P267"];

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

/**
 * Все, у кого есть утверждение: «haswbstatement:P267 haswbstatement:P231» —
 * и код АТХ, и номер CAS.
 *
 * Сколько всего предметов со свойством, считаем отдельно: разница — те, кого
 * запрос не взял (у лекарств — без номера CAS), её показываем в отчёте.
 */
async function walkStatement(group) {
  const withProperty = await searchCount(`haswbstatement:${group.root.pid}`);
  const { ids, total } = await searchAll(group.query);
  const info = await fetchItems(ids, (n, of) =>
    process.stdout.write(`\r  разобрано предметов: ${n} из ${of}   `),
  );
  process.stdout.write("\n");
  for (const item of info.values()) {
    item.depth = 1;
    item.parents = [];
  }
  // Поиск не листает дальше 10 000 — тогда часть предметов не дошла бы до нас.
  return { found: info, classes: 0, cut: ids.length < total, withProperty, total, got: ids.length };
}

/** Строка справочника: имена через «|», в хвосте — группа, CAS и код элемента. */
function lineOf(e) {
  const names = e.spellings.map((s, i) => (i > 0 && e.noSearch?.has(key(s)) ? `*${s}` : s));
  const tail = [e.group, e.tag, e.cas && `CAS ${e.cas}`].filter(Boolean).join(", ");
  return `${names.join(" | ")}   # ${tail} ${e.id}`;
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
  const rootId = (g) => g.root.qid ?? g.root.pid;
  const roots = await entities(domain.groups.map(rootId));
  await pause();
  say("\nКорни:");
  for (const g of domain.groups) {
    const r = roots.get(rootId(g));
    if (!r || !g.root.expect.test(r.label)) {
      console.error(
        `\nКорень группы «${g.name}» (${rootId(g)}) называется «${r?.label ?? "—"}», ` +
          `а ждали ${g.root.expect}. Код в DOMAINS неверен — обход ушёл бы не туда.`,
      );
      process.exit(1);
    }
    g.rootLabel = r.label;
    say(`  ${g.name.padEnd(9)} ← «${r.label}» (${rootId(g)}): ${g.about}`);
  }

  // «Или» нужно только обходу дерева классов.
  const treeRoot = domain.groups.find((g) => g.walk === "tree")?.root.qid;
  const orOk = treeRoot ? await orSupported(treeRoot) : false;
  if (treeRoot) {
    console.log(
      orOk
        ? "Поиск понимает «или» — уровень дерева спрашиваем парой запросов."
        : "Поиск «или» не понимает — спрашиваем по классу; это дольше.",
    );
  }

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
    const walked =
      g.walk === "tree"
        ? await walkTree(g.root, { orOk, maxDepth: opts.maxDepth, maxClasses: opts.maxClasses })
        : g.walk === "statement"
          ? await walkStatement(g)
          : await walkInstances(g.root);
    let taken = 0;
    let noArticle = 0;
    const labels = new Map([[rootId(g), g.rootLabel]]);
    for (const it of walked.found.values()) labels.set(it.id, it.label || it.id);
    const ordered = [...walked.found.values()].sort(
      // Без подписи по-русски имя потом возьмётся из заголовка статьи — по нему
      // и сортируем, иначе такие предметы встают в начало списка.
      g.order ?? ((a, b) => (a.label || a.ruwiki || "").localeCompare(b.label || b.ruwiki || "", "ru")),
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
      // Заголовок всегда с заглавной — по нему торговое название не узнать.
      it.wikidataLabel = it.label;
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
      it.groupSpec = g;
      it.parentLabel = asCanon(it.parents.map((p) => labels.get(p)).filter(Boolean)[0] ?? "") || null;
      items.set(it.id, it);
      taken += 1;
    }
    const found =
      g.walk === "statement"
        ? `со свойством ${g.root.pid} всего ${walked.withProperty}, по запросу ` +
          `«${g.query}» — ${walked.total}`
        : `найдено ${walked.found.size}`;
    const cutWhy =
      g.walk === "statement"
        ? ` — ОБРЕЗАНО: поиск отдал ${walked.got} из ${walked.total}`
        : " — ОБХОД ОБОРВАН по --max-classes/--max-depth";
    walkNotes.push(
      `  ${g.name}: ${found}, без статьи в русской Википедии ${noArticle}, взято ${taken}` +
        (g.walk === "tree" ? `; классов опрошено ${walked.classes}` : "") +
        (walked.cut ? cutWhy : ""),
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
  const brandRows = [];
  const abbrRows = [];

  // Куда влить строку о веществе, которое справочник уже знает под другим
  // главным именем. Без этого «Бензоилпероксид» и «Дибензоилпероксид» (один
  // номер CAS) остались бы двумя веществами, а «Изопропиловый спирт» — уже
  // второе имя «Изопропанола» — столкнулся бы с ним и потерял главное имя.
  // Вливаем, вписав первым главное имя той записи: одинаковые главные имена
  // справочник сливает сам.
  const spellingOwner = new Map();
  const casOwners = new Map();
  for (const b of baseline.entries) {
    for (const sp of b.spellings) {
      const k = key(sp);
      if (k && !spellingOwner.has(k)) spellingOwner.set(k, b);
    }
    if (b.cas) casOwners.set(b.cas, [...(casOwners.get(b.cas) ?? []), b]);
  }
  const joinTarget = (e) => {
    const ck = key(e.canon);
    if (live.has(ck)) return null;
    const owner = spellingOwner.get(ck);
    if (owner) return { to: owner, why: `«${e.canon}» у него среди написаний` };
    const sameCas = e.cas ? (casOwners.get(e.cas) ?? []) : [];
    if (sameCas.length === 1) return { to: sameCas[0], why: `тот же номер CAS ${e.cas}` };
    return null;
  };
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
    const g = it.groupSpec;
    const decidedDrop = decisions.dropSpellings?.[it.id];
    const dropKeys = new Set((decidedDrop?.spellings ?? []).map(key));
    const notBrand = new Set((decisions.notBrand?.[it.id] ?? []).map(key));
    for (const a of it.aliases) if (notBrand.has(key(a))) used.add(`${it.id}|!${key(a)}`);
    const brandWhy = g.brands ? brandsOf(it, notBrand) : new Map();
    const spellings = [];
    const seen = new Set();
    const ownKey = key(it.label);
    const brands = [];
    const abbrs = [];
    for (const s of [it.label, ...it.aliases]) {
      const alias = s !== it.label;
      const why =
        rejectReason(s) ||
        (alias && aliasReject(s, it.label)) ||
        (alias && (g.aliasChecks ?? []).map((check) => check(s)).find(Boolean)) ||
        (alias && dropKeys.has(key(s)) && `решение согласования: ${decidedDrop.why}`) ||
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
      if (alias && brandWhy.has(k)) {
        brands.push({ name: asCanon(s), why: brandWhy.get(k) });
        if (g.brands === "drop") continue;
      }
      if (alias && g.abbrNoSearch && LATIN_ABBREVIATION.test(s.trim())) abbrs.push(asCanon(s));
      spellings.push(asCanon(s));
    }
    const noSearch = new Set((decisions.noSearch?.[it.id] ?? []).map(key));
    for (const s of spellings) if (noSearch.has(key(s))) used.add(`${it.id}|*${key(s)}`);
    if (g.brands === "noSearch") for (const b of brands) noSearch.add(key(b.name));
    for (const a of abbrs) noSearch.add(key(a));
    if (brands.length) brandRows.push({ id: it.id, canon: spellings[0], brands });
    if (abbrs.length) abbrRows.push(`${spellings[0]}: ${abbrs.map((a) => `«${a}»`).join(", ")}   (${it.id})`);
    const e = {
      id: it.id,
      group: it.group,
      canon: spellings[0],
      spellings,
      cas: it.cas,
      tag: g.tag?.(it) ?? null,
      noSearch,
      parentLabel: it.parentLabel,
    };
    if (g.joinKnown) {
      const join = joinTarget(e);
      if (join) {
        e.joined = { from: e.canon, to: join.to, why: join.why };
        e.spellings = [join.to.canon, ...e.spellings.filter((x) => key(x) !== key(join.to.canon))];
        e.canon = join.to.canon;
      }
    }
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
    if (e.spellings.length < 2 && !e.cas) {
      silent += 1;
      continue;
    }
    // Справочник уже знает вещество под тем же именем, и новое ничего не
    // добавляет — ни имени, ни номера.
    const known = live.get(ck);
    if (known) {
      const knownKeys = new Set(known.spellings.map(key));
      const adds = e.spellings.some((x) => !knownKeys.has(key(x))) || (e.cas && !known.cas);
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

  // Код Wikidata по написанию строки предложения — чтобы решение согласования
  // можно было записать прямо по отчёту.
  const idOf = new Map();
  for (const e of entries) for (const sp of e.spellings) if (!idOf.has(key(sp))) idOf.set(key(sp), e.id);
  const qid = (...names) => {
    const id = names.map((n) => idOf.get(key(n))).find(Boolean);
    return id ? `   (${id})` : "";
  };

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
          (added.length ? ` ← ${added.map((s) => `«${now.noSearch.has(s) ? "*" : ""}${s}»`).join(", ")}` : "") +
          (casAdded ? ` ← номер CAS ${casAdded}` : "") +
          qid(...added, before.canon),
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
    if (!was) graphChanges.gained.push(`«${label}» → «${will}»${qid(label, will)}`);
    else if (!will) graphChanges.lost.push(`«${label}»: было «${was}», станет — никак`);
    else graphChanges.changed.push(`«${label}»: было «${was}», станет «${will}»${qid(label, will)}`);
  }

  const flagged = [];
  for (const e of entries) {
    for (const f of flagsOf(e)) flagged.push(`${e.canon}: ${f}   (${e.id})`);
  }

  // Торговые названия — по предметам; почему так решено, пишем, только если
  // не по главному правилу («с заглавной при строчном главном имени»).
  const brandLines = brandRows.map((r) => {
    const names = r.brands.map((b) => {
      const note = b.why === "с заглавной при строчном главном имени" ? "" : ` [${b.why}]`;
      return `«${b.name}»${note}`;
    });
    return `${r.canon}: ${names.join(", ")}   (${r.id})`;
  });
  const brandCount = brandRows.reduce((n, r) => n + r.brands.length, 0);
  const joined = entries
    .filter((e) => e.joined)
    .map((e) => `«${e.joined.from}» (${e.id}) → «${e.canon}» (${e.joined.to.source}): ${e.joined.why}`);

  // Один номер CAS у разных записей справочника: это одно вещество, которое не
  // слилось — общих написаний нет, — или ошибка номера в Wikidata, или разное
  // под одним номером («Активированный уголь» с номером углерода).
  const ourCas = new Set(entries.map((e) => e.cas).filter(Boolean));
  const byCas = new Map();
  for (const e of preview.entries) {
    if (!e.cas || !ourCas.has(e.cas)) continue;
    if (!byCas.has(e.cas)) byCas.set(e.cas, []);
    byCas.get(e.cas).push(e);
  }
  const sameCas = [...byCas]
    .filter(([, list2]) => list2.length > 1)
    .map(([cas, list2]) => `${cas}: ${list2.map((e) => `«${e.canon}» (${e.source})`).join(", ")}`);

  say("\n── СВОДКА ──");
  say(`  строк в предложении:            ${entries.length}`);
  say(`    новых веществ:                ${fresh.length}`);
  say(`    дополнят записи справочника:  ${extended.length}   ← смотреть: новые имена старых веществ`);
  say(`    одно имя и номер CAS:         ${entries.filter((e) => e.spellings.length === 1).length}`);
  say(`  конфликтов:                     ${conflicts.length}   ← смотреть все`);
  say(`  разные номера CAS:              ${casClashes.length}`);
  say(`  один номер CAS у разных записей: ${sameCas.length}   ← смотреть все`);
  if (joined.length) say(`  вольются в записи справочника:  ${joined.length}   ← смотреть все`);
  if (brandRows.length) {
    const how = domain.groups.some((g) => g.brands === "noSearch") ? "только для опознания, «*»" : "не берём";
    say(`  торговых названий:              ${brandCount} у ${brandRows.length} веществ — ${how}`);
  }
  if (abbrRows.length) say(`  латинские сокращения:           ${abbrRows.length}   ← только для опознания, «*»`);
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
      conflicts.map(
        (c) =>
          `«${c.spelling}»: у «${c.kept}» (${c.keptFrom}) и у «${c.ignored}» (${c.ignoredFrom})` +
          qid(c.ignoredFrom === fileName ? c.ignored : c.kept),
      ),
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
  if (sameCas.length) {
    say("\n── ОДИН НОМЕР CAS У РАЗНЫХ ЗАПИСЕЙ — одно вещество не слилось или разное под одним номером ──");
    list(sameCas, Infinity);
  }
  if (joined.length) {
    say("\n── ВОЛЬЮТСЯ В ЗАПИСИ СПРАВОЧНИКА — то же вещество под другим главным именем ──");
    list(joined, Infinity);
  }
  if (brandRows.length) {
    say("\n── ТОРГОВЫЕ НАЗВАНИЯ — по реестру нашли бы препараты марки, часто комбинированные ──");
    list(brandLines, 40);
  }
  if (abbrRows.length) {
    say("\n── ЛАТИНСКИЕ СОКРАЩЕНИЯ — только для опознания ──");
    list(abbrRows, 20);
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
  for (const [q, list2] of Object.entries(decisions.notBrand ?? {})) {
    for (const sp of list2) if (!used.has(`${q}|!${key(sp)}`)) stale.push(`notBrand ${q} «${sp}»`);
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
