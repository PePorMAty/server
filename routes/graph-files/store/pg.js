// routes/graph-files/store/pg.js
//
// Хранилище библиотеки графов в PostgreSQL (GRAPH_STORE=pg; схема —
// db/migrations/001_graphs.sql, PG-MIGRATION.md, этап 1). Набор функций и
// ответы — те же, что у files.js: роуты и клиент разницы не видят.
//
// - Граф — документом jsonb, как файл: meta.version в нём совпадает с
//   колонкой version.
// - Сохранение — в транзакции с блокировкой строки: версия сверяется и
//   растёт атомарно, два сохранения подряд не теряют друг друга.
// - Прежние сохранения — в graph_revisions, последние revisionsKeep: место на
//   диске сервера ограничено.
// - Удаление мягкое (deleted_at): граф и всё рядом с ним можно вернуть.
// - actor — кто делает (этап 5: пользователь); пока null — «владелец».
//
// jsonb не хранит порядок ключей объекта: граф отдаётся с теми же данными, но
// ключи могут идти в другом порядке. Клиенту это безразлично; сверка переноса
// (scripts/migrate-graphs-to-pg.js) сравнивает без учёта порядка.

const { ConflictError, metaOf, versionOf, nodeCount } = require("./common");
const { HISTORY_LIMIT } = require("./files");

const json = (v) => JSON.stringify(v);
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

