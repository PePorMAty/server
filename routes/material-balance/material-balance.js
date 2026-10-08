// routes/material-balance/material-balance.js
//
// Материальный баланс преобразования целиком: всё его сырьё и выбранные
// продукты, на количество опорного сырья, которое задал человек. Каждый
// продукт модель считает отдельно, а запрос и запись в базе — одни на
// преобразование. Подробности — MATERIAL-BALANCE.md.
//
//   GET  /api/graphs/material-balance/prompt    промпт по умолчанию (правится на клиенте)
//   POST /api/graphs/material-balance/lookup    готовые расчёты в базе
//   POST /api/graphs/material-balance           запустить расчёт (или взять готовый)
//   GET  /api/graphs/material-balance/jobs/:id  ход расчёта
//   POST /api/graphs/material-balance/jobs/:id/cancel  отменить расчёт
//   GET  /api/graphs/material-balance/sources/:id/text|file  копия веб-источника
//   GET  /api/graphs/material-balance/:id       расчёт из базы
//
// Модель с веб-поиском считает минуты, поэтому расчёт идёт в фоне, а клиент
// спрашивает, готово ли. Ответ сохраняется в базу и тогда, когда клиент
// ушёл: следующий такой же запрос получит его сразу.
//
// Разделы ИТС и других документов базы источников уходят модели первыми
// (utils/local.js); веб-источники ответа сервер загружает и проверяет сам и
// при неудаче просит модель их заменить (utils/sources.js).

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
  UNITS,
  basisAmount,
  buildRefs,
  buildVars,
  fillPrompt,
} = require("./utils/prompt");
const { productKey } = require("../local-sources/utils/query");
const { parseAnswer, cleanAnswer } = require("./utils/parse");
const { findLocalSources, localBlock, localChecks, localKey } = require("./utils/local");
const { checkSources, checkLines, applyChecks } = require("./utils/sources");
const store = require("./utils/store");
const jobs = require("./utils/jobs");

const MAX_KNOWN_DATA = 4000;
const MAX_PROMPT = 60000;

const text = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

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

const MAX_NODES = 30;

const nodes = (v) => (Array.isArray(v) ? v.map(node).filter(Boolean).slice(0, MAX_NODES) : []);

/** Без повторов по id: первый остаётся. */
function uniq(list, taken = new Set()) {
  return list.filter((n) => !taken.has(n.id) && taken.add(n.id));
}

/**
 * Тело запроса расчёта → проверенный ввод или текст ошибки.
 *
 *   transformation  преобразование
 *   inputs          всё его сырьё
 *   outputs         все его продукты
 *   targets         id продуктов, для которых считать (нет — все)
 *   basis           { id, amount, unit } — опорное сырьё и его количество
 *
 * Прежний вид — пара: basis и target узлами, на 1 т сырья. Его шлёт клиент
 * прежней версии; это тот же расчёт с одним продуктом.
 */
