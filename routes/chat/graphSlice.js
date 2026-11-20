// routes/chat/graphSlice.js
//
// Срез открытого графа для чата (этап 4 PG-MIGRATION.md). Граф живёт в
// браузере вместе с несохранёнными правками, поэтому срез присылает клиент:
//   { name, selectedLabel: название выбранного продукта, selected: его
//     контекст (productContext.ts; у одинокого узла без описания — null),
//     products: [{ id, label }], transformations: [{ id, label, inputs,
//     outputs }], alternatives?: [{ id, label, of: [продукты], direction }] }
// Альтернативы — фиолетовые варианты шага, которые человек ещё не принял:
// не шаги графа, но их можно показать и о них спрашивают («отобрази
// альтернативы»). Старый клиент их не шлёт.
// Здесь — проверка и обрезка (граф на сотни узлов не должен раздувать
// запрос к модели) и поиск узла по названию — с теми же ключами, что у
// источников продукта: «Кумол» найдёт узел «Изопропилбензол (кумол)».

const { readProductContext } = require("../shared/productContext");
const { mentions } = require("./mentions");
const { productKeys } = require("../local-sources/utils/store");

const LIMITS = { products: 600, transformations: 400, alternatives: 200, label: 200, ends: 20, name: 200 };

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function readGraphSlice(raw) {
  const g = raw && typeof raw === "object" ? raw : {};
  const products = (Array.isArray(g.products) ? g.products : [])
    .map((p) => ({ id: clean(p?.id, 300), label: clean(p?.label, LIMITS.label) }))
    .filter((p) => p.id && p.label)
    .slice(0, LIMITS.products);
  const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, LIMITS.label)).filter(Boolean).slice(0, LIMITS.ends) : []);
  const transformations = (Array.isArray(g.transformations) ? g.transformations : [])
    .map((t) => ({ id: clean(t?.id, 300), label: clean(t?.label, LIMITS.label), inputs: list(t?.inputs), outputs: list(t?.outputs) }))
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
  return {
    name: clean(g.name, LIMITS.name),
    selectedLabel: clean(g.selectedLabel, LIMITS.label) || null,
    selected: readProductContext(g.selected),
    products,
    transformations,
    alternatives,
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
  if (!found.length) return { found: false };
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
  };
}

module.exports = { readGraphSlice, findProducts, findTransformations, findAlternatives, findNode, graphNode, LIMITS };
