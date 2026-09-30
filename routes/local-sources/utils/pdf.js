// routes/local-sources/utils/pdf.js
//
// Текст и устройство PDF.
//
// Читаем PDF.js — тот же, что в Firefox, — в сборке unpdf: без внешних
// программ и нативных модулей, на сервере ничего доустанавливать не надо.
// Работаем с PDF, где текст есть (выгрузка из Word, статьи, сайты). Сканы —
// картинки без текстового слоя — не распознаём, а помечаем: у таких страниц
// текста нет, и документ честно говорит об этом при загрузке.
//
// Кроме текста достаём разметку документа — из неё строятся разделы:
// закладки PDF, а если их нет — ссылки строк содержания (Word ставит их
// сам: у ИТС каждая строка оглавления ведёт на страницу и место заголовка).

const { getDocumentProxy, getMeta } = require("unpdf");

/** Страница без текстового слоя: меньше стольких букв — считаем сканом. */
const TEXTLESS_PAGE_CHARS = 20;
/** Где искать содержание со ссылками: оно в начале документа. */
const TOC_SCAN_PAGES = 40;

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
 * Строки не склеиваем — абзацы и разделы режутся по ним.
 */
function cleanPageText(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "") // мягкий перенос
    .replace(/([а-яёa-z])[-‐‑]\n([а-яёa-z])/gi, "$1$2") // «произ-\nводство»
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Название документа из свойств PDF, если оно осмысленное.
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
 * Шрифт Symbol: Word набирает им греческие буквы, градусы, «±», «≤» и
 * маркеры списков, а PDF.js отдаёт такие знаки кодами из частной области
 * Юникода (U+F061 вместо «α»). Переводим по кодировке Symbol — иначе
 * «α-метилстирол» терял букву и превращался в «-метилстирол».
 */
const SYMBOL_FONT = (() => {
  const map = {
    0x22: "∀", 0x24: "∃", 0x27: "∋", 0x2a: "∗", 0x2d: "−", 0x40: "≅",
    0x5c: "∴", 0x5e: "⊥", 0x60: "‾", 0x7e: "∼",
    0xa1: "ϒ", 0xa2: "′", 0xa3: "≤", 0xa4: "⁄", 0xa5: "∞", 0xa7: "▪",
    0xab: "↔", 0xac: "←", 0xad: "↑", 0xae: "→", 0xaf: "↓", 0xb0: "°",
    0xb1: "±", 0xb2: "″", 0xb3: "≥", 0xb4: "×", 0xb5: "∝", 0xb6: "∂",
    0xb7: "•", 0xb8: "÷", 0xb9: "≠", 0xba: "≡", 0xbb: "≈", 0xbc: "…",
    0xd6: "√", 0xd7: "⋅", 0xd8: "¬", 0xdb: "⇔", 0xde: "⇒",
  };
  const upper = "ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ";
  const lower = "αβχδεφγηιϕκλμνοπθρστυϖωξψζ";
  for (let i = 0; i < 26; i++) {
    map[0x41 + i] = upper[i];
    map[0x61 + i] = lower[i];
  }
  for (let c = 0x20; c < 0x7f; c++) {
    if (!map[c]) map[c] = String.fromCharCode(c);
  }
  return map;
})();

function fromSymbolFont(s) {
  return s.replace(/[\uF020-\uF0FF]/g, (ch) => SYMBOL_FONT[ch.charCodeAt(0) - 0xf000] ?? "");
}

/**
 * Куски текста страницы → строки сверху вниз.
 *
 * PDF.js отдаёт текст кусками с координатами; строка — куски на одной высоте.
 * Индексы и степени («C₂H₄») чуть ниже строки — их прибираем к ней же.
 * Между кусками, разнесёнными по горизонтали (ячейки таблиц), — пробел.
 */
