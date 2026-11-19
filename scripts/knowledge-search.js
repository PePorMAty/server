#!/usr/bin/env node
// scripts/knowledge-search.js — проверить поиск по тексту разделов прямо на
// сервере (этап 3а PG-MIGRATION.md), без curl, кавычек и порта.
//
//   node scripts/knowledge-search.js                          — сводка: разделов и кусков
//   node scripts/knowledge-search.js расходные нормы этилена  — поиск, слова через пробел
//
// Кавычки и «--» не нужны нарочно: телефон и некоторые редакторы меняют их
// на «ёлочки» и тире, и терминал команду не понимает.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const store = require("../routes/local-sources/utils/store");
const { chunksReady } = require("../routes/knowledge/chunks");
const { searchSections } = require("../routes/knowledge/search");
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
    const q = process.argv.slice(2).join(" ").trim();
    if (!q) {
      const n = await conn.get(
        `SELECT (SELECT CAST(COUNT(*) AS INTEGER) FROM sections) AS sections,
                (SELECT CAST(COUNT(DISTINCT section_id) AS INTEGER) FROM section_chunks) AS cut,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM section_chunks) AS chunks`,
      );
      console.log(`Разделов ${n.sections}, нарезано ${n.cut}, кусков ${n.chunks}.`);
      if (n.cut < n.sections) console.log("Не все разделы нарезаны — перезапустите сервер или node scripts/knowledge-rebuild.js");
      console.log("Поиск: node scripts/knowledge-search.js слова через пробел");
      return;
    }
    const t0 = Date.now();
    const results = await searchSections(conn, q, { limit: 5 });
    console.log(`«${q}» — найдено ${results.length} за ${Date.now() - t0} мс\n`);
    for (const r of results) {
      console.log(`• ${r.docTitle} · ${r.title} (${r.pages})${r.match === "some" ? " — часть слов" : ""}`);
      console.log(`  ${r.excerpt.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sourcesPool().end().catch(() => {});
  }
})();
