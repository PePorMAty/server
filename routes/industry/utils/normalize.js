// routes/industry/utils/normalize.js
//
// Приведение названий продуктов к виду, пригодному для поиска по реестру.
//
// Названия в графе и в реестре пишут по-разному: в графе — «Изобутилен» или
// «С4-фракция (бутаны и бутилены)», в реестре — «Изобутилен технический марки
// А». Поэтому сравниваем не строки целиком, а наборы слов, и спускаемся по
// лестнице всё более мягких запросов, пока что-нибудь не найдётся.

/** Слова, которые ничего не сужают в поиске. */
const STOP_WORDS = new Set([
  "и",
  "или",
  "в",
  "во",
  "на",
  "для",
  "из",
  "с",
  "со",
  "по",
  "от",
  "до",
  "при",
  "а",
  "же",
  "др",
  "прочие",
  "прочая",
  "другие",
]);

/**
 * Слова, которые в реестре есть почти у всего и потому не помогают отличить
 * один продукт от другого. Из «ядра» запроса их убираем.
 */
const GENERIC_WORDS = new Set([
  "технический",
  "техническая",
  "технические",
  "марки",
  "марка",
  "сорт",
  "сорта",
  "продукт",
  "продукция",
  "смесь",
  "прочий",
]);

/**
 * Нормализовать строку: нижний регистр, ё→е, всё кроме букв и цифр — в пробелы.
 *
 * Регистр и «ё» разъезжаются между выгрузкой и графом постоянно, а дефисы,
 * кавычки и скобки в названиях расставлены как попало.
 */
function normalizeName(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Разбить нормализованное название на значимые слова. */
function words(normalized) {
  return normalized.split(" ").filter((w) => w && !STOP_WORDS.has(w));
}

/**
 * «Ядро» названия: слова без общих для всего реестра. Для «С4-фракция (бутаны
 * и бутилены)» это [с4, фракция, бутаны, бутилены] — по ним ещё можно искать,
 * тогда как по всей строке целиком не найдётся ничего.
 */
function coreWords(normalized) {
  const all = words(normalized);
  const core = all.filter((w) => !GENERIC_WORDS.has(w) && w.length > 2);
  return core.length ? core : all;
}

/**
 * Русские окончания, которые отрезаем. Длинные идут первыми, иначе «ами»
 * потеряло бы хвост от «и».
 */
const ENDINGS = [
  "ами",
  "ями",
  "ого",
  "его",
  "ому",
  "ему",
  "ыми",
  "ими",
  "ах",
  "ях",
  "ов",
  "ев",
  "ий",
  "ый",
  "ой",
  "ей",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ие",
  "ом",
  "ем",
  "ам",
  "ям",
  "ую",
  "юю",
  "а",
  "я",
  "ы",
  "и",
  "у",
  "ю",
  "о",
  "е",
  "ь",
];

/** Сколько букв должно остаться после отсечения — иначе режем смысл. */
const MIN_STEM = 4;

/**
 * Грубое усечение окончания.
 *
 * Полноценная морфология здесь избыточна, а без неё «бутаны» из графа не
 * находили «бутан технический» из реестра: индекс сравнивает словоформы
 * буквально. Важно не «правильно», а одинаково с обеих сторон — отсекаем и при
 * построении индекса, и в запросе.
 */
function stemWord(word) {
  for (const end of ENDINGS) {
    if (word.length - end.length >= MIN_STEM && word.endsWith(end)) {
      return word.slice(0, -end.length);
    }
  }
  return word;
}

/** Строка целиком в усечённом виде — то, что лежит в полнотекстовом индексе. */
function stemName(rawOrNormalized) {
  const normalized = normalizeName(rawOrNormalized);
  return words(normalized).map(stemWord).join(" ");
}

/** Экранировать слово для FTS5: оно понимает кавычки как строгую фразу. */
function ftsTerm(word) {
  return `"${word.replace(/"/g, '""')}"`;
}

/**
 * Лестница запросов к полнотекстовому индексу — от строгого к мягкому.
 *
 * Каждая ступень помечена уровнем совпадения: он уходит в ответ, чтобы в
 * интерфейсе было видно, точное это попадание или похожее.
 */
function buildQueryLadder(rawName) {
  const normalized = normalizeName(rawName);
  if (!normalized) return [];

  // В индексе лежат усечённые слова — запрос строим из таких же.
  const all = words(normalized).map(stemWord);
  const core = coreWords(normalized).map(stemWord);
  const ladder = [];

  // Все слова разом — самое строгое, что умеет индекс.
  if (all.length) {
    ladder.push({ level: "all-words", query: all.map(ftsTerm).join(" AND ") });
  }

  // Без общих слов реестра: «изобутилен технический» → «изобутилен».
  const coreQuery = core.map(ftsTerm).join(" AND ");
  if (core.length && coreQuery !== ladder[0]?.query) {
    ladder.push({ level: "core-words", query: coreQuery });
  }

  // Любое из значимых слов. Составные названия вроде «С4-фракция (бутаны и
  // бутилены)» целиком в реестре не встречаются, но отдельные вещества из них —
  // встречаются; берём то, что нашлось, и честно помечаем совпадение частичным.
  if (core.length > 1) {
    ladder.push({ level: "partial", query: core.map(ftsTerm).join(" OR ") });
  }

  // Приставка: «полипропилен» найдёт «полипропиленовый».
  const longest = core.slice().sort((a, b) => b.length - a.length)[0];
  if (longest && longest.length >= 5) {
    ladder.push({ level: "prefix", query: `${ftsTerm(longest)}*` });
  }

  return ladder;
}

module.exports = {
  normalizeName,
  stemWord,
  stemName,
  words,
  coreWords,
  buildQueryLadder,
  STOP_WORDS,
  GENERIC_WORDS,
};
