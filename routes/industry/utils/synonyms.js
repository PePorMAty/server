// routes/industry/utils/synonyms.js
//
// Справочник синонимов: «ИПБ», «Кумол» и «Изопропилбензол» — одно вещество.
//
// Зачем он нужен. Названием продукта пользуются как признаком равенства: по
// нему узлы графа схлопываются при объединении и при построении по шагам, по
// нему же ищется запись в реестре. Но у вещества названий несколько, и каждый
// автор графа пишет своё — одно и то же вещество расползалось на три узла, а
// поиск по реестру не находил его там, где запись была.
//
// Справочник лежит в reference/synonyms.txt рядом с классификаторами: он
// правится человеком и приезжает с кодом, поэтому читается из файла, а не из
// базы. Чтение ленивое, при первом обращении; полторы сотни строк остаются в
// памяти. Файла нет — всё работает как раньше, просто без синонимов.

const fs = require("fs");
const path = require("path");

const { foldLookalikes, normalizeName, GENERIC_WORDS } = require("./normalize");

/**
 * Ключ справочника.
 *
 * Сверх обычной нормализации сводим неотличимые на вид буквы: «Бисфенол A»
 * с латинской A и «Бисфенол А» с кириллической — на экране одна строка, и
 * справочник обязан отвечать на обе одинаково. Базы реестра это не касается:
 * справочник читается из файла, и обе стороны сравнения приводятся здесь же.
 */
const dictKey = (raw) => foldLookalikes(normalizeName(raw));

const FILE = path.resolve(__dirname, "../../../reference/synonyms.txt");

/** Нормализованное написание → запись. null, пока не читали. */
let index = null;
/** Что получилось при разборе файла — для страницы состояния и диагностики. */
let stats = null;

/**
 * Разобрать файл справочника.
 *
 * Конфликты — когда одно написание приписано двум веществам — не сливаем и не
 * выбираем молча: побеждает первая запись, а остальные откладываем в stats.
 * Молчаливое слияние здесь было бы худшим из возможных поведений: два разных
 * вещества стали бы одним узлом графа, и заметить это было бы нечем.
 */
function load() {
  const map = new Map();
  const conflicts = [];
  let lines = 0;

  let text;
  try {
    // BOM в начале: файл правят в том числе windows-редакторами, и первое
    // название иначе получило бы невидимый символ впереди.
    text = fs.readFileSync(FILE, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    stats = { entries: 0, spellings: 0, conflicts: [], file: FILE, loaded: false };
    return map;
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) continue;

    const canon = parts[0];
    lines += 1;
    const entry = { canon, spellings: parts };

    for (const spelling of parts) {
      const key = dictKey(spelling);
      if (!key) continue;
      const prev = map.get(key);
      if (prev) {
        // То же вещество, записанное дважды, — не конфликт, а повтор.
        if (prev.canon !== canon) {
          conflicts.push({ spelling, kept: prev.canon, ignored: canon });
        }
        continue;
      }
      map.set(key, entry);
    }
  }

  stats = {
    entries: lines,
    spellings: map.size,
    conflicts,
    file: FILE,
    loaded: true,
  };
  return map;
}

function ensure() {
  if (index === null) index = load();
  return index;
}

/**
 * Опознать продукт по названию.
 *
 * Возвращает каноническое название в том написании, в каком оно стоит в
 * справочнике, — именно оно становится идентификатором продукта на графе.
 * Написание нарочно не приводится к нижнему регистру: идентификатор видит
 * человек в карточке узла, и «Изопропилбензол» читается, а «изопропилбензол»
 * выглядит опечаткой.
 *
 * null — вещества в справочнике нет. Это штатно: справочник покрывает ходовые
 * названия, а не всю химию.
 */
function identify(rawName) {
  const map = ensure();
  const key = dictKey(rawName);
  if (!key) return null;

  const hit = map.get(key) ?? identifyParenthesized(map, rawName);
  if (!hit) return null;

  return {
    id: hit.canon,
    canon: hit.canon,
    /** Совпало само каноническое название или один из синонимов. */
    exact: dictKey(hit.canon) === key,
    spellings: hit.spellings,
  };
}

/**
 * Подпись вида «Название (сокращение)»: «Изопропилбензол (ИПБ)».
 *
 * Узлы так подписывают часто, а справочнику целая строка незнакома. Берём обе
 * половины — но засчитываем, только если КАЖДАЯ из них известна и обе про одно
 * вещество. Это и есть проверка, что в скобках синоним, а не уточнение.
 *
 * Одной половины мало. У «Полиэтилен (вторичный)» головное слово известно, а
 * продукт это другой: приняв его за полиэтилен, мы слили бы в один узел
 * первичное сырьё и вторичное. Скобки уточняют чаще, чем поясняют, поэтому
 * согласие обеих половин — единственное, на что тут можно опереться.
 */
function identifyParenthesized(map, rawName) {
  const text = String(rawName ?? "");
  const open = text.indexOf("(");
  if (open < 1) return null;
  const close = text.indexOf(")", open + 1);
  if (close < 0) return null;

  const head = lookupHalf(map, text.slice(0, open));
  const inner = lookupHalf(map, text.slice(open + 1, close));
  if (!head || !inner) return null;
  return head.canon === inner.canon ? head : null;
}

/**
 * Найти половину подписи в справочнике, не спотыкаясь о довески.
 *
 * Половина редко бывает чистым названием: «Изопропилбензола гидропероксид
 * технический», «LPG, пропан/бутан». Пробуем по очереди — как есть, без слов
 * вроде «технический» и «марки» (они и в поиске по реестру объявлены
 * незначащими), и первым элементом перечисления.
 *
 * Послабления касаются только того, ЧТО искать. Правило, что обе половины
 * должны сойтись на одном веществе, остаётся: «Бензол (толуол, ксилол)» так и
 * не пройдёт, сколько половинки ни чисти.
 */
function lookupHalf(map, text) {
  const raw = String(text ?? "");
  const candidates = [raw];

  const words = dictKey(raw).split(" ").filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC_WORDS.has(w));
  if (meaningful.length && meaningful.length !== words.length) {
    candidates.push(meaningful.join(" "));
  }

  // Перечисление: «LPG, пропан/бутан» — первым идёт само название.
  const firstItem = raw.split(/[,;/]/)[0];
  if (firstItem && firstItem !== raw) candidates.push(firstItem);

  for (const candidate of candidates) {
    const hit = map.get(dictKey(candidate));
    if (hit) return hit;
  }
  return null;
}

/**
 * Все написания вещества — для поиска по реестру.
 *
 * Реестр заполняют люди, и запись может стоять под любым из названий: по
 * «ПЭНД» не находилось ничего, тогда как «полиэтилен низкого давления» в
 * реестре есть. Возвращаем и само спрошенное название — оно могло не попасть в
 * справочник, но найтись в реестре.
 */
function spellingsOf(rawName) {
  const name = String(rawName ?? "").trim();
  const hit = identify(name);
  if (!hit) return name ? [name] : [];

  const out = [];
  const seen = new Set();
  for (const spelling of [name, ...hit.spellings]) {
    const key = dictKey(spelling);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(spelling);
  }
  return out;
}

/** Что удалось прочитать — для страницы состояния. */
function synonymsStatus() {
  ensure();
  return { ...stats };
}

module.exports = { identify, spellingsOf, synonymsStatus };
