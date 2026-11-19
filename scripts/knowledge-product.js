#!/usr/bin/env node
// scripts/knowledge-product.js — карточка знаний о продукте прямо на сервере
// (этап 3б PG-MIGRATION.md), без curl и кавычек: название — словами через
// пробел.
//
//   node scripts/knowledge-product.js Фенол
//   node scripts/knowledge-product.js оксид этилена
//
// То же, что отдаёт POST /api/knowledge/product, но читаемо: названия, коды,
// разделы ИТС, преобразования (из разделов и графов), расчёты баланса, графы.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const store = require("../routes/local-sources/utils/store");
const { productCard } = require("../routes/knowledge/product");
const { sourcesStoreKind, sourcesPool } = require("../db/sourcesDb");

const arrow = (t) => `${t.inputs.join(", ") || "?"} → ${t.outputs.join(", ") || "?"}`;

(async () => {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.log("Название продукта — словами через пробел: node scripts/knowledge-product.js оксид этилена");
    return;
  }
  if (sourcesStoreKind() !== "pg") {
    console.error("Карточка знаний — только с базой источников в PostgreSQL (SOURCES_STORE=pg в .env).");
    process.exitCode = 1;
    return;
  }
  try {
    const conn = await store.connection();
    const pool = process.env.GRAPH_STORE === "pg" ? require("../db/pool").getPool() : null;
    const t0 = Date.now();
    const c = await productCard(conn, name, { pool });
    if (!c) throw new Error("в названии нет слов, по которым искать");
    const p = c.product;
    console.log(`«${name}» — карточка за ${Date.now() - t0} мс\n`);
    console.log(`Названия: ${p.names.join(", ")}`);
    if (p.cas) console.log(`CAS: ${p.cas}`);
    if (p.codes?.okpd2) console.log(`ОКПД2: ${p.codes.okpd2.code} ${p.codes.okpd2.name}`);
    if (p.codes?.tnved) console.log(`ТН ВЭД: ${p.codes.tnved.display || p.codes.tnved.code} ${p.codes.tnved.name}`);
    for (const id of p.ids) console.log(`Идентификатор из графов: ${id.id} (${id.source || "?"}, узлов ${id.nodes})`);
    const n = c.counts;
    console.log(`\nРазделы ИТС: где получают — ${n.sectionsUp}, где сырьё — ${n.sectionsDown}`);
    for (const t of c.transformations.fromSections.slice(0, 8)) {
      console.log(`  ${t.direction === "up" ? "↑" : "↓"} ${arrow(t)}  [${t.source}]`);
    }
    console.log(`\nПреобразования в графах: ${n.graphTransformations}`);
    for (const t of c.transformations.fromGraphs.slice(0, 8)) {
      console.log(`  ${t.direction === "up" ? "↑" : "↓"} ${t.label}: ${arrow(t)}  [графов ${t.graphs.length}]`);
    }
    console.log(`\nРасчёты баланса: ${n.balances}`);
    for (const b of c.balances.slice(0, 5)) console.log(`  №${b.id} ${b.title} (${b.status})`);
    console.log(`\nГрафы с продуктом: ${n.graphs}`);
    for (const g of c.graphs.slice(0, 8)) console.log(`  ${g.name} — узлов ${g.nodes.length}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sourcesPool().end().catch(() => {});
  }
})();
