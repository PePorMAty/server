#!/usr/bin/env node
// scripts/export-sources-from-pg.js — выгрузить базу источников и расчёты
// баланса из PostgreSQL обратно в SQLite (откат этапа 2 PG-MIGRATION.md).
//
//   node scripts/export-sources-from-pg.js --dry   — только отчёт
//   node scripts/export-sources-from-pg.js         — выгрузить и сверить
//   --sources=ПАПКА      — база источников не в data/local-sources/
//   --balance-db=ФАЙЛ    — расчёты баланса не в data/material-balance.sqlite
//
// Нужен, если с SOURCES_STORE=pg что-то добавилось (документы, разборы,
// расчёты), а вернуться надо на SQLite: без выгрузки это новое останется
// только в базе. Прежние файлы SQLite не удаляются — переименовываются в
// <файл>.before-export-<время>. После выгрузки — убрать SOURCES_STORE=pg из
// .env и pm2 restart all. Выгружать с остановленным сервером (pm2 stop all).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { Pool } = require("pg");
const { poolConfig } = require("../db/pool");
const {
  readPgSnapshot,
  writeSnapshotToSqlite,
  readSqliteSnapshot,
  compareSnapshots,
  summarize,
  sqlitePaths,
} = require("../db/sourcesTransfer");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const paths = {
    sourcesDir: arg("sources") ? path.resolve(arg("sources")) : undefined,
    balanceDb: arg("balance-db") ? path.resolve(arg("balance-db")) : undefined,
  };
  const pool = new Pool(poolConfig());
  try {
    const snap = await readPgSnapshot(pool);
    const s = summarize(snap);
    console.log(
      `PostgreSQL: документов ${s.documents}, разделов ${s.sections}, связей ${s.links}, ` +
        `расчётов баланса ${s.balances}, копий веб-источников ${s.webDocuments}`,
    );
    const { sourcesFile, balanceFile } = sqlitePaths(paths);
    if (flag("dry")) {
      console.log(`\nПробный прогон: записалось бы в ${sourcesFile} и ${balanceFile} (прежние — в сторону).`);
      return;
    }
    const { kept } = await writeSnapshotToSqlite(snap, paths);
    for (const k of kept) console.log(`  прежний файл сохранён: ${k}`);
    const back = await readSqliteSnapshot(paths);
    const diffs = compareSnapshots(snap, back);
    if (diffs.length) {
      console.log("\n✗ Сверка: не совпало");
      for (const d of diffs) console.log(`  ${d.table}: ${d.problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n✔ Выгружено и сверено: ${sourcesFile}, ${balanceFile}`);
    console.log("Дальше: убрать SOURCES_STORE=pg из .env и pm2 restart all.");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
