// routes/industry/utils/classifiers.js
//
// Расшифровка кодов из реестра: «20.16.10» → «Полимеры этилена в первичных
// формах».
//
// Реестр хранит коды, а не названия, и в карточке стояла голая цифра. Сами
// классификаторы лежат в reference/ — они меняются раз в год и приезжают с
// кодом, поэтому читаем их файлы, а не кладём в базу: иначе смена справочника
// требовала бы переимпорта всего реестра.
//
// Читаются лениво, при первом обращении, и остаются в памяти: ОКПД2 — 1,7 тыс
// строк, ТН ВЭД — 13 тыс, вместе пара мегабайт. Файлов нет — расшифровки не
// будет, но ничего не сломается: коды показываются как есть.

const fs = require("fs");
const path = require("path");

const { words, stemName } = require("./normalize");

const DIR = path.resolve(__dirname, "../../../reference");

/** Код → название. null, пока не читали; Map — после. */
let okpd2 = null;
let tnved = null;
/** Коды ОКПД2, снятые с классификатора. null, пока не читали. */
let retired = null;

/** Прочитать файл справочника. Нет файла — это не ошибка. */
function readFile(name) {
  const file = path.join(DIR, name);
  try {
    // BOM в начале: файлы приходят из Windows-инструментов, и первый код
    // иначе получил бы невидимый символ впереди и не сошёлся бы ни с чем.
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

/** ОКПД2: плоский список «код⇥название». */
function loadOkpd2() {
  const map = new Map();
  const text = readFile("okpd2.txt");
  if (!text) return map;
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const code = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

/**
 * Коды, исключённые из классификатора.
 *
 * Собираются скриптом okpd2-refresh.js: код стоит в записях реестра, а в
 * свежей выгрузке классификатора его нет. Именно так, а не разностью двух
 * файлов справочника, — снятого кода у нас отродясь не было, вычитать нечего.
 * Файла может не быть — тогда просто не помечаем: это уточнение, а не условие
 * работы.
 */
function loadRetired() {
  const set = new Set();
  const text = readFile("okpd2-retired.txt");
  if (!text) return set;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const code = line.split("\t")[0].trim();
    if (code) set.add(code);
  }
  return set;
}

/**
 * Первый код из поля реестра.
 *
 * В одной записи ГИСП бывает несколько кодов: «20.13.25.114, 20.13.25.119»,
 * «20.16.30; 20.13.25». Целиком такая строка не совпадёт ни с одной записью
 * классификатора, и карточка оставалась без названия вовсе. Берём первый —
 * он же и главный: заявитель ставит его первым.
 */
function firstCode(raw) {
  const head = String(raw ?? "").split(/[;,]/)[0] ?? "";
  return head.trim();
}

/**
 * Снят ли код с классификатора.
 *
 * Проверяем код ЦЕЛИКОМ, без отсечения хвоста, — в отличие от поиска
 * названия. Родительская группа может быть жива, когда исключена только
 * детализация: 20.14.61.000 снят, а 20.14.61 остался.
 */
function okpd2Retired(code) {
  if (retired === null) retired = loadRetired();
  const clean = firstCode(code);
  return clean ? retired.has(clean) : false;
}

/**
 * ТН ВЭД: иерархия, где имя строки без родителей бессмысленно.
 *
 * «– – – прочие» сам по себе не значит ничего — полное имя собирается по
 * цепочке вверх, а глубина задана количеством тире в начале наименования.
 * Строки без кода — заголовки уровня, они в выдачу не идут, но в цепочку
 * входят.
 */
function loadTnved() {
  const map = new Map();
  const text = readFile("tnved.txt");
  if (!text) return map;

  let group = "";
  const parents = [];
  for (const line of text.split("\n")) {
    if (!line.includes("\t")) {
      if (line.startsWith("ГРУППА")) {
        group = line.trim();
        parents.length = 0;
      }
      continue;
    }
    const [rawCode, rawName = ""] = line.split("\t");
    const depth = (rawName.match(/–/g) ?? []).length;
    const name = rawName.replace(/^[\s–]+/, "").replace(/:\s*$/, "").trim();
    if (!name) continue;

    parents[depth] = name;
    parents.length = depth + 1;

    // В колонке кода попадаются примечания — у них там текст, а не цифры.
    const code = rawCode.replace(/\s+/g, "");
    if (!/^\d{4,10}$/.test(code)) continue;

    map.set(code, {
      name,
      path: parents.filter(Boolean).join(" → "),
      group,
    });
  }
  return map;
}

/**
 * Название по коду ОКПД2 вместе с тем, чьё оно.
 *
 * Отсекаем хвост по группам цифр, пока не найдём. Нашли по целому коду — это
 * название самой позиции; нашли по укороченному — название ГРУППЫ, в которую
 * код попал, и выдавать его за точное нельзя. Раньше файл справочника был
 * шестизначным, и группой оказывалось почти всё; со свежей выгрузкой точных
 * названий становится большинство — потому и потребовалось различать.
 */
function lookupOkpd2(code) {
  if (okpd2 === null) okpd2 = loadOkpd2();
  const clean = firstCode(code);
  if (!clean) return null;

  let key = clean;
  while (key) {
    const hit = okpd2.get(key);
    if (hit) return { name: hit, exact: key === clean, at: key };
    const dot = key.lastIndexOf(".");
    if (dot < 0) break;
    key = key.slice(0, dot);
  }
  return null;
}

/**
 * Позиции классификатора, разобранные по словам названия, — для поиска
 * КОДА ПО НАЗВАНИЮ вещества. Строится лениво, при первом обращении.
 */
let okpd2ByWords = null;

function buildOkpd2ByWords() {
  if (okpd2 === null) okpd2 = loadOkpd2();
  const out = [];
  for (const [code, name] of okpd2) {
    const stems = new Set(words(stemName(name)).filter((w) => w.length > 2));
    if (stems.size) out.push({ code, name, stems });
  }
  return out;
}

/**
 * Категория ОКПД2 по НАЗВАНИЮ вещества — без всякого реестра.
 *
 * Зачем. Классификатор и реестр — разные вещи, а в карточке это сливалось в
 * одно «записи нет». Бензол в классификаторе есть (20.14.12.130 «Бензолы»), а
 * в реестре ПП №719 его нет: код категории существует всегда, а запись
 * появляется, только когда завод заявил продукцию на подтверждение
 * происхождения. Заказчик на этом и споткнулся, увидев бензол на сайте
 * классификатора.
 *
 * Правило: все значимые слова написания входят в название позиции. Порядок
 * слов не важен — «Терефталевая кислота» находит «Кислота терефталевая».
 * Ранжируем по числу ЛИШНИХ слов позиции: точное совпадение набора лучше, чем
 * название с довеском.
 *
 * Написание, потерявшее при отборе короткие слова, пропускаем целиком: оно
 * перестаёт различать. «Пропанол-2» сводится к «пропану» и приводит к
 * сжиженному пропану — то же, из-за чего «П-Ксилол» находил орто-изомер.
 *
 * @param {string[]} spellings известные написания вещества
 * @param {number} maxExtra сколько лишних слов у позиции ещё допустимо
 */
function okpd2ByName(spellings, maxExtra = 1) {
  if (okpd2ByWords === null) okpd2ByWords = buildOkpd2ByWords();
  const out = [];
  const seen = new Set();

  for (const spelling of spellings ?? []) {
    const all = words(stemName(spelling));
    const need = all.filter((w) => w.length > 2);
    if (!need.length || need.length !== all.length) continue;

    for (const e of okpd2ByWords) {
      const extra = e.stems.size - need.length;
      if (extra < 0 || extra > maxExtra || seen.has(e.code)) continue;
      if (!need.every((w) => e.stems.has(w))) continue;
      seen.add(e.code);
      out.push({ code: e.code, name: e.name, extra, matchedAs: spelling });
    }
  }

  out.sort((a, b) => a.extra - b.extra || a.code.localeCompare(b.code));
  return out;
}

/**
 * Позиции ОКПД2, уточняющие код: 20.14.52.111 «Капролактам» и её соседи под
 * 20.14.52.110 «Соединения гетероциклические…».
 *
 * Код читается по цифрам, и ноли в хвосте последней группы значат «не
 * уточнено»: отбросив их, получаем начало кодов всех уточнений. У кода из
 * трёх групп (20.14.52) уточнения — всё, что под ним через точку. Нули в
 * средних группах не трогаем: 20.14.50 не начало для 20.14.51.
 */
function okpd2Below(code) {
  if (okpd2 === null) okpd2 = loadOkpd2();
  const clean = firstCode(code);
  if (!clean) return [];
  const groups = clean.split(".");
  const head =
    groups.length === 4
      ? `${groups.slice(0, 3).join(".")}.${groups[3].replace(/0+$/, "")}`
      : `${clean}.`;
  const out = [];
  for (const [c, name] of okpd2) {
    if (c !== clean && c.startsWith(head)) out.push({ code: c, name });
  }
  return out;
}

/**
 * Код, вписанный человеком в карточку, — с названием из классификатора.
 *
 * Формат проверяем строго: «20.14.52.111», допускаются и короткие уровни
 * («20.14», «20.14.5», «20.14.52»). Нет такого кода — known: false, но
 * название ближайшей группы над ним всё равно отдаём: человеку виднее, а
 * группа подскажет, туда ли он смотрит.
 */
function describeOkpd2(raw) {
  const code = String(raw ?? "").trim();
  if (!/^\d{2}(\.\d{1,2}(\.\d{1,2}(\.\d{1,3})?)?)?$/.test(code)) return null;
  const hit = lookupOkpd2(code);
  return {
    code,
    name: hit?.name ?? null,
    exact: Boolean(hit?.exact),
    known: Boolean(hit?.exact),
    retired: okpd2Retired(code),
  };
}

/**
 * То же для ТН ВЭД: 4–10 цифр, пробелы между группами допустимы. Наш файл
 * номенклатуры не держит каждую десятизначную позицию — название берётся по
 * ближайшему уровню (exact: false), и код считается известным, если такой
 * уровень есть.
 */
function describeTnved(raw) {
  const digits = String(raw ?? "").replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(digits)) return null;
  const hit = tnvedName(digits);
  return {
    code: digits,
    formatted: formatTnved(digits),
    name: hit?.name ?? null,
    path: hit?.path ?? null,
    exact: Boolean(hit?.exact),
    known: Boolean(hit),
  };
}

/** Только название — тем, кому подробности не нужны. */
function okpd2Name(code) {
  return lookupOkpd2(code)?.name ?? null;
}

/** Названо ли кодом целиком, а не группой над ним. */
function okpd2NameExact(code) {
  return lookupOkpd2(code)?.exact ?? false;
}

/**
 * Название по коду ТН ВЭД.
 *
 * Коды в реестре десятизначные, в номенклатуре встречаются 4, 6, 9 и 10 цифр.
 * Укорачиваем, пока не совпадёт: чем короче код, тем шире товарная группа, и
 * это честнее, чем не сказать ничего.
 */
function tnvedName(code) {
  if (tnved === null) tnved = loadTnved();
  const digits = String(code ?? "").replace(/\D+/g, "");
  if (digits.length < 4) return null;

  for (let len = digits.length; len >= 4; len--) {
    const hit = tnved.get(digits.slice(0, len));
    if (hit) {
      return {
        name: hit.name,
        path: hit.path,
        group: hit.group,
        // Код короче спрошенного — значит это группа, а не сама позиция.
        exact: len === digits.length,
      };
    }
  }
  return null;
}

/** Код ТН ВЭД цифрами — как его пишут: «2933710000» → «2933 71 000 0». */
function formatTnved(code) {
  const d = String(code ?? "").replace(/\D+/g, "");
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 9), d.slice(9)].filter(Boolean).join(" ");
}