function groupLines(items) {
  const parts = items
    .filter((it) => typeof it.str === "string" && it.str !== "")
    .map((it) => ({
      s: fromSymbolFont(it.str),
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: Math.abs(it.transform[3]) || it.height || 10,
    }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const p of parts) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) <= Math.max(2, Math.min(last.h, p.h) * 0.4)) {
      last.parts.push(p);
      last.h = Math.max(last.h, p.h);
    } else {
      lines.push({ y: p.y, h: p.h, parts: [p] });
    }
  }

  return lines
    .map((l) => {
      l.parts.sort((a, b) => a.x - b.x);
      let text = "";
      let end = null;
      for (const p of l.parts) {
        const gap = end === null ? 0 : p.x - end;
        if (text && gap > 1.5 && !/\s$/.test(text) && !/^\s/.test(p.s)) text += " ";
        text += p.s;
        end = p.x + p.w;
      }
      return { y: l.y, h: l.h, text: text.replace(/\s+/g, " ").trim() };
    })
    .filter((l) => l.text);
}

/**
 * Колонтитулы: верхняя и нижняя строки, повторяющиеся на многих страницах
 * («ИТС 18—202_»), и номера страниц. В текст разделов они не идут.
 *
 * Возвращает самый частый колонтитул — у ИТС это краткое имя документа.
 */