function createPgStore({ pool, revisionsKeep = Number(process.env.GRAPH_REVISIONS_KEEP) || 5 }) {
  /**
   * Транзакция. graphId — запись в данные этого графа: тогда она идёт по
   * очереди с остальными записями того же графа (рекомендательная блокировка
   * на время транзакции), как очередь на файл в files.js.
   *
   * Без очереди клиент ловил взаимную блокировку (deadlock): при сохранении
   * он шлёт сразу граф и идентификаторы продуктов, сервер после графа
   * чистит идентификаторы, а параллельный запрос их пишет — строки
   * блокировались в разном порядке (боевой сервер, 18.11).
   */
  async function tx(fn, graphId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (graphId != null) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(graphId)]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const bookmarkRow = (r) => ({
    graphId: r.graph_id,
    nodeId: r.node_id,
    label: r.label,
    kind: r.kind,
    note: r.note,
    createdAt: iso(r.created_at),
  });

  async function historyList(q, id, limit) {
    const { rows } = await q.query(
      "SELECT entry FROM app.graph_history WHERE graph_id = $1 ORDER BY seq DESC LIMIT $2",
      [id, limit],
    );
    return rows.map((r) => r.entry);
  }

  return {
    kind: "pg",

    // ---------- графы ----------
    async listGraphs() {
      const { rows } = await pool.query(
        `SELECT id, content->'meta' AS meta,
                CASE WHEN jsonb_typeof(content->'state'->'leaf_nodes') = 'array'
                     THEN jsonb_array_length(content->'state'->'leaf_nodes') ELSE 0 END AS leaf_count
           FROM app.graphs WHERE deleted_at IS NULL ORDER BY id`,
      );
      return rows.map((r) => metaOf(r.id, { meta: r.meta ?? {} }, r.leaf_count));
    },

    async getGraph(id) {
      const { rows } = await pool.query(
        "SELECT content, version FROM app.graphs WHERE id = $1 AND deleted_at IS NULL",
        [id],
      );
      if (!rows.length) return null;
      return { id, content: rows[0].content, version: Number(rows[0].version) };
    },

    async graphExists(id) {
      const { rowCount } = await pool.query("SELECT 1 FROM app.graphs WHERE id = $1 AND deleted_at IS NULL", [id]);
      return rowCount > 0;
    },

    async createGraph(id, content, { actor = null } = {}) {
      const next = { ...content, meta: { ...(content.meta ?? {}), version: 1 } };
      await pool.query(
        `INSERT INTO app.graphs (id, name, content, node_count, version, created_by, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, 1, $5, $5)`,
        [id, String(next.meta.name ?? id), json(next), nodeCount(next), actor],
      );
      return { id, content: next, version: 1 };
    },

    async updateGraph(id, update, { expectedVersion, bump = true, actor = null } = {}) {
      return tx(async (c) => {
        const { rows } = await c.query(
          "SELECT content, version FROM app.graphs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
          [id],
        );
        if (!rows.length) return null;
        const current = rows[0].content;
        const version = Number(rows[0].version);
        if (expectedVersion != null && Number(expectedVersion) !== version) {
          throw new ConflictError({ id, version, meta: metaOf(id, current) });
        }
        const updated = await update(current);
        const nextVersion = bump ? version + 1 : version;
        const next = { ...updated, meta: { ...(updated.meta ?? {}), version: nextVersion } };
        if (bump) {
          // Прежнее сохранение — в ревизии; старше revisionsKeep — долой.
          await c.query(
            `INSERT INTO app.graph_revisions (graph_id, version, content, saved_by)
             VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`,
            [id, version, json(current), actor],
          );
          await c.query(
            `DELETE FROM app.graph_revisions WHERE graph_id = $1 AND version NOT IN (
               SELECT version FROM app.graph_revisions WHERE graph_id = $1 ORDER BY version DESC LIMIT $2)`,
            [id, revisionsKeep],
          );
        }
        await c.query(
          `UPDATE app.graphs SET content = $2::jsonb, name = $3, node_count = $4, version = $5,
                  updated_by = $6, updated_at = now() WHERE id = $1`,
          [id, json(next), String(next.meta.name ?? id), nodeCount(next), nextVersion, actor],
        );
        return { id, content: next, version: nextVersion };
      }, id);
    },

    async deleteGraph(id) {
      return tx(async (c) => {
        const { rowCount } = await c.query(
          "UPDATE app.graphs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [id],
        );
        return rowCount > 0;
      }, id);
    },

    // ---------- закладки: свежие первыми ----------
    async listBookmarks(id) {
      const { rows } = await pool.query(
        "SELECT * FROM app.graph_bookmarks WHERE graph_id = $1 ORDER BY created_at DESC, node_id",
        [id],
      );
      return rows.map(bookmarkRow);
    },

    async upsertBookmark(id, nodeId, { label, kind, note }, { actor = null } = {}) {
      return tx(async (c) => {
        const { rows } = await c.query(
          "SELECT * FROM app.graph_bookmarks WHERE graph_id = $1 AND node_id = $2 FOR UPDATE",
          [id, nodeId],
        );
        if (rows.length) {
          // Пришедшие поля меняем, остальные (и created_at) оставляем.
          const r = await c.query(
            `UPDATE app.graph_bookmarks SET label = COALESCE($3, label), kind = COALESCE($4, kind),
                    note = COALESCE($5, note), updated_by = $6, updated_at = now()
              WHERE graph_id = $1 AND node_id = $2 RETURNING *`,
            [id, nodeId, label ?? null, kind ?? null, note ?? null, actor],
          );
          return { item: bookmarkRow(r.rows[0]), created: false };
        }
        const r = await c.query(
          `INSERT INTO app.graph_bookmarks (graph_id, node_id, label, kind, note, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [id, nodeId, label ?? "", kind ?? "product", note ?? "", actor],
        );
        return { item: bookmarkRow(r.rows[0]), created: true };
      }, id);
    },

    async deleteBookmark(id, nodeId) {
      return tx(async (c) => {
        const { rowCount } = await c.query(
          "DELETE FROM app.graph_bookmarks WHERE graph_id = $1 AND node_id = $2",
          [id, nodeId],
        );
        return rowCount > 0;
      }, id);
    },

    // ---------- история ----------
    listHistory: (id, limit = HISTORY_LIMIT) => historyList(pool, id, Math.min(limit, HISTORY_LIMIT)),

    async appendHistory(id, entries, { actor = null } = {}) {
      return tx(async (c) => {
        // По одной, в порядке событий: seq растёт — свежие с большим seq.
        for (const e of entries) {
          const at = Number.isNaN(Date.parse(e.at)) ? new Date() : new Date(e.at);
          await c.query(
            "INSERT INTO app.graph_history (graph_id, entry, user_id, at) VALUES ($1, $2::jsonb, $3, $4)",
            [id, json(e), actor, at],
          );
        }
        await c.query(
          `DELETE FROM app.graph_history WHERE graph_id = $1 AND seq NOT IN (
             SELECT seq FROM app.graph_history WHERE graph_id = $1 ORDER BY seq DESC LIMIT $2)`,
          [id, HISTORY_LIMIT],
        );
        return historyList(c, id, HISTORY_LIMIT);
      }, id);
    },

    async clearHistory(id) {
      await tx((c) => c.query("DELETE FROM app.graph_history WHERE graph_id = $1", [id]), id);
    },

    // ---------- расчёты баланса узлов ----------
    async getBalances(id) {
      const { rows } = await pool.query("SELECT node_id, calcs FROM app.graph_balances WHERE graph_id = $1", [id]);
      return Object.fromEntries(rows.map((r) => [r.node_id, Array.isArray(r.calcs) ? r.calcs : []]));
    },

    async putBalance(id, nodeId, calcs) {
      await tx(
        (c) =>
          c.query(
            `INSERT INTO app.graph_balances (graph_id, node_id, calcs) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (graph_id, node_id) DO UPDATE SET calcs = EXCLUDED.calcs, updated_at = now()`,
            [id, nodeId, json(calcs)],
          ),
        id,
      );
    },

    async clearBalances(id) {
      await tx((c) => c.query("DELETE FROM app.graph_balances WHERE graph_id = $1", [id]), id);
    },

    // ---------- идентификаторы продуктов узлов ----------
    async getProductIds(id) {
      const { rows } = await pool.query("SELECT node_id, data FROM app.graph_product_ids WHERE graph_id = $1", [id]);
      return Object.fromEntries(rows.map((r) => [r.node_id, r.data]));
    },

    async putProductIds(id, changes) {
      await tx(async (c) => {
        for (const [nodeId, entry] of changes) {
          if (entry === null) {
            await c.query("DELETE FROM app.graph_product_ids WHERE graph_id = $1 AND node_id = $2", [id, nodeId]);
          } else {
            await c.query(
              `INSERT INTO app.graph_product_ids (graph_id, node_id, data) VALUES ($1, $2, $3::jsonb)
               ON CONFLICT (graph_id, node_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
              [id, nodeId, json(entry)],
            );
          }
        }
      }, id);
    },

    async clearProductIds(id) {
      await tx((c) => c.query("DELETE FROM app.graph_product_ids WHERE graph_id = $1", [id]), id);
    },

    // ---------- снимки «Поделиться» ----------
    async shareExists(token) {
      const { rowCount } = await pool.query("SELECT 1 FROM app.shares WHERE id = $1", [token]);
      return rowCount > 0;
    },
    async getShare(token) {
      const { rows } = await pool.query("SELECT graph FROM app.shares WHERE id = $1", [token]);
      return rows.length ? rows[0].graph : null;
    },
    async createShare(token, data, { actor = null } = {}) {
      const { rowCount } = await pool.query(
        "INSERT INTO app.shares (id, graph, created_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT DO NOTHING",
        [token, json(data), actor],
      );
      return rowCount > 0;
    },

    // ---------- настройки ----------
    async getSetting(key) {
      const { rows } = await pool.query("SELECT value FROM app.settings WHERE key = $1", [key]);
      return rows.length ? rows[0].value : null;
    },
    async putSetting(key, value) {
      await pool.query(
        `INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, json(value)],
      );
    },
  };
}

module.exports = { createPgStore, versionOf };
