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
let checks = []; // проверки шага (check_steps): что спросили и что ответить
let checkReplies = {};
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    checks.push(payload.input);
    const name = /Преобразование: «([^»]+)»/.exec(payload.input)?.[1];
    return { text: JSON.stringify(checkReplies[name] ?? { verdict: "ok", summary: "верно", renames: [], transformation_name: "", transformation_description: "" }) };
  },
  extractOutputText: (r) => r.text,
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
    return { message, finishReason: r.finish ?? (r.calls ? "tool_calls" : "stop"), usage: { total_tokens: 100 }, model: "test-model" };
  },
};

const router = require("../routes/chat/chat");
const { runChat, MAX_ROUNDS, claimedAction, claimedTool } = router;
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
  assert.match(p, /никогда не пиши, что показал/i);
  assert.match(p, /РЕЖИМ С ПОДТВЕРЖДЕНИЕМ/);
  assert.match(chatSystemPrompt(slice, ["step", "show"], { mode: "auto" }), /РЕЖИМ АВТОПИЛОТА/);
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
  // Справка: «кумол» — синоним в скобках узла графа.
  assert.equal(events[0].summary, "справка: узлы графа — «Изопропилбензол (кумол)»");
  assert.match(calls[0].messages[0].content, /СПРАВКА[^\n]*\n.*"madeBy"/);
  assert.deepEqual(events.slice(1).map((e) => e.type), ["tool", "tool", "proposal", "done"]);
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

test(`${MAX_ROUNDS} круга чтения, потом круг только с действиями, потом ответ словами (20.11)`, async () => {
  calls = [];
  replies = Array.from({ length: 10 }, () => ({ calls: [["graph_node", { name: "Фенол" }]] }));
  // После чтения модель ещё может действовать: вызов баланса она писала
  // текстом, когда инструментов в последнем круге не было.
  replies.splice(MAX_ROUNDS, 0, { calls: [["propose_step", { product: "Фенол", direction: "up" }]] }, { content: "Строю шаг вверх от фенола." });
  const { done } = await chat("Почитай всё и построй шаг вверх от фенола");
  assert.equal(done.usage.requests, MAX_ROUNDS + 2);
  assert.ok(calls.slice(0, MAX_ROUNDS).every((c) => c.toolChoice === "auto" && c.tools.some((t) => t.function.name === "graph_node")));
  assert.deepEqual(toolNames(calls[MAX_ROUNDS]), ["propose_step", "show_nodes"]);
  assert.equal(calls[MAX_ROUNDS].toolChoice, "auto");
  assert.equal(calls.at(-1).toolChoice, "none");
  assert.deepEqual(done.proposals.map((p) => p.kind), ["step"]);
  assert.equal(done.reply, "Строю шаг вверх от фенола.");

  // Действовать нечего — ответ на круге действий, лишнего запроса нет.
  calls = [];
  replies = Array.from({ length: MAX_ROUNDS }, () => ({ calls: [["graph_node", { name: "Фенол" }]] }));
  replies.push({ content: "Хватит." });
  const two = await chat("Расскажи всё");
  assert.equal(two.done.usage.requests, MAX_ROUNDS + 1);
  assert.equal(two.done.reply, "Хватит.");
});

