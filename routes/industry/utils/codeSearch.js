// routes/industry/utils/codeSearch.js
//
// Поиск по файлам классификаторов для определения кода моделью (codes.js):
// наш file_search.
//
// Почему свой, а не file_search шлюза. Встроенный поиск DashScope и OpenAI —
// векторный: он находит похожие по смыслу куски, но не умеет «все коды под
// 20.14», а именно это промпт требует первым делом (шаг 4 — поиск по префиксу
// подгруппы). Файлы ОКПД2 и ТН ВЭД и так лежат у сервера (reference/), и
// поиск по ним точный: по названию и синонимам из справочника — позиции и их
// подгруппы, по префиксу — все коды подгруппы целиком, в порядке файла.
// Модель видит только этот фрагмент, а выбранный ею код сервер сверяет с
// файлом — выдумать код она не может.
//
// Уровни. ОКПД2: класс xx → подгруппа xx.xx → … → конечный код
// xx.xx.xx.xxx. ТН ВЭД: группа (2 цифры) → товарная позиция (4 цифры) → … →
// конечная подсубпозиция (9–10 цифр). «Подгруппа» промпта у ТН ВЭД — товарная
// позиция.

const fs = require("fs");
const path = require("path");

const { okpd2Entries, tnvedEntries, formatTnved } = require("./classifiers");
const { identify } = require("./synonyms");
const { stemName, words, normalizeName } = require("./normalize");

const DIR = path.resolve(__dirname, "../../../reference");

/** Сырые строки файла ТН ВЭД: во фрагмент идут и строки без кода — заголовки уровней. */
let tnvedLines = null;
function rawTnvedLines() {
  if (tnvedLines) return tnvedLines;
  try {
    tnvedLines = fs
      .readFileSync(path.join(DIR, "tnved.txt"), "utf8")
      .replace(/^﻿/, "")
      .replace(/\r\n/g, "\n")
      .split("\n");
  } catch {
    tnvedLines = [];
  }
  return tnvedLines;
}

const digits = (s) => String(s ?? "").replace(/\D+/g, "");

/** Подгруппа кода: ОКПД2 — xx.xx, ТН ВЭД — 4 цифры. */
function groupOf(kind, code) {
  if (kind === "okpd2") return /^\d{2}\.\d{2}/.exec(code)?.[0] ?? null;
  const d = digits(code);
  return d.length >= 4 ? d.slice(0, 4) : null;
}

const stems = (text) => new Set(words(stemName(text)).filter((w) => w.length > 2));

/** Позиции классификатора с основами слов названия — строится лениво. */
const index = { okpd2: null, tnved: null };
function entriesOf(kind) {
  if (index[kind]) return index[kind];
  const out = [];
  if (kind === "okpd2") {
    for (const [code, name] of okpd2Entries()) {
      const st = stems(name);
      out.push({ code, name, stems: st, own: st });
    }
  } else {
    // По цепочке уровней, а не по одной строке: «части и принадлежности
    // кузовов» — заголовок без кода над 8708 29, а «– – прочие» без него не
    // называют ничего. Точное совпадение (exact) — по самой строке.
    for (const [code, e] of tnvedEntries()) {
      out.push({ code, name: e.name, path: e.path, stems: stems(e.path || e.name), own: stems(e.name) });
    }
  }
  index[kind] = out;
  return out;
}

/** Есть ли код в файле. */
function exists(kind, code) {
  return kind === "okpd2" ? okpd2Entries().has(code) : tnvedEntries().has(digits(code));
}

/**
 * Есть ли подгруппа. У ТН ВЭД позиция без своей строки бывает: «2807 00 000
 * Серная кислота; олеум» стоит в файле сразу девятью цифрами, строки «2807»
 * нет — позиция есть, раз есть коды под ней.
 */
function groupExists(kind, group) {
  if (kind === "okpd2" || exists(kind, group)) return exists(kind, group);
  for (const code of tnvedEntries().keys()) if (code.startsWith(group)) return true;
  return false;
}

