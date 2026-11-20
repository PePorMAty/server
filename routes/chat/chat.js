// routes/chat/chat.js — чат с ИИ в открытом графе (этап 4 PG-MIGRATION.md).
//
//   POST /api/graphs/gpt/chat
//     { message, history: [{ role: "user"|"assistant", content }],
//       graph: срез открытого графа (graphSlice.js), provider?, model?,
//       proposals?: ["step", "show", "codes", …] — какие карточки предложений
//       умеет клиент (tools.js); без поля — шаг и показ, как в первой версии;
//       mode?: "confirm" | "auto" — с подтверждением (по умолчанию) или
//       автопилот: сайт выполняет действия сам и присылает итог;
//       continuation?: true — это итог автопилота, а не слова человека }
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
// Граф чат не меняет: действия (tools.js) уходят клиенту — карточками или,
// в автопилоте, на выполнение.
//
// До первого запроса к модели сервер собирает справку (context.js): узлы,
// упомянутые в сообщении, и выбранный узел — быстрая модель часто не
// вызывает инструменты и отвечает по памяти. После ответа — страховка: модель
// пишет «показал», «добавил», не вызвав действия (20.11, qwen3.8-flash), —
// ей один раз возвращают ответ переделать.

const express = require("express");

const { callChatTools } = require("../sources/utils");
const { sourcesStoreKind } = require("../../db/sourcesDb");
const { readGraphSlice } = require("./graphSlice");
const { chatSystemPrompt } = require("./prompt");
const { toolsFor, runTool, readKinds, DEFAULT_KINDS } = require("./tools");
const { prefetchContext } = require("./context");

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

/**
 * Глаголы «сделал» и «делаю» — модель утверждает, что действие выполнено
 * или выполняется. Настоящее время — тоже (20.11, автопилот на
 * qwen3.8-flash: «Делаю перераскладку графа», «Раскладываю граф заново»,
 * «строю шаг вверх» — одним запросом, без вызова), и «готово». Будущее
 * («запущу») — нет: это обещание, а не утверждение.
 */
const CLAIMS = [
  "показал", "отобразил", "выделил", "добавил", "построил", "достроил", "переименовал", "объединил",
  "рассчитал", "посчитал", "запустил", "определил", "удалил", "разложил", "заполнил", "выполнен",
  "делаю", "строю", "достраиваю", "раскладываю", "запускаю", "добавляю", "удаляю", "показываю",
  "рассчитываю", "считаю баланс", "переименовываю", "объединяю", "заполняю", "готово",
];
const CLAIM_RE = new RegExp(`(^|[^а-я])(${CLAIMS.join("|")})(а|и|о|ы)?(?![а-я])`, "g");

/**
 * Первое «сделал» в ответе; null — утверждений нет. Не считаются «не
 * сделал» и «вы (уже) сделали» — о человеке, который добавил шаг сам.
 */
function claimedAction(reply) {
  const text = String(reply ?? "").toLowerCase().replace(/ё/g, "е");
  for (const m of text.matchAll(CLAIM_RE)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length);
    if (/(^|[^а-я])(не|вы(\s+уже)?)\s*$/.test(before)) continue;
    return m[2] + (m[3] ?? "");
  }
  return null;
}

/**
 * Какое действие модель описала словами — по её ответу. На поправку её
 * заставляют вызвать именно его (tool_choice): быстрая модель после
 * простой поправки снова писала «Прошу прощения — теперь по-настоящему:
 * готово», ничего не вызвав (20.11). Порядок — от частного к общему:
 * «добавил в закладки» — закладки, а не новый продукт.
 */
const CLAIMED_TOOL = [
  [/заклад/, "bookmark_nodes"],
  [/альтернатив/, "find_alternatives"],
  [/описани[ея][^.]*(запис|заполн)|(запис|заполн)[^.]*описани/, "set_description"],
  [/карточк[^.]*заполн|заполн[^.]*карточк/, "fill_card"],
  [/источник/, "find_sources"],
  [/расклад/, "relayout"],
  [/баланс/, "propose_balance"],
  [/переимен/, "propose_rename"],
  [/объедин/, "propose_merge"],
  [/удал/, "delete_nodes"],
  [/добав[^.]*продукт|продукт[^.]*добав|добавил[^.]*на граф|добавлен[^.]*на граф/, "add_product"],
  [/шаг/, "propose_step"],
  [/показ|отобраз|выдел/, "show_nodes"],
];

