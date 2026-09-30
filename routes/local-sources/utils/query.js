// routes/local-sources/utils/query.js
//
// Как найти продукт в тексте PDF.
//
// Индекс фрагментов хранит основы слов — тем же усечением, что у реестра ГИСП
// (routes/industry/utils/normalize.js): «пропилена», «пропиленом» и «пропилен»
// лежат одним словом «пропилен». Запрос строится по ВСЕМ написаниям продукта
// из справочника: у «Изопропилбензола» найдутся и «кумол», и «ИПБ» — так же,
// как продукт опознаётся на графе.

const {
  normalizeName,
  stemName,
  stemWord,
} = require("../../industry/utils/normalize");
const { identify, spellingsOf } = require("../../industry/utils/synonyms");

/** Слово для FTS5 — в кавычках: так оно ищется буквально. */
function quote(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

/**
 * Падежные формы короткого слова.
 *
 * Усечение не трогает слова короче пяти букв, и «сера», «серы», «серу» лежат
 * в индексе тремя разными словами. Длинному слову это не грозит — «пропилена»
 * усекается до «пропилен»; короткому перечисляем формы сами.
 */
function shortWordForms(word) {
  let forms;
  if (/а$/.test(word)) {
    const b = word.slice(0, -1);
    forms = ["а", "ы", "и", "е", "у", "ой", "ою"].map((e) => b + e);
  } else if (/я$/.test(word)) {
    const b = word.slice(0, -1);
    forms = ["я", "и", "е", "ю", "ей", "ею"].map((e) => b + e);
  } else if (/ь$/.test(word)) {
    const b = word.slice(0, -1);
    forms = ["ь", "и", "ью", "ей", "ям"].map((e) => b + e);
  } else if (/[бвгджзклмнпрстфхцчшщ]$/.test(word)) {
    forms = ["", "а", "у", "ом", "е", "ы", "ов", "ам", "ами", "ах"].map((e) => word + e);
  } else {
    forms = [word];
  }
  return [...new Set(forms.map(stemWord))];
}

/** Одно написание → выражение FTS5, или null, если значимых слов нет. */
function spellingMatch(spelling) {
  const stems = stemName(spelling).split(" ").filter(Boolean);
  if (!stems.length) return null;

  if (stems.length === 1) {
    const [stem] = stems;
    const word = normalizeName(spelling);
    // Короткое слово, которое усечение не тронуло, — с падежными формами.
    if (stem === word && word.length <= 4 && /^[а-я]+$/.test(word)) {
      return `(${shortWordForms(word).map(quote).join(" OR ")})`;
    }
    return quote(stem);
  }

  // Несколько слов — рядом и в любом порядке: «серная кислота» найдёт и
  // «кислоты серной», и «серной и азотной кислоты».
  return `NEAR(${stems.map(quote).join(" ")}, ${stems.length + 3})`;
}

/**
 * Выражение для MATCH по всем написаниям продукта, или null.
 *
 * Написания с «*» (только для опознания — «ММА», «ПНГ») справочник в
 * spellingsOf не отдаёт: они приносят чужие вещества.
 */
function productMatch(productName) {
  const parts = [];
  for (const sp of spellingsOf(productName)) {
    const m = spellingMatch(sp);
    if (m && !parts.includes(m)) parts.push(m);
  }
  return parts.length ? parts.join(" OR ") : null;
}

/**
 * Ключ продукта для сохранённых источников: главное имя из справочника, а
 * если справочник продукт не знает — само название в приведённом виде.
 * Так источники, найденные для «ИПБ», видны и у «Кумола».
 */
function productKey(productName) {
  const canon = identify(productName)?.canon;
  return normalizeName(canon || productName);
}

module.exports = { productMatch, productKey, spellingMatch, shortWordForms };
