#!/usr/bin/env node
// scripts/chat-try.js — спросить чат прямо на сервере, до панели на сайте
// (этап 4 PG-MIGRATION.md): живая модель, настоящие база знаний и графы.
// Без кавычек: вопрос — словами через пробел.
//
//   node scripts/chat-try.js из чего делают фенол
//   node scripts/chat-try.js граф:Фенол из чего делают кумол
//   node scripts/chat-try.js модель:deepseek-v4.1-flash граф:Фенол дострой фенол вниз
//
// граф:Название — открытый граф из библиотеки (как будто он открыт на
// сайте); модель:имя — модель DashScope (по умолчанию qwen3.8-flash).
// Запросы к модели настоящие: обычно 2–3 на вопрос, число — в конце.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { runChat } = require("../routes/chat/chat");
const { readGraphSlice } = require("../routes/chat/graphSlice");
const { indexRows } = require("../routes/knowledge/graphIndex");
const { sourcesStoreKind, sourcesPool } = require("../db/sourcesDb");

(async () => {
  const words = process.argv.slice(2);
  const opt = (prefix) => {
    const w = words.find((x) => x.startsWith(prefix));
    return w ? w.slice(prefix.length) : null;
  };
  const graphName = opt("граф:");
  const model = opt("модель:") || "qwen3.8-flash";
  const question = words.filter((w) => !w.startsWith("граф:") && !w.startsWith("модель:")).join(" ").trim();
  if (!question) {
    console.log("Вопрос — словами через пробел: node scripts/chat-try.js граф:Фенол из чего делают кумол");
    return;
  }
  try {
    let graph = {};
    if (graphName) {
      const store = require("../routes/graph-files/store").getStore();
      const meta = (await store.listGraphs()).find((g) => g.name.toLowerCase() === graphName.toLowerCase());
      if (!meta) throw new Error(`в библиотеке нет графа «${graphName}»`);
      // Хранилище отдаёт { id, content, version }; граф — в content.
      const { content } = await store.getGraph(meta.id);
      const rows = indexRows(content);
      graph = {
        name: meta.name,
        products: rows.filter((r) => r.type === "product").map((r) => ({ id: r.node_id, label: r.label })),
        transformations: rows
          .filter((r) => r.type === "transformation")
          .map((r) => ({ id: r.node_id, label: r.label, inputs: r.inputs, outputs: r.outputs })),
      };
    }
    let bases = {};
    if (sourcesStoreKind() === "pg") {
      bases = {
        conn: await require("../routes/local-sources/utils/store").connection(),
        pool: process.env.GRAPH_STORE === "pg" ? require("../db/pool").getPool() : null,
      };
    }
    console.log(`Модель ${model}${graph.name ? `, граф «${graph.name}»` : ", без графа"}\n«${question}»\n`);
    const t0 = Date.now();
    const done = await runChat(
      { message: question, history: [], slice: readGraphSlice(graph), provider: "qwen", model },
      (e) => {
        if (e.type === "tool") console.log(`  … ${e.summary}`);
        if (e.type === "proposal") {
          const p = e.proposal;
          console.log(p.kind === "step" ? `  ➜ предложение: шаг ${p.direction === "up" ? "вверх" : "вниз"} от «${p.label}» — ${p.why}` : `  ➜ показать: ${p.nodes.map((n) => n.label).join(", ")}`);
        }
      },
      bases,
    );
    console.log(`\n${done.reply}\n`);
    console.log(`Запросов к модели: ${done.usage.requests}, токенов: ${done.usage.tokens}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sourcesPool().end().catch(() => {});
  }
})();
