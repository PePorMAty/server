// Чат с ИИ в открытом графе (routes/chat/, этап 4 PG-MIGRATION.md) — на
// подставных ответах модели: транспорт callChatTools подменён, каждый ответ
// модели задаёт тест. Карточка продукта и поиск по ИТС — на PostgreSQL
// (TEST_DATABASE_URL), без неё эти проверки пропускаются.
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ---------- подмена модели ----------
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
let replies = []; // ответы модели по очереди: { content } или { calls: [[name, args], …] }
let calls = []; // что ушло в модель
require.cache[utilsPath].exports = {
  ...real,
  callChatTools: async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const r = replies.shift() ?? { content: "…" };
    const message = r.calls
      ? {
          role: "assistant",
          content: r.content ?? null,
          tool_calls: r.calls.map(([name, args], i) => ({
            id: `call-${calls.length}-${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        }
      : { role: "assistant", content: r.content };
    if (r.fail) throw new Error(r.fail);
    return { message, usage: { total_tokens: 100 }, model: "test-model" };
  },
};

const router = require("../routes/chat/chat");
const { runChat, MAX_ROUNDS } = router;
const { readGraphSlice } = require("../routes/chat/graphSlice");
const { readKinds, runTool, PROPOSAL_KINDS } = require("../routes/chat/tools");
const { chatSystemPrompt } = require("../routes/chat/prompt");
const { addDoc, addSection, backends } = require("./helpers/sources");

const slice = readGraphSlice({
  name: "Фенол",
  products: [
    { id: "n1", label: "Фенол" },
    { id: "n2", label: "Изопропилбензол (кумол)" },
    { id: "n3", label: "Ацетон" },
  ],
  transformations: [{ id: "t1", label: "Кумольный способ", inputs: ["Изопропилбензол (кумол)"], outputs: ["Фенол", "Ацетон"] }],
  selected: { description: "Фенол — ароматический спирт.", madeBy: [{ name: "Кумольный способ", inputs: ["Кумол"], outputs: ["Фенол"] }] },
});

async function chat(message, extra = {}) {
  const events = [];
  const done = await runChat({ message, history: [], slice, ...extra }, (e) => events.push(e));
  return { done, events };
}

test("промпт: правила, продукты открытого графа и выбранный узел", () => {
  const p = chatSystemPrompt(slice);
  assert.match(p, /Граф меняет только человек/);
  assert.match(p, /Продукты на графе: Фенол; Изопропилбензол \(кумол\); Ацетон\./);
  assert.match(p, /ВЫБРАННЫЙ УЗЕЛ[\s\S]*ароматический спирт/);
  // Одинокий узел без описания: контекста нет, но название модель знает.
  const lone = chatSystemPrompt(readGraphSlice({ products: [{ id: "x", label: "Бензол" }], selectedLabel: "Бензол" }));
  assert.match(lone, /ВЫБРАННЫЙ УЗЕЛ[^\n]*\n«Бензол» \(описания и соседей на графе нет\)/);
  // Без выбора — без раздела о выбранном узле.
  assert.doesNotMatch(chatSystemPrompt(readGraphSlice({ products: [] })), /ВЫБРАННЫЙ УЗЕЛ/);
});

test("инструменты графа и предложение шага: узел по синониму, предложение — клиенту", async () => {
  calls = [];
  replies = [
    { calls: [["graph_node", { name: "Кумол" }], ["propose_step", { product: "кумол", direction: "up", why: "из чего его делают" }]] },
    { content: "Кумол есть на графе — предлагаю шаг вверх." },
  ];
  const { done, events } = await chat("Из чего делают кумол?");
  assert.equal(done.reply, "Кумол есть на графе — предлагаю шаг вверх.");
  assert.deepEqual(done.usage, { requests: 2, tokens: 200 });
  assert.deepEqual(done.proposals, [{ kind: "step", nodeId: "n2", label: "Изопропилбензол (кумол)", direction: "up", why: "из чего его делают" }]);
  assert.deepEqual(events.map((e) => e.type), ["tool", "tool", "proposal", "done"]);
  // Второй круг видит ответы инструментов по их id.
  const toolMsgs = calls[1].messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  const node = JSON.parse(toolMsgs[0].content);
  assert.equal(node.found, true);
  assert.deepEqual(node.madeBy, []);
  assert.equal(node.usedIn[0].transformation, "Кумольный способ");
  assert.equal(toolMsgs[0].tool_call_id, calls[1].messages.find((m) => m.tool_calls).tool_calls[0].id);
});

test("шаг от продукта, которого нет на графе, — не предлагается, модель узнаёт почему", async () => {
  replies = [{ calls: [["propose_step", { product: "Бензол", direction: "up" }]] }, { content: "Бензола на графе нет." }];
  calls = [];
  const { done } = await chat("Дострой бензол");
  assert.deepEqual(done.proposals, []);
  assert.match(JSON.parse(calls[1].messages.at(-1).content).error, /нет на открытом графе/);
});

test("показать на графе — узлы по названиям; незнакомые пропускаются", async () => {
  replies = [{ calls: [["show_nodes", { names: ["Ацетон", "Фенол", "Уран"] }]] }, { content: "Показал." }];
  const { done } = await chat("Покажи ацетон и фенол");
  assert.deepEqual(done.proposals, [{ kind: "show", nodes: [{ id: "n3", label: "Ацетон" }, { id: "n1", label: "Фенол" }] }]);
});

test(`не больше ${MAX_ROUNDS} кругов: на последнем инструменты выключены`, async () => {
  calls = [];
  replies = Array.from({ length: 10 }, () => ({ calls: [["graph_node", { name: "Фенол" }]] }));
  replies.splice(MAX_ROUNDS, 0, { content: "Хватит." }); // ответ на круге без инструментов
  const { done } = await chat("Расскажи всё");
  assert.equal(done.usage.requests, MAX_ROUNDS + 1);
  assert.equal(calls.at(-1).toolChoice, "none");
  assert.ok(calls.slice(0, -1).every((c) => c.toolChoice === "auto"));
  assert.equal(done.reply, "Хватит.");
});

test("история разговора — в запросе перед новым сообщением; модель и провайдер — из запроса", async () => {
  calls = [];
  replies = [{ content: "Да." }];
  await runChat(
    { message: "А ацетон?", history: [{ role: "user", content: "Что такое фенол?" }, { role: "assistant", content: "Ароматический спирт." }], slice, provider: "qwen", model: "qwen3.8-flash" },
    () => {},
  );
  assert.deepEqual(calls[0].messages.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(calls[0].model, "qwen3.8-flash");
  assert.equal(calls[0].provider, "qwen");
});

// ---------- карточки предложений (этап 4.3) ----------
const graph2 = readGraphSlice({
  products: [
    { id: "n1", label: "Фенол" },
    { id: "n2", label: "Изопропилбензол (кумол)" },
    { id: "n4", label: "Кумол" },
    { id: "n5", label: "Водород" },
    { id: "n6", label: "Циклогексанол" },
  ],
  transformations: [
    { id: "t1", label: "Кумольный способ", inputs: ["Изопропилбензол (кумол)"], outputs: ["Фенол"] },
    { id: "t2", label: "Гидрирование", inputs: ["Фенол", "Водород"], outputs: ["Циклогексанол"] },
    { id: "t3", label: "Гидрирование", inputs: ["Кумол", "Водород"], outputs: ["Изопропилциклогексан"] },
  ],
});
const tool = (name, args, kinds = PROPOSAL_KINDS) => runTool(name, args, { slice: graph2, kinds });
const toolNames = (call) => call.tools.map((t) => t.function.name);

test("карточки — по списку клиента: без него шаг и показ, как в первой версии", async () => {
  assert.deepEqual(readKinds(undefined), ["step", "show"]);
  assert.deepEqual(readKinds(["merge", "чужое", "step"]), ["step", "merge"]);
  assert.deepEqual(readKinds([]), ["step", "show"]);

  calls = [];
  replies = [{ content: "Да." }, { content: "Да." }];
  await chat("Привет");
  assert.ok(toolNames(calls[0]).includes("balance_calc"), "чтение — всегда");
  assert.ok(!toolNames(calls[0]).includes("propose_merge"));
  assert.doesNotMatch(calls[0].messages[0].content, /propose_merge/);
  await chat("Привет", { kinds: PROPOSAL_KINDS });
  assert.ok(toolNames(calls[1]).includes("propose_merge"));
  assert.match(calls[1].messages[0].content, /propose_merge — объединить/);

  // Модель вызвала то, чего клиент не умеет, — карточки нет.
  const old = await tool("propose_merge", { node: "Кумол", into: "Изопропилбензол (кумол)" }, ["step", "show"]);
  assert.equal(old.proposal, undefined);
  assert.match(old.result.error, /Нет инструмента/);
});

test("предложения кодов, баланса и описания — у узлов открытого графа", async () => {
  const codes = await tool("propose_codes", { products: ["Фенол", "кумол", "Уран", "Фенол"], why: "кодов нет" });
  assert.deepEqual(codes.proposal, { kind: "codes", nodes: [{ id: "n1", label: "Фенол" }, { id: "n4", label: "Кумол" }], why: "кодов нет" });
  assert.equal((await tool("propose_codes", { products: ["Уран"] })).proposal, undefined);

  // Одноимённые преобразования различает продукт.
  assert.equal((await tool("propose_balance", { transformation: "Гидрирование" })).proposal.nodeId, "t2");
  assert.equal((await tool("propose_balance", { transformation: "Гидрирование", product: "Кумол" })).proposal.nodeId, "t3");
  assert.deepEqual((await tool("propose_balance", { transformation: "кумольный" })).proposal, { kind: "balance", nodeId: "t1", label: "Кумольный способ", why: "" });
  const none = await tool("propose_balance", { transformation: "Пиролиз" });
  assert.equal(none.proposal, undefined);
  assert.match(none.result.error, /graph_node/);

  assert.deepEqual((await tool("propose_description", { node: "Фенол" })).proposal, { kind: "tech", nodeId: "n1", label: "Фенол", nodeKind: "product", why: "" });
  assert.equal((await tool("propose_description", { node: "Кумольный способ" })).proposal.nodeKind, "transformation");
});

test("переименование и объединение: два разных узла, новое название — не прежнее", async () => {
  const rename = await tool("propose_rename", { node: "Кумол", new_name: "  Изопропилбензол ", why: "по ИТС" });
  assert.deepEqual(rename.proposal, { kind: "rename", nodeId: "n4", label: "Кумол", newLabel: "Изопропилбензол", nodeKind: "product", why: "по ИТС" });
  assert.equal((await tool("propose_rename", { node: "Фенол", new_name: "фенол" })).proposal, undefined);

  const merge = await tool("propose_merge", { node: "Кумол", into: "Изопропилбензол (кумол)" });
  assert.deepEqual(merge.proposal, { kind: "merge", fromId: "n4", fromLabel: "Кумол", intoId: "n2", intoLabel: "Изопропилбензол (кумол)", why: "" });
  assert.equal(merge.summary, "предложено объединить «Кумол» → «Изопропилбензол (кумол)»");
  // Узел сам с собой не объединяется.
  assert.equal((await tool("propose_merge", { node: "Кумол", into: "кумол" })).proposal, undefined);
  assert.equal((await tool("propose_merge", { node: "Уран", into: "Фенол" })).proposal, undefined);
});

for (const backend of backends().filter((b) => b.name === "SQLite")) {
  describe("готовый расчёт баланса — чтение моделью", () => {
    let close;
    before(async () => {
      close = await backend.open();
    });
    after(() => close());

    test("balance_calc: сырьё, продукты с массами, итог; нет расчёта — ошибка модели", async () => {
      const id = await require("../routes/material-balance/utils/store").save({
        transformation: "Кумольный способ",
        inputs: ["Кумол", "Кислород"],
        targets: ["Фенол", "Ацетон"],
        basisAmount: { amount: 1, unit: "т", kg: 1000 },
        answer: "# Материальный баланс\n…",
        parsed: {
          status: "calculated",
          statusLabel: "Рассчитан",
          basisText: "1 т кумола",
          products: [
            { ref: "P1", name: "Фенол", massKg: 610, massText: "610 кг" },
            { ref: "P2", name: "Ацетон", massKg: 380 },
          ],
          totals: { input: "1 260 кг", output: "1 250 кг", residual: "0,8 %" },
          sources: [{ title: "ИТС 18—2023 · 3.6", url: "local://documents/1/sections/2" }],
        },
        refs: [],
      });
      const r = await tool("balance_calc", { id });
      assert.equal(r.summary, `расчёт баланса №${id}: ${r.result.title}`);
      assert.deepEqual(r.result.inputs, ["Кумол", "Кислород"]);
      assert.deepEqual(r.result.products, ["Фенол: 610 кг", "Ацетон: нет данных"]);
      assert.equal(r.result.basis, "1 т кумола");
      assert.equal(r.result.status, "Рассчитан");
      assert.equal(r.result.totals.residual, "0,8 %");
      assert.deepEqual(r.result.sources, ["ИТС 18—2023 · 3.6"]);
      assert.match((await tool("balance_calc", { id: id + 100 })).result.error, /нет/);
      assert.match((await tool("balance_calc", { id: "двенадцать" })).result.error, /номер/);
    });
  });
}

/** Обработчик роутера как Express: тело ответа — строки NDJSON. */
function post(body) {
  const layer = router.stack.find((l) => l.route?.path === "/gpt/chat");
  return new Promise((resolve) => {
    let out = "";
    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      status(c) {
        this.statusCode = c;
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      on() {},
      json(o) {
        resolve({ status: this.statusCode, json: o });
      },
      write(s) {
        out += s;
      },
      end() {
        this.writableEnded = true;
        resolve({ status: this.statusCode, headers: this.headers, events: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) });
      },
    };
    layer.route.stack[0].handle({ body }, res);
  });
}

test("роут: поток NDJSON без буфера nginx; пустое сообщение — 400; ошибка модели — событием", async () => {
  assert.equal((await post({ message: " " })).status, 400);
  replies = [{ content: "Привет." }];
  const ok = await post({ message: "Привет", graph: { products: [] } });
  assert.equal(ok.headers["x-accel-buffering"], "no");
  assert.match(ok.headers["content-type"], /ndjson/);
  assert.equal(ok.events.at(-1).type, "done");
  // Карточки клиента — из поля proposals запроса.
  calls = [];
  replies = [{ content: "Да." }];
  await post({ message: "Привет", proposals: ["step", "show", "rename"] });
  assert.ok(toolNames(calls[0]).includes("propose_rename"));
  assert.ok(!toolNames(calls[0]).includes("propose_merge"));
  replies = [{ fail: "шлюз не ответил" }];
  const bad = await post({ message: "Привет" });
  assert.deepEqual(bad.events, [{ type: "error", error: "шлюз не ответил" }]);
});

// ---------- база знаний ----------
for (const backend of backends().filter((b) => b.name === "PostgreSQL")) {
  describe("инструменты базы знаний — PostgreSQL", () => {
    let close;
    let conn;
    before(async () => {
      close = await backend.open();
      require("../routes/knowledge/chunks").resetChunksReady();
      const store = require("../routes/local-sources/utils/store");
      const its = await addDoc({ shortTitle: "ИТС 18—2023" });
      await addSection(its, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Изопропилбензол"] }, {
        text: "Гидропероксид изопропилбензола разлагают серной кислотой на фенол и ацетон.",
      });
      conn = await store.connection();
      await require("../routes/knowledge/chunks").ensureSectionChunks(conn);
    });
    after(() => close());

    test("карточка продукта и поиск по ИТС — коротким JSON модели", async () => {
      calls = [];
      replies = [
        { calls: [["product_card", { name: "Фенол" }], ["search_sources", { query: "гидропероксид серная кислота" }]] },
        { content: "По ИТС 18—2023, 3.6: фенол получают кумольным способом." },
      ];
      const events = [];
      await runChat({ message: "Как получают фенол?", history: [], slice }, (e) => events.push(e), { conn, pool: null });
      const [card, search] = calls[1].messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
      assert.equal(card.cas, "108-95-2");
      assert.equal(card.onOpenGraph, true);
      assert.deepEqual(card.sectionsUp, ["ИТС 18—2023 · 3.6 Производство фенола и ацетона (стр. 1–10)"]);
      assert.equal(search.results[0].source, "ИТС 18—2023 · 3.6 Производство фенола и ацетона (стр. 1–10)");
      assert.match(search.results[0].excerpt, /серной кислотой/);
      assert.match(events.find((e) => e.name === "product_card").summary, /карточка «Фенол»: разделов 1/);
    });
  });
}
