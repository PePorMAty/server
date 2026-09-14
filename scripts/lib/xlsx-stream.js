// scripts/lib/xlsx-stream.js
//
// Потоковое чтение книги Excel. Выгрузка реестра приходит в .xlsx, а внутри
// это сжатый XML: распакованный лист на сотни тысяч строк весит гигабайты, и
// открывать книгу целиком нельзя. Читаем построчно.
//
// exceljs лежит в devDependencies: сервер его не требует, он нужен только при
// импорте. Если пакета нет — говорим об этом прямо, а не падаем стеком.

/** Ячейка Excel → строка. Значение бывает объектом: формула, ссылка, дата. */
function cellText(value) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    // Даты реестра сравнивать не нужно — показываем как есть, по-русски.
    return value.toLocaleDateString("ru-RU");
  }

  if (typeof value === "object") {
    // Формула: интересует посчитанное значение.
    if ("result" in value) return cellText(value.result);
    // Ссылка: показываем подпись, а не адрес.
    if ("text" in value) return cellText(value.text);
    if ("hyperlink" in value) return String(value.hyperlink);
    // Форматированный текст: собираем куски.
    if (Array.isArray(value.richText)) {
      return value.richText.map((p) => p.text ?? "").join("");
    }
    if ("error" in value) return "";
  }

  return String(value);
}

/**
 * Пройти по строкам первого листа книги.
 *
 * Первая непустая строка считается заголовком. onRow получает объект
 * «заголовок → значение» и может вернуть false, чтобы остановить чтение.
 */
async function forEachXlsxRow(file, { onHeader, onRow }) {
  let ExcelJS;
  try {
    ExcelJS = require("exceljs");
  } catch {
    throw new Error(
      "Для чтения .xlsx нужен пакет exceljs. Установите его:\n" +
        "  npm install --include=dev\n" +
        "или сохраните лист как CSV (UTF-8) и передайте его.",
    );
  }

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    // Строки книги хранятся в общей таблице; без кэша каждое значение
    // пришлось бы искать заново.
    sharedStrings: "cache",
    worksheets: "emit",
    entries: "emit",
    styles: "ignore",
  });

  let header = null;
  let index = 0;

  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      // values — массив с единицы: нулевой элемент всегда пуст.
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
      const texts = cells.map((c) => cellText(c).trim());

      if (!header) {
        // Перед шапкой в выгрузках попадаются пустые строки и заголовок отчёта.
        if (texts.filter(Boolean).length < 2) continue;
        header = texts;
        onHeader?.(header);
        continue;
      }

      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = texts[i] ?? "";
      index += 1;
      if (onRow(obj, index) === false) return { header, rows: index };
    }

    // Читаем только первый лист: реестр лежит на нём, а остальные листы в
    // выгрузках — справочники и пояснения.
    break;
  }

  return { header, rows: index };
}

module.exports = { forEachXlsxRow, cellText };
