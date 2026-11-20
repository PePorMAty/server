// routes/chat/context.js
//
// Справка до ответа: что сервер узнал сам, прежде чем спрашивать модель, —
// узлы графа, упомянутые в сообщении (mentions.js), и выбранный узел с
// соседями и альтернативами, а для продукта — карточка знаний из базы.
//
// Зачем. Быстрая модель часто не вызывает инструменты и отвечает по памяти
// (20.11: «кучерянский процесс», «готового расчёта для другого
// преобразования» при нужном узле на графе). Справка — это то, что модель
// всё равно должна была бы посмотреть: чтение базы бесплатно, а лишний круг
// модели стоит запроса. Подробности по-прежнему — инструментами.
//
// Человек видит справку в «Что смотрел ИИ», как вызовы инструментов.

const { graphNode, findProducts } = require("./graphSlice");
const { mentionedNodes } = require("./mentions");

/** Карточек знаний в справке — не больше: каждая — сотни токенов. */
const MAX_CARDS = 2;

/**
 * @returns {{ text: string, steps: { name, args, summary }[] }} text — для
 *   промпта ("" — справки нет), steps — для «Что смотрел ИИ».
 */
async function prefetchContext(slice, message, { runTool, ctx } = {}) {
  const found = mentionedNodes(slice, message);
  const steps = [];
  const facts = {};

  // Узлы графа: выбранный и упомянутые продукты — с соседями.
  const productNames = [
    ...(slice.selectedLabel ? [slice.selectedLabel] : []),
    ...found.products.map((p) => p.label),
  ].filter((n, i, all) => all.indexOf(n) === i);
  const nodes = productNames.map((n) => graphNode(slice, n)).filter((n) => n.found);
  if (nodes.length) {
    facts.graphNodes = nodes;
    steps.push({ name: "graph_node", args: { names: productNames }, summary: `справка: узлы графа — ${nodes.map((n) => `«${n.nodes[0]}»`).join(", ")}` });
  }
  if (found.transformations.length) {
    facts.transformations = found.transformations.map((t) => ({ transformation: t.label, inputs: t.inputs, outputs: t.outputs }));
    steps.push({
      name: "graph_node",
      args: { transformations: found.transformations.map((t) => t.label) },
      summary: `справка: преобразования — ${found.transformations.map((t) => `«${t.label}»`).join(", ")}`,
    });
  }
  if (found.alternatives.length) {
    facts.alternatives = found.alternatives.map((a) => ({ alternative: a.label, of: a.of, direction: a.direction }));
  }

  // Карточки знаний — по продуктам графа, о которых речь. Нет базы знаний
  // (SQLite) — runTool скажет, и справка обойдётся без них.
  if (runTool && ctx?.conn) {
    const cards = [];
    for (const name of productNames.slice(0, MAX_CARDS)) {
      if (!findProducts(slice, name).length) continue;
      try {
        const out = await runTool("product_card", { name }, ctx);
        if (!out.result?.error) {
          cards.push({ product: name, ...out.result });
          steps.push({ name: "product_card", args: { name }, summary: `справка: ${out.summary}` });
        }
      } catch (e) {
        console.warn(`[chat] справка: карточка «${name}»:`, e.message);
      }
    }
    if (cards.length) facts.productCards = cards;
  }

  const text = Object.keys(facts).length
    ? `СПРАВКА (сервер собрал до ответа — опирайся на неё; подробности — инструментами):\n${JSON.stringify(facts)}`
    : "";
  return { text, steps };
}

module.exports = { prefetchContext };