function claimedTool(reply, available) {
  const text = String(reply ?? "").toLowerCase().replace(/ё/g, "е");
  const found = CLAIMED_TOOL.find(([re, name]) => available.has(name) && re.test(text));
  return found ? found[1] : null;
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
async function runChat(
  { message, history, slice, provider, model, signal, kinds = DEFAULT_KINDS, mode = "confirm", continuation = false },
  emit = () => {},
  bases = {},
) {
  const proposals = [];
  const tools = [];
  const usage = { requests: 0, tokens: 0 };
  let usedModel = model || null;
  const ctx = { slice, kinds, provider, model, signal, ...bases };
  const toolDefs = toolsFor(kinds);
  const t0 = Date.now();

  // Справка — в системный промпт: второе системное сообщение посреди
  // разговора не все модели шлюза понимают.
  const pre = await prefetchContext(slice, message, { runTool, ctx });
  for (const step of pre.steps) {
    tools.push(step);
    emit({ type: "tool", ...step });
  }
  const system = chatSystemPrompt(slice, kinds, { mode });
  const messages = [
    { role: "system", content: pre.text ? `${system}\n\n${pre.text}` : system },
    ...history,
    { role: "user", content: message },
  ];
  let corrected = null;
  // Следующий круг — с обязательным вызовом этого действия (после поправки).
  let forceTool = null;
  let forced = null;
  const available = new Set(toolDefs.map((t) => t.function.name));

  for (let round = 0; ; round++) {
    const last = round >= MAX_ROUNDS;
    const r = await callChatTools({
      messages,
      tools: toolDefs,
      toolChoice: last ? "none" : forceTool ? { type: "function", function: { name: forceTool } } : "auto",
      provider,
      model,
      signal,
    });
    usage.requests++;
    forceTool = null;
    usage.tokens += r.usage?.total_tokens ?? 0;
    usedModel = r.model || usedModel;
    const calls = last ? [] : r.message?.tool_calls ?? [];
    if (!calls.length) {
      let reply = String(r.message?.content ?? "").trim();
      // «Показал» без действия: на графе ничего не произошло. Один раз
      // возвращаем ответ — модель вызовет инструмент или ответит честно.
      // Итог автопилота — не тот случай: «добавил» там правда.
      const claimed = !continuation && !proposals.length && !corrected && !last ? claimedAction(reply) : null;
      if (claimed) {
        corrected = claimed;
        forceTool = claimedTool(reply, available);
        forced = forceTool;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "user",
          content: `Проверка сервера: в ответе «${claimed}», но ты не вызвал ни одного действия — на графе ничего не произошло. Нужно действие — вызови инструмент. Нельзя — ответь заново и не пиши, что сделал.`,
        });
        continue;
      }
      if (r.finishReason === "length") reply += "\n\n…(ответ оборван: модель упёрлась в предел длины — спросите короче)";
      const done = {
        type: "done",
        reply,
        proposals,
        tools,
        usage,
        model: usedModel,
      };
      // Строка в лог pm2: по ней видно, смотрела ли модель базу и граф.
      const called = tools.filter((t) => !t.summary?.startsWith("справка")).map((t) => t.name);
      console.log(
        `[chat] ${usedModel} · ${mode}${continuation ? " · итог автопилота" : ""}: запросов ${usage.requests}, справка ${pre.steps.length}, инструменты: ${called.join(", ") || "—"}, действий ${proposals.length}${corrected ? `, поправка «${corrected}» без действия${forced ? ` (обязательный ${forced})` : ""}` : ""}${r.finishReason && r.finishReason !== "stop" ? `, конец: ${r.finishReason}` : ""}, ${Date.now() - t0} мс`,
      );
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
      // Инструменты, которые сами спрашивают модель (check_steps), — в счётчик.
      usage.requests += out.requests ?? 0;
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
  const kinds = readKinds(req.body?.proposals);
  const mode = req.body?.mode === "auto" ? "auto" : "confirm";
  const continuation = req.body?.continuation === true;

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
    await runChat({ message, history, slice, provider, model, kinds, mode, continuation, signal: controller.signal }, emit, bases);
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
module.exports.claimedAction = claimedAction;
module.exports.claimedTool = claimedTool;
