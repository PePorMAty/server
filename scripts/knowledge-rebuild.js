#!/usr/bin/env node
// scripts/knowledge-rebuild.js — пересобрать куски всех разделов для поиска
// по тексту (этап 3а PG-MIGRATION.md).
//
//   node scripts/knowledge-rebuild.js
//
// Обычно не нужен: сервер сам режет разделы при записи и разборе, а при
// запуске достраивает недостающие. Нужен, если куски испортились или их
// надо пересобрать сразу, не дожидаясь перезапуска. Только SOURCES_STORE=pg.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const store = require("../routes/local-sources/utils/store");
const { rebuildSectionChunks, chunksReady } = require("../routes/knowledge/chunks");
const { sourcesStoreKind, sourcesPool } = require("../db/sourcesDb");

(async () => {
  if (sourcesStoreKind() !== "pg") {
    console.error("Поиск по тексту — только с базой источников в PostgreSQL (SOURCES_STORE=pg в .env).");
    process.exitCode = 1;
    return;
  }
  try {
    const conn = await store.connection();
    if (!(await chunksReady(conn))) throw new Error("таблицы кусков нет — сначала npm run pg:migrate");
    const ids = (await conn.all("SELECT id FROM sections ORDER BY id")).map((r) => r.id);
    const t0 = Date.now();
    let chunks = 0;
    for (const id of ids) chunks += await conn.tx((t) => rebuildSectionChunks(t, [id]));
    console.log(`✔ Разделов ${ids.length}, кусков ${chunks}, за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sourcesPool().end().catch(() => {});
  }
})();
