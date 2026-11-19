// routes/knowledge/product.js
//
// Карточка знаний о продукте (этап 3б PG-MIGRATION.md) — всё, что сервер о
// нём знает, одним ответом: первый инструмент чата («что за продукт»).
//
// Продукт узнаётся по ключам названия (productKeys: основы слов и написания
// из справочника синонимов) — как источники продукта, поэтому «Кумол»
// найдёт и разделы, и узлы графов, где написано «Изопропилбензол».
//
//   product      — названия (справочник синонимов, разделы ИТС, узлы
//                  графов), CAS, коды ОКПД2/ТН ВЭД (определённые моделью,
//                  data/product-codes.json), идентификаторы из графов;
//   sections     — разделы ИТС: где получают (up) и где он сырьё (down);
//   transformations — «сырьё → продукты» с ним: из разделов ИТС (связи
//                  разделов) и из преобразований графов;
//   balances     — готовые расчёты материального баланса с ним;
//   graphs       — графы библиотеки, где он есть, и его узлы там.
//
// Только PostgreSQL (база источников и библиотека графов в базе).

const localStore = require("../local-sources/utils/store");
const { productKey } = require("../local-sources/utils/query");
const { identify } = require("../industry/utils/synonyms");
const { savedCodes } = require("../industry/utils/modelCodes");
const { marks } = require("../../db/sql");
const { indexReady } = require("./graphIndex");

/** Сколько отдавать в списках: карточка — для модели, а не выгрузка базы. */
const LIMIT = 30;

const lower = (s) => String(s).toLowerCase().replace(/ё/g, "е");

/** Названия без повторов (без учёта регистра и ё), в порядке появления. */
function uniqueNames(list) {
  const seen = new Set();
  return list.filter((n) => n && !seen.has(lower(n)) && seen.add(lower(n)));
}

/**
 * Связи разделов: id раздела → { outputs, inputs } — продукты и сырьё по
 * названиям модели (заголовочные — если модель раздел не разобрала).
 */
async function sectionEnds(conn, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await conn.all(
    `SELECT section_id, label, role, origin FROM section_products
     WHERE section_id IN (${marks(ids)}) ORDER BY ${conn.rowid}`,
    ...ids,
  );
  const byModel = new Set(rows.filter((r) => r.origin === "model").map((r) => r.section_id));
  for (const r of rows) {
    if (byModel.has(r.section_id) && r.origin !== "model") continue;
    if (!out.has(r.section_id)) out.set(r.section_id, { outputs: [], inputs: [] });
    const e = out.get(r.section_id);
    if (r.role === "product" || r.role === "byproduct") e.outputs.push(r.label);
    else if (r.role === "raw") e.inputs.push(r.label);
  }
  for (const e of out.values()) {
    e.outputs = uniqueNames(e.outputs);
    e.inputs = uniqueNames(e.inputs);
  }
  return out;
}

/**
 * @param conn  адаптер PostgreSQL (db/sql.js) базы источников
 * @param pool  пул PostgreSQL (библиотека графов; null — без графов)
 */
