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

const {
  foldLookalikes,
  normalizeName,
  isElementFormula,
  stemWord,
  words,
  GENERIC_WORDS,
} = require("./normalize");

/**
 * Ключ справочника.
 *
 * Сверх обычной нормализации сводим неотличимые на вид буквы: «Бисфенол A»
 * с латинской A и «Бисфенол А» с кириллической — на экране одна строка, и
 * справочник обязан отвечать на обе одинаково. Базы реестра это не касается:
 * справочник читается из файла, и обе стороны сравнения приводятся здесь же.
 */
const dictKey = (raw) => foldLookalikes(normalizeName(raw));

/**
 * Ключ с усечёнными окончаниями: «Базовые масла» и «Базовое масло» сходятся.
 *
 * Отдельным ключом, а не вместо обычного: усечение — вещь грубая, и решать по
 * нему можно только тогда, когда точный ключ уже не нашёлся.
 *
 * Стоп-слова здесь НЕ отбрасываются, в отличие от words(). Русские «а», «с»,
 * «о» — предлоги и союзы, и words() их выбрасывает; а в «Бисфенол А» именно
 * эта буква и есть всё отличие от «Бисфенола». С отсевом ключ у них вышел бы
 * один, и два разных вещества слились бы.
 *
 * Слова ещё и сортируются: в русском порядок слов в химическом названии
 * свободный, и «Хлорид натрия» с «Натрия хлорид», «Сырой природный газ» с
 * «Природный газ (сырой)» — одно и то же. Вещества, различающегося ТОЛЬКО
 * порядком слов, не бывает.
 */
const stemKey = (raw) =>
  foldLookalikes(
    normalizeName(raw)
      .split(" ")
      .filter(Boolean)
      .map(stemWord)
      .sort()
      .join(" "),
  );

/**
 * Файлы справочника, в порядке доверия.
 *
 * Первый — правленный человеком, он и побеждает при расхождениях. Второй
 * собирается скриптом из Wikidata по номеру CAS и в репозитории может
 * отсутствовать: справочник должен работать и без него.
 */
const FILES = [
  path.resolve(__dirname, "../../../reference/synonyms.txt"),
  path.resolve(__dirname, "../../../reference/synonyms-wikidata.txt"),
];

/** Нормализованное написание → запись. null, пока не читали. */
let index = null;
/** Усечённое написание → запись. null у значения — столкновение, судить нечем. */
let stemIndex = null;
/** Что получилось при разборе файла — для страницы состояния и диагностики. */
let stats = null;

/**
 * Разобрать файлы справочника.
 *
 * Две строки могут описывать одно вещество, разойдясь лишь в том, какое имя
 * главное: «О-Ксилол | Орто-ксилол» в правленом файле и «Ортоксилол |
 * о-ксилол» в собранном из Wikidata. Такие строки СЛИВАЮТСЯ: все написания
 * достаются первой записи. Иначе проигравшая строка продолжала бы жить
 * отдельной записью, узлы «Ортоксилол» и «О-Ксилол» получили бы РАЗНЫЕ
 * идентификаторы и не схлопнулись — вещество разъехалось бы надвое, ровно
 * против того, ради чего справочник и заводился.
 *
 * Сливаем не всякое совпадение. Одно общее написание при расхождении во всём
 * остальном — случай противоположный и опасный: одно имя у двух РАЗНЫХ
 * веществ. Такие не сливаем и не выбираем молча: побеждает первая запись, а
 * пара уходит в stats.conflicts, чтобы её разобрал человек.
 */
