// routes/chat/tools.js
//
// Инструменты модели в чате (этап 4 PG-MIGRATION.md).
//
// Чтение — без модели и бесплатно: карточка знаний о продукте (этап 3б),
// поиск по тексту разделов ИТС (3а), узел открытого графа (срез клиента).
//
// Предложения — ничего не делают на сервере: возвращаются клиенту карточками,
// а меняет граф человек («Построить шаг» открывает обычный мастер шага).
// Шаг — только от продукта, который уже есть на графе: мастер открывается у
// узла.
//
// Ответы инструментов — короткий JSON: модели нужны факты и ссылки, а не
// выгрузка базы, и каждый лишний знак — токены тарифа.

const { sourcesStoreKind } = require("../../db/sourcesDb");
const { findProducts, graphNode } = require("./graphSlice");

const DIRECTION = { up: "вверх — из чего его делают", down: "вниз — что из него делают" };

const fn = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const TOOLS = [
  fn(
    "product_card",
    "Что база сервера знает о продукте: названия и синонимы, CAS, коды ОКПД2/ТН ВЭД, разделы ИТС (где получают и где он сырьё) со стадиями процессов, преобразования из разделов и графов библиотеки, готовые расчёты материального баланса, графы, где он есть.",
    { name: { type: "string", description: "Название продукта, как в графе или общепринятое" } },
    ["name"],
  ),
  fn(
    "search_sources",
    "Поиск по тексту разделов отраслевых справочников ИТС (НДТ). Ищет по словам (основы слов), поэтому запрос — ключевые слова и названия веществ, а не вопрос: «этиленгликоль антифриз», а не «из чего делают антифриз».",
    {
      query: { type: "string", description: "Ключевые слова" },
      product: { type: "string", description: "Необязательно: только разделы, связанные с этим продуктом" },
      direction: { type: "string", enum: ["up", "down"], description: "С product: up — где его получают, down — где он сырьё" },
    },
    ["query"],
  ),
  fn(
    "graph_node",
    "Узел открытого графа: есть ли продукт на графе, какими преобразованиями его получают и во что он идёт.",
    { name: { type: "string", description: "Название продукта" } },
    ["name"],
  ),
  fn(
    "propose_step",
    "Предложить человеку построить шаг от продукта, который ЕСТЬ на открытом графе: up — из чего его делают, down — что из него делают. Шаг строит человек в мастере шага (поиск источников, обобщение, превью).",
    {
      product: { type: "string", description: "Продукт на графе" },
      direction: { type: "string", enum: ["up", "down"] },
      why: { type: "string", description: "Коротко — зачем этот шаг" },
    },
    ["product", "direction"],
  ),
  fn(
    "show_nodes",
    "Показать человеку узлы на открытом графе (выделить и подвести камеру).",
    { names: { type: "array", items: { type: "string" }, description: "Названия продуктов на графе" } },
    ["names"],
  ),
];

/** Карточка знаний — коротко, для модели. */
function briefCard(c, onGraph) {
  const section = (s) => `${s.docTitle} · ${s.title} (${s.pages})`;
  return {
    names: c.product.names.slice(0, 10),
    cas: c.product.cas,
    okpd2: c.product.codes?.okpd2 ? `${c.product.codes.okpd2.code} ${c.product.codes.okpd2.name}` : null,
    tnved: c.product.codes?.tnved ? `${c.product.codes.tnved.code} ${c.product.codes.tnved.name}` : null,
    onOpenGraph: onGraph,
    sectionsUp: c.sections.up.slice(0, 6).map(section),
    sectionsDown: c.sections.down.slice(0, 6).map(section),
    fromSections: c.transformations.fromSections.slice(0, 8).map((t) => ({
      direction: t.direction,
      source: t.source,
      ...(t.multi ? { note: "раздел о нескольких производствах" } : { inputs: t.inputs, outputs: t.outputs }),
      stages: t.stages.slice(0, 3),
    })),
    fromGraphs: c.transformations.fromGraphs.slice(0, 8).map((t) => ({
      direction: t.direction,
      transformation: t.label,
      inputs: t.inputs,
      outputs: t.outputs,
      graphs: t.graphs.length,
    })),
    balances: c.balances.slice(0, 5).map((b) => `№${b.id} ${b.title} (${b.status})`),
    graphs: c.graphs.slice(0, 8).map((g) => g.name),
    counts: c.counts,
  };
}