async function productCard(conn, name, { pool = null } = {}) {
  const keys = localStore.productKeys(name);
  const ident = identify(name);
  if (!keys.length) return null;

  // ---------- разделы ИТС ----------
  const sources = await localStore.productSources(keys);
  const sectionIds = [...new Set([...sources.up, ...sources.down].map((s) => s.sectionId))];
  const ends = await sectionEnds(conn, sectionIds);
  const section = (s) => ({
    sectionId: s.sectionId,
    docTitle: s.docTitle,
    title: s.title,
    pages: s.pages,
    url: s.url,
    role: s.role,
    summary: s.summary,
  });
  const fromSections = [];
  for (const [dir, list] of [["up", sources.up], ["down", sources.down]]) {
    for (const s of list) {
      const e = ends.get(s.sectionId);
      if (!e || !e.outputs.length) continue;
      fromSections.push({
        direction: dir,
        sectionId: s.sectionId,
        source: `${s.docTitle} · ${s.title}`,
        inputs: e.inputs,
        outputs: e.outputs,
      });
    }
  }

  // ---------- названия из разделов ----------
  // Только от модели разбора: из заголовка название в падеже раздела
  // («Производство фенола» → «фенола»).
  const sectionLabels = (
    await conn.all(
      `SELECT DISTINCT label FROM section_products WHERE origin = 'model' AND key IN (${marks(keys)})`,
      ...keys,
    )
  ).map((r) => r.label);

  // ---------- графы ----------
  let graphs = [];
  let fromGraphs = [];
  let graphLabels = [];
  let ids = [];
  if (pool && (await indexReady(pool))) {
    const nodes = (
      await pool.query(
        `SELECT n.graph_id, g.name, n.node_id, n.label FROM app.graph_nodes n
         JOIN app.graphs g ON g.id = n.graph_id AND g.deleted_at IS NULL
         WHERE n.type = 'product' AND n.keys && $1::text[]
         ORDER BY g.updated_at DESC, n.graph_id, n.label`,
        [keys],
      )
    ).rows;
    const byGraph = new Map();
    for (const n of nodes) {
      if (!byGraph.has(n.graph_id)) byGraph.set(n.graph_id, { graphId: n.graph_id, name: n.name, nodes: [] });
      byGraph.get(n.graph_id).nodes.push({ id: n.node_id, label: n.label });
    }
    graphs = [...byGraph.values()];
    graphLabels = nodes.map((n) => n.label);

    // Преобразования графов с этим продуктом; одинаковые (то же название,
    // сырьё и продукты) из разных графов — одной строкой со списком графов.
    const trs = (
      await pool.query(
        `SELECT n.graph_id, g.name, n.node_id, n.label, n.inputs, n.outputs,
                n.in_keys && $1::text[] AS as_input, n.out_keys && $1::text[] AS as_output
         FROM app.graph_nodes n
         JOIN app.graphs g ON g.id = n.graph_id AND g.deleted_at IS NULL
         WHERE n.type = 'transformation' AND (n.in_keys && $1::text[] OR n.out_keys && $1::text[])
         ORDER BY g.updated_at DESC, n.label`,
        [keys],
      )
    ).rows;
    const seen = new Map();
    for (const t of trs) {
      const sig = [lower(t.label), ...t.inputs.map(lower).sort(), "→", ...t.outputs.map(lower).sort()].join("\u0000");
      if (!seen.has(sig)) {
        seen.set(sig, {
          direction: t.as_output ? "up" : "down",
          label: t.label,
          inputs: t.inputs,
          outputs: t.outputs,
          graphs: [],
        });
      }
      const e = seen.get(sig);
      if (!e.graphs.some((g) => g.graphId === t.graph_id)) {
        e.graphs.push({ graphId: t.graph_id, name: t.name, nodeId: t.node_id });
      }
    }
    fromGraphs = [...seen.values()];

    // Идентификаторы продукта, записанные в графах (CAS и др.).
    if (nodes.length) {
      const pairs = nodes.map((n) => [n.graph_id, n.node_id]);
      const { rows } = await pool.query(
        `SELECT data FROM app.graph_product_ids
         WHERE (graph_id, node_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
      const count = new Map();
      for (const r of rows) {
        const id = String(r.data?.productId ?? "").trim();
        if (!id) continue;
        const k = `${r.data.productIdSource || ""}\u0000${id}`;
        const c = count.get(k) ?? { id, source: r.data.productIdSource || null, label: r.data.productIdLabel || null, nodes: 0 };
        c.nodes++;
        count.set(k, c);
      }
      ids = [...count.values()].sort((a, b) => b.nodes - a.nodes);
    }
  }

  // ---------- расчёты баланса ----------
  const pk = JSON.stringify(productKey(name));
  const balances = (
    await conn.all(
      `SELECT id, title, status, created_at,
              CASE WHEN strpos(targets_key, ?) > 0 THEN 'target' ELSE 'input' END AS role
       FROM balances
       WHERE direction = 'down' AND (strpos(targets_key, ?) > 0 OR strpos(inputs_key, ?) > 0)
       ORDER BY created_at DESC, id DESC`,
      pk,
      pk,
      pk,
    )
  ).map((b) => ({ id: b.id, title: b.title, status: b.status, role: b.role, createdAt: b.created_at }));

  const canon = ident?.canon || null;
  return {
    product: {
      name,
      canon,
      cas: ident?.cas || null,
      names: uniqueNames([canon, ...(ident?.spellings ?? []), name, ...sectionLabels, ...graphLabels]).slice(0, LIMIT),
      codes: savedCodes(name) ?? (canon ? savedCodes(canon) : null),
      ids,
    },
    sections: { up: sources.up.slice(0, LIMIT).map(section), down: sources.down.slice(0, LIMIT).map(section) },
    transformations: { fromSections: fromSections.slice(0, LIMIT), fromGraphs: fromGraphs.slice(0, LIMIT) },
    balances: balances.slice(0, LIMIT),
    graphs: graphs.slice(0, LIMIT),
    counts: {
      sectionsUp: sources.up.length,
      sectionsDown: sources.down.length,
      graphTransformations: fromGraphs.length,
      balances: balances.length,
      graphs: graphs.length,
    },
  };
}

module.exports = { productCard };
