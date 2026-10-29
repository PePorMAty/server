#!/usr/bin/env node
// Повторная проверка промпта обобщения шага на сохранённых источниках.
//
//   node .claude/skills/prompt-check/scripts/replay.cjs [флаги] [кейс…]
//
// Без флагов — ЖИВАЯ модель: каждый кейс = один запрос обобщения на сервер
// (по умолчанию боевой; +1, если ответ перепрыгнул уровень и сервер ветки
// переспросил бы модель) с промптами из ЭТОГО репозитория (как из окна
// «Редактировать промпт»), так что проверяется код ветки, даже если на
// сервере старый. Флаги:
//   --dry            без модели: собрать промпт локальным обработчиком
//                    обобщения и проверить его (бесплатно)
//   --answers=ПАПКА  без модели: перепроверить сохранённые ответы <кейс>.md
//   --api=URL        сервер (по умолчанию https://sorangptgraph.xyz)
//   --out=ПАПКА      куда сохранять ответы модели (<кейс>.md)
// Кейсы — файлы fixtures/<кейс>.json; без имён — все.
// Выход: 0 — все проверки прошли, 1 — есть провалы, 2 — не удалось проверить.

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
  });
  process.exit(r.status ?? 2);
}

const SKILL = path.resolve(__dirname, "..");
const REPO = path.resolve(SKILL, "../../..");
const FIXTURES = path.join(SKILL, "fixtures");
const { checkAnswer } = require("./checks.cjs");

const opts = { api: "https://sorangptgraph.xyz", out: path.join(os.tmpdir(), "prompt-check"), cases: [] };
for (const a of process.argv.slice(2)) {
  const [k, v] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
  if (k === "--dry") opts.dry = true;
  else if (k === "--answers") opts.answers = path.resolve(v);
  else if (k === "--api") opts.api = v.replace(/\/+$/, "");
  else if (k === "--out") opts.out = path.resolve(v);
  else if (k.startsWith("--")) { console.error(`Неизвестный флаг ${k}`); process.exit(2); }
  else opts.cases.push(k);
}
const all = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const cases = opts.cases.length ? opts.cases : all;
for (const c of cases) if (!all.includes(c)) { console.error(`Нет кейса «${c}». Есть: ${all.join(", ")}`); process.exit(2); }

// ---------- локальный обработчик обобщения с подменённой моделью ----------
let captured = null;
function localAggregate() {
  const utilsPath = require.resolve(path.join(REPO, "routes/sources/utils"));
  const real = require(utilsPath);
  require.cache[utilsPath].exports = {
    ...real,
    callOpenAIResponsesRaw: async ({ payload }) => {
      captured = payload;
      return { status: "completed", text: "# Раскрываемый продукт\n" };
    },
    extractOutputText: (r) => r.text,
  };
  const router = require(path.join(REPO, "routes/step/aggregate.js"));
  const layer = router.stack.find((l) => l.route?.path === "/gpt/step/aggregate" && l.route.methods.post);
  return (body) =>
    new Promise((resolve) => {
      captured = null;
      let out = "";
      const res = {
        statusCode: 200, writableEnded: false,
        status(c) { this.statusCode = c; return this; },
        setHeader() {}, flushHeaders() {}, on() {},
        write(s) { out += s; },
        end(s) { out += s || ""; this.writableEnded = true; resolve({ status: this.statusCode, body: out.trim() }); },
        json(o) { resolve({ status: this.statusCode, body: JSON.stringify(o) }); },
      };
      layer.route.stack[0].handle({ body, on() {} }, res);
    });
}

/**
 * Блоки — как их соберёт сервер ветки. Промежуточные продукты раздела сервер
 * берёт из своей базы и ставит строкой в начало блока (aggregate.js,
 * withIntermediates); в фикстуре они лежат у источника полем intermediates.
 * Боевой сервер может быть старее и строку не добавит — добавляем сами.
 */
function asBranchServer(body) {
  const { isStream } = require(path.join(REPO, "routes/step/utils/levelSkip.js"));
  const sources = (body.sources || []).map(({ intermediates, ...s }) => {
    const list = (intermediates || []).filter((p) => !isStream(p));
    return list.length
      ? { ...s, technology_description: `Промежуточные продукты раздела: ${list.join(", ")}.\n${s.technology_description}` }
      : s;
  });
  return { ...body, sources };
}

/**
 * Ответ — как его вернёт сервер ветки: если основной шаг перепрыгнул через
 * промежуточные продукты раздела, сервер переспрашивает модель в той же
 * переписке (aggregate.js, utils/levelSkip.js). Боевой сервер переписку в
 * обобщение не принимает — её текст уходит продолжением шаблона. Второй
 * запрос — только в этом случае. Возвращает { md, followUp }.
 */
/**
 * Сервер сам ставит строку промежуточных и переспрашивает (aggregate.js с
 * ef8a114) — тогда повторять это здесь нельзя: строка задвоится, а дозапрос
 * уйдёт дважды. Узнаём по его промпту по умолчанию.
 */
let serverDoesIt = null;
async function serverHandlesLevel() {
  if (serverDoesIt !== null) return serverDoesIt;
  try {
    const r = await fetch(`${opts.api}/api/graphs/gpt/step/aggregate/prompt?direction=down`);
    const j = await r.json();
    serverDoesIt = /Промежуточные продукты раздела/.test(`${j.system}${j.template}`);
  } catch {
    serverDoesIt = false;
  }
  return serverDoesIt;
}

