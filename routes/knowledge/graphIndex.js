// routes/knowledge/graphIndex.js
//
// Указатель узлов графов библиотеки (этап 3б PG-MIGRATION.md, таблицы
// app.graph_nodes и app.graph_index): продукты — с ключами названий,
// преобразования — с сырьём и продуктами. По нему «в каких графах есть
// фенол» и «какие преобразования графов его делают» — запрос, а не разбор
// каждого графа.
//
// Ключи — те же, что у источников продукта (productKeys: основы слов и
// написания из справочника синонимов), поэтому «Кумол» найдёт узлы
// «Изопропилбензол».
//
// Производный: пересчитывается после сохранения графа (store/pg.js) и при
// запуске сервера — у графов, где версия указателя отстала от версии графа.
// Без миграции 004 ничего не делает.

const { productKeys } = require("../local-sources/utils/store");

/** Узлы графа → строки указателя. */
function indexRows(content) {
  const nodes = Array.isArray(content?.graph?.nodes) ? content.graph.nodes : [];
  const edges = Array.isArray(content?.graph?.edges) ? content.graph.edges : [];
  const byId = new Map(nodes.map((n) => [n?.id, n]));
  const label = (n) => String(n?.data?.label ?? "").trim();
  const productLabel = (id) => {
    const n = byId.get(id);
    return n?.type === "product" ? label(n) : "";
  };
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const keysOf = (names) => uniq(names.flatMap((n) => productKeys(n)));
  const rows = [];
  for (const n of nodes) {
    if (!n?.id || !["product", "transformation"].includes(n.type)) continue;
    const name = label(n);
    if (!name) continue;
    if (n.type === "product") {
      rows.push({ node_id: String(n.id), type: "product", label: name, keys: keysOf([name]), inputs: [], outputs: [], in_keys: [], out_keys: [] });
      continue;
    }
    const inputs = uniq(edges.filter((e) => e?.target === n.id).map((e) => productLabel(e.source)));
    const outputs = uniq(edges.filter((e) => e?.source === n.id).map((e) => productLabel(e.target)));
    rows.push({
      node_id: String(n.id),
      type: "transformation",
      label: name,
      keys: [],
      inputs,
      outputs,
      in_keys: keysOf(inputs),
      out_keys: keysOf(outputs),
    });
  }
  return rows;
}

const COLUMNS = ["graph_id", "node_id", "type", "label", "keys", "inputs", "outputs", "in_keys", "out_keys"];
const BATCH = 400;

/** Есть ли таблицы указателя (миграция 004) — один раз на пул. */
const ready = new Map();
function indexReady(pool) {
  if (!ready.has(pool)) {
    ready.set(
      pool,
      pool
        .query("SELECT to_regclass('app.graph_nodes') AS t")
        .then((r) => Boolean(r.rows[0]?.t))
        .catch(() => false),
    );
  }
  return ready.get(pool);
}

function resetIndexReady() {
  ready.clear();
}

/**
 * Пересчитать указатель графа (удалённого — убрать). Возвращает число узлов
 * или null, если таблиц указателя нет.
 */
async function indexGraph(pool, graphId) {
  if (!(await indexReady(pool))) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT content, version FROM app.graphs WHERE id = $1 AND deleted_at IS NULL",
      [graphId],
    );
    await client.query("DELETE FROM app.graph_nodes WHERE graph_id = $1", [graphId]);
    if (!rows.length) {
      await client.query("DELETE FROM app.graph_index WHERE graph_id = $1", [graphId]);
      await client.query("COMMIT");
      return 0;
    }
    const list = indexRows(rows[0].content);
    for (let i = 0; i < list.length; i += BATCH) {
      const part = list.slice(i, i + BATCH);
      const values = [];
      const tuples = part.map((r) => {
        const row = { graph_id: graphId, ...r };
        return `(${COLUMNS.map((c) => {
          values.push(row[c]);
          return `$${values.length}`;
        }).join(", ")})`;
      });
      await client.query(`INSERT INTO app.graph_nodes (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`, values);
    }
    await client.query(
      `INSERT INTO app.graph_index (graph_id, version, nodes) VALUES ($1, $2, $3)
       ON CONFLICT (graph_id) DO UPDATE SET version = excluded.version, nodes = excluded.nodes, indexed_at = now()`,
      [graphId, rows[0].version, list.length],
    );
    await client.query("COMMIT");
    return list.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * При запуске сервера: указатель графов, где он отстал от версии графа или
 * его нет, и без удалённых графов. Возвращает { graphs, nodes } или null.
 */
async function ensureGraphIndex(pool) {
  if (!(await indexReady(pool))) return null;
  const { rows } = await pool.query(
    `SELECT g.id FROM app.graphs g LEFT JOIN app.graph_index i ON i.graph_id = g.id
     WHERE (g.deleted_at IS NULL AND (i.graph_id IS NULL OR i.version <> g.version))
        OR (g.deleted_at IS NOT NULL AND i.graph_id IS NOT NULL)
     ORDER BY g.id`,
  );
  let nodes = 0;
  for (const r of rows) nodes += (await indexGraph(pool, r.id)) || 0;
  return { graphs: rows.length, nodes };
}

module.exports = { indexRows, indexGraph, ensureGraphIndex, indexReady, resetIndexReady };
