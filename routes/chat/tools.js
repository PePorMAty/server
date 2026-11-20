// routes/chat/tools.js
//
// Инструменты модели в чате (этап 4 PG-MIGRATION.md).
//
// Чтение — без модели и бесплатно: карточка знаний о продукте (этап 3б),
// поиск по тексту разделов ИТС (3а), узел открытого графа (срез клиента),
// готовый расчёт материального баланса из базы.
//
// Предложения — ничего не делают на сервере: возвращаются клиенту карточками,
// а меняет граф человек своей кнопкой. Каждое ведёт в то, что на сайте уже
// есть: шаг — мастер шага у узла, коды — окно «Определить коды», баланс —
// расчёт во вкладке карточки преобразования, техописание — вкладка карточки,
// переименование и объединение — те же действия, что у человека (с окном
// «Такой продукт уже есть»), новый продукт — узел на полотне. Поэтому всё,
// кроме нового продукта, — только для узлов, которые ЕСТЬ на открытом графе.
//
// Режим чата (4.4): «с подтверждением» — карточки с кнопкой; «автопилот» —
// сайт выполняет вызванное сам и присылает итог следующим сообщением.
// Инструменты те же: режим знает промпт и клиент.
//
// Клиент присылает, какие карточки умеет показывать (proposals в запросе);
// модель видит только эти инструменты. Клиент первой версии чата знает шаг
// и показ — для него набор прежний, и незнакомая карточка его не уронит.
//
// Ответы инструментов — короткий JSON: модели нужны факты и ссылки, а не
// выгрузка базы, и каждый лишний знак — токены тарифа.

const { sourcesStoreKind } = require("../../db/sourcesDb");
const { findProducts, findTransformations, findAlternatives, findNode, graphNode } = require("./graphSlice");

const DIRECTION = { up: "вверх — из чего его делают", down: "вниз — что из него делают" };

/** Инструмент-предложение → вид карточки у клиента. */
const PROPOSAL_TOOLS = {
  propose_step: "step",
  show_nodes: "show",
  propose_codes: "codes",
  propose_balance: "balance",
  propose_description: "tech",
  propose_rename: "rename",
  propose_merge: "merge",
  add_product: "add",
};
const PROPOSAL_KINDS = Object.values(PROPOSAL_TOOLS);
/** Что умеет клиент, не приславший proposals (первая версия чата). */
const DEFAULT_KINDS = ["step", "show"];

/** Виды карточек из запроса клиента: знакомые серверу, без повторов. */
function readKinds(raw) {
  if (!Array.isArray(raw)) return DEFAULT_KINDS;
  const kinds = PROPOSAL_KINDS.filter((k) => raw.includes(k));
  return kinds.length ? kinds : DEFAULT_KINDS;
}

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
    "Показать человеку узлы на открытом графе (выделить и подвести камеру): продукты, преобразования, альтернативы. Название продукта с alternatives: true — показать его альтернативы (фиолетовые варианты шага).",
    {
      names: { type: "array", items: { type: "string" }, description: "Названия узлов на графе" },
      alternatives: { type: "boolean", description: "Показать альтернативы этих продуктов, а не сами продукты" },
    },
    ["names"],
  ),
  fn(
    "balance_calc",
    "Готовый расчёт материального баланса из базы сервера по номеру (номера — в product_card, поле balances): сырьё, продукты с массами на базис, итог «вход — выход», источники.",
    { id: { type: "integer", description: "Номер расчёта, например 12 из «№12 …»" } },
    ["id"],
  ),
  fn(
    "propose_codes",
    "Предложить человеку определить коды ОКПД2 и ТН ВЭД продуктов открытого графа: откроется окно «Определить коды», коды подберёт модель по классификаторам за отдельные запросы. Предлагай, когда кодов нет в product_card или человек о них спрашивает.",
    {
      products: { type: "array", items: { type: "string" }, description: "Продукты на графе" },
      why: { type: "string", description: "Коротко — зачем" },
    },
    ["products"],
  ),
  fn(
    "propose_balance",
    "Рассчитать материальный баланс преобразования открытого графа: сайт откроет вкладку баланса и запустит расчёт по ИТС (готовый из базы придёт сразу, новый — минуты, это запросы к модели). Преобразования узла покажет graph_node.",
    {
      transformation: { type: "string", description: "Преобразование на графе" },
      product: { type: "string", description: "Необязательно: продукт этого преобразования — если одноимённых преобразований несколько" },
      why: { type: "string", description: "Коротко — зачем" },
    },
    ["transformation"],
  ),
  fn(
    "propose_description",
    "Предложить человеку открыть технологическое описание узла открытого графа — продукта или преобразования (вкладка карточки; описание собирается по источникам).",
    {
      node: { type: "string", description: "Продукт или преобразование на графе" },
      why: { type: "string", description: "Коротко — зачем" },
    },
    ["node"],
  ),
  fn(
    "propose_rename",
    "Предложить человеку переименовать узел открытого графа: опечатка, неточное или нестандартное название. Если новое название — продукт, который уже есть на графе, человеку предложат объединить узлы.",
    {
      node: { type: "string", description: "Узел на графе, как он назван сейчас" },
      new_name: { type: "string", description: "Новое название" },
      why: { type: "string", description: "Коротко — почему" },
    },
    ["node", "new_name"],
  ),
  fn(
    "add_product",
    "Добавить на граф новый продукт-узел (без связей). near — продукт графа, рядом с которым поставить. Связать его с цепочкой можно потом шагом от него или от соседа.",
    {
      name: { type: "string", description: "Название продукта" },
      near: { type: "string", description: "Необязательно: продукт на графе, рядом с которым поставить" },
      why: { type: "string", description: "Коротко — зачем" },
    },
    ["name"],
  ),
  fn(
    "propose_merge",
    "Предложить человеку объединить два узла одного продукта под разными названиями (синонимы: «Кумол» и «Изопропилбензол»). Связи первого перейдут ко второму, первый исчезнет.",
    {
      node: { type: "string", description: "Узел, который уйдёт" },
      into: { type: "string", description: "Узел, который останется" },
      why: { type: "string", description: "Коротко — почему это один продукт" },
    },
    ["node", "into"],
  ),
];