function load() {
  const map = new Map();
  const conflicts = [];
  // Вердикт по паре записей. Одна пара даёт столько столкновений, сколько у
  // неё общих написаний, — считаем и сообщаем о ней один раз.
  const verdicts = new Map();
  /**
   * Строки, слитые с уже прочитанной записью того же вещества.
   *
   * Слияние молчаливое, а последствие у него такое же, как у конфликта: два
   * названия становятся одним узлом графа. Раз так, оно должно быть видно
   * поимённо — иначе ошибка в правиле родства никак себя не проявит.
   */
  const merged = [];

  /**
   * Одно ли это вещество.
   *
   * Считаем, сколько написаний у записей общих. Два независимых источника,
   * сошедшиеся на двух и более именах, говорят об одном веществе и разошлись
   * лишь в том, какое имя главное. А совпадение ровно в ОДНОМ написании при
   * расхождении во всём остальном — это и есть опасный случай: одно имя у
   * двух разных веществ. Его надо видеть поимённо.
   *
   * Ошибиться тут лучше в сторону тревоги: лишняя строка в отчёте ничего не
   * стоит, а ошибочное слияние сведёт два вещества в один узел молча.
   */
  const sameSubstance = (kept, incoming, spelling) => {
    const pair = `${kept.canon}\u0000${incoming.canon}`;
    const known = verdicts.get(pair);
    if (known !== undefined) return known;

    const keptKeys = new Set(kept.spellings.map(dictKey));
    const shared = incoming.spellings
      .map(dictKey)
      .filter((k) => k && keptKeys.has(k)).length;
    const same = shared > 1;
    verdicts.set(pair, same);

    const pairInfo = {
      spelling,
      kept: kept.canon,
      keptFrom: kept.source,
      ignored: incoming.canon,
      ignoredFrom: incoming.source,
    };
    if (same) merged.push({ ...pairInfo, shared });
    else conflicts.push(pairInfo);
    return same;
  };

  const sources = [];
  let lines = 0;

  for (const file of FILES) {
    let text;
    try {
      // BOM в начале: файл правят в том числе windows-редакторами, и первое
      // название иначе получило бы невидимый символ впереди.
      text = fs
        .readFileSync(file, "utf8")
        .replace(/^﻿/, "")
        .replace(/\r\n/g, "\n");
    } catch {
      // Файла нет — штатно для того, что собирается скриптом.
      continue;
    }

    let fileLines = 0;
    for (const rawLine of text.split("\n")) {
      // Хвостовой комментарий несёт происхождение записи: «# CAS 98-82-8 Q…».
      const hash = rawLine.indexOf("#");
      const body = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
      const note = hash >= 0 ? rawLine.slice(hash + 1).trim() : "";
      if (!body) continue;

      const parts = body
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);
      if (!parts.length) continue;

      const canon = parts[0];
      lines += 1;
      fileLines += 1;
      const cas = /CAS\s+([0-9]{2,7}-[0-9]{2}-[0-9])/i.exec(note)?.[1] ?? null;
      const entry = { canon, spellings: parts, cas, source: path.basename(file) };

      // Куда в итоге лягут написания этой строки. Обычно — в её собственную
      // запись; но если строка описывает вещество, уже известное под другим
      // каноническим именем, всё достаётся той записи.
      let target = entry;
      const written = [];

      for (const spelling of parts) {
        const key = dictKey(spelling);
        if (!key) continue;
        const prev = map.get(key);
        if (prev) {
          // То же вещество, записанное дважды, — не конфликт, а повтор.
          // Первое найденное родство и решает: строка, сошедшаяся сразу с
          // двумя записями, вливается в ту, что встретилась раньше.
          if (
            prev.canon !== canon &&
            sameSubstance(prev, entry, spelling) &&
            target === entry
          ) {
            target = prev;
          }
          continue;
        }
        map.set(key, entry);
        written.push(key);
      }

      if (target !== entry) mergeInto(map, target, entry, written);
    }
    sources.push({ file: path.basename(file), entries: fileLines });
  }

  stats = {
    entries: lines,
    spellings: map.size,
    conflicts,
    /** Строки, слитые с записью того же вещества из другого файла. */
    merged,
    sources,
    file: FILES[0],
    loaded: sources.length > 0,
  };
  return map;
}

/**
 * Влить строку в уже прочитанную запись того же вещества.
 *
 * Написания, которых у записи не было, переводим на неё: без этого
 * «Ортоксилол» остался бы отдельным веществом со своим идентификатором — то
 * есть ровно тем расхождением, которое справочник и должен убирать.
 *
 * И дописываем их в spellings. По этому списку идёт поиск по реестру, и лишнее
 * известное написание — лишний шанс найти запись, стоящую там под другим
 * именем.
 */
function mergeInto(map, target, entry, keys) {
  for (const key of keys) map.set(key, target);

  const known = new Set(target.spellings.map(dictKey));
  for (const spelling of entry.spellings) {
    const key = dictKey(spelling);
    if (!key || known.has(key)) continue;
    known.add(key);
    target.spellings.push(spelling);
  }
}

function ensure() {
  if (index === null) {
    index = load();
    stemIndex = buildStemIndex(index);
  }
  return index;
}

/**
 * Указатель по усечённым написаниям.
 *
 * Строится вторым проходом, по уже готовой карте: к этому моменту строки об
 * одном веществе слиты, и усечённый ключ ведёт к настоящей записи, а не к
 * проигравшей.
 *
 * Столкновение — не повод угадывать. Два РАЗНЫХ вещества, чьи написания после
 * усечения совпали, дают в значении null, и опознание по усечению на таком
 * ключе честно отказывается. Лучше не опознать, чем опознать не то.
 */
