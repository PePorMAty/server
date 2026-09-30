// routes/local-sources/utils/chunks.js
//
// Нарезка текста PDF на фрагменты.
//
// Фрагмент — единица поиска и то, что уходит модели как текст источника.
// Целая страница для этого крупна (в ней бывает три разных процесса), строка —
// мелка (упоминание продукта без контекста). Режем по абзацам до ~1500 знаков:
// это абзац-два связного текста, и обобщению шага его хватает.

/** Предел длины фрагмента, знаков. */
const CHUNK_CHARS = 1500;

/**
 * Строки страницы — в абзацы.
 *
 * PDF из Word разбивает текст на строки по ширине страницы, а конец абзаца
 * отдельно не помечает. Считаем, что абзац кончился, если строка кончается
 * точкой (двоеточием, скобкой…), а следующая начинается с заглавной, цифры
 * или маркера списка. Пустая строка — тоже граница.
 */
function paragraphs(pageText) {
  const out = [];
  let cur = "";
  for (const line of String(pageText || "").split("\n")) {
    if (!line) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    if (!cur) {
      cur = line;
      continue;
    }
    const endsSentence = /[.:;!?»)]$/.test(cur);
    const startsNew = /^[А-ЯЁA-Z0-9•\-–—*]/.test(line);
    if (endsSentence && startsNew) {
      out.push(cur);
      cur = line;
    } else {
      cur += ` ${line}`;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Длинный абзац — по предложениям; сверхдлинное предложение — как есть кусками. */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if (cur.length + s.length > max) {
      out.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Страницы → фрагменты { page, text }.
 *
 * Фрагмент не переходит на другую страницу: номер страницы — это ссылка, по
 * которой человек откроет PDF и проверит, откуда взят текст.
 */
function chunkPages(pages, max = CHUNK_CHARS) {
  const chunks = [];
  for (const { n, text } of pages) {
    let cur = "";
    for (const p of paragraphs(text)) {
      for (const piece of splitLong(p, max)) {
        if (cur && cur.length + 1 + piece.length > max) {
          chunks.push({ page: n, text: cur });
          cur = piece;
        } else {
          cur = cur ? `${cur}\n${piece}` : piece;
        }
      }
    }
    if (cur) chunks.push({ page: n, text: cur });
  }
  return chunks;
}

/**
 * Название документа, если в свойствах PDF его нет: первая строка текста,
 * похожая на заголовок, иначе имя файла.
 */
function guessTitle(pages, fileName) {
  for (const { text } of pages.slice(0, 2)) {
    const line = String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 4 && /[а-яёa-z]/i.test(l));
    if (line) return line.length > 150 ? `${line.slice(0, 150)}…` : line;
  }
  return String(fileName || "Документ").replace(/\.pdf$/i, "");
}

module.exports = { chunkPages, paragraphs, guessTitle, CHUNK_CHARS };
