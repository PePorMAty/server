// routes/chat/graphSlice.js
//
// Срез открытого графа для чата (этап 4 PG-MIGRATION.md). Граф живёт в
// браузере вместе с несохранёнными правками, поэтому срез присылает клиент:
//   { name, selectedLabel: название выбранного продукта, selected: его
//     контекст (productContext.ts; у одинокого узла без описания — null),
//     products: [{ id, label }], transformations: [{ id, label, inputs,
//     outputs }], alternatives?: [{ id, label, of: [продукты], direction }] }
// recent?: [{ title, details }] — последние изменения графа из его истории,
// новые сверху: по ним «построй дальше» продолжает от последнего шага, а не
// от первого попавшегося продукта.
// Альтернативы — фиолетовые варианты шага, которые человек ещё не принял:
// не шаги графа, но их можно показать и о них спрашивают («отобрази
// альтернативы»). Старый клиент их не шлёт.
// products[].sources?: { up?, down?: { count, titles } } — источники, которые
// мастер шага уже нашёл (база ИТС и интернет): их видно на графе, и о них
// спрашивают («что за источники нашлись у автомобиля»), а product_card знает
// только базу. transformations[].balance?: { status, basis, note } —
// последний расчёт баланса: «частично» и почему, чтобы досчитать (20.11).
// selection?: [{ id, label, kind }] — узлы, выделенные на полотне рамкой или
// с Shift: «заполни карточки для всех выделенных» (20.11).
// Здесь — проверка и обрезка (граф на сотни узлов не должен раздувать
// запрос к модели) и поиск узла по названию — с теми же ключами, что у
// источников продукта: «Кумол» найдёт узел «Изопропилбензол (кумол)».

const { readProductContext } = require("../shared/productContext");
const { mentions } = require("./mentions");
const { productKeys } = require("../local-sources/utils/store");

const LIMITS = { products: 600, transformations: 400, alternatives: 200, recent: 10, label: 200, ends: 20, name: 200, titles: 5, note: 600, withSources: 80, selection: 60 };

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Источники продукта в одном направлении: сколько и первые названия. */
function readFound(v) {
  if (!v || typeof v !== "object") return null;
  const titles = (Array.isArray(v.titles) ? v.titles : []).map((x) => clean(x, LIMITS.label)).filter(Boolean).slice(0, LIMITS.titles);
  const count = Math.max(titles.length, Math.min(Number(v.count) || 0, 999));
  return count ? { count, titles } : null;
}

function readSources(v) {
  if (!v || typeof v !== "object") return null;
  const up = readFound(v.up);
  const down = readFound(v.down);
  return up || down ? { ...(up ? { up } : {}), ...(down ? { down } : {}) } : null;
}

function readBalance(v) {
  if (!v || typeof v !== "object") return null;
  const status = clean(v.status, 40);
  if (!status) return null;
  const basis = clean(v.basis, LIMITS.label);
  const note = clean(v.note, LIMITS.note);
  return { status, ...(basis ? { basis } : {}), ...(note ? { note } : {}) };
}

function readGraphSlice(raw) {
  const g = raw && typeof raw === "object" ? raw : {};
  const products = (Array.isArray(g.products) ? g.products : [])
    .map((p) => {
      const sources = readSources(p?.sources);
      return { id: clean(p?.id, 300), label: clean(p?.label, LIMITS.label), ...(sources ? { sources } : {}) };
    })
    .filter((p) => p.id && p.label)
    .slice(0, LIMITS.products);
  // Источники — у первых LIMITS.withSources продуктов: граф на сотни узлов
  // с найденным у каждого не должен раздувать запрос.
  let withSources = 0;
  for (const p of products) if (p.sources && ++withSources > LIMITS.withSources) delete p.sources;
  const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, LIMITS.label)).filter(Boolean).slice(0, LIMITS.ends) : []);
  const transformations = (Array.isArray(g.transformations) ? g.transformations : [])
    .map((t) => {
      const balance = readBalance(t?.balance);
      return {
        id: clean(t?.id, 300),
        label: clean(t?.label, LIMITS.label),
        inputs: list(t?.inputs),
        outputs: list(t?.outputs),
        ...(balance ? { balance } : {}),
      };
    })
    .filter((t) => t.id && t.label)
    .slice(0, LIMITS.transformations);
  const alternatives = (Array.isArray(g.alternatives) ? g.alternatives : [])
    .map((a) => ({
      id: clean(a?.id, 300),
      label: clean(a?.label, LIMITS.label),
      of: list(a?.of),
      direction: a?.direction === "up" ? "up" : "down",
    }))
    .filter((a) => a.id && a.label)
    .slice(0, LIMITS.alternatives);
  const recent = (Array.isArray(g.recent) ? g.recent : [])
    .map((r) => ({ title: clean(r?.title, 120), details: clean(r?.details, 400) }))
    .filter((r) => r.title)
    .slice(0, LIMITS.recent);
  const selection = (Array.isArray(g.selection) ? g.selection : [])
    .map((x) => ({
      id: clean(x?.id, 300),
      label: clean(x?.label, LIMITS.label),
      kind: x?.kind === "transformation" ? "transformation" : "product",
    }))
    .filter((x) => x.id && x.label)
    .slice(0, LIMITS.selection);
  return {
    name: clean(g.name, LIMITS.name),
    selection,
    selectedLabel: clean(g.selectedLabel, LIMITS.label) || null,
    selected: readProductContext(g.selected),
    products,
    transformations,
    alternatives,
    recent,
  };
}

