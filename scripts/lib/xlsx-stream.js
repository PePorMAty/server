// scripts/lib/xlsx-stream.js
//
// Построчное чтение книги Excel без временных файлов.
//
// Книга — это zip, внутри которого лист лежит в виде XML. Распакованный лист
// весит примерно в восемь раз больше самой книги: выгрузка реестра на 150 МБ
// разворачивается в 1,2 ГБ. Готовые библиотеки ради удобства сначала пишут
// этот XML во временный файл, и на диске сервера столько места может просто
// не быть — импорт падал с ENOSPC ещё на сухом прогоне.
//
// Поэтому читаем сами: разворачиваем нужную запись архива потоком и разбираем
// её по мере поступления. На диск не пишем ничего, в памяти держим только
// таблицу общих строк.

const { StringDecoder } = require("string_decoder");

const { readDirectory, openEntry, hasEntry } = require("./zip-read");

/* ────────────────────────────── XML ────────────────────────────── */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Развернуть XML-подстановки: &amp;, &#1088; и подобные. */
function decode(s) {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Значение атрибута открывающего тега. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? decode(m[1]) : null;
}

/** Весь текст из вложенных <t>: в общих строках он бывает разбит на куски. */
function innerText(xml) {
  let out = "";
  const re = /<t\b[^>]*?(\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(xml))) out += m[2] ? decode(m[2]) : "";
  return out;
}

/**
 * Выдавать элементы <tag>…</tag> по мере чтения потока.
 *
 * Граница куска приходится на середину элемента сплошь и рядом, поэтому
 * недочитанный хвост остаётся в буфере до следующего куска.
 */
async function* elements(stream, tag) {
  const open = new RegExp(`<${tag}(?=[\\s/>])`);
  const close = `</${tag}>`;
  // Кириллическая буква занимает два байта и запросто попадает на границу
  // куска. StringDecoder придерживает такой огрызок до следующего куска —
  // без него в тексте изредка появляются ромбы с вопросом.
  const decoder = new StringDecoder("utf8");
  let buf = "";

  for await (const chunk of stream) {
    buf += decoder.write(chunk);

    for (;;) {
      const m = open.exec(buf);
      if (!m) {
        // Начала элемента в буфере нет. Хвост короче тега трогать нельзя:
        // в нём может лежать его начало, разрезанное по живому.
        if (buf.length > tag.length + 2) buf = buf.slice(-(tag.length + 2));
        break;
      }

      const start = m.index;
      const headEnd = buf.indexOf(">", start);
      if (headEnd === -1) break;

      if (buf[headEnd - 1] === "/") {
        // Пустой элемент: <row r="7"/>
        yield buf.slice(start, headEnd + 1);
        buf = buf.slice(headEnd + 1);
        continue;
      }

      const end = buf.indexOf(close, headEnd);
      if (end === -1) {
        buf = buf.slice(start);
        break;
      }

      yield buf.slice(start, end + close.length);
      buf = buf.slice(end + close.length);
    }
  }
}

/** Небольшую запись архива читаем целиком: оглавление, стили, общие строки. */
async function readAll(zip, name) {
  const stream = openEntry(zip, name);
  if (!stream) return null;
  const decoder = new StringDecoder("utf8");
  let out = "";
  for await (const chunk of stream) out += decoder.write(chunk);
  return out + decoder.end();
}

/* ───────────────────────────── стили и даты ───────────────────────────── */

// Встроенные форматы дат и времени. Всё остальное встроенное — числа и текст.
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Похож ли пользовательский формат на дату. */
function looksLikeDate(code) {
  const cleaned = String(code)
    .replace(/\[[^\]]*\]/g, "") // [$-419], [Red]
    .replace(/"[^"]*"/g, "") // литералы в кавычках
    .replace(/\\./g, ""); // экранированные символы
  return /[ymdhs]/i.test(cleaned);
}

/**
 * Разобрать стили книги.
 *
 * Дата в XML лежит обычным числом, и отличить её от количества можно только по
 * формату ячейки: номер формата берётся из стиля, а стиль — из атрибута ячейки.
 */
async function readDateStyles(zip) {
  const xml = await readAll(zip, "xl/styles.xml");
  if (!xml) return [];

  const custom = new Map();
  const fmtRe = /<numFmt\b[^>]*\/>/g;
  let m;
  while ((m = fmtRe.exec(xml))) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code !== null) custom.set(id, code);
  }

  // Нас интересует только cellXfs: на него ссылаются ячейки листа.
  const block = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!block) return [];

  const styles = [];
  const xfRe = /<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
  while ((m = xfRe.exec(block[1]))) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    styles.push(
      BUILTIN_DATE.has(id) || (custom.has(id) && looksLikeDate(custom.get(id))),
    );
  }
  return styles;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * Номер дня Excel → «ДД.ММ.ГГГГ».
 *
 * Отсчёт идёт с 1 января 1900 года, но Excel считает 1900-й високосным — из-за
 * совместимости с давней ошибкой Lotus. Поэтому до мнимого 29 февраля и после
 * него точки отсчёта разные. Формат собираем руками: toLocaleDateString зависит
 * от того, с какой таблицей локалей собран Node, и на сервере может молча выдать
 * американский порядок.
 */
