// routes/material-balance/material-balance.js
//
// Материальный баланс одного преобразования: сырьё → продукт, в одном из
// двух направлений — «вниз» (сколько продукта из 1 т сырья) или «вверх»
// (сколько сырья на 1 т продукта). Подробности — MATERIAL-BALANCE.md.
//
//   GET  /api/graphs/material-balance/prompt    промпт по умолчанию (правится на клиенте)
//   POST /api/graphs/material-balance/lookup    готовые расчёты пары в базе
//   POST /api/graphs/material-balance           запустить расчёт (или взять готовый)
//   GET  /api/graphs/material-balance/jobs/:id  ход расчёта
//   GET  /api/graphs/material-balance/:id       расчёт из базы
//
// Модель с веб-поиском считает минуты, поэтому расчёт идёт в фоне, а клиент
// спрашивает, готово ли. Ответ сохраняется в базу и тогда, когда клиент
// ушёл: следующий такой же запрос получит его сразу.

const crypto = require("crypto");
const express = require("express");

const router = express.Router();

const {
  callOpenAIResponsesRaw,
  extractOutputText,
} = require("../sources/utils/openai");
const {
  MATERIAL_BALANCE_SYSTEM,
  MATERIAL_BALANCE_USER_TEMPLATE,
  PLACEHOLDERS,
  BASIS_KG,
  DIRECTIONS,
  buildRefs,
  buildVars,
  fillPrompt,
} = require("./utils/prompt");
const { parseAnswer, cleanAnswer } = require("./utils/parse");
const store = require("./utils/store");
const jobs = require("./utils/jobs");

const MAX_KNOWN_DATA = 4000;
const MAX_PROMPT = 60000;

const text = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

/** Направление из запроса; не передано — «вниз», как считали всегда. */
const directionOf = (v) => (DIRECTIONS.includes(v) ? v : "down");

/** Узел из тела запроса: id и название обязательны, описание — нет. */
function node(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name, 300);
  if (!name) return null;
  return {
    id: text(raw.id, 200) || name,
    name,
    description: text(raw.description, 4000),
  };
}

/** Тело запроса расчёта → проверенный ввод или текст ошибки. */
function readInput(body) {
  const transformation = node(body?.transformation);
  const basis = node(body?.basis);
  const target = node(body?.target);
  if (!transformation) return { error: "Не передано преобразование (transformation.name)" };
  if (!basis) return { error: "Не передано сырьё (basis.name)" };
  if (!target) return { error: "Не передан продукт (target.name)" };
  if (basis.id === target.id) return { error: "Сырьё и продукт совпадают" };
  if (body?.direction !== undefined && !DIRECTIONS.includes(body.direction)) {
    return { error: `Направление расчёта — ${DIRECTIONS.join(" или ")}` };
  }
  const list = (v) => (Array.isArray(v) ? v.map(node).filter(Boolean).slice(0, 30) : []);
  const system = text(body?.system, MAX_PROMPT);
  const template = text(body?.template, MAX_PROMPT);
  return {
    input: {
      transformation,
      basis,
      target,
      direction: directionOf(body?.direction),
      inputs: list(body?.inputs),
      outputs: list(body?.outputs),
      knownData: text(body?.knownData, MAX_KNOWN_DATA),
      system: system && system !== MATERIAL_BALANCE_SYSTEM ? system : "",
      template: template && template !== MATERIAL_BALANCE_USER_TEMPLATE ? template : "",
      provider: text(body?.provider, 50) || undefined,
      model: text(body?.model, 100) || undefined,
      force: body?.force === true,
    },
  };
}

