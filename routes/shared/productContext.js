// routes/shared/productContext.js
//
// Контекст продукта из графа — что о нём известно кроме названия: описание
// карточки, отрасль и назначение, CAS, через какие преобразования его
// получают и во что он идёт (с описаниями процессов), куда ведёт цепочка
// дальше — до конечного изделия.
//
// Зачем. По одному названию модель путается: «Смолы», «Двигатель», «Масло»
// — что угодно; «Нейлон 6,6» — то ли гранулы, то ли волокно. В графе обычно
// есть ответ: описание узла, техописание шага, соседи. Первым его берёт
// определение кодов ОКПД2/ТН ВЭД (routes/industry/codes.js); тот же формат —
// под чат с ИИ на полотне (PG-MIGRATION.md, этап 4): инструменту «что за
// продукт» нужен тот же срез графа вокруг узла.
//
// Собирает контекст клиент — у него живой граф, в том числе не сохранённый
// (gpt-graph-client: src/utils/productContext.ts). Сервер ему не доверяет:
// readProductContext обрезает строки и списки, productContextText укладывает
// текст в бюджет знаков. Поле необязательное: старый клиент его не шлёт, и
// всё работает по названию, описанию и usedFor/madeFrom, как раньше.
//
// Форма (JSON):
//   {
//     description?, industry?, mainPurpose?, cas?,
//     madeBy?:  [{ name, description?, inputs: [], outputs: [] }],  // как получают
//     usedIn?:  [{ name, description?, inputs: [], outputs: [] }],  // во что идёт
//     downstream?: [["Двигатель", "Самолёт"]]  // пути дальше по цепочке
//   }

const LIMITS = {
  text: 600, // описание продукта
  process: 400, // описание преобразования
  name: 120,
  processes: 4, // преобразований на сторону
  names: 8, // продуктов на сторону преобразования
  paths: 3, // путей дальше по цепочке
  pathLength: 5,
};

const clean = (v, max) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const names = (raw, max = LIMITS.names) =>
  (Array.isArray(raw) ? raw : [])
    .map((x) => clean(x, LIMITS.name))
    .filter(Boolean)
    .slice(0, max);

function readProcess(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = {
    name: clean(raw.name, LIMITS.name),
    description: clean(raw.description, LIMITS.process),
    inputs: names(raw.inputs),
    outputs: names(raw.outputs),
  };
  if (!p.name && !p.inputs.length && !p.outputs.length) return null;
  if (!p.description) delete p.description;
  return p;
}

/**
 * Контекст из тела запроса — проверенный и обрезанный; пустой — null.
 */
function readProductContext(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ctx = {};
  for (const [k, max] of [["description", LIMITS.text], ["industry", LIMITS.name], ["mainPurpose", LIMITS.process], ["cas", 20]]) {
    const v = clean(raw[k], max);
    if (v) ctx[k] = v;
  }
  for (const k of ["madeBy", "usedIn"]) {
    const list = (Array.isArray(raw[k]) ? raw[k] : []).map(readProcess).filter(Boolean).slice(0, LIMITS.processes);
    if (list.length) ctx[k] = list;
  }
  const paths = (Array.isArray(raw.downstream) ? raw.downstream : [])
    .map((p) => names(p, LIMITS.pathLength))
    .filter((p) => p.length)
    .slice(0, LIMITS.paths);
  if (paths.length) ctx.downstream = paths;
  return Object.keys(ctx).length ? ctx : null;
}

const processLine = (p) => {
  const flow = `${p.inputs.join(" + ") || "?"} → ${p.outputs.join(" + ") || "?"}`;
  return `- «${p.name || "преобразование"}»: ${flow}${p.description ? `. ${p.description}` : ""}`;
};

/**
 * Контекст текстом для модели — по-русски, строками; не длиннее budget
 * знаков: сперва уходят описания процессов, потом лишние процессы.
 * withDescription: false — без описания карточки (его промпт уже дал
 * отдельной строкой).
 */
function productContextText(ctx, { budget = 2400, withDescription = true } = {}) {
  if (!ctx) return "";
  const render = (c) => {
    const lines = [];
    const card = [
      withDescription && c.description ? `Описание: ${c.description}` : "",
      c.industry ? `Отрасль: ${c.industry}` : "",
      c.mainPurpose ? `Назначение: ${c.mainPurpose}` : "",
      c.cas ? `CAS: ${c.cas}` : "",
    ].filter(Boolean);
    if (card.length) lines.push(card.join(". "));
    if (c.madeBy?.length) lines.push("Как получают (по графу):", ...c.madeBy.map(processLine));
    if (c.usedIn?.length) lines.push("Во что идёт (по графу):", ...c.usedIn.map(processLine));
    if (c.downstream?.length) lines.push(`Дальше по цепочке: ${c.downstream.map((p) => p.join(" → ")).join("; ")}`);
    return lines.join("\n");
  };
  let c = ctx;
  let text = render(c);
  const strip = (list) => list?.map(({ description, ...p }) => p);
  if (text.length > budget) {
    c = { ...c, madeBy: strip(c.madeBy), usedIn: strip(c.usedIn) };
    text = render(c);
  }
  while (text.length > budget && ((c.madeBy?.length ?? 0) > 1 || (c.usedIn?.length ?? 0) > 1)) {
    const side = (c.usedIn?.length ?? 0) >= (c.madeBy?.length ?? 0) ? "usedIn" : "madeBy";
    c = { ...c, [side]: c[side].slice(0, -1) };
    text = render(c);
  }
  return text.slice(0, budget);
}

/**
 * Во что продукт идёт и из чего его делают — названия по контексту: для
 * поиска по классификатору и для тех, кто знает только usedFor/madeFrom.
 */
function neighboursOf(ctx) {
  if (!ctx) return { usedFor: [], madeFrom: [] };
  const uniq = (list) => [...new Set(list)].slice(0, 6);
  return {
    usedFor: uniq([...(ctx.usedIn ?? []).flatMap((p) => p.outputs), ...(ctx.downstream ?? []).map((p) => p[p.length - 1])]),
    madeFrom: uniq((ctx.madeBy ?? []).flatMap((p) => p.inputs)),
  };
}

module.exports = { readProductContext, productContextText, neighboursOf, LIMITS };