/**
 * Концы цепочек: продукты, из которых на графе ещё ничего не делают (дальше
 * вниз), и те, что ещё ни из чего не получают (дальше вверх). «Продолжи
 * цепочку» — от них.
 */
function chainEnds(slice) {
  const used = new Set();
  const made = new Set();
  for (const t of slice.transformations) {
    for (const x of t.inputs) used.add(lower(x));
    for (const x of t.outputs) made.add(lower(x));
  }
  const linked = (p) => used.has(lower(p.label)) || made.has(lower(p.label));
  return {
    down: slice.products.filter((p) => made.has(lower(p.label)) && !used.has(lower(p.label))).map((p) => p.label),
    up: slice.products.filter((p) => used.has(lower(p.label)) && !made.has(lower(p.label))).map((p) => p.label),
    alone: slice.products.filter((p) => !linked(p)).map((p) => p.label),
  };
}

const lower = (s) => s.toLowerCase().replace(/ё/g, "е");

/**
 * Узлы-продукты среза с этим названием: сначала точное совпадение, потом по
 * ключам названия. [] — на графе такого нет.
 */
function findProducts(slice, name) {
  const want = lower(clean(name, LIMITS.label));
  if (!want) return [];
  const exact = slice.products.filter((p) => lower(p.label) === want);
  if (exact.length) return exact;
  const keys = new Set(productKeys(name));
  if (!keys.size) return [];
  return slice.products.filter((p) => productKeys(p.label).some((k) => keys.has(k)));
}

/**
 * Преобразования среза с этим названием: точное совпадение, потом по
 * вхождению («кумольный» найдёт «Кумольный способ»). product — только те,
 * где продукт среди сырья или продуктов: одноимённых преобразований на
 * графе бывает несколько («Гидрирование»).
 */
function findTransformations(slice, name, product) {
  const want = lower(clean(name, LIMITS.label));
  if (!want) return [];
  let list = slice.transformations;
  if (product) {
    const labels = new Set(findProducts(slice, product).map((p) => lower(p.label)));
    if (labels.size) list = list.filter((t) => [...t.inputs, ...t.outputs].some((x) => labels.has(lower(x))));
  }
  const exact = list.filter((t) => lower(t.label) === want);
  if (exact.length) return exact;
  const part = list.filter((t) => lower(t.label).includes(want) || want.includes(lower(t.label)));
  if (part.length) return part;
  // Другим падежом: «алкилированием фенола олигомерами этилена».
  return list.filter((t) => mentions(name, t.label));
}

/** Альтернативы по названию варианта или продукта, у которого они стоят. */
function findAlternatives(slice, name) {
  const want = lower(clean(name, LIMITS.label));
  if (!want) return [];
  const own = slice.alternatives.filter((a) => lower(a.label) === want || mentions(name, a.label));
  if (own.length) return own;
  const labels = new Set(findProducts(slice, name).map((p) => lower(p.label)));
  return slice.alternatives.filter((a) => a.of.some((x) => labels.has(lower(x))));
}

/** Узел графа по названию — продукт, а нет такого — преобразование. */
function findNode(slice, name) {
  const [p] = findProducts(slice, name);
  if (p) return { ...p, kind: "product" };
  const [t] = findTransformations(slice, name);
  return t ? { id: t.id, label: t.label, kind: "transformation" } : null;
}

/** Узел графа и его соседи: из чего его делают и что делают из него. */
function graphNode(slice, name) {
  const found = findProducts(slice, name);
  if (!found.length) {
    // Не продукт — может быть, преобразование: «Оксимирование циклогексанона»
    // модель искала здесь и слышала «на графе нет» (20.11).
    const ts = findTransformations(slice, name);
    if (!ts.length) return { found: false };
    return {
      found: true,
      kind: "transformation",
      transformations: ts.slice(0, 5).map((t) => ({
        transformation: t.label,
        inputs: t.inputs,
        outputs: t.outputs,
        balance: t.balance ?? "не считался",
      })),
    };
  }
  const labels = new Set(found.map((p) => lower(p.label)));
  const has = (list) => list.some((x) => labels.has(lower(x)));
  const made = slice.transformations.filter((t) => has(t.outputs));
  const used = slice.transformations.filter((t) => has(t.inputs));
  const brief = (t) => ({ transformation: t.label, inputs: t.inputs, outputs: t.outputs });
  const alts = slice.alternatives.filter((a) => a.of.some((x) => labels.has(lower(x))));
  return {
    found: true,
    nodes: found.map((p) => p.label),
    madeBy: made.slice(0, 10).map(brief),
    usedIn: used.slice(0, 10).map(brief),
    // Варианты шага, ещё не принятые человеком: вверх — другие способы
    // получить продукт, вниз — другие пути его переработки.
    alternatives: alts.slice(0, 10).map((a) => ({ alternative: a.label, direction: a.direction })),
    // Найденное мастером шага — то, что человек видит на графе значком
    // источников; product_card этого не знает (там только база ИТС).
    foundSources: Object.fromEntries(found.filter((p) => p.sources).map((p) => [p.label, p.sources])),
  };
}

module.exports = { readGraphSlice, findProducts, findTransformations, findAlternatives, findNode, graphNode, chainEnds, LIMITS };