/** Один запрос к модели и разбор ответа; результат — запись базы. */
async function calculate(input) {
  const t0 = Date.now();
  const refs = buildRefs(input);
  const vars = buildVars(input, refs);
  const system = fillPrompt(input.system || MATERIAL_BALANCE_SYSTEM, vars);
  const user = fillPrompt(input.template || MATERIAL_BALANCE_USER_TEMPLATE, vars);

  const resp = await callOpenAIResponsesRaw({
    payload: {
      model: "gpt-5-mini",
      instructions: system,
      input: user,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "auto",
      reasoning: { effort: "medium" },
      truncation: "auto",
      // Ответ большой: таблицы, расчёт по переходам, блоки источников. У
      // рассуждающих моделей лимит делится с рассуждением.
      max_output_tokens: 16000,
    },
    timeoutMs: 25 * 60 * 1000,
    provider: input.provider,
    model: input.model,
  });

  if (resp?.status && resp.status !== "completed") {
    const why = resp?.incomplete_details?.reason;
    throw new Error(
      why === "max_output_tokens"
        ? "Ответ модели не уместился в лимит и оборвался — попробуйте другую модель"
        : `Модель не закончила ответ (status: ${resp.status})`,
    );
  }
  const answer = cleanAnswer(extractOutputText(resp));
  if (!answer) throw new Error("Модель вернула пустой ответ");

  const parsed = parseAnswer(answer, refs);
  if (parsed.status === "unknown") {
    const excerpt = answer.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Ответ модели не по шаблону: не найден статус расчёта. Начало ответа: «${excerpt}»`);
  }

  const id = store.save({
    transformation: input.transformation.name,
    basis: input.basis.name,
    target: input.target.name,
    direction: input.direction,
    answer,
    parsed,
    refs,
    knownData: input.knownData,
    customPrompt: Boolean(input.system || input.template),
    provider: input.provider || resp?.provider || null,
    model: resp?.model || input.model || null,
    tookMs: Date.now() - t0,
  });
  return store.get(id);
}

/**
 * Подпись запроса: одинаковые запросы, пока первый ещё считается, к модели
 * второй раз не идут — получают тот же расчёт.
 */
function signatureOf(input) {
  const names = (list) => list.map((n) => n.name).sort();
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        input.transformation.name,
        input.basis.name,
        input.target.name,
        input.direction,
        names(input.inputs),
        names(input.outputs),
        input.knownData,
        input.system,
        input.template,
        input.provider ?? "",
        input.model ?? "",
      ]),
    )
    .digest("hex");
}

router.get("/material-balance/prompt", (req, res) => {
  res.json({
    success: true,
    system: MATERIAL_BALANCE_SYSTEM,
    template: MATERIAL_BALANCE_USER_TEMPLATE,
    placeholders: PLACEHOLDERS,
    basisKg: BASIS_KG,
  });
});

router.post("/material-balance/lookup", (req, res) => {
  const transformation = text(req.body?.transformation?.name ?? req.body?.transformation, 300);
  const basis = text(req.body?.basis?.name ?? req.body?.basis, 300);
  const target = text(req.body?.target?.name ?? req.body?.target, 300);
  if (!transformation || !basis || !target) {
    return res
      .status(400)
      .json({ success: false, error: "Нужны transformation, basis и target" });
  }
  const direction = directionOf(req.body?.direction);
  try {
    res.json({
      success: true,
      ...store.lookup({ transformation, basis, target, direction }),
    });
  } catch (e) {
    console.error("[material-balance] lookup:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/material-balance", (req, res) => {
  const { input, error } = readInput(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    // Обычный запрос берёт готовый расчёт из базы. Свои данные или правка
    // промпта — просьба посчитать именно так, и готовое тут не подходит.
    if (!input.force && !input.knownData && !input.system && !input.template) {
      const { exact } = store.lookup({
        transformation: input.transformation.name,
        basis: input.basis.name,
        target: input.target.name,
        direction: input.direction,
      });
      if (exact) {
        return res.json({ success: true, fromCache: true, result: store.get(exact.id) });
      }
    }
    const job = jobs.start(signatureOf(input), () => calculate(input));
    res.json({ success: true, jobId: job.id, startedAt: new Date(job.startedAt).toISOString() });
  } catch (e) {
    console.error("[material-balance] start:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/material-balance/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({
      success: false,
      error:
        "Расчёт не найден: сервер перезапускался. Если модель успела ответить, " +
        "результат уже в базе — запустите расчёт ещё раз.",
    });
  }
  res.json({ success: true, job: jobs.view(job) });
});

router.get("/material-balance/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: "Неверный номер расчёта" });
  }
  try {
    const result = store.get(id);
    if (!result) return res.status(404).json({ success: false, error: "Расчёт не найден" });
    res.json({ success: true, result });
  } catch (e) {
    console.error("[material-balance] get:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
module.exports.calculate = calculate;
module.exports.readInput = readInput;