test("«Альтернативы ищутся. Сайт выполнит…» без вызова — поправка с обязательным действием (20.11)", async () => {
  calls = [];
  replies = [
    { content: "Альтернативные способы получения ищутся. Сайт выполнит действие автоматически, итог придёт сообщением «Автопилот: …»." },
    { calls: [["find_alternatives", { product: "Кумол", direction: "up" }]] },
    { content: "Ищу альтернативы кумола." },
  ];
  const done = await runChat({ message: "а для кумола найди альтернативы", history: [], slice: graph2, kinds: PROPOSAL_KINDS, mode: "auto" }, () => {});
  assert.equal(calls[1].toolChoice.function.name, "find_alternatives");
  assert.deepEqual(done.proposals.map((p) => p.kind), ["alternatives"]);
  for (const t of ["Граф перекладывается заново.", "Шаг от фенола вверх запущен.", "Расчёт баланса рассчитывается."]) assert.ok(claimedAction(t), t);
  assert.equal(claimedAction("Расчёт не запущен: у преобразования нет сырья."), null);
  assert.equal(claimedTool("Граф перекладывается заново.", new Set(["relayout", "undo_layout"])), "relayout");
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

test("справка до ответа: упомянутое преобразование — другим падежом, выбранный узел", async () => {
  const sl = readGraphSlice({
    products: [{ id: "p1", label: "Фенол" }, { id: "p2", label: "Олигомеры этилена" }, { id: "p3", label: "Алкилфенолы" }],
    transformations: [{ id: "t9", label: "Алкилирование фенола олигомерами этилена", inputs: ["Фенол", "Олигомеры этилена"], outputs: ["Алкилфенолы"] }],
    selectedLabel: "Алкилфенолы",
  });
  calls = [];
  replies = [{ content: "Сейчас." }];
  const events = [];
  await runChat({ message: "рассчитай материальный баланс для фенола - алкилированием фенола олигомерами этилена", history: [], slice: sl }, (e) => events.push(e));
  const system = calls[0].messages[0].content;
  assert.match(system, /"transformation":"Алкилирование фенола олигомерами этилена"/);
  assert.deepEqual(
    events.filter((e) => e.type === "tool").map((e) => e.summary),
    ["справка: узлы графа — «Алкилфенолы», «Олигомеры этилена», «Фенол»", "справка: преобразования — «Алкилирование фенола олигомерами этилена»"],
  );
  // Слово длинного названия — не отдельный продукт: «тримеров пропилена» ≠ «Пропилен».
  const { mentionedNodes } = require("../routes/chat/mentions");
  const tri = readGraphSlice({ products: [{ id: "a", label: "Пропилен" }, { id: "b", label: "Тримеры пропилена" }] });
  assert.deepEqual(mentionedNodes(tri, "отобрази тримеров пропилена").products.map((p) => p.label), ["Тримеры пропилена"]);
  assert.deepEqual(mentionedNodes(tri, "пропилен и его тримеры пропилена").products.map((p) => p.label), ["Тримеры пропилена"]);
  // Ничего не упомянуто и не выбрано — справки нет.
  calls = [];
  replies = [{ content: "Привет." }];
  await runChat({ message: "привет", history: [], slice: readGraphSlice({ products: [{ id: "p1", label: "Фенол" }] }) });
  assert.doesNotMatch(calls[0].messages[0].content, /СПРАВКА/);
});

test("«показал» без действия — модель переделывает ответ один раз; итог автопилота не трогаем", async () => {
  calls = [];
  replies = [{ content: "Показал «Фенол» на графе." }, { calls: [["show_nodes", { names: ["Фенол"] }]] }, { content: "Показал." }];
  const { done } = await chat("отобрази фенол");
  assert.equal(done.usage.requests, 3);
  assert.match(calls[1].messages.at(-1).content, /Проверка сервера: в ответе «показал»/);
  // Поправка — с обязательным вызовом того действия, что модель описала.
  assert.deepEqual(calls[1].toolChoice, { type: "function", function: { name: "show_nodes" } });
  assert.equal(calls[2].toolChoice, "auto");
  assert.equal(done.proposals[0].kind, "show");

  // Второй раз подряд — не крутим: ответ как есть.
  calls = [];
  replies = [{ content: "Добавил." }, { content: "Добавила." }];
  assert.equal((await chat("добавь бензол")).done.reply, "Добавила.");
  assert.equal(calls.length, 2);

  // Итог автопилота: «построил» там правда — без поправки.
  calls = [];
  replies = [{ content: "Построил шаг вниз от фенола — задача выполнена." }];
  await chat("Автопилот: шаг добавлен", { continuation: true, mode: "auto" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /РЕЖИМ АВТОПИЛОТА/);
});

test("что считается «сделал»", () => {
  assert.equal(claimedAction("Показал «Тримеры пропилена» на графе."), "показал");
  assert.equal(claimedAction("Шаг построила, всё на графе"), "построила");
  assert.equal(claimedAction("Я не добавил шаг: бензола на графе нет."), null);
  assert.equal(claimedAction("Вы уже добавили шаг — дальше бисфенол А."), null);
  assert.equal(claimedAction("Предлагаю шаг вниз — построю его, когда скажете."), null);
  // Настоящее время — тоже утверждение (автопилот на flash: «Делаю
  // перераскладку графа» без вызова).
  assert.equal(claimedAction("Делаю перераскладку графа."), "делаю");
  assert.equal(claimedAction("Раскладываю граф заново — узлы встанут по уровням."), "раскладываю");
  assert.equal(claimedAction("Готово — перераскладка выполнена."), "готово");
  assert.equal(claimedAction("Скажи «строй» — запущу."), null);
});

test("какое действие модель описала словами", () => {
  const all = new Set(["show_nodes", "add_product", "propose_step", "bookmark_nodes", "set_description", "relayout", "find_alternatives"]);
  assert.equal(claimedTool("Готово: описание фенола записано, и «фенол» добавлен в закладки.", all), "bookmark_nodes");
  assert.equal(claimedTool("Готово: описание фенола записано по ИТС.", all), "set_description");
  assert.equal(claimedTool("Добавил «Автомобиль» на граф и запустил шаг вверх от него.", all), "add_product");
  assert.equal(claimedTool("Делаю перераскладку графа.", all), "relayout");
  assert.equal(claimedTool("Строю шаг вверх от фенола.", all), "propose_step");
  assert.equal(claimedTool("Показал «Фенол».", all), "show_nodes");
  // Действия нет у клиента — не заставляем.
  assert.equal(claimedTool("Добавил в закладки.", new Set(["show_nodes"])), null);
});

test("оборванный ответ — с пометкой", async () => {
  replies = [{ content: "Тримеры пропилена получают только одним преобразованием:", finish: "length" }];
  assert.match((await chat("Расскажи")).done.reply, /ответ оборван/);
});

// ---------- карточки предложений (этап 4.3) ----------
const graph2 = readGraphSlice({
  alternatives: [
    { id: "a1", label: "Олигомеризация пропилена на цеолитах", of: ["Кумол"], direction: "up" },
    { id: "a2", label: "Бисфенол А", of: ["Фенол"], direction: "down" },
  ],
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

test("новый продукт и показ альтернатив", async () => {
  const sl = readGraphSlice({ products: [{ id: "n1", label: "Фенол" }] });
  const add = await runTool("add_product", { name: " Автомобиль ", near: "фенол", why: "просили" }, { slice: sl, kinds: PROPOSAL_KINDS });
  const { id, ...rest } = add.proposal;
  assert.deepEqual(rest, { kind: "add", label: "Автомобиль", nearId: "n1", nearLabel: "Фенол", why: "просили" });
  assert.match(id, /^chat-[0-9a-f-]{36}$/);
  // «Добавь автомобиль и построй от него шаг» — в том же ответе: новый узел
  // уже в срезе, шаг строится от его id.
  const step = await runTool("propose_step", { product: "Автомобиль", direction: "up" }, { slice: sl, kinds: PROPOSAL_KINDS });
  assert.equal(step.proposal.nodeId, id);
  const dup = await tool("add_product", { name: "Фенол" });
  assert.equal(dup.proposal, undefined);
  assert.match(dup.result.error, /уже есть/);

  const alts = await tool("show_nodes", { names: ["Фенол"], alternatives: true });
  assert.deepEqual(alts.proposal.nodes, [{ id: "a2", label: "Бисфенол А" }]);
  // Альтернативу показывают и по её названию, преобразование — по своему.
  assert.deepEqual((await tool("show_nodes", { names: ["Бисфенол А", "Кумольный способ"] })).proposal.nodes, [
    { id: "a2", label: "Бисфенол А" },
    { id: "t1", label: "Кумольный способ" },
  ]);
  const node = (await tool("graph_node", { name: "Кумол" })).result;
  assert.deepEqual(node.alternatives, [{ alternative: "Олигомеризация пропилена на цеолитах", direction: "up" }]);
});

test("источники, удаление, раскладка — действия у узлов графа", async () => {
  const src = await tool("find_sources", { product: "кумол", direction: "up", web: true, why: "в интернете" });
  assert.deepEqual(src.proposal, { kind: "sources", nodeId: "n4", label: "Кумол", direction: "up", web: true, why: "в интернете" });
  assert.equal((await tool("find_sources", { product: "Мультиварка", direction: "up" })).proposal, undefined);

  const del = await tool("delete_nodes", { names: ["Ацетон", "Гидрирование", "Бисфенол А", "Уран", "Гидрирование"] });
  assert.deepEqual(del.proposal.nodes, [
    { id: "t2", label: "Гидрирование" },
    { id: "a2", label: "Бисфенол А" },
  ]);
  assert.equal((await tool("delete_nodes", { names: ["Уран"] })).proposal, undefined);

  assert.deepEqual((await tool("relayout", {})).proposal, { kind: "layout", why: "" });
  // Старый клиент действий 4.5 не знает — модель их не получит.
  assert.match((await tool("delete_nodes", { names: ["Фенол"] }, ["step", "show"])).result.error, /Нет инструмента/);
});

test("итог действия для модели — по режиму: в автопилоте сайт делает сам, а не человек (20.11)", async () => {
  const confirm = await runTool("propose_step", { product: "Фенол", direction: "up" }, { slice: graph2, kinds: PROPOSAL_KINDS });
  assert.match(confirm.result.note, /карточку с кнопкой и сделает это сам/);
  const auto = await runTool("propose_step", { product: "Фенол", direction: "up" }, { slice: graph2, kinds: PROPOSAL_KINDS, mode: "auto" });
  assert.match(auto.result.note, /выполнится само/);
  // Записку не пересказывать человеку: модель повторяла её дословно.
  assert.match(auto.result.note, /без слов о сайте/);
  assert.doesNotMatch(auto.result.note, /человек[^.]*сам\b(?! или)/);
  const bm = await runTool("bookmark_nodes", { names: ["Фенол"] }, { slice: graph2, kinds: PROPOSAL_KINDS, mode: "auto" });
  assert.match(bm.result.note, /выполнится само/);
  // Промпт автопилота прямо запрещает «ты построишь сам».
  assert.match(chatSystemPrompt(graph2, PROPOSAL_KINDS, { mode: "auto" }), /никогда не пиши «ты построишь сам»/);
  // Вопрос «из чего делают» — ответ словами, а не шаг.
  assert.match(chatSystemPrompt(graph2, PROPOSAL_KINDS), /ВОПРОС «из чего делают X\?»[^\n]*не просьба строить/);
});

test("graph_node: преобразование с последним расчётом баланса, у продукта — найденные мастером источники", async () => {
  const g = readGraphSlice({
    products: [
      { id: "p1", label: "Циклогексанон" },
      { id: "p2", label: "Гидроксиламинсульфат" },
      { id: "p3", label: "Циклогексаноноксим" },
      { id: "p4", label: "Автомобиль", sources: { up: { count: 7, titles: ["Автомобильная промышленность — обзор", "", "Сталь кузова"] } } },
    ],
    transformations: [
      {
        id: "t9",
        label: "Оксимирование циклогексанона",
        inputs: ["Циклогексанон", "Гидроксиламинсульфат"],
        outputs: ["Циклогексаноноксим"],
        balance: { status: "частично рассчитан", basis: "Циклогексанон", note: "нет норм расхода на стадию оксимирования" },
      },
    ],
  });
  const t = await runTool("graph_node", { name: "Оксимирование циклогексанона" }, { slice: g, kinds: PROPOSAL_KINDS });
  assert.equal(t.summary, "«Оксимирование циклогексанона» на графе");
  assert.equal(t.result.kind, "transformation");
  assert.deepEqual(t.result.transformations[0].balance, { status: "частично рассчитан", basis: "Циклогексанон", note: "нет норм расхода на стадию оксимирования" });
  const car = await runTool("graph_node", { name: "автомобиль" }, { slice: g, kinds: PROPOSAL_KINDS });
  assert.deepEqual(car.result.foundSources, { Автомобиль: { up: { count: 7, titles: ["Автомобильная промышленность — обзор", "Сталь кузова"] } } });
  assert.deepEqual((await runTool("graph_node", { name: "Уран" }, { slice: g, kinds: PROPOSAL_KINDS })).result, { found: false });

  // Баланс со своими данными, на тонну сырья, заново.
  const b = await runTool(
    "propose_balance",
    { transformation: "оксимирование циклогексанона", basis: "циклогексанон", known_data: "Выход оксима 99,5 % (ИТС 32—2023)", recalc: true },
    { slice: g, kinds: PROPOSAL_KINDS },
  );
  assert.deepEqual(b.proposal, {
    kind: "balance",
    nodeId: "t9",
    label: "Оксимирование циклогексанона",
    why: "",
    basisId: "p1",
    basisLabel: "Циклогексанон",
    knownData: "Выход оксима 99,5 % (ИТС 32—2023)",
    force: true,
  });
  // Не сырьё этого преобразования — расчёт на сырьё по умолчанию, модель знает почему.
  const wrong = await runTool("propose_balance", { transformation: "Оксимирование циклогексанона", basis: "Циклогексаноноксим" }, { slice: g, kinds: PROPOSAL_KINDS });
  assert.equal(wrong.proposal.basisId, undefined);
  assert.match(wrong.result.basis, /не сырьё/);
  // Старый клиент без «вернуть раскладку» — инструмента нет.
  assert.deepEqual((await runTool("undo_layout", {}, { slice: g, kinds: PROPOSAL_KINDS })).proposal, { kind: "unlayout" });
  assert.match((await runTool("undo_layout", {}, { slice: g, kinds: ["step", "show", "layout"] })).result.error, /Нет инструмента/);
});

test("«Свои данные» таблицей — строками; выделенные узлы — в промпте", async () => {
  const b = await tool("propose_balance", {
    transformation: "Кумольный способ",
    known_data: { inputs: { "Изопропилбензол (кумол)": 912 }, outputs: { Фенол: 600 }, note: "по общим сведениям" },
  });
  assert.equal(b.proposal.knownData, "inputs:\n  Изопропилбензол (кумол): 912\noutputs:\n  Фенол: 600\nnote: по общим сведениям");
  const g = readGraphSlice({
    products: [{ id: "a", label: "Чай" }, { id: "b", label: "Йогурт" }],
    selection: [{ id: "a", label: "Чай" }, { id: "b", label: "Йогурт" }, { id: "", label: "без id" }],
  });
  assert.equal(g.selection.length, 2);
  assert.match(chatSystemPrompt(g, PROPOSAL_KINDS), /ВЫДЕЛЕНО НА ГРАФЕ \(2\): «Чай»; «Йогурт»\./);
  // Один выделенный — это «выбранный узел», отдельного списка нет.
  assert.doesNotMatch(chatSystemPrompt(readGraphSlice({ selection: [{ id: "a", label: "Чай" }] }), PROPOSAL_KINDS), /ВЫДЕЛЕНО НА ГРАФЕ \(/);
});

test("источники в срезе — не больше чем у 80 продуктов", () => {
  const many = readGraphSlice({
    products: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, label: `П${i}`, sources: { down: { count: 1, titles: ["x"] } } })),
  });
  assert.equal(many.products.filter((p) => p.sources).length, 80);
});

test("страховка: «предложение показано в карточке» без карточки — поправка", () => {
  assert.equal(claimedAction("Предложение показано в карточке — шаг вверх от «фенола» ты построишь сам."), "показано в карточке");
  assert.equal(claimedAction("На графе уже показаны альтернативы фенола."), null);
  assert.equal(claimedAction("Предложение не показано: фенола нет."), null);
  assert.equal(claimedTool("Верну раскладку, как было", new Set(["undo_layout", "relayout"])), "undo_layout");
  assert.equal(claimedTool("Разложил граф заново", new Set(["undo_layout", "relayout"])), "relayout");
});

test("альтернативы без шага, описание, карточка, закладки", async () => {
  assert.deepEqual((await tool("find_alternatives", { product: "кумол", direction: "up" })).proposal, {
    kind: "alternatives",
    nodeId: "n4",
    label: "Кумол",
    direction: "up",
    why: "",
  });
  const d = await tool("set_description", { node: "водород", description: "Газ, восстановитель.", industry: "Химия", main_purpose: "Гидрирование" });
  assert.deepEqual(d.proposal, { kind: "describe", nodeId: "n5", label: "Водород", description: "Газ, восстановитель.", industry: "Химия", mainPurpose: "Гидрирование" });
  assert.equal((await tool("set_description", { node: "Водород", description: " " })).proposal, undefined);
  assert.deepEqual((await tool("fill_card", { node: "Кумольный способ" })).proposals, [{ kind: "fillcard", nodeId: "t1", label: "Кумольный способ", nodeKind: "transformation", why: "" }]);
  // Выделенные — одним вызовом, по карточке на узел; чего нет — модели.
  const many = await tool("fill_card", { nodes: ["Фенол", "Водород", "Фенол", "Уран"] });
  assert.deepEqual(many.proposals.map((p) => p.label), ["Фенол", "Водород"]);
  assert.deepEqual(many.result.missing, ["Уран"]);
  assert.equal(many.summary, "предложено заполнить карточки: 2");
  assert.deepEqual((await tool("bookmark_nodes", { names: ["Фенол", "Фенол", "Уран"], remove: true })).proposal, {
    kind: "bookmark",
    nodes: [{ id: "n1", label: "Фенол" }],
    remove: true,
  });
});

test("промпт: последние изменения графа и концы цепочек — для «дальше»", () => {
  const sl = readGraphSlice({
    products: [{ id: "a", label: "Кумол" }, { id: "b", label: "Фенол" }, { id: "c", label: "Смолы" }, { id: "d", label: "Автомобиль" }],
    transformations: [
      { id: "t1", label: "Кумольный способ", inputs: ["Кумол"], outputs: ["Фенол"] },
      { id: "t2", label: "Синтез смол", inputs: ["Фенол"], outputs: ["Смолы"] },
    ],
    recent: [{ title: "Шаг принят", details: "«Синтез смол» вниз от «Фенол»: новые продукты «Смолы»" }],
  });
  const p = chatSystemPrompt(sl, PROPOSAL_KINDS, { mode: "auto" });
  assert.match(p, /ПОСЛЕДНИЕ ИЗМЕНЕНИЯ ГРАФА[^\n]*\n- Шаг принят: «Синтез смол» вниз от «Фенол»/);
  assert.match(p, /дальше вниз[^\n]*: Смолы\n/);
  assert.match(p, /дальше вверх[^\n]*: Кумол\n/);
  assert.match(p, /без связей: Автомобиль/);
  assert.match(p, /не спрашивай «запустить\?»/);
  assert.match(p, /find_alternatives/);
});

test("check_steps: проверка шага моделью по сырью и продуктам графа, запросы — в счётчик", async () => {
  checks = [];
  checkReplies = {
    "Кумольный способ": {
      verdict: "wrong",
      summary: "из кумола так фенол не получают",
      renames: [],
      transformation_name: "",
      transformation_description: "",
    },
  };
  const out = await tool("check_steps", { transformations: ["кумольный", "Гидрирование", "Пиролиз"] });
  assert.equal(checks.length, 2);
  assert.match(checks[0], /Сырьё:\n- «Изопропилбензол \(кумол\)»/);
  assert.deepEqual(
    out.result.checked.map((r) => [r.transformation, r.verdict]),
    [["Кумольный способ", "wrong"], ["Гидрирование", "ok"]],
  );
  assert.equal(out.summary, "проверка шагов: 2 — верно 1, исправить 0, ошибочно 1");
  assert.equal(out.requests, 2);

  // Через цикл чата — запросы проверки видны в итоге.
  calls = [];
  replies = [{ calls: [["check_steps", { transformations: ["Кумольный способ"] }]] }, { content: "Кумольный способ ошибочен." }];
  const { done } = await chat("проверь кумольный способ");
  assert.equal(done.usage.requests, 3);
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
  await post({ message: "Привет", proposals: ["step", "show", "rename"], mode: "auto" });
  assert.ok(toolNames(calls[0]).includes("propose_rename"));
  assert.ok(!toolNames(calls[0]).includes("propose_merge"));
  assert.match(calls[0].messages[0].content, /РЕЖИМ АВТОПИЛОТА/);
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