/** Название уровня по коду: подгруппа, класс, группа; у позиции без строки — первый код под ней. */
function nameOf(kind, code) {
  if (kind === "okpd2") return okpd2Entries().get(code) ?? null;
  const d = digits(code);
  const own = tnvedEntries().get(d);
  if (own) return own.name;
  for (const [c, e] of tnvedEntries()) if (c.startsWith(d)) return e.name;
  return null;
}

/**
 * Начало кодов, уточняющих данный. ОКПД2: ноли в хвосте четвёртой группы
 * значат «не уточнено» — под 20.14.61.100 стоят 20.14.61.110…190; у кодов
 * короче — всё, что начинается с них.
 */
function refinementPrefix(kind, code) {
  if (kind === "tnved") return digits(code);
  const parts = code.split(".");
  if (parts.length === 4) parts[3] = parts[3].replace(/0+$/, "");
  return parts.join(".").replace(/\.$/, "");
}

/** Конечный ли код: под ним в файле ничего нет. */
function isLeaf(kind, code) {
  const all = kind === "okpd2" ? okpd2Entries() : tnvedEntries();
  const c = kind === "okpd2" ? code : digits(code);
  const prefix = refinementPrefix(kind, c);
  // Предков не считаем: у 29.10.21.000 начало уточнений — «29.10.21», а с
  // него начинается и сама группа 29.10.21 над кодом. Без этого любой код
  // xx.xx.xx.000 (их в ОКПД2 1749) считался группой, и верный ответ модели
  // отклонялся (2026-11-17: «Автомобиль» → 29.10.21.000).
  for (const other of all.keys()) {
    if (other !== c && other.startsWith(prefix) && !c.startsWith(other)) return false;
  }
  return true;
}

/**
 * «Детали кузова» = «Части кузова»: в классификаторах детали и компоненты
 * называются «частями» и «комплектующими» (8708 «Части и принадлежности…»,
 * 29.32 «Комплектующие…»), и по слову «детали» поиск не находил ничего.
 */
function partSpellings(text) {
  const t = String(text ?? "");
  if (!/(^|\s)(детал|компонент|запчаст)/i.test(t)) return [];
  const rest = t.replace(/(^|\s)(внутренн\S*\s+)?(детал\S*|компонент\S*|запчаст\S*)/i, " ").replace(/\s+/g, " ").trim();
  return rest ? [`Части ${rest}`, `Комплектующие ${rest}`] : ["Части", "Комплектующие"];
}

/**
 * Написания товара: само название, оно же без уточнения в скобках и
 * уточнение отдельно («Двигатель (Самолёт)» — и «Двигатель», и «Самолёт»),
 * синонимы из справочника («Кумол» — «Изопропилбензол», «ИПБ»), «части»
 * вместо «деталей». Изделия из графа — отдельно (contextSpellings): по ним
 * поиск находит и подгруппы изделия («Крылья» для «Самолёта» — 8807 «прочие
 * части самолётов», а не куриные крылья 0207).
 */
function spellingsFor(name) {
  const raw = String(name ?? "").trim();
  const out = new Set([raw]);
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(raw);
  if (m) {
    out.add(m[1].trim());
    out.add(m[2].trim());
  }
  for (const s of [raw, m?.[1]]) {
    const hit = s ? identify(s) : null;
    if (hit?.canon) out.add(hit.canon);
    for (const sp of hit?.spellings ?? []) out.add(sp);
  }
  for (const sp of partSpellings(m ? m[1] : raw)) out.add(sp);
  return [...out].filter((s) => s && /[a-zа-яё]{3}/i.test(s)).slice(0, 20);
}

/**
 * Название позиции и его части: «Серная кислота; олеум», «метаналь
 * (формальдегид)» — это и «серная кислота», и «формальдегид».
 */
function namesOf(name) {
  const parts = String(name).split(/;\s*|\s*\(|\)\s*/).map((p) => p.trim()).filter(Boolean);
  return [...new Set([name, ...parts].map(normalizeName))];
}

