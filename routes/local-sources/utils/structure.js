// routes/local-sources/utils/structure.js
//
// Документ → разделы-источники.
//
// Источник в базе — не файл, а раздел документа: «ИТС 18 · 2.1 Производство
// этилена · стр. 14–43». Разделы берём из разметки самого документа:
//   1) закладки PDF;
//   2) ссылки строк содержания (Word ставит их сам);
//   3) нумерованные заголовки в тексте («2.1. Производство этилена»);
//   4) ничего нет — куски по нескольку страниц.
//
// Источником становится самый мелкий раздел «Производство X» (у «4.8
// Производство бутиловых спиртов и 2-этилгексанола» — оба подраздела), а
// там, где производств нет, — раздел верхнего уровня, если он о деле, а не
// введение, библиография или приложения.

/**
 * Раздел о производстве продукта: из него видно, из чего и как это делают.
 *
 * Только «Производство X». «Технология получения бутадиена
 * дегидрированием…» — вариант процесса внутри «Производства бутадиена», а не
 * отдельный продукт: иначе раздел распадался на варианты, и терялись его
 * общая часть и расход сырья.
 */
const PRODUCTION_TITLE = /^(производство|производства)[\s-]+/i;
/** Разделы не о производстве: их модели не отдаём. */
const SKIP_TITLE =
  /^(введение|предисловие|область применения|содержание|оглавление|библиограф|список (использованн\S* )?литератур|литература|заключительные положения|заключение|приложени|определение наилучших|наилучшие доступные|общие ндт|ндт\b|общая информация|термины|сокращения|обозначения|перечень|сведения о разработчик)/i;
/** То же — где бы в заголовке ни стояло (у ИТС это разделы про НДТ). */
const SKIP_ANYWHERE =
  /наилучш\S*\s+доступн\S*\s+технолог|библиограф|маркерн\S*\s+веществ|энергоэффективност|парниковых газов/i;

const skipped = (h) =>
  SKIP_TITLE.test(h.core) || SKIP_TITLE.test(h.title) || SKIP_ANYWHERE.test(h.title);

/** Раздел больше стольких страниц делим на подразделы, если они есть. */
const MAX_UNIT_PAGES = 45;
/** Документ без разметки режем кусками по столько страниц. */
const WINDOW_PAGES = 10;
/** Раздел короче этого — пустышка (заголовок без текста). */
const MIN_UNIT_CHARS = 200;

/**
 * Строка содержания → номер, заголовок, уровень и печатный номер страницы.
 *
 * «2.1.1. Описание технологических процессов … 14» → { number: "2.1.1",
 * title: "Описание технологических процессов …", level: 3, printed: "14" }.
 */
function parseHeading(raw, outlineLevel = null) {
  let text = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/-\s+(?=[а-яё])/g, "-") // «метил-втор- амиленового» — перенос из содержания
    .trim();

  // Отточие и номер страницы в конце.
  let printed = null;
  const tail = /^(.*?\S)\s*(?:[.…·_]{2,}|\s)\s*(\d{1,4}|[IVXLCDM]{1,7})$/.exec(text);
  if (tail && /[.…·_]{2,}/.test(text)) {
    text = tail[1].replace(/[.…·_\s]+$/, "");
    printed = tail[2];
  }

  let number = null;
  let level = outlineLevel || 1;
  let core = text;
  let m;
  if ((m = /^(Раздел|Глава|Часть)\s+(\d+)\.?\s*(.*)$/i.exec(text))) {
    number = m[2];
    level = 1;
    core = m[3];
  } else if ((m = /^Приложение\s+([А-ЯЁA-Z])\b\.?\s*(.*)$/.exec(text))) {
    number = `Прил. ${m[1]}`;
    level = 1;
    core = m[2];
  } else if ((m = /^(\d{1,2}(?:\.\d{1,3}){0,4})\.?\s*(.+)$/.exec(text)) && /^[^\d\s]/.test(m[2])) {
    number = m[1];
    level = m[1].split(".").length;
    core = m[2];
  }
  core = core.replace(/^\((обязательное|справочное|рекомендуемое)\)\s*/i, "").trim();
  return { number, level, title: text, core, printed };
}

