// routes/chat/analysis.js
//
// Работа с графом целиком для чата (PG-MIGRATION.md, 4.9; предложения
// владельца 20.11): проверка графа, сквозной баланс цепочки, сравнение
// способов, проверка по ГИСП, маршрут «от X до Y» по базе знаний и графы
// библиотеки, откуда взять готовый кусок цепочки.
//
// Всё здесь — без модели: считается по срезу графа от клиента
// (graphSlice.js), базе знаний (этап 3) и реестру ГИСП. Модель получает
// факты и пишет человеку словами; так дешевле и ничего не выдумано.

const { findProducts, chainEnds } = require("./graphSlice");
const { productKeys } = require("../local-sources/utils/store");

const lower = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const LIST = 30;
const round = (x) => Math.round(x * 1000) / 1000;
/** «Окисление кумола: кумол + кислород → …» — название стадии раздела. */
const stageName = (line, fallback) => {
  const s = String(line ?? "");
  const colon = s.indexOf(": ");
  const arrow = s.indexOf("→");
  return colon > 0 && (arrow < 0 || colon < arrow) ? s.slice(0, colon) : fallback;
};

/** Одно ли это вещество: то же название или общие ключи названия. */
function same(a, b) {
  if (lower(a) === lower(b)) return true;
  const ka = new Set(productKeys(a));
  return ka.size > 0 && productKeys(b).some((k) => ka.has(k));
}

/** Значение по названию — точно или по ключам названия. */
function pick(map, label) {
  if (!map) return null;
  const exact = Object.keys(map).find((k) => lower(k) === lower(label));
  const key = exact ?? Object.keys(map).find((k) => same(k, label));
  return key ? map[key] : null;
}

// ---------- проверка графа ----------

/**
 * Дубли: продукты с общими ключами названия («Кумол» и «Изопропилбензол
 * (кумол)») — группами.
 */
function duplicateGroups(products) {
  const parent = products.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const byKey = new Map();
  products.forEach((p, i) => {
    for (const k of productKeys(p.label)) {
      if (byKey.has(k)) parent[root(i)] = root(byKey.get(k));
      else byKey.set(k, i);
    }
  });
  const groups = new Map();
  products.forEach((p, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.label);
  });
  return [...groups.values()].filter((g) => new Set(g.map(lower)).size > 1);
}

/**
 * Что в графе не доделано. codesOf(название) — есть ли коды (сохранённые
 * моделью или ОКПД2 из ГИСП); не передан — коды не проверяются.
 */
function auditGraph(slice, { codesOf = null, codesLimit = 300 } = {}) {
  const t = slice.transformations;
  const empty = slice.products.filter((p) => p.empty).map((p) => p.label);
  const checked = codesOf ? slice.products.slice(0, codesLimit) : [];
  const noCodes = checked.filter((p) => !codesOf(p.label)).map((p) => p.label);
  const noBalance = t.filter((x) => !x.balance && x.inputs.length && x.outputs.length).map((x) => x.label);
  const partial = t
    .filter((x) => x.balance && lower(x.balance.status) !== "рассчитан")
    .map((x) => ({ transformation: x.label, status: x.balance.status, ...(x.balance.note ? { why: x.balance.note } : {}) }));
  const broken = t.filter((x) => !x.inputs.length || !x.outputs.length).map((x) => x.label);
  const duplicates = duplicateGroups(slice.products);
  const ends = chainEnds(slice);
  return {
    counts: {
      products: slice.products.length,
      transformations: t.length,
      withoutDescription: empty.length,
      ...(codesOf ? { withoutCodes: noCodes.length, codesChecked: checked.length } : {}),
      withoutBalance: noBalance.length,
      balancePartial: partial.length,
      brokenSteps: broken.length,
      duplicateGroups: duplicates.length,
      unacceptedAlternatives: slice.alternatives.length,
    },
    withoutDescription: empty.slice(0, LIST),
    ...(codesOf ? { withoutCodes: noCodes.slice(0, LIST) } : {}),
    withoutBalance: noBalance.slice(0, LIST),
    balancePartial: partial.slice(0, LIST),
    brokenSteps: broken.slice(0, LIST),
    duplicates: duplicates.slice(0, LIST),
    chainEnds: { down: ends.down.slice(0, LIST), up: ends.up.slice(0, LIST), alone: ends.alone.slice(0, LIST) },
  };
}

// ---------- сквозной баланс ----------

/**
 * Сколько сырья на 1 т продукта по цепочке графа: от продукта вверх по
 * преобразованиям, доли — из последних расчётов баланса (массы в долях
 * массы сырья, срез клиента). Сырьё шага на 1 т его продукта = доля сырья /
 * доля продукта; по цепочке — произведение. Где расчёта нет — продукт
 * остаётся «не разложен», и модель знает, какой баланс посчитать.
 */
