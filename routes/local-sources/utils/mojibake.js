// routes/local-sources/utils/mojibake.js
//
// Кириллица, прочитанная как латиница: «ÑÐÅÄÍÅÅ» вместо «СРЕДНЕЕ».
//
// В старых русских PDF (учебники, издательства, studfile) шрифт часто хранит
// буквы в кодировке Windows-1251 без таблицы Unicode. PDF.js отдаёт их байты
// как Latin-1: «С» (0xD1 в 1251) становится «Ñ» (U+00D1). Так пришёл учебник
// academia-moscow.ru «Технология сборки кузовов и агрегатов» (живой прогон
// 2026-11-17): заголовки целы, а текст — «ÑÐÅÄÍÅÅ ÏÐÎÔÅÑÑÈÎÍÀËÜÍÎÅ», и
// обобщение получало вместо книги мусор.
//
// Буквы 1251 А–я — байты 0xC0–0xFF, ровно те же номера, что À–ÿ в Latin-1;
// Ё и ё — 0xA8 и 0xB8 («¨», «¸»). Поэтому обратно — сдвигом номера символа.
//
// Чинится только страница, где таких слов явно много: слово из одних À–ÿ
// длиннее двух букв в живых языках не встречается, а одиночные «é», «ü» в
// латинских словах («Größe», «été») не трогаются — рядом с ними латиница.

/** Слово из одних «À–ÿ», «¨», «¸», не прилегающее к латинице. */
const WORD = /(?<![A-Za-z])[¨¸À-ÿ]+(?![A-Za-z])/g;

/** Сколько длинных (от 3 букв) таких слов делает страницу «перекодированной». */
const MIN_LONG_WORDS = 2;

function toCyrillic(word) {
  let out = "";
  for (const ch of word) {
    const c = ch.charCodeAt(0);
    if (c === 0xa8) out += "Ё";
    else if (c === 0xb8) out += "ё";
    else out += String.fromCharCode(0x0410 + (c - 0xc0));
  }
  return out;
}

/** Похожа ли страница (весь её текст) на кириллицу, прочитанную как Latin-1. */
function looksLikeCp1251(text) {
  let long = 0;
  for (const m of String(text || "").matchAll(WORD)) {
    if (m[0].length >= 3 && ++long >= MIN_LONG_WORDS) return true;
  }
  return false;
}

/**
 * Вернуть кириллицу в строке (страница уже признана перекодированной). «¹» —
 * знак номера: в 1251 «№» — 0xB9, как «¹» в Latin-1 («Колледж ¹ 31»).
 */
function fixCp1251(text) {
  return String(text ?? "").replace(WORD, toCyrillic).replace(/\u00B9/g, "№");
}

/**
 * Строки страницы PDF ({ text, … }) — с кириллицей на месте, если страница
 * перекодирована; иначе те же строки.
 */
function fixPageLines(lines) {
  if (!looksLikeCp1251(lines.map((l) => l.text).join("\n"))) return lines;
  return lines.map((l) => ({ ...l, text: fixCp1251(l.text) }));
}

module.exports = { looksLikeCp1251, fixCp1251, fixPageLines };