/**
 * Разбить текст по разделителю, но только вне скобок: в
 * «2-этил-2-(гидроксиметил)пропан-1,3-диол» и «(1 : 1)» делить нечего.
 */
function splitOutsideParens(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const m = sep.exec(text.slice(i));
      if (m && m.index === 0 && m[0].length) {
        out.push(text.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  out.push(text.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * Скобка в конце названия, отделённая пробелом, — второе имя: «6-гексанлактам
 * (ε-капролактам)». Скобка впритык — часть химического имени, а не второе
 * имя: «2-этил-2-(гидроксиметил)пропан-1,3-диол». null — второго имени нет.
 */
function trailingParen(text) {
  if (!text.endsWith(")")) return null;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(" && --depth === 0) {
      if (i === 0 || !/\s/.test(text[i - 1])) return null;
      return { head: text.slice(0, i).trim(), inner: text.slice(i + 1, -1).trim() };
    }
  }
  return null;
}

/**
 * Варианты названия позиции ТН ВЭД: целиком, части перечня («A, B и C»,
 * «A; B») порознь, у каждой — имя до скобки и имена в скобке.
 * «6-гексанлактам (ε-капролактам)» — это и «6-гексанлактам», и
 * «ε-капролактам»; «бута-1,3-диен и изопрен» — оба вещества; «гидрохинон
 * (хинол) и его соли» — гидрохинон и хинол.
 *
 * Делим только вне скобок и только по «, » с пробелом: запятая между цифрами
 * — часть имени («пропан-1,2-диол»). Часть, начатая скобкой, — хвост
 * сложного имени: в «соль метилфосфоновой кислоты и
 * (аминоиминометил)мочевины» «мочевины» — не мочевина. «его соли», «их соли»
 * — тоже не вещества.
 *
 * whole — имя и есть вся позиция (или её второе имя в скобке). Часть перечня
 * слабее: из описательной фразы «водород и его соединения, обогащенные
 * дейтерием» деление выдёргивает «водород», а это не водород. Своя позиция у
 * вещества побеждает часть перечня (tnvedByName.js).
 *
 * @returns {{ text: string, whole: boolean }[]}
 */
function tnvedNameVariants(name) {
  const out = new Map();
  const add = (text, whole) => {
    if (text.length > 2) out.set(text, out.get(text) === true || whole);
  };
  const addWithParen = (text, whole) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    add(t, whole);
    const p = trailingParen(t);
    if (!p) return;
    add(p.head, whole);
    for (const alt of splitOutsideParens(p.inner, /^[;,]\s+/)) add(alt, whole);
  };
  addWithParen(name, true);
  for (const part of splitOutsideParens(name, /^(\s+и\s+|[;,]\s+)/)) {
    if (/^\(|^(его|ее|её|их)\s/i.test(part)) continue;
    addWithParen(part, false);
  }
  return [...out].map(([text, whole]) => ({ text, whole }));
}

/**
 * Позиции ТН ВЭД групп 28–29 — неорганической и органической химии — для
 * поиска КОДА ПО НАЗВАНИЮ вещества (tnvedByName.js).
 *
 * Только эти группы: там названия — сами вещества («бензол», «6-гексанлактам
 * (ε-капролактам)»), а в остальных — товарные категории («смеси…»,
 * «препараты…»), и бензол нашёлся бы ещё и в 2707 «продукты перегонки
 * каменноугольной смолы». «Прочие» не берём: это остаток группы, а не
 * вещество.
 */
let tnvedSubstances = null;

function tnvedSubstancePositions() {
  if (tnvedSubstances) return tnvedSubstances;
  if (tnved === null) tnved = loadTnved();
  const out = [];
  for (const [code, e] of tnved) {
    if (!/^ГРУППА 2[89]\b/.test(e.group)) continue;
    // «прочие» — остаток группы, где бы ни стояло: «бутанолы прочие» — не
    // н-бутанол, у него своя позиция.
    if (/(^|\s)проч/i.test(e.name)) continue;
    out.push({ code, display: formatTnved(code), name: e.name, variants: tnvedNameVariants(e.name) });
  }
  tnvedSubstances = out;
  return out;
}

/** Что удалось прочитать — для диагностики и страницы состояния. */
function classifiersStatus() {
  if (okpd2 === null) okpd2 = loadOkpd2();
  if (tnved === null) tnved = loadTnved();
  return { okpd2: okpd2.size, tnved: tnved.size, dir: DIR };
}

module.exports = {
  describeOkpd2,
  describeTnved,
  okpd2Below,
  okpd2ByName,
  okpd2Name,
  okpd2NameExact,
  okpd2Retired,
  formatTnved,
  tnvedName,
  tnvedSubstancePositions,
  classifiersStatus,
};
