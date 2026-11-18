#!/usr/bin/env node
// scripts/migrate-sources-to-pg.js — перенести базу источников и расчёты
// баланса из SQLite в PostgreSQL (PG-MIGRATION.md, этап 2).
//
//   node scripts/migrate-sources-to-pg.js --dry       — только отчёт: что и сколько перенесётся
//   node scripts/migrate-sources-to-pg.js             — перенести и сверить
//   node scripts/migrate-sources-to-pg.js --replace   — в базе уже есть — заменить данными из SQLite
//   --sources=ПАПКА      — база источников не в data/local-sources/
//   --balance-db=ФАЙЛ    — расчёты баланса не в data/material-balance.sqlite
//
// Что переносится: документы, разделы и их связи с продуктами
// (data/local-sources/sources.sqlite), готовые расчёты баланса и записи о
// копиях веб-источников (data/material-balance.sqlite). Номера документов,
// разделов и расчётов — прежние: на них ссылаются сохранённые графы.
// Найденное моделью раньше (web_sources) не переносится — оно с 29.10 не
// отдаётся.
//
// Файлы НЕ удаляются и не меняются: PDF и копии страниц остаются где были,
// откат — убрать SOURCES_STORE=pg из .env. После записи всё читается из базы
// обратно и сверяется с SQLite.
//
// Переносить лучше с остановленным сервером (pm2 stop all): разбор разделов
// моделью и новые расчёты иначе допишутся в SQLite уже после переноса.
//
// Подключение — как у сервера (DB_* из .env; DATABASE_URL главнее). Схема
// должна быть создана: npm run pg:migrate.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { Pool } = require("pg");
const { poolConfig } = require("../db/pool");
const {
  readSqliteSnapshot,
  writeSnapshotToPg,
  readPgSnapshot,
  compareSnapshots,
  summarize,
  pgCounts,
  sqlitePaths,
} = require("../db/sourcesTransfer");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

function printSummary(title, s) {
  const st = Object.entries(s.sectionsByStatus)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  console.log(`${title}:`);
  console.log(`  документов ${s.documents}, разделов ${s.sections}${st ? ` (${st})` : ""}, связей с продуктами ${s.links}`);
  console.log(`  расчётов баланса ${s.balances}, копий веб-источников ${s.webDocuments}, служебных отметок ${s.meta}`);
}

(async () => {
  const paths = {
    sourcesDir: arg("sources") ? path.resolve(arg("sources")) : undefined,
    balanceDb: arg("balance-db") ? path.resolve(arg("balance-db")) : undefined,
  };
  const { sourcesFile, balanceFile } = sqlitePaths(paths);
  const dry = flag("dry");
  const replace = flag("replace");

  const snap = await readSqliteSnapshot(paths);
  const sum = summarize(snap);
  printSummary(`SQLite (${sourcesFile}, ${balanceFile})`, sum);
  if (sum.webSourcesSkipped) {
    console.log(`  найденного моделью (web_sources, не отдаётся с 29.10) — ${sum.webSourcesSkipped}: не переносится`);
  }

  const pool = new Pool(poolConfig());
  try {
    const { rows } = await pool.query("SELECT to_regclass('app.documents') AS t");
    if (!rows[0].t) throw new Error("таблиц этапа 2 в базе нет — сначала npm run pg:migrate");

    const counts = await pgCounts(pool);
    const busy = Object.entries(counts).filter(([, n]) => n > 0);
    if (dry) {
      console.log(
        `\nПробный прогон: в PostgreSQL ушло бы всё перечисленное выше.` +
          (busy.length
            ? ` В базе уже есть данные (${busy.map(([t, n]) => `${t} ${n}`).join(", ")}) — ` +
              (replace ? "заменились бы." : "перенос откажется без --replace.")
            : ""),
      );
      return;
    }

    await writeSnapshotToPg(pool, snap, { replace });
    const back = await readPgSnapshot(pool);
    const diffs = compareSnapshots(snap, back);
    printSummary("\nPostgreSQL после переноса", summarize(back));
    if (diffs.length) {
      console.log("\n✗ Сверка: не совпало");
      for (const d of diffs) console.log(`  ${d.table}: ${d.problem}`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✔ Сверка: всё, что в SQLite, в базе совпадает (строка в строку, в том же порядке)");
    console.log("Дальше: SOURCES_STORE=pg в .env и pm2 restart all (или pm2 start all, если сервер остановлен).");
    console.log("Откат — убрать строку и pm2 restart all (новое из базы прежде выгрузить: node scripts/export-sources-from-pg.js).");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
