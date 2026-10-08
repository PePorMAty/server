// routes/material-balance/utils/parse.js
//
// Ответ модели — Markdown по шаблону (prompt.js) — в структуру для клиента.
//
// Целиком ответ клиент показывает как есть, а числа нужны отдельно: массы
// продуктов — для подписей на узлах и пересчёта на любое количество сырья,
// поля «Расчёта по преобразованиям» — чтобы показать расчёт одного продукта,
// потоки и источники — для вкладки. Разбор терпит то, что модели пишут
// вразнобой: «1 000» и «1000,0», «≈180», «150–200», «Р1» кириллицей, жирные
// подписи полей с двоеточием внутри и снаружи.
//
// Понимает и ответы прежнего промпта (пара «сырьё → продукт»): «Цепочка»
// вместо «Схемы участка», «Расчёт по переходам» вместо «Расчёта по
// преобразованиям», таблица «Коэффициенты переходов».

/** Статусы шаблона. «Частично рассчитан» проверяется раньше «Рассчитан». */
const STATUSES = [
  [/некорректн\S*\s+выбор\S*/i, "invalid_selection"],
  [/не\s+задан\S*\s+(?:корректн\S*\s+)?базис\S*/i, "invalid_basis"],
  [/недостаточно\s+данных/i, "insufficient"],
  [/частичн\S*\s+рассчитан\S*|рассчитан\S*\s+частичн\S*|частичн\S*/i, "partial"],
  [/рассчитан\S*/i, "calculated"],
];

/**
 * Статус по строке «Статус:». Несколько статусов сразу — модель переписала
 * строку шаблона вместо ответа, и такой статус неизвестен.
 */
function statusOf(line) {
  let rest = String(line || "");
  const found = [];
  for (const [re, code] of STATUSES) {
    if (re.test(rest)) {
      found.push(code);
      rest = rest.replace(re, " ");
    }
  }
  return found.length === 1 ? found[0] : "unknown";
}

const keyOf = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").trim();

/** Разделы ответа по заголовкам первого уровня: «# Название». */
function splitSections(md) {
  const sections = [];
  let current = null;
  for (const line of String(md || "").split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) {
      current = { title: m[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() }));
}

function section(sections, prefix) {
  const want = keyOf(prefix);
  return sections.find((s) => keyOf(s.title).startsWith(want))?.body ?? "";
}

const stripMd = (s) =>
  String(s ?? "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Поле вида «- **Статус:** Рассчитан.» — двоеточие бывает и внутри жирного, и
 * снаружи. Возвращает значение без точки в конце.
 */
function field(body, label) {
  const re = new RegExp(
    `^\\s*(?:[-*•]\\s*)?(?:\\*\\*|__)?\\s*${label}\\s*:?\\s*(?:\\*\\*|__)?\\s*:?\\s*(.+)$`,
    "im",
  );
  const m = String(body || "").match(re);
  if (!m) return null;
  const value = stripMd(m[1]).replace(/\.$/, "").trim();
  return value || null;
}

/** Первая таблица Markdown в тексте: шапка и строки ячеек. */
function firstTable(body) {
  const rows = [];
  let started = false;
  for (const line of String(body || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("|")) {
      started = true;
      const cells = t
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => stripMd(c.replace(/\\\|/g, "|")));
      // Разделитель шапки: |---|:---:|
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      rows.push(cells);
    } else if (started && t) {
      break;
    }
  }
  if (!rows.length) return null;
  const [header, ...data] = rows;
  return { header: header.map(keyOf), rows: data };
}

/** Номер колонки по началу/вхождению слова в шапке. */
function col(header, test) {
  return header.findIndex((h) => test(h));
}

/**
 * Обозначение узла: «P1», «p 1», «Р1» кириллицей, «[P1]», «P1 (Изобутилен)».
 * kind — "P" или "T".
 */
function refOf(text, kind) {
  const letters = kind === "T" ? "TtТт" : "PpРр";
  const m = String(text || "").match(
    new RegExp(`(?<![\\p{L}\\d])[${letters}]\\s*-?\\s*(\\d{1,3})(?!\\d)`, "u"),
  );
  return m ? `${kind}${m[1]}` : null;
}

/**
 * Масса или коэффициент из ячейки: число, диапазон, «≈180», «1 000»,
 * «Нет данных». В колонке «Масса, кг» встречаются и тонны — их переводим.
 */