function buildStemIndex(map) {
  const out = new Map();
  for (const [key, entry] of map) {
    const sk = stemKey(key);
    if (!sk) continue;
    const prev = out.get(sk);
    if (prev === undefined) out.set(sk, entry);
    else if (prev && prev.canon !== entry.canon) out.set(sk, null);
  }
  return out;
}

/**
 * Опознать с усечёнными окончаниями — последняя попытка, после всех точных.
 *
 * Множественное число и падежи проходили мимо молча: ключ справочника точный,
 * и «Базовые масла» не находили «Базовое масло». Усечение это закрывает, а
 * разные вещества не сводит: «Циклогексан» и «Циклогексанол» после усечения
 * так и остаются разными, потому что отличаются не окончанием.
 */
function identifyByStem(rawName) {
  ensure();
  const sk = stemKey(rawName);
  if (!sk) return null;
  return stemIndex.get(sk) ?? null;
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

  const hit =
    map.get(key) ??
    identifyParenthesized(map, rawName) ??
    identifyWithoutGeneric(map, key) ??
    identifyByStem(rawName);
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
 * То же название без слов, ничего не говорящих о веществе.
 *
 * «Пропан технический» — это пропан, «Бутан марки А» — бутан. Такие довески
 * стоят в подписях узлов сплошь и рядом, а опознание до сих пор было
 * буквальным: одна точная выборка по всей строке, и любое уточнение сбивало
 * его начисто.
 *
 * Список этих слов (GENERIC_WORDS) намеренно короткий и разборчивый: туда
 * попадает только то, что говорит об исполнении, но не о происхождении.
 * «Вторичный» там не лежит и лежать не должен — вторичный полиэтилен это
 * другой продукт.
 */
function identifyWithoutGeneric(map, key) {
  const all = words(key);
  const rest = stripGeneric(all);
  if (!rest.length || rest.length === all.length) return null;
  return map.get(rest.join(" ")) ?? null;
}

/**
 * Убрать слова, ничего не говорящие о веществе.
 *
 * Обозначение сорта сразу за таким словом уходит вместе с ним: «марки А»,
 * «сорт Б» — это одно целое. А вот одинокую букву саму по себе трогать
 * нельзя ни в коем случае: «Бисфенол А» и «Бисфенол» — РАЗНЫЕ вещества, и
 * сведя их, мы слили бы два узла зря.
 */
function stripGeneric(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (GENERIC_WORDS.has(list[i])) {
      if (list[i + 1]?.length === 1) i += 1;
      continue;
    }
    out.push(list[i]);
  }
  return out;
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

  const innerText = text.slice(open + 1, close);
  const head = lookupHalf(map, text.slice(0, open));

  // Скобка, которая ничего не решает, — не повод отказывать.
  //
  // «Хлор (Cl2)» и «Жидкая ртуть (Hg)»: формула это ПЕРЕСКАЗ названия, другим
  // веществом она быть не может. «Изопрен (мономер)»: слово говорит о форме, а
  // не о веществе. В обоих случаях скобка не добавляет и не отменяет ничего,
  // и судить надо по головной половине.
  //
  // Строго про формулы: сокращения сюда НЕ попадают. «Каучук (SBR)» — это
  // конкретный каучук, а не каучук вообще, и такая поблажка слила бы разное.
  if (head && (isElementFormula(innerText) || allGeneric(innerText))) return head;

  const inner = lookupHalf(map, innerText);
  if (!head || !inner) return null;
  return head.canon === inner.canon ? head : null;
}

/** Скобка целиком из слов, ничего не говорящих о веществе. */
function allGeneric(text) {
  const parts = words(dictKey(text));
  return parts.length > 0 && parts.every((w) => GENERIC_WORDS.has(w));
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

/**
 * Все записи справочника — для отчётов и разбора.
 *
 * Опознанию не нужна: там выборка по ключу. Нужна тем, кто ищет, чего в
 * справочнике НЕ хватает, и сравнивает с ним названия целыми списками.
 */
function allEntries() {
  const map = ensure();
  const seen = new Set();
  const out = [];
  for (const entry of map.values()) {
    if (seen.has(entry.canon)) continue;
    seen.add(entry.canon);
    out.push({ canon: entry.canon, spellings: [...entry.spellings] });
  }
  return out;
}

module.exports = { identify, spellingsOf, synonymsStatus, allEntries };
