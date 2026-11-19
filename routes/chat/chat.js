// routes/chat/chat.js — чат с ИИ в открытом графе (этап 4 PG-MIGRATION.md).
//
//   POST /api/graphs/gpt/chat
//     { message, history: [{ role: "user"|"assistant", content }],
//       graph: срез открытого графа (graphSlice.js), provider?, model? }
//   → поток строк JSON (NDJSON), по событию на строку:
//     { type: "tool", name, args, summary }      — модель смотрит базу/граф
//     { type: "proposal", proposal }             — предложение человеку
//     { type: "done", reply, proposals, tools, usage: { requests, tokens }, model }
//     { type: "error", error }
//
// Цикл: модель → инструменты → модель, не больше MAX_ROUNDS кругов; на
// последнем круге инструменты выключены — модель обязана ответить. Поток —
// чтобы человек видел ход («смотрю карточку «Фенол»»): ответ модели с
// кругами идёт десятки секунд. X-Accel-Buffering: no — nginx отдаёт строки
// сразу, а не копит до конца.
//
// Граф чат не меняет: предложения (tools.js) уходят клиенту карточками.

const express = require("express");

const { callChatTools } = require("../sources/utils");
const { sourcesStoreKind } = require("../../db/sourcesDb");
const { readGraphSlice } = require("./graphSlice");
const { chatSystemPrompt } = require("./prompt");
const { TOOLS, runTool } = require("./tools");

const router = express.Router();

/** Кругов «модель → инструменты» на одно сообщение. */
const MAX_ROUNDS = 4;
const MAX_HISTORY = 12;
const MAX_MESSAGE = 4000;

/** Последние реплики разговора — только текст, без инструментов. */
function readHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
}

function parseArgs(raw) {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Базы для инструментов: источники и библиотека графов в PostgreSQL. */
async function knowledgeBases() {
  if (sourcesStoreKind() !== "pg") return {};
  const conn = await require("../local-sources/utils/store").connection();
  const pool = require("../graph-files/store").storeKind() === "pg" ? require("../../db/pool").getPool() : null;
  return { conn, pool };
}

/**
 * Разговор на одно сообщение. emit(event) — события потока.
 * Возвращает итог (то же, что событие done).
 */
async function runChat({ message, history, slice, provider, model, signal }, emit = () => {}, bases = {}) {
  const messages = [
    { role: "system", content: chatSystemPrompt(slice) },
    ...history,
    { role: "user", content: message },
  ];
  const proposals = [];
  const tools = [];
  const usage = { requests: 0, tokens: 0 };
  let usedModel = model || null;
  const ctx = { slice, ...bases };

  for (let round = 0; ; round++) {
    const last = round >= MAX_ROUNDS;
    const r = await callChatTools({
      messages,
      tools: TOOLS,
      toolChoice: last ? "none" : "auto",
      provider,
      model,
      signal,
    });
    usage.requests++;
    usage.tokens += r.usage?.total_tokens ?? 0;
    usedModel = r.model || usedModel;
    const calls = last ? [] : r.message?.tool_calls ?? [];
    if (!calls.length) {
      const done = {
        type: "done",
        reply: String(r.message?.content ?? "").trim(),
        proposals,
        tools,
        usage,
        model: usedModel,
      };
      emit(done);
      return done;
    }
    // Ответ модели с вызовами — в разговор как есть: следующий круг видит,
    // что она спросила, и ответы инструментов по их id.
    messages.push({ role: "assistant", content: r.message.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      let out;
      try {
        out = await runTool(name, args, ctx);
      } catch (e) {
        console.error(`[chat] инструмент ${name}:`, e.message);
        out = { result: { error: `Инструмент не сработал: ${e.message}` }, summary: `${name} — ошибка` };
      }
      const step = { name, args, summary: out.summary };
      tools.push(step);
      emit({ type: "tool", ...step });
      if (out.proposal) {
        proposals.push(out.proposal);
        emit({ type: "proposal", proposal: out.proposal });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.result) });
    }
  }
}

router.post("/gpt/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim().slice(0, MAX_MESSAGE);
  if (!message) return res.status(400).json({ success: false, error: "message is required" });
  const history = readHistory(req.body?.history);
  const slice = readGraphSlice(req.body?.graph);
  const provider = req.body?.provider ? String(req.body.provider).trim() : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const controller = new AbortController();
  // Человек закрыл чат или ушёл со страницы — запрос к модели не нужен.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const emit = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const bases = await knowledgeBases().catch((e) => {
      console.warn("[chat] база знаний недоступна:", e.message);
      return {};
    });
    await runChat({ message, history, slice, provider, model, signal: controller.signal }, emit, bases);
  } catch (e) {
    if (!controller.signal.aborted) {
      console.error("[chat] ошибка:", e.message);
      emit({ type: "error", error: e.message });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
module.exports.runChat = runChat;
module.exports.MAX_ROUNDS = MAX_ROUNDS;
