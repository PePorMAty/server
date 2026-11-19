// routes/knowledge/knowledge.js — слой знаний (этап 3 PG-MIGRATION.md).
//
//   POST /api/knowledge/search { q, limit?, product?, direction? }
//     → { success, results: [раздел с выдержкой] } — поиск по тексту
//       разделов ИТС (search.js). Только с SOURCES_STORE=pg.
//
// Первый потребитель — чат с ИИ (этап 4): инструмент «где об этом написано».

const express = require("express");

const localStore = require("../local-sources/utils/store");
const { sourcesStoreKind } = require("../../db/sourcesDb");
const { chunksReady } = require("./chunks");
const { searchSections } = require("./search");

const router = express.Router();

const fail = (res, status, error) => res.status(status).json({ success: false, error });

router.post("/knowledge/search", async (req, res) => {
  const q = String(req.body?.q ?? "").trim().slice(0, 300);
  if (!q) return fail(res, 400, "q is required");
  const limit = Math.min(30, Math.max(1, Math.trunc(Number(req.body?.limit)) || 10));
  const product = String(req.body?.product ?? "").trim().slice(0, 300);
  const direction = ["up", "down"].includes(req.body?.direction) ? req.body.direction : null;
  if (sourcesStoreKind() !== "pg") {
    return fail(res, 501, "Поиск по тексту разделов работает с базой источников в PostgreSQL (SOURCES_STORE=pg).");
  }
  try {
    const conn = await localStore.connection();
    if (!(await chunksReady(conn))) {
      return fail(res, 503, "Таблицы поиска нет — выполните `npm run pg:migrate` и перезапустите сервер.");
    }
    res.json({ success: true, results: await searchSections(conn, q, { limit, product, direction }) });
  } catch (e) {
    console.error("[knowledge] поиск:", e);
    fail(res, 500, e.message);
  }
});

module.exports = router;
