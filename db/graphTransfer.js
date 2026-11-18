// db/graphTransfer.js
//
// Перенос библиотеки графов между файлами data/ и PostgreSQL (этап 1
// PG-MIGRATION.md) — для scripts/migrate-graphs-to-pg.js и
// scripts/export-graphs-from-pg.js.
//
// Оба направления идут через «снимок» — всё, что лежит в библиотеке:
//   { graphs: [{ id, content, bookmarks, history, balances, productIds }],
//     shares: [{ id, data }], settings: { key: value }, problems: [] }
// Снимок читается из одного места, пишется в другое, потом читается
// обратно и сверяется с исходным без учёта порядка ключей (jsonb его не
// хранит): отчёт показывает, совпало ли всё.
//
// Даты сохраняются: createdAt/updatedAt графа, время закладок, записей
// истории и расчётов — те, что были, а не время переноса.

const fs = require("fs/promises");
const path = require("path");

const { versionOf, nodeCount } = require("../routes/graph-files/store/common");

const SIDECARS = {
  bookmarks: "bookmarks",
  history: "history",
  balances: "material-balances",
  productIds: "product-ids",
};

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}
const sidecarFile = (dataDir, kind, id) => path.join(dataDir, SIDECARS[kind], `${id.replace(/\.json$/i, "")}.json`);
const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const dateOr = (v, fallback = new Date()) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : fallback);
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// ---------- файлы → снимок ----------
async function readFilesSnapshot(dataDir) {
  const snap = { graphs: [], shares: [], settings: {}, problems: [] };
  const graphDir = path.join(dataDir, "saved-graphs");
  const files = (await fs.readdir(graphDir).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  for (const id of files) {
    try {
      const content = await readJson(path.join(graphDir, id));
      if (!content || typeof content !== "object") throw new Error("не объект JSON");
      const bm = await readJson(sidecarFile(dataDir, "bookmarks", id));
      const hi = await readJson(sidecarFile(dataDir, "history", id));
      const ba = await readJson(sidecarFile(dataDir, "balances", id));
      const pi = await readJson(sidecarFile(dataDir, "productIds", id));
      snap.graphs.push({
        id,
        content,
        bookmarks: Array.isArray(bm?.items) ? bm.items : [],
        history: Array.isArray(hi?.entries) ? hi.entries : [],
        balances: objectOr(ba?.items),
        productIds: objectOr(pi?.items),
      });
    } catch (e) {
      snap.problems.push({ where: `saved-graphs/${id}`, error: e.message });
    }
  }
  const shareDir = path.join(dataDir, "shared-graphs");
  for (const f of (await fs.readdir(shareDir).catch(() => [])).filter((x) => x.endsWith(".json")).sort()) {
    try {
      snap.shares.push({ id: f.replace(/\.json$/, ""), data: await readJson(path.join(shareDir, f)) });
    } catch (e) {
      snap.problems.push({ where: `shared-graphs/${f}`, error: e.message });
    }
  }
  const layout = await readJson(path.join(dataDir, "prompt-layout.json")).catch((e) => {
    snap.problems.push({ where: "prompt-layout.json", error: e.message });
    return null;
  });
  if (layout) snap.settings["prompt-layout"] = layout;
  return snap;
}

// ---------- снимок → PostgreSQL ----------
/**
 * Записать снимок в базу. Граф, который в базе уже есть (и не удалён), —
 * пропускается, с replace — заменяется целиком со всем, что рядом. Каждый
 * граф — своей транзакцией. Возвращает { written: [], skipped: [] }.
 */
async function writeSnapshotToPg(pool, snap, { replace = false } = {}) {
  const result = { written: [], skipped: [], shares: 0, settings: 0 };
  const json = (v) => JSON.stringify(v);
  for (const g of snap.graphs) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT deleted_at FROM app.graphs WHERE id = $1 FOR UPDATE", [g.id]);
      if (rows.length && !rows[0].deleted_at && !replace) {
        await client.query("ROLLBACK");
        result.skipped.push(g.id);
        continue;
      }
      // Удалённый в базе граф с тем же id (или replace) — заменяем начисто:
      // всё рядом с ним уходит каскадом.
      if (rows.length) await client.query("DELETE FROM app.graphs WHERE id = $1", [g.id]);
      const version = versionOf(g.content);
      const content = { ...g.content, meta: { ...(g.content.meta ?? {}), version } };
      const created = dateOr(g.content.meta?.createdAt);
      await client.query(
        `INSERT INTO app.graphs (id, name, content, node_count, version, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [g.id, String(content.meta.name ?? g.id), json(content), nodeCount(content), version, created, dateOr(g.content.meta?.updatedAt, created)],
      );
      for (const b of g.bookmarks) {
        if (!b?.nodeId) continue;
        await client.query(
          `INSERT INTO app.graph_bookmarks (graph_id, node_id, label, kind, note, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT DO NOTHING`,
          [g.id, String(b.nodeId), b.label ?? "", b.kind ?? "product", b.note ?? "", dateOr(b.createdAt)],
        );
      }
      // В файле история — свежие первыми; в базе свежие — с большим seq.
      for (const e of [...g.history].reverse()) {
        await client.query("INSERT INTO app.graph_history (graph_id, entry, at) VALUES ($1, $2::jsonb, $3)", [g.id, json(e), dateOr(e?.at)]);
      }
      for (const [nodeId, e] of Object.entries(g.balances)) {
        await client.query(
          "INSERT INTO app.graph_balances (graph_id, node_id, calcs, updated_at) VALUES ($1, $2, $3::jsonb, $4)",
          [g.id, nodeId, json(Array.isArray(e?.calcs) ? e.calcs : []), dateOr(e?.updatedAt)],
        );
      }
      for (const [nodeId, data] of Object.entries(g.productIds)) {
        await client.query("INSERT INTO app.graph_product_ids (graph_id, node_id, data) VALUES ($1, $2, $3::jsonb)", [g.id, nodeId, json(data)]);
      }
      await client.query("COMMIT");
      result.written.push(g.id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`граф ${g.id}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  for (const s of snap.shares) {
    const r = await pool.query(
      `INSERT INTO app.shares (id, graph, created_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO ${replace ? "UPDATE SET graph = EXCLUDED.graph" : "NOTHING"}`,
      [s.id, json(s.data), dateOr(s.data?.meta?.createdAt)],
    );
    result.shares += r.rowCount;
  }
  for (const [key, value] of Object.entries(snap.settings)) {
    const r = await pool.query(
      `INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO ${replace ? "UPDATE SET value = EXCLUDED.value, updated_at = now()" : "NOTHING"}`,
      [key, json(value)],
    );
    result.settings += r.rowCount;
  }
  return result;
}

// ---------- PostgreSQL → снимок ----------
async function readPgSnapshot(pool, { ids = null } = {}) {
  const snap = { graphs: [], shares: [], settings: {}, problems: [], deleted: [] };
  const { rows: graphs } = await pool.query(
    `SELECT id, content, deleted_at FROM app.graphs ${ids ? "WHERE id = ANY($1)" : ""} ORDER BY id`,
    ids ? [ids] : [],
  );
  for (const g of graphs) {
    if (g.deleted_at) {
      snap.deleted.push(g.id);
      continue;
    }
    const q = (sql) => pool.query(sql, [g.id]).then((r) => r.rows);
    const bookmarks = (await q("SELECT * FROM app.graph_bookmarks WHERE graph_id = $1 ORDER BY created_at DESC, node_id")).map((r) => ({
      graphId: r.graph_id,
      nodeId: r.node_id,
      label: r.label,
      kind: r.kind,
      note: r.note,
      createdAt: iso(r.created_at),
    }));
    const history = (await q("SELECT entry FROM app.graph_history WHERE graph_id = $1 ORDER BY seq DESC")).map((r) => r.entry);
    const balances = Object.fromEntries(
      (await q("SELECT node_id, calcs, updated_at FROM app.graph_balances WHERE graph_id = $1")).map((r) => [
        r.node_id,
        { calcs: r.calcs, updatedAt: iso(r.updated_at) },
      ]),
    );
    const productIds = Object.fromEntries(
      (await q("SELECT node_id, data FROM app.graph_product_ids WHERE graph_id = $1")).map((r) => [r.node_id, r.data]),
    );
    snap.graphs.push({ id: g.id, content: g.content, bookmarks, history, balances, productIds });
  }
  if (!ids) {
    snap.shares = (await pool.query("SELECT id, graph FROM app.shares ORDER BY id")).rows.map((r) => ({ id: r.id, data: r.graph }));
    for (const r of (await pool.query("SELECT key, value FROM app.settings")).rows) snap.settings[r.key] = r.value;
  }
  return snap;
}

// ---------- снимок → файлы ----------
/** Записать снимок в каталог данных (формат data/). prune — убрать файлы удалённых в базе графов. */
async function writeSnapshotToFiles(dataDir, snap, { prune = false } = {}) {
  const now = new Date().toISOString();
  for (const g of snap.graphs) {
    await writeJson(path.join(dataDir, "saved-graphs", g.id), g.content);
    const side = async (kind, key, value, empty) => {
      const file = sidecarFile(dataDir, kind, g.id);
      if (empty) await fs.rm(file, { force: true });
      else await writeJson(file, { graphId: g.id, updatedAt: now, [key]: value });
    };
    await side("bookmarks", "items", g.bookmarks, !g.bookmarks.length);
    await side("history", "entries", g.history, !g.history.length);
    await side("balances", "items", g.balances, !Object.keys(g.balances).length);
    await side("productIds", "items", g.productIds, !Object.keys(g.productIds).length);
  }
  for (const s of snap.shares) await writeJson(path.join(dataDir, "shared-graphs", `${s.id}.json`), s.data);
  if (snap.settings["prompt-layout"]) await writeJson(path.join(dataDir, "prompt-layout.json"), snap.settings["prompt-layout"]);
  const pruned = [];
  if (prune) {
    for (const id of snap.deleted ?? []) {
      const file = path.join(dataDir, "saved-graphs", id);
      if (await readJson(file).catch(() => null)) {
        await fs.rm(file, { force: true });
        for (const kind of Object.keys(SIDECARS)) await fs.rm(sidecarFile(dataDir, kind, id), { force: true });
        pruned.push(id);
      }
    }
  }
  return { written: snap.graphs.length, pruned };
}

// ---------- сверка ----------
/** JSON с ключами по алфавиту — сравнение без учёта порядка (jsonb его не хранит). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Сверить снимки по графам: [{ id, what }] — что не совпало. */
function compareSnapshots(source, target, { ignoreTimestamps = false } = {}) {
  const diff = [];
  const byId = new Map(target.graphs.map((g) => [g.id, g]));
  const withVersion = (c) => ({ ...c, meta: { ...(c?.meta ?? {}), version: versionOf(c) } });
  const balancesOf = (b) =>
    Object.fromEntries(Object.entries(b).map(([k, e]) => [k, ignoreTimestamps ? { calcs: e?.calcs ?? [] } : { calcs: e?.calcs ?? [], updatedAt: e?.updatedAt }]));
  const bookmarksOf = (list) => list.map(({ graphId, ...b }) => ({ ...b, graphId: graphId ?? null }));
  for (const g of source.graphs) {
    const t = byId.get(g.id);
    if (!t) {
      diff.push({ id: g.id, what: "нет в цели" });
      continue;
    }
    if (canonical(withVersion(g.content)) !== canonical(withVersion(t.content))) diff.push({ id: g.id, what: "граф" });
    // Порядок закладок в базе — по времени создания; в файле — порядок
    // вставки (тот же, если время не правили руками): сверяем без порядка.
    const bm = (l) =>
      bookmarksOf(l)
        .map((b) => ({ ...b, graphId: g.id }))
        .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
    if (canonical(bm(g.bookmarks)) !== canonical(bm(t.bookmarks))) diff.push({ id: g.id, what: "закладки" });
    if (canonical(g.history) !== canonical(t.history)) diff.push({ id: g.id, what: "история" });
    if (canonical(balancesOf(g.balances)) !== canonical(balancesOf(t.balances))) diff.push({ id: g.id, what: "расчёты баланса" });
    if (canonical(g.productIds) !== canonical(t.productIds)) diff.push({ id: g.id, what: "идентификаторы" });
  }
  const tShares = new Map(target.shares.map((s) => [s.id, s.data]));
  for (const s of source.shares) {
    if (!tShares.has(s.id) || canonical(s.data) !== canonical(tShares.get(s.id))) diff.push({ id: `share:${s.id}`, what: "снимок «Поделиться»" });
  }
  for (const [k, v] of Object.entries(source.settings)) {
    if (canonical(v) !== canonical(target.settings[k])) diff.push({ id: `setting:${k}`, what: "настройка" });
  }
  return diff;
}

/** Сводка снимка для отчёта. */
function summarize(snap) {
  const sum = (f) => snap.graphs.reduce((n, g) => n + f(g), 0);
  return {
    graphs: snap.graphs.length,
    nodes: sum((g) => nodeCount(g.content)),
    bookmarks: sum((g) => g.bookmarks.length),
    history: sum((g) => g.history.length),
    balances: sum((g) => Object.keys(g.balances).length),
    productIds: sum((g) => Object.keys(g.productIds).length),
    shares: snap.shares.length,
    settings: Object.keys(snap.settings).length,
    biggest: snap.graphs.reduce((m, g) => (nodeCount(g.content) > m.nodes ? { id: g.id, nodes: nodeCount(g.content) } : m), { id: null, nodes: 0 }),
  };
}

module.exports = {
  readFilesSnapshot,
  writeSnapshotToPg,
  readPgSnapshot,
  writeSnapshotToFiles,
  compareSnapshots,
  summarize,
  canonical,
};