/**
 * Названия продуктов из заголовка «Производство X и Y».
 *
 * Падеж не важен: продукты сверяются по основам слов («этилена» и «этилен» —
 * одно). Общее существительное делим: «метил-трет-амилового и
 * метил-втор-амиленового эфиров» → оба «…эфиров».
 */
function productsFromTitle(core) {
  const m = PRODUCTION_TITLE.exec(String(core || ""));
  if (!m) return [];
  const rest = core
    .slice(m[0].length)
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!rest) return [];
  // Запятая с цифрой после неё — часть названия («бутадиена-1,3»).
  const parts = rest.split(/\s*,\s*(?=\D)|\s+и\s+/).map((p) => p.trim()).filter(Boolean);
  const lastWords = parts[parts.length - 1].split(" ");
  const head = lastWords.length > 1 ? lastWords[lastWords.length - 1] : null;
  return parts
    .map((p) => {
      const words = p.split(" ");
      const adjectiveOnly = /(ого|его|ых|их|ой|ей|ых)$/i.test(words[words.length - 1]);
      return head && parts.length > 1 && adjectiveOnly && p !== parts[parts.length - 1]
        ? `${p} ${head}`
        : p;
    })
    // «акриловой кислоты и ее эфиров» — «ее эфиров» не название.
    .filter((p) => !/^(ее|её|их|его)\s/i.test(p))
    .filter((p) => p.replace(/[^а-яёa-z]/gi, "").length >= 3);
}

