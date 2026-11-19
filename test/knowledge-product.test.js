// Слой знаний, этап 3б PG-MIGRATION.md: указатель узлов графов
// (routes/knowledge/graphIndex.js) и карточка знаний о продукте
// (routes/knowledge/product.js). Нужен PostgreSQL (TEST_DATABASE_URL).
//
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { indexRows, ensureGraphIndex, resetIndexReady } = require("../routes/knowledge/graphIndex");
const { addDoc, addSection, backends, PG_URL } = require("./helpers/sources");

// Коды, определённые моделью, — во временном файле.
const codesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codes-")), "product-codes.json");
process.env.PRODUCT_CODES_FILE = codesFile;
fs.writeFileSync(
  codesFile,
  JSON.stringify({ "canon:изопропилбензол": { name: "Изопропилбензол", okpd2: { code: "20.14.12.120", name: "Кумол" } } }),
);

const store = require("../routes/local-sources/utils/store");
const balanceStore = require("../routes/material-balance/utils/store");
const { createPgStore } = require("../routes/graph-files/store");
const { productCard } = require("../routes/knowledge/product");

/** Граф: продукты и преобразования «сырьё → продукты». */
function graph(name, steps) {
  const nodes = [];
  const edges = [];
  const product = (label) => {
    const id = `p:${label}`;
    if (!nodes.some((n) => n.id === id)) nodes.push({ id, type: "product", data: { label } });
    return id;
  };
  steps.forEach(([label, inputs, outputs], i) => {
    const t = `t${i}`;
    nodes.push({ id: t, type: "transformation", data: { label } });
    for (const x of inputs) edges.push({ id: `e${i}i${x}`, source: product(x), target: t });
    for (const x of outputs) edges.push({ id: `e${i}o${x}`, source: t, target: product(x) });
  });
  return { meta: { name }, graph: { nodes, edges }, state: { leaf_nodes: [], has_more: false } };
}

test("указатель: продукт — с ключами названия, преобразование — с сырьём и продуктами", () => {
  const rows = indexRows(graph("Г", [["Кумольный способ", ["Кумол", "Кислород"], ["Фенол", "Ацетон"]]]));
  const tr = rows.find((r) => r.type === "transformation");
  assert.deepEqual(tr.inputs, ["Кумол", "Кислород"]);
  assert.deepEqual(tr.outputs, ["Фенол", "Ацетон"]);
  // «Кумол» — по справочнику синонимов и под именем «Изопропилбензол».
  assert.ok(tr.in_keys.includes(store.productKeys("Изопропилбензол")[0]));
  assert.equal(rows.filter((r) => r.type === "product").length, 4);
});