function parseAmount(raw, { massKg = false } = {}) {
  let s = String(raw ?? "")
    .replace(/[   ]/g, " ")
    .trim();
  if (!s || /нет\s+данных|не\s+определ|неизвестн|не\s+установ/i.test(s)) return null;
  const approx = /[≈~∼]|около|примерно|порядка|оценк/i.test(s);
  // Разряды через пробел: «1 000», «12 500,5».
  s = s.replace(/(\d) (?=\d{3}(?!\d))/g, "$1");
  const nums = [...s.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => ({
    v: Number(m[0].replace(",", ".")),
    at: m.index,
    len: m[0].length,
  }));
  if (!nums.length || !Number.isFinite(nums[0].v)) return null;
  let min = nums[0].v;
  let max = min;
  if (nums.length >= 2) {
    const between = s.slice(nums[0].at + nums[0].len, nums[1].at);
    if (/^\s*(?:[-–—]|до|\.{2,3}|…)\s*$/i.test(between)) max = nums[1].v;
  }
  if (min > max) [min, max] = [max, min];
  if (massKg && /(?<!\p{L})(?:т|тонн\p{L}*)(?!\p{L})/iu.test(s) && !/кг/i.test(s)) {
    min *= 1000;
    max *= 1000;
  }
  return { min, max, approx };
}