/**
 * Поиск по названию: позиции, в названии которых есть все значимые слова
 * написания (порядок и падеж не важны). Ранжируем по написанию (первым —
 * само название), по числу лишних слов позиции, затем глубже — точнее.
 *
 * @returns {{ hits: {code, name, extra, exact, by}[], groups: {code, name, hits}[] }}
 */
function searchByName(kind, spellings, { maxGroups = 10, contextFrom = Infinity } = {}) {
  const hits = [];
  const seen = new Set();
  spellings.forEach((spelling, rank) => {
    const need = [...stems(spelling)];
    if (!need.length) return;
    const wanted = normalizeName(spelling);
    for (const e of entriesOf(kind)) {
      if (seen.has(e.code) || !need.every((w) => e.stems.has(w))) continue;
      seen.add(e.code);
      // Слова в самой строке, а не только в уровнях над ней: «двигатели
      // авиационные» точнее, чем любой код под «Двигателями…».
      const inName = need.every((w) => e.own.has(w));
      // Строка начинается с товара: «Двигатели внутреннего сгорания для
      // автотранспортных средств» — о двигателях, а «Автосамосвалы с
      // дизельным двигателем» — об автосамосвалах.
      const lead = inName && [...e.own][0] === need[0];
      hits.push({
        code: e.code,
        name: e.name,
        rank,
        context: rank >= contextFrom,
        inName,
        lead,
        extra: (inName ? e.own.size : e.stems.size) - need.length,
        exact: namesOf(e.name).includes(wanted),
        by: spelling,
      });
    }
  });
  hits.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      Number(a.context) - Number(b.context) ||
      Number(b.inName) - Number(a.inName) ||
      Number(b.lead) - Number(a.lead) ||
      a.rank - b.rank ||
      a.extra - b.extra ||
      b.code.length - a.code.length,
  );

  // Подгруппы — по лучшей находке; найденным по изделию из графа (контекст)
  // — свои места, иначе их вытеснили бы находки по самому названию.
  const own = new Map();
  const ctx = new Map();
  for (const h of hits) {
    const g = groupOf(kind, h.code);
    if (!g || !groupExists(kind, g)) continue;
    const bucket = h.context && !own.has(g) ? ctx : own;
    if (!bucket.has(g)) bucket.set(g, { code: g, name: nameOf(kind, g), hits: [] });
    const list = bucket.get(g).hits;
    if (list.length < 3) list.push(h);
  }
  const ctxGroups = [...ctx.values()].filter((g) => !own.has(g.code));
  // Своих находок мало — места отдаём изделию: у «Крыльев» в ОКПД2 своих нет.
  const ctxSlots = Math.min(ctxGroups.length, Math.max(3, maxGroups - own.size));
  const groups = [...[...own.values()].slice(0, maxGroups - ctxSlots), ...ctxGroups.slice(0, ctxSlots)];
  return { hits: hits.slice(0, 40), groups };
}

