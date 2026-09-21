// scripts/lib/graph-products.js
//
// Названия продуктов с сохранённых графов.
//
// Нужны двум скриптам сразу — аудиту и сборщику синонимов, — и читать их надо
// одинаково, иначе сборщик пойдёт за одними названиями, а аудит отчитается по
// другим.

const fs = require("fs");
const path = require("path");

const GRAPHS_DIR = path.resolve(__dirname, "../../data/saved-graphs");

/** Сохранённый граф → названия его продуктов, без повторов внутри графа. */
function productLabels(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { name: path.basename(file), labels: [] };
  }

  // Формат сохранения менялся: узлы лежат то в graph.nodes, то в корне.
  const nodes = parsed?.graph?.nodes ?? parsed?.nodes ?? [];
  const name =
    parsed?.meta?.name ?? parsed?.name ?? parsed?.prompt ?? path.basename(file);

  const seen = new Set();
  const labels = [];
  for (const n of nodes) {
    if (n?.type !== "product") continue;
    const label = String(n?.data?.label ?? "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return { name, labels };
}

/**
 * Все названия продуктов со всех сохранённых графов.
 *
 * Возвращает и счётчик: на скольких графах встретилось название. Продукт,
 * стоящий на пяти графах, важнее встретившегося однажды — и в списке работ, и
 * при сборе синонимов.
 */
function collectProducts(onlyGraph = null) {
  if (!fs.existsSync(GRAPHS_DIR)) return { graphs: [], counts: new Map() };

  const graphs = [];
  const counts = new Map();

  for (const entry of fs.readdirSync(GRAPHS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    if (onlyGraph && !entry.includes(onlyGraph)) continue;
    const { name, labels } = productLabels(path.join(GRAPHS_DIR, entry));
    if (!labels.length) continue;
    graphs.push({ file: entry, name, count: labels.length });
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return { graphs, counts };
}

module.exports = { GRAPHS_DIR, collectProducts, productLabels };
