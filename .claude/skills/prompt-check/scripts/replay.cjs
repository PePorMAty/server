#!/usr/bin/env node
// Повторная проверка промпта обобщения шага на сохранённых источниках.
//
//   node .claude/skills/prompt-check/scripts/replay.cjs [флаги] [кейс…]
//
// Без флагов — ЖИВАЯ модель: каждый кейс = один запрос обобщения на сервер
// (по умолчанию боевой) с промптами из ЭТОГО репозитория (как из окна
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

async function live(body) {
  const { stepAggregateDefaults } = require(path.join(REPO, "routes/step/utils/prompts.js"));
  const d = stepAggregateDefaults(body.direction === "up" ? "up" : "down");
  const payload = { ...body, customSystemPrompt: d.system, customUserPrompt: d.template };
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${opts.api}/api/graphs/gpt/step/aggregate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = JSON.parse((await r.text()).trim());
      if (!json.success) throw new Error(json.error || `HTTP ${r.status}`);
      return json.aggregated_markdown;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}

(async () => {
  const mode = opts.dry ? "без модели: сборка промпта" : opts.answers ? `без модели: ответы из ${opts.answers}` : `ЖИВАЯ модель через ${opts.api}`;
  console.log(`prompt-check — ${mode}; кейсов: ${cases.length}${!opts.dry && !opts.answers ? ` (= ${cases.length} запросов к модели)` : ""}`);
  if (!opts.dry && !opts.answers) fs.mkdirSync(opts.out, { recursive: true });
  const aggregate = opts.dry ? localAggregate() : null;
  let failed = 0, broken = 0;

  const runCase = async (name) => {
      const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
      const lines = [];
      const add = (ok, title, detail = "") => { if (!ok) failed++; lines.push(`  ${ok ? "✔" : "✘"} ${title}${detail ? ` — ${detail}` : ""}`); };
      try {
        if (opts.dry) {
          const r = await aggregate(fx.request);
          const input = captured?.input || "";
          add(r.status === 200 && !!captured, "обработчик принял запрос и позвал модель", `HTTP ${r.status}`);
          add(!/<<<[A-Z_]+>>>/.test(input + (captured?.instructions || "")), "все подстановки заполнены");
          add(["<lineage>", "<target_product>", "<existing_chain>", "<blocks>"].every((t) => input.includes(t)) && input.includes(fx.request.productName),
            "данные отделены от шаблона метками", `промпт ${input.length} симв., инструкция ${(captured?.instructions || "").length} симв.`);
        } else {
          const md = opts.answers
            ? fs.readFileSync(path.join(opts.answers, `${name}.md`), "utf8")
            : await live(fx.request);
          if (!opts.answers) fs.writeFileSync(path.join(opts.out, `${name}.md`), md);
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
