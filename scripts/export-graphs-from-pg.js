#!/usr/bin/env node
// scripts/export-graphs-from-pg.js — выгрузить библиотеку графов из
// PostgreSQL в файлы в формате data/ (обратный перенос, PG-MIGRATION.md, этап 1).
//
//   node scripts/export-graphs-from-pg.js                     — в новую папку pg-export-<время>/
//   node scripts/export-graphs-from-pg.js --out=ПАПКА         — в свою папку
//   node scripts/export-graphs-from-pg.js --out=data          — откат: база → data/ (перезаписывает графы из базы)
//   --prune                                                   — с --out=data: убрать файлы графов, удалённых в базе
//
// Когда нужно:
// - откат с базы на файлы, если в базе уже успели что-то сохранить: выгрузить
//   в data/, убрать GRAPH_STORE=pg из .env, pm2 restart all;
// - посмотреть, что лежит в базе, глазами — в отдельную папку.
//
// После записи выгруженное читается обратно и сверяется с базой.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { Pool } = require("pg");
const { poolConfig } = require("../db/pool");
const { readPgSnapshot, writeSnapshotToFiles, readFilesSnapshot, compareSnapshots, summarize } = require("../db/graphTransfer");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(path.join(__dirname, ".."), arg("out") || `pg-export-${stamp}`);
  const prune = process.argv.includes("--prune");
  const pool = new Pool(poolConfig());
  try {
    const snap = await readPgSnapshot(pool);
    const s = summarize(snap);
    console.log(`В базе: графов ${s.graphs} (узлов ${s.nodes}), закладок ${s.bookmarks}, записей истории ${s.history}, расчётов ${s.balances}, идентификаторов ${s.productIds}, снимков ${s.shares}`);
    if (snap.deleted.length) console.log(`Удалены в базе (мягко): ${snap.deleted.join(", ")}${prune ? "" : " — их файлы не трогаем (--prune уберёт)"}`);

    const r = await writeSnapshotToFiles(out, snap, { prune });
    console.log(`Выгружено в ${out}: графов ${r.written}${r.pruned.length ? `; убраны файлы удалённых: ${r.pruned.join(", ")}` : ""}`);

    // Сверка: выгруженное читаем из файлов и сравниваем с базой.
    const back = await readFilesSnapshot(out);
    const diff = compareSnapshots(snap, back);
    if (diff.length) {
      console.log(`✘ Не сошлось: ${diff.length}`);
      for (const d of diff) console.log(`  ${d.id}: ${d.what}`);
      process.exitCode = 1;
    } else {
      console.log("✔ Сверка: выгруженное совпадает с базой");
    }
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
