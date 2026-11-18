#!/usr/bin/env node
// scripts/migrate-graphs-to-pg.js — перенести библиотеку графов из файлов
// data/ в PostgreSQL (PG-MIGRATION.md, этап 1).
//
//   node scripts/migrate-graphs-to-pg.js --dry       — только отчёт: что и сколько перенесётся
//   node scripts/migrate-graphs-to-pg.js             — перенести и сверить
//   node scripts/migrate-graphs-to-pg.js --replace   — граф, что уже есть в базе, заменить файлом
//   --data=ПАПКА                                     — другой каталог данных (по умолчанию data/)
//
// Что переносится: графы (data/saved-graphs), закладки, история, расчёты
// баланса и идентификаторы продуктов рядом с ними, снимки «Поделиться»
// (data/shared-graphs), шаблон промпта (data/prompt-layout.json).
//
// Файлы НЕ удаляются и не меняются: откат — убрать GRAPH_STORE=pg из .env.
// Повторный запуск безопасен: граф, что уже в базе, пропускается.
// После записи всё читается из базы обратно и сверяется с файлами — в конце
// отчёт: сколько графов, узлов, закладок и что не сошлось.
//
// Подключение — как у сервера (DB_* из .env; DATABASE_URL главнее). Схема
// должна быть создана: npm run pg:migrate.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { Pool } = require("pg");
const { poolConfig } = require("../db/pool");
const { readFilesSnapshot, writeSnapshotToPg, readPgSnapshot, compareSnapshots, summarize } = require("../db/graphTransfer");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

function printSummary(title, s) {
  console.log(`${title}:`);
  console.log(`  графов ${s.graphs} (узлов ${s.nodes}; самый большой — ${s.biggest.id ?? "—"}, ${s.biggest.nodes})`);
  console.log(`  закладок ${s.bookmarks}, записей истории ${s.history}, расчётов баланса узлов ${s.balances}, идентификаторов ${s.productIds}`);
  console.log(`  снимков «Поделиться» ${s.shares}, настроек ${s.settings}`);
}

(async () => {
  const dataDir = path.resolve(arg("data") || path.join(__dirname, "../data"));
  const dry = flag("dry");
  const replace = flag("replace");

  const snap = await readFilesSnapshot(dataDir);
  printSummary(`Файлы (${dataDir})`, summarize(snap));
  for (const p of snap.problems) console.log(`  ⚠ ${p.where}: ${p.error} — не переносится`);

  const pool = new Pool(poolConfig());
  try {
    const { rows } = await pool.query("SELECT to_regclass('app.graphs') AS t");
    if (!rows[0].t) throw new Error("схемы app в базе нет — сначала npm run pg:migrate");

    const { rows: existing } = await pool.query("SELECT id FROM app.graphs WHERE deleted_at IS NULL");
    const inDb = new Set(existing.map((r) => r.id));
    const already = snap.graphs.filter((g) => inDb.has(g.id)).map((g) => g.id);
    if (dry) {
      const todo = snap.graphs.length - (replace ? 0 : already.length);
      console.log(`\nПробный прогон: в базу ушло бы графов ${todo}` + (already.length ? `; уже в базе ${already.length}${replace ? " — заменились бы файлом" : " — пропустились бы"}` : ""));
      return;
    }

    const written = await writeSnapshotToPg(pool, snap, { replace });
    console.log(`\nЗаписано графов: ${written.written.length}; пропущено (уже в базе): ${written.skipped.length}; снимков «Поделиться»: ${written.shares}; настроек: ${written.settings}`);

    // Сверка: всё, что в файлах, читаем из базы и сравниваем.
    const back = await readPgSnapshot(pool);
    const diff = compareSnapshots(snap, back);
    printSummary("\nВ базе после переноса", summarize(back));
    if (diff.length) {
      console.log(`\n✘ Не сошлось: ${diff.length}`);
      for (const d of diff) console.log(`  ${d.id}: ${d.what}`);
      if (written.skipped.length) console.log("  (пропущенные графы в базе — от прежнего переноса: --replace заменит их файлом)");
      process.exitCode = 1;
    } else {
      console.log("\n✔ Сверка: всё, что в файлах, в базе совпадает (без учёта порядка ключей)");
      console.log("Дальше: GRAPH_STORE=pg в .env и pm2 restart all. Откат — убрать строку и pm2 restart all.");
    }
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