function readInput(body) {
  const transformation = node(body?.transformation);
  if (!transformation) return { error: "Не передано преобразование (transformation.name)" };
  let inputs = nodes(body?.inputs);
  let outputs = nodes(body?.outputs);
  let targets;
  let basis;
  if (body?.target && !Array.isArray(body?.targets)) {
    const b = node(body?.basis);
    const t = node(body?.target);
    if (!b) return { error: "Не передано сырьё (basis.name)" };
    if (!t) return { error: "Не передан продукт (target.name)" };
    if (b.id === t.id) return { error: "Сырьё и продукт совпадают" };
    inputs = [b, ...inputs];
    outputs = [t, ...outputs];
    targets = [t.id];
    basis = { id: b.id, ...basisAmount(1, "т") };
  } else {
    targets = Array.isArray(body?.targets) ? body.targets.map((id) => text(id, 200)) : null;
    const amount = basisAmount(body?.basis?.amount, text(body?.basis?.unit, 10));
    if (!amount) {
      return {
        error: `Неверное количество сырья: нужно положительное число и единица ${UNITS.map((u) => `«${u}»`).join(", ")} (basis.amount, basis.unit)`,
      };
    }
    basis = { id: text(body?.basis?.id, 200), ...amount };
  }
  // Продукт, нарисованный и входом, и выходом, — вход.
  inputs = uniq(inputs);
  outputs = uniq(outputs, new Set(inputs.map((n) => n.id)));
  if (!inputs.length) return { error: "Не передано сырьё преобразования (inputs)" };
  if (!outputs.length) return { error: "Не переданы продукты преобразования (outputs)" };
  targets = outputs.filter((n) => !targets || targets.includes(n.id)).map((n) => n.id);
  if (!targets.length) return { error: "Не выбран ни один продукт для расчёта (targets)" };
  if (!inputs.some((n) => n.id === basis.id)) {
    return { error: "Количество задано не для сырья этого преобразования (basis.id)" };
  }
  const system = text(body?.system, MAX_PROMPT);
  const template = text(body?.template, MAX_PROMPT);
  return {
    input: {
      transformation,
      inputs,
      outputs,
      targets,
      basis,
      knownData: text(body?.knownData, MAX_KNOWN_DATA),
      system: system && system !== MATERIAL_BALANCE_SYSTEM ? system : "",
      template: template && template !== MATERIAL_BALANCE_USER_TEMPLATE ? template : "",
      provider: text(body?.provider, 50) || undefined,
      model: text(body?.model, 100) || undefined,
      force: body?.force === true,
    },
  };
}

/** Сырьё запроса: опорное первым — так оно встанет в базе. */
function inputNames(input) {
  const ref = input.inputs.find((n) => n.id === input.basis.id);
  return [ref, ...input.inputs.filter((n) => n !== ref)].map((n) => n.name);
}

const targetNames = (input) =>
  input.outputs.filter((n) => input.targets.includes(n.id)).map((n) => n.name);

/**
 * Узлы запроса по обозначениям готового расчёта: сырьё — среди сырья,
 * продукты — среди продуктов, по справочнику (productKey). Расчёт из базы
 * мог быть сделан на другом графе — там у узлов свои id.
 */
function matchRefs(refs, input) {
  const out = {};
  const used = new Set();
  const pick = (list, name) => {
    const key = productKey(name);
    const lower = String(name).trim().toLowerCase();
    const hit =
      list.find((n) => !used.has(n.id) && productKey(n.name) === key) ??
      list.find((n) => !used.has(n.id) && n.name.trim().toLowerCase() === lower);
    if (hit) used.add(hit.id);
    return hit;
  };
  for (const r of refs) {
    if (!/^P\d+$/.test(r.ref)) continue;
    const list = r.role === "basis" || r.role === "input" ? input.inputs : input.outputs;
    const hit = pick(list, r.name);
    if (hit) out[r.ref] = hit.id;
  }
  out.T1 = input.transformation.id;
  return out;
}

/** Второй запрос к модели: не больше одного; MB_SOURCE_RETRY=0 — без него. */
const RETRY = process.env.MB_SOURCE_RETRY !== "0";

/** Один запрос к модели — ответ без обёрток. messages — переписка. */
async function ask(input, system, messages, { signal }) {
  const resp = await callOpenAIResponsesRaw({
    payload: {
      model: "gpt-5-mini",
      instructions: system,
      input: messages.length === 1 ? messages[0].content : messages,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "auto",
      reasoning: { effort: "medium" },
      truncation: "auto",
      // Ответ большой: таблицы, расчёт по преобразованию, блоки источников.
      // У рассуждающих моделей лимит делится с рассуждением.
      max_output_tokens: 20000,
    },
    timeoutMs: 25 * 60 * 1000,
    provider: input.provider,
    model: input.model,
    signal,
  });
  if (signal?.aborted) throw new Error("Расчёт отменён");
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
  return { answer, resp };
}

/** Ответ без статуса — не по шаблону. */
function notTemplate(answer) {
  const excerpt = answer.replace(/\s+/g, " ").slice(0, 300);
  return new Error(`Ответ модели не по шаблону: не найден статус расчёта. Начало ответа: «${excerpt}»`);
}