/**
 * Выполнить вызов инструмента.
 * @param ctx { slice, conn?, pool? } — срез графа и базы (conn — только с SOURCES_STORE=pg)
 * @returns { result: объект для модели, summary: строка для человека, proposal? }
 */
async function runTool(name, args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);

  if (name === "graph_node") {
    const product = str(a.name);
    const node = graphNode(ctx.slice, product);
    return {
      result: node,
      summary: node.found ? `«${product}» на графе` : `«${product}» — на графе нет`,
    };
  }

  if (name === "propose_step") {
    const product = str(a.product);
    const direction = a.direction === "up" ? "up" : "down";
    const [node] = findProducts(ctx.slice, product);
    if (!node) {
      return {
        result: { ok: false, error: `«${product}» нет на открытом графе — шаг строится от узла графа. Предложи шаг от продукта, который есть на графе, или скажи человеку.` },
        summary: `шаг от «${product}» — на графе нет`,
      };
    }
    const proposal = { kind: "step", nodeId: node.id, label: node.label, direction, why: str(a.why, 500) };
    return {
      result: { ok: true, note: "Предложение показано человеку карточкой; шаг он построит сам в мастере." },
      summary: `предложен шаг ${direction === "up" ? "вверх" : "вниз"} от «${node.label}»`,
      proposal,
    };
  }

  if (name === "show_nodes") {
    const names = (Array.isArray(a.names) ? a.names : []).map((n) => str(n)).filter(Boolean).slice(0, 20);
    const nodes = [];
    for (const n of names) for (const p of findProducts(ctx.slice, n)) if (!nodes.some((x) => x.id === p.id)) nodes.push(p);
    if (!nodes.length) {
      return { result: { ok: false, error: "Таких узлов на открытом графе нет." }, summary: "показать на графе — узлов нет" };
    }
    return {
      result: { ok: true, shown: nodes.map((p) => p.label) },
      summary: `показать на графе: ${nodes.length}`,
      proposal: { kind: "show", nodes },
    };
  }

  if (name === "product_card" || name === "search_sources") {
    if (sourcesStoreKind() !== "pg" || !ctx.conn) {
      return { result: { error: "База знаний недоступна (нужна база источников в PostgreSQL)." }, summary: "база знаний недоступна" };
    }
  }

  if (name === "product_card") {
    const product = str(a.name);
    const card = await require("../knowledge/product").productCard(ctx.conn, product, { pool: ctx.pool });
    if (!card) return { result: { error: "В названии нет слов, по которым искать." }, summary: `карточка «${product}» — пусто` };
    const n = card.counts;
    return {
      result: briefCard(card, findProducts(ctx.slice, product).length > 0),
      summary: `карточка «${product}»: разделов ${n.sectionsUp + n.sectionsDown}, графов ${n.graphs}, расчётов ${n.balances}`,
    };
  }

  if (name === "search_sources") {
    const query = str(a.query);
    const direction = ["up", "down"].includes(a.direction) ? a.direction : null;
    const product = str(a.product);
    const { chunksReady } = require("../knowledge/chunks");
    if (!(await chunksReady(ctx.conn))) {
      return { result: { error: "Поиск по тексту ИТС не настроен (npm run pg:migrate)." }, summary: "поиск по ИТС недоступен" };
    }
    const found = await require("../knowledge/search").searchSections(ctx.conn, query, { limit: 5, product, direction });
    return {
      result: {
        results: found.map((r) => ({
          source: `${r.docTitle} · ${r.title} (${r.pages})`,
          excerpt: r.excerpt.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 600),
          allWords: r.match === "all",
        })),
      },
      summary: `поиск в ИТС «${query}»${product ? ` у «${product}» ${DIRECTION[direction] ?? ""}` : ""}: ${found.length}`,
    };
  }

  return { result: { error: `Нет инструмента ${name}` }, summary: `нет инструмента ${name}` };
}

module.exports = { TOOLS, runTool, briefCard };
