// scripts/lib/csv-stream.js
//
// Потоковый разбор CSV/TSV. Выгрузка реестра — сотни мегабайт, целиком в память
// её тянуть незачем; готовых зависимостей ради одного скрипта тоже не хочется.
//
// Разбор — конечный автомат по символам: он правильно переживает кавычки,
// удвоенные кавычки внутри поля и переводы строк внутри закавыченного значения
// (в выгрузках такое встречается в адресах и наименованиях).

const fs = require("fs");

/** Угадать разделитель по первой строке: запятая, точка с запятой или таб. */
function detectDelimiter(sample) {
  const line = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts = [
    [";", (line.match(/;/g) || []).length],
    [",", (line.match(/,/g) || []).length],
    ["\t", (line.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

/**
 * Прочитать первые байты файла — чтобы определить разделитель и заголовки, не
 * открывая файл целиком.
 */
async function peek(file, bytes = 64 * 1024) {
  const fd = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return stripBom(buf.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await fd.close();
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Пройти по строкам файла. Первая строка считается заголовком; на каждую
 * следующую вызывается onRow с объектом «заголовок → значение».
 *
 * onRow может вернуть false, чтобы остановить чтение (нужно для --limit).
 */
async function forEachRow(file, { delimiter, onHeader, onRow }) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });

  let header = null;
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteJustClosed = false;
  let first = true;
  let stopped = false;
  let index = 0;

  const pushField = () => {
    row.push(field.trim());
    field = "";
  };

  const pushRow = () => {
    // Хвостовая пустая строка файла — не запись.
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    if (!header) {
      header = row.map((h) => stripBom(h).trim());
      onHeader?.(header);
    } else {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] ?? "";
      index += 1;
      if (onRow(obj, index) === false) stopped = true;
    }
    row = [];
  };

  for await (const chunk of stream) {
    const text = first ? stripBom(chunk) : chunk;
    first = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          inQuotes = false;
          quoteJustClosed = true;
        } else {
          field += ch;
        }
        continue;
      }

      if (quoteJustClosed) {
        quoteJustClosed = false;
        // Удвоенная кавычка внутри поля — это экранированная кавычка.
        if (ch === '"') {
          field += '"';
          inQuotes = true;
          continue;
        }
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        pushField();
      } else if (ch === "\n") {
        pushField();
        pushRow();
        if (stopped) break;
      } else if (ch !== "\r") {
        field += ch;
      }
    }

    if (stopped) {
      stream.destroy();
      break;
    }
  }

  // Последняя строка без перевода в конце файла.
  if (!stopped && (field !== "" || row.length)) {
    pushField();
    pushRow();
  }

  return { header, rows: index };
}

module.exports = { detectDelimiter, peek, forEachRow };