function chainBalance(slice, product, raw = "", { depth = 8 } = {}) {
  const [target] = findProducts(slice, product);
  if (!target) return { error: `«${product}» нет на открытом графе.` };
  const makers = (label) =>
    slice.transformations.filter((t) => t.outputs.some((o) => same(o, label)) && !t.inputs.some((i) => same(i, label)));
  const need = new Map();
  const add = (map, label, tons) => map.set(label, (map.get(label) ?? 0) + tons);
  const steps = [];
  const unresolved = [];
  const choices = [];
  const visit = (label, tons, level, path) => {
    const ts = makers(label);
    if (!ts.length || path.has(lower(label))) {
      add(need, label, tons);
      return;
    }
    const t = ts.find((x) => x.balance?.inputs && pick(x.balance.outputs, label)) ?? ts[0];
    if (ts.length > 1) choices.push({ product: label, used: t.label, other: ts.filter((x) => x !== t).map((x) => x.label) });
    const out = pick(t.balance?.outputs, label);
    if (!t.balance?.inputs || !out || level >= depth) {
      unresolved.push({
        product: label,
        tons: round(tons),
        transformation: t.label,
        why: !t.balance ? "баланса нет" : !t.balance.inputs ? `расчёт «${t.balance.status}» без масс` : "глубже не считаем",
      });
      return;
    }
    const inputs = Object.entries(t.balance.inputs).map(([name, share]) => [name, (tons * share) / out]);
    steps.push({ transformation: t.label, product: label, productTons: round(tons), inputs: Object.fromEntries(inputs.map(([n, x]) => [n, round(x)])) });
    const next = new Set(path).add(lower(label));
    for (const [name, x] of inputs) visit(name, x, level + 1, next);
  };
  visit(target.label, 1, 0, new Set());
  const rawList = [...need.entries()].map(([name, tons]) => ({ name, tons: round(tons) })).sort((a, b) => b.tons - a.tons);
  const asked = raw ? rawList.find((r) => same(r.name, raw)) ?? null : null;
  const viaStep = raw ? steps.filter((s) => Object.keys(s.inputs).some((n) => same(n, raw))) : [];
  return {
    product: target.label,
    basis: "на 1 т продукта",
    rawMaterials: rawList,
    ...(raw
      ? {
          asked: asked
            ? { name: asked.name, tons: asked.tons }
            : viaStep.length
              ? { name: raw, tons: round(viaStep.reduce((s, x) => s + (pick(x.inputs, raw) ?? 0), 0)), note: "промежуточный продукт цепочки" }
              : { name: raw, tons: null, note: "в цепочке продукта по расчётам не встретилось" },
        }
      : {}),
    steps,
    unresolved,
    choices,
    note: "доли расчётов — оценки модели по источникам; итог приблизителен",
  };
}

// ---------- сравнение способов ----------

/** Способы получения (up) или переработки (down) продукта: граф, альтернативы, база. */
function compareRoutes(slice, product, direction, card = null) {
  const [p] = findProducts(slice, product);
  const label = p?.label ?? product;
  const has = (list) => list.some((x) => same(x, label));
  const routes = [];
  for (const t of slice.transformations) {
    if (!(direction === "up" ? has(t.outputs) : has(t.inputs))) continue;
    routes.push({ route: t.label, where: "на графе", inputs: t.inputs, outputs: t.outputs, ...(t.balance ? { balance: t.balance.status } : {}) });
  }
  for (const a of slice.alternatives) {
    if (a.direction !== direction || !a.of.some((x) => same(x, label))) continue;
    routes.push({ route: a.label, where: "альтернатива на графе (не принята)", ...(a.description ? { description: a.description } : {}) });
  }
  if (card) {
    for (const t of card.transformations.fromSections) {
      if (t.direction !== direction) continue;
      routes.push({
        route: stageName(t.stages?.[0], t.source),
        where: t.source,
        ...(t.multi ? { note: "раздел о нескольких производствах" } : { inputs: t.inputs, outputs: t.outputs }),
      });
    }
    for (const t of card.transformations.fromGraphs) {
      if (t.direction !== direction) continue;
      if (routes.some((r) => lower(r.route) === lower(t.label))) continue;
      routes.push({ route: t.label, where: `графы библиотеки: ${t.graphs.map((g) => `«${g.name}»`).join(", ")}`, inputs: t.inputs, outputs: t.outputs });
    }
  }
  return { product: label, direction, routes: routes.slice(0, 15), total: routes.length };
}

// ---------- ГИСП ----------

