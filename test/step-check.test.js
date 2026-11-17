// Проверка шага моделью (POST /gpt/step/check): модель подменена, ответы
// задаёт тест.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let reply = {};
let lastPayload = null;
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    lastPayload = payload;
    return { status: "completed", text: typeof reply === "string" ? reply : JSON.stringify(reply) };
  },
  extractOutputText: (r) => r.text,
};

const router = require("../routes/step/check");
const handle = router.stack.find((l) => l.route?.path === "/gpt/step/check").route.stack[0].handle;

function check(body) {
  return new Promise((resolve) => {
    let out = "";
    const res = {
      statusCode: 200,
      writableEnded: false,
      status(c) { this.statusCode = c; return this; },
      setHeader() {},
      flushHeaders() {},
      on() {},
      write(s) { out += s; },
      end(s) { out += s || ""; this.writableEnded = true; resolve(JSON.parse(out.trim())); },
      json(o) { resolve({ ...o, http_status: this.statusCode }); },
    };
    handle({ body, on() {} }, res);
  });
}

// Шаг 2026-11-11: от «Этилцеллозольва» — «этилацетат».
const cellosolve = {
  direction: "down",
  anchor: "Этилцеллозольв",
  transformation: { name: "Синтез этилацетата из этилцеллозольва", description: "Этерификация уксусной кислотой." },
  inputs: [{ name: "Этилцеллозольв" }, { name: "Уксусная кислота", description: "**Ледяная** уксусная кислота" }],
  outputs: [{ name: "Этилацетат" }],
  byproducts: ["Вода"],
};

test("неверный продукт: переименование и новое название преобразования", async () => {
  reply = {
    verdict: "fix",
    summary: "Из этилцеллозольва и уксусной кислоты получают этилцеллозольвацетат, а не этилацетат.",
    renames: [{ from: "«этилацетат»", to: "Этилцеллозольвацетат (2-этоксиэтилацетат)", description: "Растворитель лаков и красок." }],
    transformation_name: "Этерификация этилцеллозольва уксусной кислотой",
    transformation_description: "Этилцеллозольв этерифицируют уксусной кислотой с отгонкой воды.",
  };
  const r = await check(cellosolve);
  assert.equal(r.success, true);
  assert.equal(r.verdict, "fix");
  // from — название из шага, как прислал клиент: по нему он найдёт продукт.
  assert.deepEqual(r.renames, [{ from: "Этилацетат", to: "Этилцеллозольвацетат (2-этоксиэтилацетат)", description: "Растворитель лаков и красок." }]);
  assert.equal(r.transformation.name, "Этерификация этилцеллозольва уксусной кислотой");
  // В запросе — направление, сырьё с описанием без разметки и запрет трогать якорь.
  assert.match(lastPayload.input, /Шаг «вниз» от продукта «Этилцеллозольв»/);
  assert.match(lastPayload.input, /- «Уксусная кислота» — Ледяная уксусная кислота/);
  assert.match(lastPayload.input, /Побочные продукты:\n- «Вода»/);
  assert.match(lastPayload.input, /Не переименовывать: «Этилцеллозольв»\./);
  assert.equal(lastPayload.text.format.strict, true);
});

test("верный шаг — ok, переименования отброшены", async () => {
  reply = {
    verdict: "ok",
    summary: "Фенол с формальдегидом дают фенолоформальдегидные смолы.",
    renames: [{ from: "Фенол", to: "Гидроксибензол", description: "" }],
    transformation_name: "",
    transformation_description: "",
  };
  const r = await check({
    transformation: { name: "Поликонденсация" },
    inputs: ["Фенол", "Формальдегид"],
    outputs: ["Фенолоформальдегидные смолы"],
  });
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.renames, []);
  assert.equal(r.transformation, null);
  assert.match(lastPayload.input, /^Шаг производственной цепочки на графе\./);
});

test("переименовать раскрываемый продукт нельзя — шаг ошибочен (wrong)", async () => {
  reply = {
    verdict: "fix",
    summary: "Этилацетат получают из этанола, а не из этилцеллозольва.",
    renames: [{ from: "Этилцеллозольв", to: "Этанол", description: "" }],
    transformation_name: "Этерификация этанола",
    transformation_description: "",
  };
  const r = await check(cellosolve);
  assert.equal(r.verdict, "wrong");
  assert.deepEqual(r.renames, []);
  assert.equal(r.transformation, null);
  assert.match(r.summary, /из этанола/);
});

test("исправления только неизвестных продуктов — wrong; без скобок — однозначное совпадение", async () => {
  reply = { verdict: "fix", summary: "…", renames: [{ from: "Бензол", to: "Толуол", description: "" }], transformation_name: "", transformation_description: "" };
  assert.equal((await check(cellosolve)).verdict, "wrong");

  reply = {
    verdict: "fix",
    summary: "…",
    renames: [{ from: "Этилацетат (растворитель)", to: "Этилцеллозольвацетат", description: "" }],
    transformation_name: "Синтез этилацетата из этилцеллозольва",
    transformation_description: "",
  };
  const r = await check(cellosolve);
  assert.equal(r.verdict, "fix");
  assert.deepEqual(r.renames.map((x) => x.from), ["Этилацетат"]);
  // То же название преобразования — не исправление.
  assert.equal(r.transformation, null);
});

test("замечание расчёта баланса и fixed уходят в запрос", async () => {
  reply = { verdict: "ok", summary: "", renames: [], transformation_name: "", transformation_description: "" };
  await check({
    transformation: { name: "Синтез этилацетата из этилцеллозольва" },
    inputs: ["Этилцеллозольв", "Уксусная кислота"],
    outputs: ["Этилацетат"],
    fixed: ["Этилцеллозольв", "Уксусная кислота"],
    remark: "Из P1 и уксусной кислоты получают этилцеллозольвацетат.",
  });
  assert.match(lastPayload.input, /Не переименовывать: «Этилцеллозольв», «Уксусная кислота»\./);
  assert.match(lastPayload.input, /Замечание:\nИз P1 и уксусной кислоты получают этилцеллозольвацетат\./);
});

test("без сырья или продуктов — 400; ответ не по схеме — 502", async () => {
  const bad = await check({ transformation: { name: "X" }, inputs: ["А"], outputs: [] });
  assert.equal(bad.http_status, 400);
  const noName = await check({ transformation: { description: "…" }, inputs: ["А"], outputs: ["Б"] });
  assert.equal(noName.http_status, 400);
  reply = "это не JSON";
  const r = await check(cellosolve);
  assert.equal(r.success, false);
  assert.equal(r.http_status, 502);
});
