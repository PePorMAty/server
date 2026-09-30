// routes/local-sources/utils/pdf.js
//
// Текст из PDF.
//
// Читаем PDF.js — тот же, что в Firefox, — в сборке unpdf: без внешних
// программ и нативных модулей, на сервере ничего доустанавливать не надо.
// Работаем с PDF, где текст есть (выгрузка из Word, статьи, сайты). Сканы —
// картинки без текстового слоя — не распознаём, а помечаем: у таких страниц
// текста нет, и документ честно говорит об этом при загрузке.

const { getDocumentProxy, extractText, getMeta } = require("unpdf");

/** Страница без текстового слоя: меньше стольких букв — считаем сканом. */
const TEXTLESS_PAGE_CHARS = 20;

/** PDF ли это вообще: файл начинается с «%PDF-». */
function isPdf(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 5 &&
    buf.subarray(0, 5).toString("latin1") === "%PDF-"
  );
}

/**
 * Текст страницы: перенос слова по слогам склеиваем, пробелы приводим.
 *
 * Строки не склеиваем — абзацы из них собирает нарезка на фрагменты, ей
 * нужны концы строк.
 */
function cleanPageText(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "") // мягкий перенос
    .replace(/([а-яёa-z])[-‐‑]\n([а-яёa-z])/gi, "$1$2") // «произ-\nводство»
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Название документа: из свойств PDF, если оно осмысленное.
 *
 * Word пишет в свойства «Microsoft Word - отчёт.docx», конструкторы — «Untitled»
 * или имя шаблона; такое хуже первой строки текста.
 */
function metaTitle(info) {
  const raw = String(info?.Title || "")
    .replace(/^Microsoft Word\s*-\s*/i, "")
    .replace(/\.(docx?|rtf|odt|pdf)$/i, "")
    .trim();
  if (raw.length < 4 || /^(untitled|без названия|document\d*|документ\d*)$/i.test(raw)) {
    return "";
  }
  return raw;
}

/**
 * Разобрать PDF.
 *
 * @param buf содержимое файла
 * @returns { title, pages: [{ n, text }], textlessPages: number[] }
 * @throws Error с понятным человеку текстом: не PDF, повреждён, под паролем
 */
async function extractPdf(buf) {
  if (!isPdf(buf)) {
    throw new Error("Это не PDF: файл не начинается с заголовка %PDF.");
  }

  let pdf;
  try {
    // Копия буфера: PDF.js может забрать себе исходный массив.
    pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  } catch (e) {
    if (/password/i.test(String(e?.name) + String(e?.message))) {
      throw new Error("PDF защищён паролем — снимите защиту и загрузите снова.");
    }
    throw new Error(`PDF не читается — файл повреждён (${e?.message || e}).`);
  }

  try {
    const meta = await getMeta(pdf).catch(() => null);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((t, i) => ({ n: i + 1, text: cleanPageText(t) }));
    const textlessPages = pages
      .filter((p) => p.text.replace(/\s/g, "").length < TEXTLESS_PAGE_CHARS)
      .map((p) => p.n);
    return { metaTitle: metaTitle(meta?.info), pages, textlessPages };
  } finally {
    await pdf.destroy?.().catch(() => {});
  }
}

module.exports = { extractPdf, isPdf, cleanPageText };
