// routes/knowledge/knowledge.js — слой знаний (этап 3 PG-MIGRATION.md).
//
//   POST /api/knowledge/search { q, limit?, product?, direction? }
//     → { success, results: [раздел с выдержкой] } — поиск по тексту
//       разделов ИТС (search.js);
//   POST /api/knowledge/product { name }
//     → { success, product, sections, transformations, balances, graphs,
//         counts } — карточка знаний о продукте (product.js).
//
// Только с SOURCES_STORE=pg; графы в карточке — с GRAPH_STORE=pg.
// Потребитель — чат с ИИ (этап 4): инструменты «где об этом написано» и
// «что за продукт».

const express = require("express");

const localStore = require("../local-sources/utils/store");
const { sourcesStoreKind } = require("../../db/sourcesDb");
const { chunksReady } = require("./chunks");
const { searchSections } = require("./search");
const { productCard } = require("./product");

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

router.post("/knowledge/product", async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 300);
  if (!name) return fail(res, 400, "name is required");
  if (sourcesStoreKind() !== "pg") {
    return fail(res, 501, "Карточка знаний работает с базой источников в PostgreSQL (SOURCES_STORE=pg).");
  }
  try {
    const conn = await localStore.connection();
    const pool = require("../graph-files/store").storeKind() === "pg" ? require("../../db/pool").getPool() : null;
    const card = await productCard(conn, name, { pool });
    if (!card) return fail(res, 400, "В названии нет слов, по которым искать.");
    res.json({ success: true, ...card });
  } catch (e) {
    console.error("[knowledge] карточка продукта:", e);
    fail(res, 500, e.message);
  }
});

module.exports = router;