async function live(body) {
  const fmt = (lc) =>
    `${lc.outputs.join(", ")} мимо ${lc.skipped.join(", ")} → ${(lc.changed ? lc.outputsAfter : lc.outputs).join(", ")}${lc.changed ? "" : ` (предложено «${(lc.outputsOffered || []).join(", ")}» — не принято)`}`;
  if (await serverHandlesLevel()) {
    const json = await ask({ ...body, sources: (body.sources || []).map(({ intermediates, ...s }) => s) }, "", { raw: true });
    return { md: json.aggregated_markdown, followUp: json.levelCheck ? `сервер: ${fmt(json.levelCheck)}` : null };
  }
  const first = await ask(asBranchServer(body));
  if (body.direction === "up") return { md: first, followUp: null };
  const { skippedIntermediates, levelFollowUp, acceptFollowUp, mainStep, isStream } = require(path.join(REPO, "routes/step/utils/levelSkip.js"));
  const mid = (body.sources || []).flatMap((s) => s.intermediates || []).filter((p) => !isStream(p));
  const skipped = skippedIntermediates(first, body.productName, mid);
  if (!skipped.length) return { md: first, followUp: null };
  const outputs = mainStep(first).outputs;
  const tail = `\n\n---\nТвой предыдущий ответ на это задание:\n\n${first}\n\n---\n${levelFollowUp(body.productName, outputs, skipped)}`;
  const second = await ask(asBranchServer(body), tail);
  // Как сервер: ответ на дозапрос — только если выход стал названным продуктом.
  const changed = acceptFollowUp(second, skipped);
  const fixed = changed ? second : first;
  return {
    md: fixed,
    followUp: fmt({ outputs, skipped, changed, outputsAfter: mainStep(fixed)?.outputs ?? [], outputsOffered: mainStep(second)?.outputs ?? [] }),
  };
}

async function ask(body, tail = "", { raw = false } = {}) {
  const { stepAggregateDefaults } = require(path.join(REPO, "routes/step/utils/prompts.js"));
  const d = stepAggregateDefaults(body.direction === "up" ? "up" : "down");
  const payload = { ...body, customSystemPrompt: d.system, customUserPrompt: d.template + tail };
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${opts.api}/api/graphs/gpt/step/aggregate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = JSON.parse((await r.text()).trim());
      if (!json.success) throw new Error(json.error || `HTTP ${r.status}`);
      return raw ? json : json.aggregated_markdown;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}

(async () => {
  const mode = opts.dry ? "без модели: сборка промпта" : opts.answers ? `без модели: ответы из ${opts.answers}` : `ЖИВАЯ модель через ${opts.api}`;
  console.log(`prompt-check — ${mode}; кейсов: ${cases.length}${!opts.dry && !opts.answers ? ` (= ${cases.length} запросов к модели, +1 на кейс с дозапросом)` : ""}`);
  if (!opts.dry && !opts.answers) fs.mkdirSync(opts.out, { recursive: true });
  const aggregate = opts.dry ? localAggregate() : null;
  let failed = 0, broken = 0;

  const runCase = async (name) => {
      const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
      const lines = [];
      const add = (ok, title, detail = "") => { if (!ok) failed++; lines.push(`  ${ok ? "✔" : "✘"} ${title}${detail ? ` — ${detail}` : ""}`); };
      try {
        if (opts.dry) {
          const r = await aggregate(asBranchServer(fx.request));
          const input = captured?.input || "";
          add(r.status === 200 && !!captured, "обработчик принял запрос и позвал модель", `HTTP ${r.status}`);
          add(!/<<<[A-Z_]+>>>/.test(input + (captured?.instructions || "")), "все подстановки заполнены");
          add(["<lineage>", "<target_product>", "<existing_chain>", "<blocks>"].every((t) => input.includes(t)) && input.includes(fx.request.productName),
            "данные отделены от шаблона метками", `промпт ${input.length} симв., инструкция ${(captured?.instructions || "").length} симв.`);
        } else {
          const got = opts.answers
            ? { md: fs.readFileSync(path.join(opts.answers, `${name}.md`), "utf8"), followUp: null }
            : await live(fx.request);
          const md = got.md;
          if (!opts.answers) fs.writeFileSync(path.join(opts.out, `${name}.md`), md);
          if (got.followUp) lines.push(`  ↻ дозапрос о перепрыгивании уровня (+1 запрос): ${got.followUp}`);
          for (const c of checkAnswer(md, fx.request, fx.expect)) add(c.ok, c.title, c.ok ? "" : c.detail.slice(0, 200));
        }
      } catch (e) {
        broken++;
        lines.push(`  ✘ НЕ УДАЛОСЬ: ${e.message.split("\n")[0]}`);
      }
      console.log(`\n=== ${name}: ${fx.note}\n${lines.join("\n")}`);
  };
  // Модель отвечает минуту — кейсы параллельно. Сборка промпта перехватывает
  // один общий вызов — по очереди.
  if (opts.dry) for (const name of cases) await runCase(name);
  else await Promise.all(cases.map(runCase));

  console.log(`\nИтог: ${failed ? `провалов ${failed}` : "все проверки прошли"}${broken ? `; не проверено кейсов: ${broken}` : ""}`);
  if (!opts.dry && !opts.answers) console.log(`Ответы модели: ${opts.out}`);
  process.exit(broken ? 2 : failed ? 1 : 0);
})();