/** Заглавные буквы обложки → обычный регистр: «ПРОИЗВОДСТВО …» → «Производство …». */
function sentenceCase(s) {
  const t = String(s || "").trim();
  if (!t || t !== t.toUpperCase()) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Название документа и краткое имя для подписей источников.
 *
 * Краткое — самый частый колонтитул («ИТС 18—202_»), если он есть. Полное —
 * самая крупная строка обложки («ПРОИЗВОДСТВО ОСНОВНЫХ ОРГАНИЧЕСКИХ …»),
 * иначе название из свойств PDF, иначе имя файла.
 */
function documentTitles({ cover = [], runningHeader, metaTitle, fileName }) {
  const shortFromHeader =
    runningHeader && runningHeader.length <= 40 ? runningHeader.trim() : null;

  // Разрядка («И Н Ф О Р М А Ц И О Н Н О») и «Содержание» — не название.
  const lines = cover.filter(
    (l) =>
      !/^(\S ){4,}/.test(l.text) &&
      /[а-яёa-z]{3}/i.test(l.text) &&
      !/^(содержание|оглавление)$/i.test(l.text.trim()),
  );
  let coverTitle = "";
  // Кегль названия — самый крупный у строк подлиннее: «ИТС» на обложке
  // крупнее, но это не название.
  const sized = lines.filter((l) => l.text.length >= 8);
  if (sized.length) {
    const maxH = Math.max(...sized.map((l) => l.h));
    const first = lines.findIndex((l) => Math.abs(l.h - maxH) <= 0.5);
    const block = [];
    // Название в несколько строк — подряд идущие строки того же кегля,
    // и короткие тоже («Пиролиз углеводородного / сырья»).
    for (let i = first; i >= 0 && i < lines.length && Math.abs(lines[i].h - maxH) <= 0.5; i++) {
      block.push(lines[i].text);
    }
    coverTitle = sentenceCase(block.join(" ").replace(/\s+/g, " "));
    if (coverTitle.length > 160) coverTitle = "";
  }
  // Название из свойств PDF полнее и начинается так же («Серная кислота:
  // контактный способ») — берём его.
  if (
    metaTitle &&
    coverTitle &&
    metaTitle.length > coverTitle.length &&
    metaTitle.toLowerCase().startsWith(coverTitle.toLowerCase())
  ) {
    coverTitle = metaTitle;
  }

  const fileBase = String(fileName || "").replace(/\.pdf$/i, "").trim();
  const full = coverTitle || metaTitle || fileBase || "Документ";
  const title = shortFromHeader && coverTitle ? `${shortFromHeader} «${coverTitle}»` : full;
  const short = shortFromHeader || (full.length <= 40 ? full : `${full.slice(0, 38)}…`);
  return { title, short };
}

/**
 * Сдвиг между печатным номером страницы и номером страницы в файле: у ИТС
 * обложка, содержание и предисловие идут римскими, и «стр. 14» — это 24-я
 * страница PDF. Берём самый частый сдвиг по пунктам содержания.
 */
function pageOffset(headings) {
  const counts = new Map();
  for (const h of headings) {
    if (!h.printed || !/^\d+$/.test(h.printed)) continue;
    const off = h.page - Number(h.printed);
    counts.set(off, (counts.get(off) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [off, n] of counts) {
    if (n > bestN) {
      best = off;
      bestN = n;
    }
  }
  return bestN >= 3 ? best : null;
}

/** Нумерованные заголовки прямо в тексте — если разметки нет. */
function headingsFromText(pages) {
  const out = [];
  for (const p of pages) {
    for (const l of p.lines) {
      const t = l.text;
      if (t.length > 160 || t.length < 4) continue;
      if (/[.;,:]$/.test(t) && !/^(Раздел|Глава)\s+\d+\.$/i.test(t)) continue;
      const isNumbered = /^(\d{1,2}(\.\d{1,3}){0,3})\.?\s+[А-ЯЁA-Z«]/.test(t);
      const isChapter = /^(Раздел|Глава|Часть)\s+\d+\.?\s+\S/i.test(t);
      if (!isNumbered && !isChapter) continue;
      // Таблицы и рисунки — не заголовки; строки из таблиц часто начинаются
      // с цифры и заглавной.
      if (/^(Таблица|Рисунок|Рис\.)/i.test(t)) continue;
      out.push({ raw: t, page: p.n, y: l.y + l.h });
    }
  }
  // Заголовков мало — это не разметка, а совпадения.
  return out.length >= 3 ? out : [];
}

/**
 * Строки документа от заголовка до следующего заголовка — текст раздела и
 * последняя страница, где он есть.
 */
function sliceText(pages, from, to) {
  const lines = [];
  let lastPage = from.page;
  const endPage = Math.min(to.page, pages.length);
  for (let n = from.page; n <= endPage; n++) {
    const p = pages[n - 1];
    let any = false;
    for (const l of p.lines) {
      // На первой странице — от заголовка вниз.
      if (n === from.page && from.y !== null && l.y > from.y + 1) continue;
      // На странице следующего заголовка — только то, что выше него.
      if (n === to.page && (to.y === null || l.y <= to.y + 1)) continue;
      lines.push(l.text);
      any = true;
    }
    if (any) lastPage = n;
    lines.push("");
  }
  const text = lines
    .join("\n")
    .replace(/([а-яёa-z])[-‐‑]\n([а-яёa-z])/gi, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, lastPage };
}

/**
 * Разделы-источники документа.
 *
 * @param doc — результат extractPdf
 * @returns {
 *   structure: "outline" | "links" | "headings" | "pages",
 *   offset: сдвиг печатных номеров страниц или null,
 *   units: [{ ord, number, title, core, level, path, pageFrom, pageTo,
 *             printedFrom, printedTo, text, titleProducts, decode }]
 * }
 */
function buildUnits(doc) {
  const { pages, toc } = doc;
  let structure = toc.kind;
  let raw = toc.entries;
  if (!raw.length) {
    raw = headingsFromText(pages);
    structure = raw.length ? "headings" : "pages";
  }

  const headings = raw
    .map((e) => ({ ...parseHeading(e.raw, e.level), page: e.page, y: e.y }))
    .filter((h) => h.page >= 1 && h.page <= pages.length && h.core)
    .sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));
  // Одна и та же позиция дважды (строка содержания и закладка) — одна.
  const uniq = [];
  for (const h of headings) {
    const prev = uniq[uniq.length - 1];
    if (prev && prev.page === h.page && prev.y === h.y) continue;
    uniq.push(h);
  }

  const offset = pageOffset(uniq);
  const endOf = (i) => {
    for (let j = i + 1; j < uniq.length; j++) {
      if (uniq[j].level <= uniq[i].level) return { page: uniq[j].page, y: uniq[j].y };
    }
    return { page: pages.length + 1, y: null };
  };
  const childrenOf = (i) => {
    const out = [];
    for (let j = i + 1; j < uniq.length && uniq[j].level > uniq[i].level; j++) out.push(j);
    return out;
  };
  const pathOf = (i) => {
    const chain = [];
    let level = uniq[i].level;
    for (let j = i - 1; j >= 0 && level > 1; j--) {
      if (uniq[j].level < level) {
        chain.unshift(uniq[j].title);
        level = uniq[j].level;
      }
    }
    return chain.join(" › ");
  };

  const picked = [];
  const pick = (i) => {
    const kids = childrenOf(i);
    const end = endOf(i);
    const size = end.page - uniq[i].page;
    // Слишком большой раздел с подразделами — берём подразделы.
    if (size > MAX_UNIT_PAGES && kids.length) {
      const direct = kids.filter((j) => uniq[j].level === Math.min(...kids.map((k) => uniq[k].level)));
      for (const j of direct) pick(j);
      return;
    }
    picked.push(i);
  };

  const isProduction = (i) => PRODUCTION_TITLE.test(uniq[i].core);
  const hasAncestor = (i) =>
    uniq.some((u, j) => j < i && u.level < uniq[i].level && childrenOf(j).includes(i));
  const insidePicked = (i) => picked.some((p) => childrenOf(p).includes(i));
  for (let i = 0; i < uniq.length; i++) {
    if (insidePicked(i)) continue;
    const kidsProduction = childrenOf(i).some(isProduction);
    if (isProduction(i)) {
      // Самый мелкий раздел «Производство X»: у «Производство бутиловых
      // спиртов и 2-этилгексанола» источники — оба подраздела.
      if (!kidsProduction) pick(i);
      continue;
    }
    // Раздел верхнего уровня без производств внутри — если он о деле, а не
    // введение или приложение. (Разделы о перспективных технологиях отсеет
    // writeSections — они не источник, см. prospective.js.)
    if (!hasAncestor(i) && !kidsProduction && !skipped(uniq[i])) pick(i);
  }

  let units = [...new Set(picked)]
    .sort((a, b) => a - b)
    .map((i) => {
      const h = uniq[i];
      const { text, lastPage } = sliceText(pages, { page: h.page, y: h.y }, endOf(i));
      return {
        number: h.number,
        title: h.core,
        fullTitle: h.title,
        level: h.level,
        path: pathOf(i),
        pageFrom: h.page,
        pageTo: Math.max(h.page, lastPage),
        text,
        titleProducts: productsFromTitle(h.core),
      };
    })
    .filter((u) => u.text.length >= MIN_UNIT_CHARS);

  // Разметки нет — куски по нескольку страниц.
  if (!units.length) {
    structure = "pages";
    units = [];
    for (let s = 1; s <= pages.length; s += WINDOW_PAGES) {
      const e = Math.min(pages.length, s + WINDOW_PAGES - 1);
      const text = pages
        .slice(s - 1, e)
        .map((p) => p.text)
        .join("\n\n")
        .trim();
      if (text.length < MIN_UNIT_CHARS) continue;
      units.push({
        number: null,
        title: s === e ? `Страница ${s}` : `Страницы ${s}–${e}`,
        fullTitle: null,
        level: 1,
        path: "",
        pageFrom: s,
        pageTo: e,
        text,
        titleProducts: [],
      });
    }
  }

  return {
    structure,
    offset,
    units: units.map((u, ord) => ({
      ...u,
      ord,
      printedFrom: offset !== null && u.pageFrom - offset >= 1 ? u.pageFrom - offset : null,
      printedTo: offset !== null && u.pageTo - offset >= 1 ? u.pageTo - offset : null,
    })),
  };
}

module.exports = {
  buildUnits,
  parseHeading,
  productsFromTitle,
  documentTitles,
  PRODUCTION_TITLE,
  SKIP_TITLE,
};
