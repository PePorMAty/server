// routes/chat/graphSlice.js
//
// Срез открытого графа для чата (этап 4 PG-MIGRATION.md). Граф живёт в
// браузере вместе с несохранёнными правками, поэтому срез присылает клиент:
//   { name, selectedLabel: название выбранного продукта, selected: его
//     контекст (productContext.ts; у одинокого узла без описания — null),
//     products: [{ id, label }], transformations: [{ id, label, inputs,
//     outputs }] }
// Здесь — проверка и обрезка (граф на сотни узлов не должен раздувать
// запрос к модели) и поиск узла по названию — с теми же ключами, что у
// источников продукта: «Кумол» найдёт узел «Изопропилбензол (кумол)».

const { readProductContext } = require("../shared/productContext");
const { productKeys } = require("../local-sources/utils/store");

const LIMITS = { products: 600, transformations: 400, label: 200, ends: 20, name: 200 };

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
  return {
    name: clean(g.name, LIMITS.name),
    selectedLabel: clean(g.selectedLabel, LIMITS.label) || null,
    selected: readProductContext(g.selected),
    products,
    transformations,
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

/** Узел графа и его соседи: из чего его делают и что делают из него. */
function graphNode(slice, name) {
  const found = findProducts(slice, name);
  if (!found.length) return { found: false };
  const labels = new Set(found.map((p) => lower(p.label)));
  const has = (list) => list.some((x) => labels.has(lower(x)));
  const made = slice.transformations.filter((t) => has(t.outputs));
  const used = slice.transformations.filter((t) => has(t.inputs));
  const brief = (t) => ({ transformation: t.label, inputs: t.inputs, outputs: t.outputs });
  return {
    found: true,
    nodes: found.map((p) => p.label),
    madeBy: made.slice(0, 10).map(brief),
    usedIn: used.slice(0, 10).map(brief),
  };
}

module.exports = { readGraphSlice, findProducts, graphNode, LIMITS };