const nameKey = (s) =>
  keyOf(s)
    .replace(/[«»"'()[\].,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Строки «Результатов по продуктам»: обозначение, масса на 1 т исходного. */
function parseProducts(body, refs) {
  const table = firstTable(body);
  if (!table) return [];
  const h = table.header;
  const iRef = col(h, (x) => x.includes("id"));
  const iName = col(h, (x) => x.startsWith("продукт"));
  const iMass = col(h, (x) => x.includes("масса"));
  const iLabel = col(h, (x) => x.includes("подпись"));
  const iBasis = col(h, (x) => x.includes("основан"));
  const byName = new Map(refs.map((r) => [nameKey(r.name), r.ref]));
  return table.rows
    .map((cells) => {
      const name = cells[iName] ?? "";
      const ref = refOf(cells[iRef], "P") ?? byName.get(nameKey(name)) ?? null;
      return {
        ref,
        name,
        massKg: parseAmount(cells[iMass], { massKg: true }),
        massText: cells[iMass] ?? "",
        label: cells[iLabel] ?? "",
        basis: cells[iBasis] ?? "",
      };
    })
    .filter((p) => p.ref || p.name);
}

/**
 * «Коэффициенты переходов» прежнего промпта: показатель стадии как в
 * источнике. В новом шаблоне такой таблицы нет — пусто.
 */
function parseCoefficients(body) {
  const table = firstTable(body);
  if (!table) return [];
  const h = table.header;
  const iT = col(h, (x) => x.includes("преобразован"));
  const iFrom = col(h, (x) => x.startsWith("из"));
  const iTo = col(h, (x) => x === "в" || x.startsWith("в ") || x.startsWith("в("));
  const iInd = col(h, (x) => x.includes("показател"));
  const iVal = col(h, (x) => x.includes("значен"));
  const iUnit = col(h, (x) => x.includes("единиц"));
  const iSrc = col(h, (x) => x.includes("источник"));
  return table.rows
    .map((cells) => {
      const valueText = cells[iVal] ?? "";
      const unit = cells[iUnit] ?? "";
      return {
        transformationRef: refOf(cells[iT], "T"),
        fromRef: refOf(cells[iFrom], "P"),
        toRef: refOf(cells[iTo], "P"),
        indicator: cells[iInd] ?? "",
        value: parseAmount(valueText),
        valueText,
        unit: unit || (/%/.test(valueText) ? "%" : ""),
        source: cells[iSrc] ?? "",
      };
    })
    .filter((c) => c.indicator || c.valueText);
}

/** Внешние потоки «Общего баланса участка». */
function parseFlows(body) {
  const table = firstTable(body);
  if (!table) return [];
  const h = table.header;
  const iName = col(h, (x) => x.includes("поток"));
  const iDir = col(h, (x) => x.includes("вход") || x.includes("выход"));
  const iMass = col(h, (x) => x.includes("масса"));
  const iBasis = col(h, (x) => x.includes("основан"));
  return table.rows
    .map((cells) => {
      const dir = keyOf(cells[iDir]);
      return {
        name: cells[iName] ?? "",
        direction: dir.startsWith("вход") ? "in" : dir.startsWith("выход") ? "out" : "",
        massKg: parseAmount(cells[iMass], { massKg: true }),
        massText: cells[iMass] ?? "",
        basis: cells[iBasis] ?? "",
      };
    })
    .filter((f) => f.name);
}

/** Поля стадии из шаблона — их узнаём и без жирного шрифта. */
const STEP_FIELDS = [
  "Преобразование",
  "Входные потоки",
  "Выходные потоки",
  "Коэффициенты",
  "Коэффициент",
  "Источник и условия",
  "Расчёт",
  "Расчет",
  "Невыбранные потоки",
  "Дополнительные потоки",
  "Проверка стадии",
];

const FIELD_LINE = new RegExp(
  `^[-*•]\\s*(?:(?:\\*\\*|__)\\s*([^*_\\n]{2,60}?)\\s*:?\\s*(?:\\*\\*|__)|(${STEP_FIELDS.join("|")}))\\s*:?\\s*(.*)$`,
  "i",
);

/**
 * Поля одной стадии: «- **Расчёт:** …» и всё, что ниже до следующего поля, —
 * вложенные пункты и продолжение строки. Метка — без жирного и двоеточия.
 */
function stepFields(text) {
  const fields = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    // Поле — только пункт без отступа: вложенный «- **P3:** 820 кг» — часть
    // поля выше.
    const m = /^\S/.test(line) ? line.match(FIELD_LINE) : null;
    if (m) {
      current = { label: (m[1] || m[2]).trim().replace(/:$/, ""), text: m[3].trim() };
      fields.push(current);
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  return fields
    .map((f) => ({ label: f.label, text: f.text.replace(/\s+$/, "").replace(/^\n+/, "") }))
    .filter((f) => f.label);
}

/**
 * «Расчёт по преобразованиям»: раздел «## 1. А + Б → В + Г» на каждое
 * преобразование. title — заголовок без номера, fields — поля шаблона.
 */
function parseSteps(body) {
  return String(body || "")
    .split(/^##\s+/m)
    .slice(1)
    .map((part) => {
      const [head, ...rest] = part.split(/\r?\n/);
      const text = rest.join("\n").trim();
      return {
        title: stripMd(head).replace(/^\d+\s*[.)]\s*/, ""),
        fields: stepFields(text),
        body: text,
      };
    })
    .filter((s) => s.title || s.body);
}

/**
 * Адрес без обрамления: «<https://…>.», «https://….». Закрывающую скобку
 * снимаем, только если открывающей к ней нет: в адресах Википедии скобки
 * бывают своими — «…/MTBE_(fuel)».
 */
function cleanUrl(raw) {
  let url = String(raw || "")
    .trim()
    .replace(/^<+/, "")
    .replace(/[>\],.;:!?'"»]+$/g, "");
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1).replace(/[>\],.;:!?'"»]+$/g, "");
  }
  return /^https?:\/\//i.test(url) ? url : "";
}

/** Блоки «## Источник [S1]» раздела «Источники». */
function parseSources(body) {
  const out = [];
  const parts = String(body || "").split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split(/\r?\n/);
    const block = rest.join("\n").trim();
    const id = head.match(/\[?\s*([SL]\s*\d+)\s*\]?/i)?.[1]?.replace(/\s+/g, "").toUpperCase();
    const line = (label) => {
      const m = block.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, "im"));
      return m ? stripMd(m[1]) : "";
    };
    const rawUrl = line("URL");
    // Документ базы источников сервера — local://documents/<id>/sections/<id>.
    const local = /local:\/\/documents\/\d+\/sections\/\d+(?:#page=\d+)?/i.exec(rawUrl)?.[0];
    const url = local || cleanUrl(rawUrl.replace(/^.*?(https?:\/\/\S+).*$/i, "$1"));
    const title = line("Название");
    if (!url && !title) continue;
    out.push({
      id: id || `S${out.length + 1}`,
      url,
      title,
      org: line("Организация и год"),
      type: line("Тип"),
      usedFor: line("Использован для"),
      accessHint: line("access_hint"),
      readCheck: line("Проверка чтения"),
      block,
    });
  }
  return out;
}

/**
 * Ответ модели без обёрток: код-блок вокруг всего ответа и вступление до
 * первого заголовка шаблона.
 */
function cleanAnswer(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i);
  if (fenced) text = fenced[1].trim();
  const start = text.search(/^#\s+Материальный баланс/im);
  if (start > 0) text = text.slice(start);
  return text.trim();
}

/** Разобрать ответ. refs — обозначения узлов запроса (prompt.buildRefs). */
function parseAnswer(markdown, refs = []) {
  const sections = splitSections(markdown);
  const head = section(sections, "Материальный баланс");
  const statusLabel = field(head, "Статус") ?? "";
  const balance = section(sections, "Общий баланс участка");
  const transitions =
    section(sections, "Расчёт по преобразованиям") ||
    section(sections, "Расчет по преобразованиям") ||
    section(sections, "Расчёт по переходам");
  return {
    status: statusOf(statusLabel),
    statusLabel,
    chain: field(head, "Схема участка") ?? field(head, "Цепочка"),
    basisText: field(head, "Базис"),
    nature: field(head, "Характер результата"),
    products: parseProducts(section(sections, "Результаты по продуктам"), refs),
    coefficients: parseCoefficients(section(sections, "Коэффициенты переходов")),
    flows: parseFlows(balance),
    totals: {
      input: field(balance, "Всего на входе"),
      output: field(balance, "Всего на выходе"),
      accumulation: field(balance, "Накопление"),
      residual: field(balance, "Невязка"),
      conclusion: field(balance, "Вывод о балансе"),
    },
    steps: parseSteps(transitions),
    sources: parseSources(section(sections, "Источники")),
    sections: {
      transitions,
      balance,
      notes: section(sections, "Примечания"),
    },
  };
}

module.exports = {
  parseAnswer,
  cleanAnswer,
  parseAmount,
  statusOf,
  refOf,
  splitSections,
  firstTable,
  parseSteps,
};