/** Инструменты для клиента, который умеет карточки kinds. */
const toolsFor = (kinds) => TOOLS.filter((t) => !PROPOSAL_TOOLS[t.function.name] || kinds.includes(PROPOSAL_TOOLS[t.function.name]));

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

/** Расчёт баланса — коротко, для модели. */
function briefBalance(b) {
  return {
    id: b.id,
    title: b.title,
    transformation: b.transformation,
    inputs: b.inputs,
    targets: b.targets,
    basis: b.basisText || null,
    status: b.statusLabel || b.status,
    products: (b.products ?? []).slice(0, 12).map((p) => `${p.name || p.ref}: ${p.massText || "нет данных"}`),
    totals: b.totals ?? null,
    sources: (b.sources ?? []).slice(0, 5).map((s) => s.title || s.url),
  };
}

/** Отказ предложения: модель узнаёт почему и может поправиться. */
const refuse = (error, summary) => ({ result: { ok: false, error }, summary });
const shown = (summary, proposal) => ({
  result: { ok: true, note: "Предложение показано человеку карточкой; сделает он сам." },
  summary,
  proposal,
});

/**
 * Выполнить вызов инструмента.
 * @param ctx { slice, kinds?, conn?, pool? } — срез графа, карточки клиента
 *   (readKinds) и базы (conn — только с SOURCES_STORE=pg)
 * @returns { result: объект для модели, summary: строка для человека, proposal? }
 */