function stripRunningLines(pages) {
  const key = (t) => t.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const isPageNumber = (t) => /^(\d{1,4}|[IVXLCDM]{1,7})$/.test(t.replace(/\s/g, ""));
  const counts = new Map();
  for (const p of pages) {
    const edge = new Set();
    if (p.lines.length) edge.add(key(p.lines[0].text));
    if (p.lines.length > 1) edge.add(key(p.lines[p.lines.length - 1].text));
    for (const k of edge) {
      // Колонтитул короткий; длинная строка, повторённая наверху страниц, —
      // это текст (повторяющийся абзац), его не трогаем.
      if (k.length <= 80) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const threshold = Math.max(3, pages.length * 0.2);
  let header = null;
  let headerCount = 0;
  for (const p of pages) {
    const kept = [];
    p.lines.forEach((l, i) => {
      const edge = i <= 1 || i >= p.lines.length - 2;
      const k = key(l.text);
      const frequent = (counts.get(k) || 0) >= threshold;
      if (edge && (isPageNumber(l.text) || frequent)) {
        if (frequent && !isPageNumber(l.text) && counts.get(k) > headerCount) {
          header = l.text;
          headerCount = counts.get(k);
        }
        return;
      }
      kept.push(l);
    });
    p.lines = kept;
  }
  return header;
}

/**
 * Куда ведёт ссылка или закладка: страница (с 1) и высота на ней, если
 * указана (у «XYZ» — верх заголовка).
 */
async function resolveDest(pdf, dest) {
  let d = dest;
  if (typeof d === "string") d = await pdf.getDestination(d).catch(() => null);
  if (!Array.isArray(d) || !d.length) return null;
  let index = null;
  if (typeof d[0] === "number") index = d[0];
  else if (d[0] && typeof d[0] === "object") {
    index = await pdf.getPageIndex(d[0]).catch(() => null);
  }
  if (index === null || index === undefined) return null;
  const kind = d[1]?.name;
  const y = kind === "XYZ" ? d[3] : kind === "FitH" || kind === "FitBH" ? d[2] : null;
  return { page: index + 1, y: typeof y === "number" ? y : null };
}

/** Закладки PDF плоским списком: заголовок, уровень, страница, высота. */
async function tocFromOutline(pdf) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const out = [];
  const walk = async (items, level) => {
    for (const it of items) {
      const target = await resolveDest(pdf, it.dest);
      if (target && it.title) {
        out.push({ raw: String(it.title).trim(), level, page: target.page, y: target.y });
      }
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

/**
 * Содержание со ссылками: текст каждой строки оглавления и куда она ведёт.
 *
 * Длинный пункт Word переносит на две-три строки, и у каждой своя ссылка с
 * той же целью — такие склеиваем, пока пункт не кончится номером страницы.
 */
async function tocFromLinks(pdf, pages) {
  const entries = [];
  let started = false;
  const last = Math.min(pdf.numPages, TOC_SCAN_PAGES);
  for (let n = 1; n <= last; n++) {
    const page = await pdf.getPage(n);
    const annots = await page.getAnnotations().catch(() => []);
    const links = annots.filter((a) => a.subtype === "Link" && a.dest && !a.url);
    if (links.length < 3) {
      if (started) break;
      continue;
    }
    started = true;
    const lines = pages[n - 1].lines;
    links.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    for (const a of links) {
      const [, y1, , y2] = a.rect;
      const text = lines
        .filter((l) => l.y >= y1 - 1 && l.y <= y2 - 1)
        .map((l) => l.text)
        .join(" ")
        .trim();
      if (!text) continue;
      const target = await resolveDest(pdf, a.dest);
      if (!target) continue;
      const prev = entries[entries.length - 1];
      const prevOpen = prev && !/(\d{1,4}|[IVXLCDM]{1,7})\s*$/.test(prev.raw);
      if (prev && prevOpen && prev.page === target.page && prev.y === target.y) {
        prev.raw = `${prev.raw} ${text}`;
      } else {
        entries.push({ raw: text, page: target.page, y: target.y });
      }
    }
  }
  return entries;
}

async function openPdf(buf) {
  if (!isPdf(buf)) {
    throw new Error("Это не PDF: файл не начинается с заголовка %PDF.");
  }
  try {
    // Копия буфера: PDF.js может забрать себе исходный массив.
    return await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  } catch (e) {
    if (/password/i.test(String(e?.name) + String(e?.message))) {
      throw new Error("PDF защищён паролем — снимите защиту и загрузите снова.");
    }
    throw new Error(`PDF не читается — файл повреждён (${e?.message || e}).`);
  }
}

/**
 * Разобрать PDF.
 *
 * @param buf содержимое файла
 * @returns {
 *   metaTitle,
 *   pages: [{ n, text, lines: [{ y, h, text }] }] — без колонтитулов,
 *   textlessPages: number[],
 *   toc: { kind: "outline" | "links" | null, entries: [{ raw, page, y, level? }] },
 *   runningHeader — самый частый колонтитул («ИТС 18—202_») или null,
 *   cover — строки первой страницы с высотой шрифта
 * }
 * @throws Error с понятным человеку текстом: не PDF, повреждён, под паролем
 */
async function extractPdf(buf) {
  const pdf = await openPdf(buf);
  try {
    const meta = await getMeta(pdf).catch(() => null);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push({ n, lines: groupLines(content.items) });
      page.cleanup?.();
    }
    const cover = pages[0] ? pages[0].lines.map((l) => ({ ...l })) : [];

    // Содержание — до срезания колонтитулов: строки оглавления нужны целиком.
    const outline = await tocFromOutline(pdf);
    const links = outline.length ? [] : await tocFromLinks(pdf, pages);
    const toc = outline.length
      ? { kind: "outline", entries: outline }
      : links.length >= 3
        ? { kind: "links", entries: links }
        : { kind: null, entries: [] };

    const runningHeader = stripRunningLines(pages);
    for (const p of pages) {
      p.text = cleanPageText(p.lines.map((l) => l.text).join("\n"));
    }
    const textlessPages = pages
      .filter((p) => p.text.replace(/\s/g, "").length < TEXTLESS_PAGE_CHARS)
      .map((p) => p.n);

    return {
      metaTitle: metaTitle(meta?.info),
      pages,
      textlessPages,
      toc,
      runningHeader,
      cover,
    };
  } finally {
    await pdf.destroy?.().catch(() => {});
  }
}

module.exports = { extractPdf, isPdf, cleanPageText, groupLines };
