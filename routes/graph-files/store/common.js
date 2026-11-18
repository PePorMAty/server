// routes/graph-files/store/common.js
//
// Общее для хранилищ графов (files.js и pg.js): мета для списка библиотеки,
// версия графа и ошибка конфликта сохранений.

/**
 * Мета графа для списка библиотеки и ответов на изменение.
 *
 * Читается защитно: у графов, сохранённых ранними версиями, может не быть
 * `state`, `meta.updatedAt` или `meta.description` — на таких список всё равно
 * обязан отрисоваться, а не падать целиком. leafCount — число, когда мета
 * пришла из базы без самого списка листьев.
 */
function metaOf(id, content, leafCount) {
  const meta = content?.meta ?? {};
  const state = content?.state ?? {};
  return {
    id,
    name: meta.name ?? id,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    leafCount: leafCount ?? (Array.isArray(state.leaf_nodes) ? state.leaf_nodes.length : 0),
    description: meta.description ?? null,
    version: versionOf(content),
  };
}

/**
 * Версия графа — растёт с каждым сохранением (meta.version). У графов,
 * сохранённых до версий (до 2026-11-18), её нет — это версия 1.
 */
function versionOf(content) {
  const v = Number(content?.meta?.version);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

function nodeCount(content) {
  const nodes = content?.graph?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

/**
 * Граф сохранили, пока его правили: версия, с которой его открыли, — не
 * последняя. current — мета последней версии ({ id, version, meta }).
 */
class ConflictError extends Error {
  constructor(current) {
    super("graph was saved by someone else");
    this.code = "GRAPH_CONFLICT";
    this.current = current;
  }
}

module.exports = { metaOf, versionOf, nodeCount, ConflictError };