for (const backend of backends().filter((b) => b.name === "PostgreSQL")) {
  describe("карточка знаний о продукте — PostgreSQL", () => {
    let close;
    let pool;
    let graphs;
    before(async () => {
      close = await backend.open();
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: PG_URL, max: 3, options: "-c search_path=app,public" });
      await pool.query("TRUNCATE app.graphs CASCADE");
      resetIndexReady();
      graphs = createPgStore({ pool });

      const its = await addDoc({ shortTitle: "ИТС 18—2023" });
      await addSection(its, "3.6 Производство фенола и ацетона", { product: ["Фенол", "Ацетон"], raw: ["Изопропилбензол"] });
      await addSection(its, "3.4 Производство кумола", { product: ["Кумол"], raw: ["Бензол", "Пропилен"] });
      await balanceStore.save({
        transformation: "Кумольный способ",
        inputs: ["Кумол"],
        targets: ["Фенол", "Ацетон"],
        basisAmount: { amount: 1, unit: "т", kg: 1000 },
        answer: "…",
        parsed: { status: "calculated", statusLabel: "Рассчитан" },
        refs: [],
      });
    });
    after(async () => {
      await pool.query("TRUNCATE app.graphs CASCADE");
      await pool.end();
      await close();
    });

    test("сохранение графа строит указатель; правка — пересчитывает; удаление — убирает", async () => {
      await graphs.createGraph("a.json", graph("Фенол", [["Кумольный способ", ["Кумол", "Кислород"], ["Фенол", "Ацетон"]]]));
      await graphs.createGraph("b.json", graph("Нефтехимия", [
        ["Алкилирование бензола пропиленом", ["Бензол", "Пропилен"], ["Изопропилбензол"]],
        ["Кумольный способ", ["Кумол", "Кислород"], ["Фенол", "Ацетон"]],
      ]));
      await graphs.whenIndexed();
      let card = await productCard(await store.connection(), "Кумол", { pool });
      assert.deepEqual(card.graphs.map((g) => g.name).sort(), ["Нефтехимия", "Фенол"]);
      // Одинаковое преобразование двух графов — одной строкой.
      const cumene = card.transformations.fromGraphs.find((t) => t.label === "Кумольный способ");
      assert.equal(cumene.graphs.length, 2);
      assert.equal(cumene.direction, "down");
      assert.equal(card.transformations.fromGraphs.find((t) => t.label.startsWith("Алкилирование")).direction, "up");

      // Правка: кумол из графа «Фенол» убран.
      await graphs.updateGraph("a.json", (g) => ({ ...g, ...graph("Фенол", [["Гидрирование", ["Фенол", "Водород"], ["Циклогексанол"]]]) }));
      await graphs.whenIndexed();
      card = await productCard(await store.connection(), "Кумол", { pool });
      assert.deepEqual(card.graphs.map((g) => g.name), ["Нефтехимия"]);
      // Переименование не меняет узлы — имя в карточке новое.
      await graphs.updateGraph("b.json", (g) => ({ ...g, meta: { ...g.meta, name: "Нефтехимия 2" } }), { bump: false });
      await graphs.whenIndexed();
      card = await productCard(await store.connection(), "Кумол", { pool });
      assert.deepEqual(card.graphs.map((g) => g.name), ["Нефтехимия 2"]);
      // Удаление — графа в карточке нет.
      await graphs.deleteGraph("b.json");
      await graphs.whenIndexed();
      card = await productCard(await store.connection(), "Кумол", { pool });
      assert.deepEqual(card.graphs, []);
    });

    test("при запуске: указатель графов, где он отстал или его нет", async () => {
      await graphs.createGraph("c.json", graph("Бензол", [["Риформинг", ["Нафта"], ["Бензол"]]]));
      await graphs.whenIndexed();
      await pool.query("DELETE FROM app.graph_index WHERE graph_id = 'c.json'");
      await pool.query("DELETE FROM app.graph_nodes WHERE graph_id = 'c.json'");
      const built = await ensureGraphIndex(pool);
      assert.equal(built.graphs, 1);
      assert.equal((await ensureGraphIndex(pool)).graphs, 0);
      const card = await productCard(await store.connection(), "Бензол", { pool });
      assert.ok(card.graphs.some((g) => g.graphId === "c.json"));
    });

    test("карточка: названия, CAS и коды по синонимам, разделы, преобразования разделов, расчёты", async () => {
      await graphs.putProductIds("c.json", [["p:Бензол", { productId: "71-43-2", productIdSource: "cas" }]]);
      const benzene = await productCard(await store.connection(), "Бензол", { pool });
      assert.deepEqual(benzene.product.ids.map((i) => i.id), ["71-43-2"]);

      const card = await productCard(await store.connection(), "Кумол", { pool });
      assert.equal(card.product.canon, "Изопропилбензол");
      assert.equal(card.product.cas, "98-82-8");
      assert.ok(card.product.names.includes("Кумол") && card.product.names.includes("ИПБ"));
      // Код записан для канона — достаётся и «Кумолу».
      assert.equal(card.product.codes?.okpd2?.code, "20.14.12.120");
      assert.deepEqual(card.sections.up.map((s) => s.title), ["3.4 Производство кумола"]);
      assert.deepEqual(card.sections.down.map((s) => s.title), ["3.6 Производство фенола и ацетона"]);
      const down = card.transformations.fromSections.find((t) => t.direction === "down");
      assert.deepEqual(down.inputs, ["Изопропилбензол"]);
      assert.deepEqual(down.outputs, ["Фенол", "Ацетон"]);
      assert.deepEqual(card.balances.map((b) => [b.title, b.role]), [["Кумольный способ → Фенол, Ацетон", "input"]]);
      assert.equal((await productCard(await store.connection(), "Ацетон", { pool })).balances[0].role, "target");
    });
  });
}
