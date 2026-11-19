#!/usr/bin/env node
// scripts/chat-tools-probe.js — понимает ли шлюз модели инструменты (tools /
// function calling) в chat completions. Нужно для чата этапа 4
// PG-MIGRATION.md: модель сама зовёт карточку продукта и поиск по ИТС.
//
//   node scripts/chat-tools-probe.js                    — модели по умолчанию
//   node scripts/chat-tools-probe.js qwen3.8-flash      — свои, через пробел
//
// Каждой модели — два коротких запроса (вопрос → вызов инструмента →
// ответ по его результату), сотни токенов. Ключ — тот же, что у сервера
// (.env: QWEN_API_KEY, шлюз — QWEN_BASE_URL).
//
// Итог по модели: ✔ — вызвала инструмент и ответила по его данным;
// ✗ — шлюз или модель инструменты не принимают (тогда чат пойдёт на
// ответах по схеме JSON).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { getClient } = require("../routes/sources/utils/openai");

const DEFAULT_MODELS = [process.env.QWEN_MODEL || "qwen3.7-plus", "qwen3.8-flash", "deepseek-v4.1-flash"];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "product_card",
      description: "Что известно о продукте в базе сервера: CAS, коды, где его получают.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Название продукта" } },
        required: ["name"],
      },
    },
  },
];

const QUESTION = "Какой CAS у фенола? Узнай через инструмент product_card, не по памяти. Ответь одной строкой.";
// Нарочно не настоящий CAS фенола: так видно, что ответ — по инструменту.
const TOOL_RESULT = JSON.stringify({ name: "Фенол", cas: "000-00-1" });

async function probe(client, model) {
  const t0 = Date.now();
  const messages = [{ role: "user", content: QUESTION }];
  const first = await client.chat.completions.create({
    model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    enable_thinking: false,
  });
  const msg = first.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call) {
    return `✗ ${model}: инструмент не вызван — ответ текстом: «${String(msg?.content ?? "").slice(0, 120)}»`;
  }
  let args = {};
  try {
    args = JSON.parse(call.function?.arguments || "{}");
  } catch {
    // аргументы не JSON — скажем ниже
  }
  messages.push(msg, { role: "tool", tool_call_id: call.id, content: TOOL_RESULT });
  const second = await client.chat.completions.create({ model, messages, tools: TOOLS, enable_thinking: false });
  const text = String(second.choices?.[0]?.message?.content ?? "").trim();
  const usedTool = text.includes("000-00-1");
  const tokens = (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0);
  return (
    `${usedTool ? "✔" : "≈"} ${model}: вызвала ${call.function?.name}(${JSON.stringify(args)}), ` +
    `ответ ${usedTool ? "по данным инструмента" : "без них"}: «${text.slice(0, 100)}» — ${Date.now() - t0} мс` +
    (tokens ? `, токенов ${tokens}` : "")
  );
}

(async () => {
  let client;
  try {
    ({ client } = getClient("qwen"));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
  for (const model of models) {
    try {
      console.log(await probe(client, model));
    } catch (e) {
      const msg = String(e.message);
      const status = e.status && !msg.startsWith(String(e.status)) ? `${e.status} ` : "";
      console.log(`✗ ${model}: ${status}${msg.slice(0, 200)}`);
    }
  }
})();