/** Названия изделий из графа — запасные написания для поиска (spellingsFor). */
function contextSpellings(usedFor = []) {
  const out = [];
  for (const owner of usedFor ?? []) {
    const o = String(owner ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (o && /[a-zа-яё]{3}/i.test(o) && !out.includes(o)) out.push(o);
  }
  return out.slice(0, 6);
}

/** Верхний уровень: классы ОКПД2 (xx), группы ТН ВЭД (2 цифры). */
function topLevels(kind) {
  if (kind === "okpd2") {
    return [...okpd2Entries()].filter(([c]) => /^\d{2}$/.test(c)).map(([code, name]) => ({ code, name }));
  }
  // Группы ТН ВЭД — из строк «ГРУППА 29» файла: название бывает в той же
  // строке («ГРУППА 01 ЖИВЫЕ ЖИВОТНЫЕ») или в следующей.
  const lines = rawTnvedLines();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ГРУППА\s+(\d{2})\s*(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    const name = (m[2] || lines.slice(i + 1, i + 4).find((l) => l.trim()) || "").trim();
    out.push({ code: m[1], name: name.charAt(0) + name.slice(1).toLowerCase() });
  }
  return out;
}

/** Подгруппы (позиции ТН ВЭД) внутри класса или группы верхнего уровня. */
function groupsUnder(kind, top) {
  if (kind === "okpd2") {
    return [...okpd2Entries()]
      .filter(([c]) => c.startsWith(`${top}.`) && /^\d{2}\.\d{2}$/.test(c))
      .map(([code, name]) => ({ code, name, hits: [] }));
  }
  return [...tnvedEntries()]
    .filter(([c]) => c.length === 4 && c.startsWith(top))
    .map(([code, e]) => ({ code, name: e.name, hits: [] }));
}

/**
 * Фрагмент файла: подгруппа и все коды под ней — как в файле. У ТН ВЭД — с
 * заголовками уровней без кода и тире глубины: «– – прочие» читается только
 * с уровнями над ним.
 */
function fragmentOf(kind, group) {
  if (kind === "okpd2") {
    const lines = [];
    for (const [code, name] of okpd2Entries()) {
      if (code === group || code.startsWith(`${group}.`)) lines.push(`${code}\t${name}`);
    }
    return lines.join("\n");
  }
  const lines = rawTnvedLines();
  const tabbed = (l) => l.includes("\t");
  let start = lines.findIndex((l) => tabbed(l) && digits(l.split("\t")[0]) === group);
  // Позиции без своей строки — с первого кода под ней.
  if (start < 0) start = lines.findIndex((l) => tabbed(l) && digits(l.split("\t")[0]).startsWith(group));
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // Строки без табуляции — заголовки разделов и тексты примечаний.
    if (!line.includes("\t")) {
      if (i > start && /^(ГРУППА|РАЗДЕЛ)/.test(line.trim())) break;
      continue;
    }
    const [rawCode, rawName = ""] = line.split("\t");
    const d = digits(rawCode);
    // Следующая товарная позиция — своей строкой или сразу кодами.
    if (i > start && d && (d.length === 4 || !d.startsWith(group))) break;
    if (!rawName.trim()) continue;
    out.push(`${d ? formatTnved(d) : ""}\t${rawName.trim()}`);
  }
  return out.join("\n");
}

/**
 * Код из ответа модели — в виде файла. ОКПД2: «20.14.61.110»; ТН ВЭД: цифры
 * («2912 11 000 0» → «2912110000»). null — кода в ответе нет (или NONE).
 */
function codeFromAnswer(kind, text) {
  const t = String(text ?? "");
  if (kind === "okpd2") {
    return /\b\d{2}\.\d{2}(?:\.\d{1,2}(?:\.\d{3})?)?\b/.exec(t)?.[0] ?? null;
  }
  const m = /\b\d{4}(?:\s?\d{2}(?:\s?\d{3}(?:\s?\d)?)?)?\b/.exec(t);
  return m ? digits(m[0]) : null;
}

/**
 * Код ТН ВЭД — как в файле и полным. Конечные подсубпозиции в файле — 9
 * цифр, десятая у них 0: «291211000» — это «2912 11 000 0».
 */
function tnvedInFile(code) {
  const d = digits(code);
  if (tnvedEntries().has(d)) return d;
  if (d.length === 10 && d.endsWith("0") && tnvedEntries().has(d.slice(0, 9))) return d.slice(0, 9);
  return null;
}

const tnvedFull = (inFile) => (inFile.length === 9 ? `${inFile}0` : inFile);

module.exports = {
  spellingsFor,
  contextSpellings,
  searchByName,
  topLevels,
  groupsUnder,
  fragmentOf,
  groupOf,
  exists,
  groupExists,
  nameOf,
  isLeaf,
  codeFromAnswer,
  tnvedInFile,
  tnvedFull,
};