/** Источники проверяем, только когда модель что-то посчитала. */
const checkable = (parsed) => !["invalid_selection", "invalid_basis"].includes(parsed.status);

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/**
 * Расчёт целиком; результат — запись базы. signal обрывает запросы:
 * отменённый расчёт в базу не пишется.
 *
 * 1. Модель считает: документы базы источников (ИТС) — в запросе первыми.
 * 2. Сервер загружает веб-источники ответа, проверяет в их тексте числа,
 *    сохраняет копии (sources.js).
 * 3. Какие-то не загрузились — второй запрос: тот же разговор и итоги
 *    проверки (SERVER_SOURCE_CHECKS); модель заменяет их и пересчитывает.
 *    Новые источники снова проверяются. Второй запрос не удался — остаётся
 *    первый ответ с отметками проверки.
 */
async function calculate(input, { signal, setStage = () => {} } = {}) {
  const t0 = Date.now();
  const refs = buildRefs(input);
  const local = input.local || [];
  const vars = buildVars(input, refs, { checks: localChecks(local) });
  const system = fillPrompt(input.system || MATERIAL_BALANCE_SYSTEM, vars);
  const block = localBlock(local);
  const user = `${fillPrompt(input.template || MATERIAL_BALANCE_USER_TEMPLATE, vars)}${block ? `\n\n${block}` : ""}`;

  setStage(
    local.length
      ? `Модель считает: ${local.length} ${plural(local.length, "раздел", "раздела", "разделов")} из базы источников и поиск в интернете`
      : "Модель ищет источники в интернете и считает",
  );
  const first = await ask(input, system, [{ role: "user", content: user }], { signal });
  let answer = first.answer;
  let resp = first.resp;
  let parsed = parseAnswer(answer, refs);
  if (parsed.status === "unknown") throw notTemplate(answer);

  if (checkable(parsed) && parsed.sources.length) {
    const progress = (label) => (done, total) =>
      total && setStage(`${label}: ${done} из ${total}`);
    let checks = await checkSources(parsed.sources, {
      signal,
      onProgress: progress("Сервер загружает и проверяет источники"),
    });
    let rounds = 1;
    const failed = checks.filter((c) => c.status === "failed");
    if (failed.length && RETRY) {
      setStage(
        `${failed.length} ${plural(failed.length, "источник не загрузился", "источника не загрузились", "источников не загрузились")} — модель ищет замену и пересчитывает`,
      );
      const followUp = [
        "# Результаты серверной проверки источников",
        ...localChecks(local),
        ...checkLines(checks),
        "",
        "Сервер загрузил источники из твоего ответа. Источники со status: failed сервер получить не смог: по правилам исключи их из используемых, найди замену и пересчитай зависимые результаты либо отметь их как неподтверждённые. Для источников со status: saved укажи server_status: saved и server_document_id. Верни ответ заново, целиком, по тому же шаблону.",
      ].join("\n");
      try {
        const second = await ask(
          input,
          system,
          [
            { role: "user", content: user },
            { role: "assistant", content: answer },
            { role: "user", content: followUp },
          ],
          { signal },
        );
        const parsed2 = parseAnswer(second.answer, refs);
        if (parsed2.status !== "unknown") {
          const previous = new Map(checks.map((c) => [c.url, c]));
          checks = await checkSources(parsed2.sources, {
            signal,
            previous,
            onProgress: progress("Сервер проверяет новые источники"),
          });
          answer = second.answer;
          resp = second.resp;
          parsed = parsed2;
          rounds = 2;
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn("[material-balance] второй запрос не удался:", e.message);
      }
    }
    applyChecks(parsed, checks, rounds);
  }

  const id = store.save({
    transformation: input.transformation.name,
    inputs: inputNames(input),
    targets: targetNames(input),
    basisAmount: { amount: input.basis.amount, unit: input.basis.unit, kg: input.basis.kg },
    localKey: localKey(local),
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
 * второй раз не идут — получают тот же расчёт. id узлов — в подписи: свежий
 * расчёт несёт их в refs, и чужой граф с теми же названиями их получить не
 * должен.
 */
function signatureOf(input) {
  const ids = (list) => list.map((n) => `${n.id}\u0000${n.name}`).sort();
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        input.transformation.id,
        input.transformation.name,
        ids(input.inputs),
        ids(input.outputs),
        [...input.targets].sort(),
        input.basis.id,
        input.basis.kg,
        localKey(input.local || []),
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
    units: UNITS,
  });
});

const names = (v) =>
  (Array.isArray(v) ? v : [])
    .map((n) => text(n?.name ?? n, 300))
    .filter(Boolean)
    .slice(0, MAX_NODES);

// Новый вид: { transformation, inputs, targets } — названия или узлы.
// Прежний: { transformation, basis, target } — пара.
router.post("/material-balance/lookup", (req, res) => {
  const transformation = text(req.body?.transformation?.name ?? req.body?.transformation, 300);
  try {
    if (req.body?.target && !Array.isArray(req.body?.targets)) {
      const basis = text(req.body?.basis?.name ?? req.body?.basis, 300);
      const target = text(req.body?.target?.name ?? req.body?.target, 300);
      if (!transformation || !basis || !target) {
        return res
          .status(400)
          .json({ success: false, error: "Нужны transformation, basis и target" });
      }
      return res.json({ success: true, ...store.lookupPair({ transformation, basis, target }) });
    }
    const inputs = names(req.body?.inputs);
    const targets = names(req.body?.targets);
    if (!transformation || !inputs.length || !targets.length) {
      return res
        .status(400)
        .json({ success: false, error: "Нужны transformation, inputs и targets" });
    }
    // Готовое — только если считалось с теми же разделами базы источников.
    const local = findLocalSources({
      inputs: inputs.map((name) => ({ name })),
      targets: targets.map((name) => ({ name })),
    });
    res.json({
      success: true,
      ...store.lookup({ transformation, inputs, targets, localKey: localKey(local) }),
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
    // Готовый мог быть сделан на другом графе: nodeIds — какие узлы этого
    // запроса стоят за его обозначениями.
    // Разделы базы источников о преобразовании — в запрос первыми. Готовый
    // расчёт годится, только если считался с теми же разделами.
    input.local = findLocalSources({
      inputs: input.inputs,
      targets: input.outputs.filter((n) => input.targets.includes(n.id)),
    });
    if (!input.force && !input.knownData && !input.system && !input.template) {
      const { exact } = store.lookup({
        transformation: input.transformation.name,
        inputs: inputNames(input),
        targets: targetNames(input),
        localKey: localKey(input.local),
      });
      if (exact) {
        const result = store.get(exact.id);
        return res.json({
          success: true,
          fromCache: true,
          result,
          nodeIds: matchRefs(result.refs, input),
        });
      }
    }
    const job = jobs.start(signatureOf(input), ({ signal, setStage }) =>
      calculate(input, { signal, setStage }),
    );
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

// «Отменить расчёт»: запрос к модели обрывается, ответ в базу не пишется.
// Такой же запрос, запущенный ещё откуда-то, — та же задача (signatureOf),
// поэтому отмена останавливает и его: там опрос получит «cancelled».
router.post("/material-balance/jobs/:id/cancel", (req, res) => {
  const job = jobs.cancel(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: "Расчёт не найден: возможно, сервер перезапускался" });
  }
  res.json({ success: true, job: jobs.view(job) });
});

// Копии веб-источников, загруженные сервером при проверке: текст — всегда
// простым текстом; оригинал PDF — как есть, HTML — файлом для скачивания,
// чтобы чужая страница не выполнялась на адресе сервера.
router.get("/material-balance/sources/:id/:what", (req, res) => {
  if (!["text", "file"].includes(req.params.what)) {
    return res.status(404).json({ success: false, error: "Нет такого вида копии: text или file" });
  }
  const doc = store.webDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ success: false, error: "Копия источника не найдена" });
  const files = store.webDocumentFiles(doc);
  if (req.params.what === "text") {
    res.type("text/plain; charset=utf-8");
    return res.sendFile(files.text, (err) => err && !res.headersSent && res.status(404).end());
  }
  res.setHeader("Content-Security-Policy", "sandbox");
  if (doc.kind === "pdf") {
    res.type("application/pdf");
    res.setHeader("Content-Disposition", "inline");
  } else {
    res.type("application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="source-${doc.id}.html"`);
  }
  res.sendFile(files.original, (err) => err && !res.headersSent && res.status(404).end());
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
module.exports.matchRefs = matchRefs;