async function runTool(name, args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);
  const kind = PROPOSAL_TOOLS[name];
  if (kind && !(ctx.kinds ?? DEFAULT_KINDS).includes(kind)) {
    return { result: { error: `Нет инструмента ${name}` }, summary: `нет инструмента ${name}` };
  }
  const why = str(a.why, 500);

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
    const proposal = { kind: "step", nodeId: node.id, label: node.label, direction, why };
    return {
      result: { ok: true, note: "Предложение показано человеку карточкой; шаг он построит сам в мастере." },
      summary: `предложен шаг ${direction === "up" ? "вверх" : "вниз"} от «${node.label}»`,
      proposal,
    };
  }

  if (name === "show_nodes") {
    const names = (Array.isArray(a.names) ? a.names : []).map((n) => str(n)).filter(Boolean).slice(0, 20);
    const nodes = [];
    const add = (n) => {
      if (n && !nodes.some((x) => x.id === n.id)) nodes.push({ id: n.id, label: n.label });
    };
    for (const n of names) {
      if (a.alternatives) {
        findAlternatives(ctx.slice, n).forEach(add);
        continue;
      }
      const products = findProducts(ctx.slice, n);
      if (products.length) products.forEach(add);
      else add(findNode(ctx.slice, n) ?? findAlternatives(ctx.slice, n)[0]);
    }
    if (!nodes.length) {
      return { result: { ok: false, error: "Таких узлов на открытом графе нет." }, summary: "показать на графе — узлов нет" };
    }
    return {
      result: { ok: true, shown: nodes.map((p) => p.label) },
      summary: `показать на графе: ${nodes.length}`,
      proposal: { kind: "show", nodes },
    };
  }

  if (name === "propose_codes") {
    const names = (Array.isArray(a.products) ? a.products : []).map((n) => str(n)).filter(Boolean).slice(0, 20);
    const nodes = [];
    for (const n of names) {
      const [p] = findProducts(ctx.slice, n);
      if (p && !nodes.some((x) => x.id === p.id)) nodes.push(p);
    }
    if (!nodes.length) return refuse("Этих продуктов нет на открытом графе — коды определяются у узлов графа.", "коды — продуктов на графе нет");
    return shown(`предложено определить коды: ${nodes.length}`, { kind: "codes", nodes, why });
  }

  if (name === "propose_balance") {
    const label = str(a.transformation);
    const [t] = findTransformations(ctx.slice, label, str(a.product));
    if (!t) {
      return refuse(
        `Преобразования «${label}» нет на открытом графе — баланс считается у преобразования графа. Какими преобразованиями связан продукт, покажет graph_node.`,
        `баланс «${label}» — на графе нет`,
      );
    }
    return shown(`предложен баланс «${t.label}»`, { kind: "balance", nodeId: t.id, label: t.label, why });
  }

  if (name === "propose_description") {
    const label = str(a.node);
    const node = findNode(ctx.slice, label);
    if (!node) return refuse(`«${label}» нет на открытом графе.`, `описание «${label}» — на графе нет`);
    return shown(`предложено описание «${node.label}»`, { kind: "tech", nodeId: node.id, label: node.label, nodeKind: node.kind, why });
  }

  if (name === "propose_rename") {
    const label = str(a.node);
    const newLabel = str(a.new_name, 200).replace(/\s+/g, " ");
    const node = findNode(ctx.slice, label);
    if (!node) return refuse(`«${label}» нет на открытом графе.`, `переименовать «${label}» — на графе нет`);
    if (!newLabel || newLabel.toLowerCase() === node.label.toLowerCase()) {
      return refuse("Новое название пустое или совпадает с нынешним.", `переименовать «${node.label}» — то же название`);
    }
    return shown(`предложено переименовать «${node.label}» → «${newLabel}»`, {
      kind: "rename",
      nodeId: node.id,
      label: node.label,
      newLabel,
      nodeKind: node.kind,
      why,
    });
  }

  if (name === "add_product") {
    const label = str(a.name, 200).replace(/\s+/g, " ");
    if (!label) return refuse("Нужно название продукта.", "добавить продукт — без названия");
    const [same] = findProducts(ctx.slice, label);
    if (same && same.label.toLowerCase() === label.toLowerCase()) {
      return refuse(`«${same.label}» уже есть на графе — покажи его (show_nodes).`, `добавить «${label}» — уже на графе`);
    }
    const [near] = a.near ? findProducts(ctx.slice, str(a.near)) : [];
    return shown(`предложено добавить продукт «${label}»`, {
      kind: "add",
      label,
      ...(near ? { nearId: near.id, nearLabel: near.label } : {}),
      why,
    });
  }

  if (name === "propose_merge") {
    const fromName = str(a.node);
    const intoName = str(a.into);
    const [from] = findProducts(ctx.slice, fromName);
    const into = from && findProducts(ctx.slice, intoName).find((p) => p.id !== from.id);
    if (!from || !into) {
      return refuse(
        "Объединяются два разных узла-продукта, которые оба есть на открытом графе; одного из них нет.",
        `объединить «${fromName}» и «${intoName}» — узлов нет`,
      );
    }
    return shown(`предложено объединить «${from.label}» → «${into.label}»`, {
      kind: "merge",
      fromId: from.id,
      fromLabel: from.label,
      intoId: into.id,
      intoLabel: into.label,
      why,
    });
  }

  if (name === "balance_calc") {
    const id = Number(a.id);
    if (!Number.isInteger(id) || id <= 0) return { result: { error: "Нужен номер расчёта — целое число." }, summary: "расчёт баланса — без номера" };
    const b = await require("../material-balance/utils/store").get(id);
    if (!b) return { result: { error: `Расчёта №${id} в базе нет.` }, summary: `расчёт баланса №${id} — нет` };
    return { result: briefBalance(b), summary: `расчёт баланса №${id}: ${b.title}` };
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

module.exports = { TOOLS, toolsFor, runTool, briefCard, briefBalance, readKinds, PROPOSAL_KINDS, DEFAULT_KINDS };