function serialToText(serial, date1904) {
  const base = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);

  const whole = Math.floor(serial);
  const d = new Date(base + whole * 86400000);
  const text = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;

  const rest = serial - whole;
  if (rest < 1e-6) return text;

  const secs = Math.round(rest * 86400);
  return `${text} ${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}`;
}

/* ────────────────────────────── лист ────────────────────────────── */

/** «C» → 2, «AB» → 27. Нужен, чтобы не съезжали пропущенные ячейки. */
function columnIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/** Ячейки одной строки листа → массив строк по позициям колонок. */
function parseRow(xml, shared, dateStyles, date1904) {
  const cells = [];
  let m;
  CELL_RE.lastIndex = 0;

  while ((m = CELL_RE.exec(xml))) {
    const head = m[1] ?? "";
    const body = m[2] ?? "";
    const ref = attr(head, "r");
    const at = ref ? columnIndex(ref) : cells.length;
    if (at < 0) continue;

    const type = attr(head, "t");
    let text = "";

    if (type === "inlineStr") {
      text = innerText(body);
    } else {
      const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      const raw = v ? decode(v[1]) : "";

      if (!raw) text = "";
      else if (type === "s") text = shared[Number(raw)] ?? "";
      else if (type === "e") text = ""; // #Н/Д и прочие ошибки
      else if (type === "str" || type === "b") text = raw;
      else {
        // Без типа в ячейке лежит число — и, возможно, это дата.
        const style = Number(attr(head, "s") ?? -1);
        const num = Number(raw);
        text =
          dateStyles[style] && Number.isFinite(num) && num > 0
            ? serialToText(num, date1904)
            : raw; // берём запись как есть: длинный ИНН float бы испортил
      }
    }

    cells[at] = text;
  }

  for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
  return cells;
}

/**
 * Какой лист читать.
 *
 * Порядок записей внутри архива произвольный, поэтому первый лист книги — не
 * обязательно sheet1.xml. Берём первый из оглавления книги, а если оглавления
 * нет — лист с наименьшим номером.
 */
async function pickSheet(zip) {
  const book = await readAll(zip, "xl/workbook.xml");
  const rels = await readAll(zip, "xl/_rels/workbook.xml.rels");

  if (book && rels) {
    const sheet = book.match(/<sheet\b[^>]*\/>/);
    const rid = sheet && attr(sheet[0], "r:id");
    if (rid) {
      const re = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`);
      const rel = rels.match(re);
      const target = rel && attr(rel[0], "Target");
      if (target) {
        const name = target.replace(/^\/?(xl\/)?/, "xl/");
        if (hasEntry(zip, name)) return { name, date1904: /date1904="(1|true)"/.test(book) };
      }
    }
  }

  const sheets = [...zip.entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  if (!sheets.length) throw new Error("В книге не найдено ни одного листа.");
  return { name: sheets[0], date1904: !!book && /date1904="(1|true)"/.test(book) };
}

/* ────────────────────────────── чтение ────────────────────────────── */

/**
 * Пройти по строкам первого листа книги.
 *
 * Первая строка, в которой заполнено хотя бы две ячейки, считается заголовком:
 * перед ним в выгрузках встречаются название отчёта и пустые строки. onRow
 * получает объект «заголовок → значение» и может вернуть false, чтобы
 * остановить чтение.
 */
async function forEachXlsxRow(file, { onHeader, onRow }) {
  const zip = readDirectory(file);
  const { name, date1904 } = await pickSheet(zip);

  // Общие строки: Excel хранит повторяющийся текст один раз, а в ячейках
  // оставляет номера. Уникальных значений много меньше, чем ячеек, поэтому
  // таблица помещается в память, в отличие от самого листа.
  const shared = [];
  if (hasEntry(zip, "xl/sharedStrings.xml")) {
    for await (const si of elements(openEntry(zip, "xl/sharedStrings.xml"), "si")) {
      shared.push(innerText(si));
    }
  }

  const dateStyles = await readDateStyles(zip);

  let header = null;
  let index = 0;

  for await (const xml of elements(openEntry(zip, name), "row")) {
    const cells = parseRow(xml, shared, dateStyles, date1904).map((c) => c.trim());

    if (!header) {
      if (cells.filter(Boolean).length < 2) continue;
      header = cells;
      onHeader?.(header);
      continue;
    }

    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] ?? "";
    index += 1;
    if (onRow(obj, index) === false) return { header, rows: index };
  }

  return { header, rows: index };
}

module.exports = { forEachXlsxRow };
