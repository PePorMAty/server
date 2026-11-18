#!/usr/bin/env node
// scripts/embeddings-probe.js — какие модели эмбеддингов (векторов смысла
// текста) доступны нашим ключам. Нужно для этапа 3 PG-MIGRATION.md: слой
// знаний и поиск по смыслу.
//
//   node scripts/embeddings-probe.js
//
// Каждой модели уходит один запрос со словом «фенол» — это доли копейки.
// Тариф DashScope (Token Plan) открывает не все модели (qwen-plus, например,
// нашему ключу недоступна), поэтому проверяем на деле, а не по документации.
// Ключи — те же, что у сервера (.env: QWEN_API_KEY, GPT_API_KEY); ключ не
// задан — провайдер пропускается.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { getClient } = require("../routes/sources/utils/openai");

const CANDIDATES = [
  { provider: "qwen", model: "text-embedding-v4" },
  { provider: "qwen", model: "text-embedding-v3" },
  { provider: "openai", model: "text-embedding-3-small" },
];

(async () => {
  for (const { provider, model } of CANDIDATES) {
    let client;
    try {
      client = getClient(provider);
    } catch (e) {
      console.log(`– ${provider} ${model}: пропущено (${e.message})`);
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await client.embeddings.create({ model, input: "фенол" });
      const dims = r.data?.[0]?.embedding?.length;
      console.log(
        `✔ ${provider} ${model}: работает, размер вектора ${dims}, ${Date.now() - t0} мс` +
          (r.usage?.total_tokens ? `, токенов ${r.usage.total_tokens}` : ""),
      );
    } catch (e) {
      const status = e.status ? `${e.status} ` : "";
      console.log(`✗ ${provider} ${model}: ${status}${String(e.message).slice(0, 200)}`);
    }
  }
})();