/** Есть ли продукты в реестре российской продукции (ГИСП): без модели. */
function gispCheck(names) {
  const { lookupProduct, status } = require("../industry/utils/store");
  const info = status();
  if (!info.ready) return { ready: false, reason: info.reason };
  const found = [];
  const notFound = [];
  for (const name of names) {
    const r = lookupProduct(name);
    if (r.found) {
      found.push({
        product: name,
        entries: r.entryCount,
        producers: r.producerCount,
        regions: r.regionCount,
        ...(r.okpd2 ? { okpd2: typeof r.okpd2 === "object" ? r.okpd2.code ?? null : r.okpd2 } : {}),
        ...(r.producers?.length ? { examples: r.producers.slice(0, 3).map((x) => x.name ?? x.shortName ?? String(x)) } : {}),
      });
    } else notFound.push(name);
  }
  return { ready: true, actualAt: info.actualAt ?? null, checked: names.length, found, notFound };
}

// ---------- маршрут «от X до Y» ----------

/**
 * Как получить продукт to (из from): поиск вверх по шагам — открытый граф,
 * графы библиотеки и разделы ИТС (карточка знаний, этап 3). cardOf(name) —
 * карточка продукта или null (база недоступна).
 */
async function findRoute(slice, to, from = "", { cardOf = null, depth = 4, branch = 4, frontierMax = 8 } = {}) {
  const fromKeys = new Set(from ? productKeys(from) : []);
  const isFrom = (name) => (from ? lower(name) === lower(from) || productKeys(name).some((k) => fromKeys.has(k)) : false);
  const makers = async (label) => {
    const list = [];
    for (const t of slice.transformations) {
      if (t.outputs.some((o) => same(o, label))) list.push({ transformation: t.label, inputs: t.inputs, outputs: t.outputs, source: "открытый граф" });
    }
    const card = cardOf ? await cardOf(label) : null;
    for (const t of card?.transformations.fromGraphs ?? []) {
      if (t.direction !== "up") continue;
      list.push({ transformation: t.label, inputs: t.inputs, outputs: t.outputs, source: `граф «${t.graphs[0]?.name}»`, graph: t.graphs[0] });
    }
    for (const t of card?.transformations.fromSections ?? []) {
      if (t.direction !== "up" || t.multi) continue;
      list.push({ transformation: stageName(t.stages?.[0], t.source), inputs: t.inputs, outputs: t.outputs, source: t.source });
    }
    // Одинаковые шаги из разных мест — один раз.
    const seen = new Set();
    return list.filter((x) => {
      const sig = [lower(x.transformation), ...x.inputs.map(lower).sort()].join("|");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  };
  const levels = [];
  const paths = [];
  let frontier = [{ product: to, path: [] }];
  const done = new Set([lower(to)]);
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    const shown = [];
    for (const f of frontier.slice(0, frontierMax)) {
      const ms = (await makers(f.product)).slice(0, branch);
      shown.push({ product: f.product, madeBy: ms.map((m) => ({ transformation: m.transformation, inputs: m.inputs, source: m.source })) });
      for (const m of ms) {
        const path = [...f.path, m];
        if (m.inputs.some(isFrom)) paths.push(path.slice().reverse());
        for (const input of m.inputs) {
          if (done.has(lower(input))) continue;
          done.add(lower(input));
          next.push({ product: input, path });
        }
      }
    }
    levels.push(shown);
    if (from && paths.length) break;
    frontier = next;
  }
  return {
    to,
    ...(from ? { from, found: paths.length > 0 } : {}),
    paths: paths.slice(0, 3).map((p) => p.map((m) => ({ transformation: m.transformation, inputs: m.inputs, outputs: m.outputs, source: m.source }))),
    levels,
  };
}

// ---------- библиотека ----------

/**
 * Графы библиотеки, где у продукта есть шаги в эту сторону: откуда взять
 * готовый кусок цепочки, а не строить его заново за запросы к модели.
 */
async function libraryChains(pool, product, direction) {
  const keys = productKeys(product);
  if (!pool || !keys.length) return [];
  const side = direction === "up" ? "out_keys" : "in_keys";
  const { rows } = await pool.query(
    `SELECT n.graph_id, g.name, COUNT(*)::int AS steps
     FROM app.graph_nodes n
     JOIN app.graphs g ON g.id = n.graph_id AND g.deleted_at IS NULL
     WHERE n.type = 'transformation' AND n.${side} && $1::text[]
     GROUP BY n.graph_id, g.name, g.updated_at
     ORDER BY steps DESC, g.updated_at DESC
     LIMIT 10`,
    [keys],
  );
  const out = [];
  for (const r of rows) {
    const node = (
      await pool.query(
        `SELECT node_id, label FROM app.graph_nodes WHERE graph_id = $1 AND type = 'product' AND keys && $2::text[] LIMIT 1`,
        [r.graph_id, keys],
      )
    ).rows[0];
    if (node) out.push({ graphId: r.graph_id, name: r.name, nodeId: node.node_id, label: node.label, steps: r.steps });
  }
  return out;
}

module.exports = { auditGraph, chainBalance, compareRoutes, gispCheck, findRoute, libraryChains, duplicateGroups, same };
