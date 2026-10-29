// Разбор ответа обобщения шага (Markdown по шаблону routes/step/utils/prompts.js)
// и проверки, которые делает prompt-check. Чистые функции — без сети.

"use strict";

const base = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const same = (a, b) => !!base(a) && base(a) === base(b);

/** «[А, Б (В, Г)]» → ["А", "Б (В, Г)"]; без скобок — строка целиком. */
function list(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("[")) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "[") depth++;
      if (s[i] === "]") depth--;
      if (depth === 0) { s = s.slice(1, i); break; }
    }
  }
  const items = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
  }
  items.push(cur);
  return items.map((x) => x.trim().replace(/\.$/, "")).filter((x) => x && !/^(нет|—|-)$/i.test(x));
}

function field(section, label) {
  const m = new RegExp(`\\*\\*${label}:\\*\\*([^\\n]*)`).exec(section);
  return m ? { raw: m[1].trim(), items: list(m[1]) } : null;
}

/** Основной шаг, альтернативы и строки «Контроля шага». */
function parseAnswer(md) {
  const text = String(md || "");
  const altAt = text.search(/^#{1,2}\s*Альтернатив/m);
  const notesAt = text.search(/^#\s*Примечания/m);
  const main = altAt > 0 ? text.slice(0, altAt) : text;
  const altsText = altAt > 0 ? text.slice(altAt, notesAt > altAt ? notesAt : undefined) : "";
  const variant = (title, s) => ({
    title,
    outputs: field(s, "Что производят")?.items ?? [],
    inputs: field(s, "Из чего производят")?.items ?? [],
    byproducts: field(s, "Побочные продукты")?.items ?? [],
    raw: { out: field(s, "Что производят")?.raw, inp: field(s, "Из чего производят")?.raw, by: field(s, "Побочные продукты")?.raw },
  });
  const alts = altsText
    .split(/^##\s*Альтернатива:\s*/m)
    .slice(1)
    .map((chunk) => variant(chunk.split("\n")[0].trim(), chunk));
  // [вход…] → [выход…] — блоки 1, 2 (всего: 2)
  const control = [...text.matchAll(/\[([^\]]*)\]\s*→\s*\[([^\]]*)\][^\n]*?всего:\s*(\d+)/g)].map((m) => ({
    inputs: list(`[${m[1]}]`),
    outputs: list(`[${m[2]}]`),
    total: Number(m[3]),
  }));
  return { main: variant("основной", main), alts, control, product: (/\*\*Продукт:\*\*\s*([^\n]+)/.exec(text) || [])[1]?.trim() };
}

const ECHO = ["<lineage>", "<blocks>", "<existing_chain>", "ВХОДНЫЕ ДАННЫЕ", "# Родословная", "# Текстовые блоки", "# Существующая цепочка", "# Целевой продукт"];

/**
 * Проверки ответа. Возвращает [{title, ok, detail}].
 * request — тело запроса обобщения, expect — ожидания фикстуры.
 */
function checkAnswer(md, request, expect = {}) {
  const out = [];
  const add = (title, ok, detail = "") => out.push({ title, ok: !!ok, detail });
  const a = parseAnswer(md);
  const anchor = request.productName;
  const down = request.direction !== "up";
  const variants = [a.main, ...a.alts];
  const allOutputs = variants.flatMap((v) => (down ? v.outputs : v.inputs));

  const echoed = ECHO.filter((m) => md.includes(m));
  add("нет эха входных данных", !echoed.length, echoed.join(", "));
  add("шаблон соблюдён (продукт, шаг, три поля списком)",
    same(a.product, anchor) && a.main.raw.out && a.main.raw.inp && a.main.raw.by !== undefined && /^\[/.test(a.main.raw.inp),
    `Продукт: ${a.product ?? "—"}; Из чего: ${a.main.raw.inp ?? "—"}; Побочные: ${a.main.raw.by ?? "нет поля"}`);
  if (down) {
    add("раскрываемый продукт — первый вход основного шага", same(a.main.inputs[0], anchor), a.main.inputs.join(", "));
    add("у каждой альтернативы раскрываемый продукт во входах", a.alts.every((v) => v.inputs.some((x) => same(x, anchor))),
      a.alts.filter((v) => !v.inputs.some((x) => same(x, anchor))).map((v) => v.title).join(", "));
  } else {
    add("раскрываемый продукт — выход основного шага", a.main.outputs.some((x) => same(x, anchor)), a.main.outputs.join(", "));
  }
  const ancestors = (request.ancestorProducts || []).filter((x) => !same(x, anchor));
  const loops = allOutputs.filter((x) => ancestors.some((y) => same(x, y)));
  add("новые продукты не ведут обратно в родословную", !loops.length, loops.join(", "));

  // Основной — самый подтверждённый: строка контроля для его продуктов — с наибольшим «всего».
  const mainNew = down ? a.main.outputs : a.main.inputs;
  const mainRow = a.control.find((c) => (down ? c.outputs : c.inputs).some((x) => mainNew.some((y) => same(x, y))));
  const maxTotal = Math.max(0, ...a.control.map((c) => c.total));
  add("в «Контроле шага» посчитаны блоки", a.control.length > 0, `${a.control.length} строк`);
  if (a.control.length)
    add("основной шаг — самый подтверждённый", mainRow && mainRow.total === maxTotal,
      `основной: ${mainNew.join(", ")} (всего ${mainRow?.total ?? "?"}), максимум ${maxTotal}`);

  if (expect.forbidOutputs) {
    const bad = allOutputs.filter((x) => expect.forbidOutputs.some((f) => same(x, f)));
    add(`нет перепрыгивания уровня (не выход: ${expect.forbidOutputs.join(", ")})`, !bad.length,
      bad.length ? `выход: ${bad.join(", ")}` : `выходы: ${allOutputs.join(", ")}`);
  }
  if (expect.someOutputs)
    add(`среди вариантов есть ${expect.someOutputs.join(", ")}`, expect.someOutputs.every((x) => allOutputs.some((y) => same(x, y))), allOutputs.join(", "));
  if (expect.mainOutputs)
    add(`основной выход: ${expect.mainOutputs.join(", ")}`, expect.mainOutputs.every((x) => a.main.outputs.some((y) => same(x, y))), a.main.outputs.join(", "));
  if (expect.mainInputs)
    add(`второе сырьё основного шага: ${expect.mainInputs.join(", ")}`, expect.mainInputs.every((x) => a.main.inputs.some((y) => same(x, y))), a.main.inputs.join(", "));
  if (expect.mainByproducts)
    add(`побочные основного шага: ${expect.mainByproducts.join(", ")}`, expect.mainByproducts.every((x) => a.main.byproducts.some((y) => same(x, y))), a.main.byproducts.join(", ") || "[]");
  return out;
}

module.exports = { parseAnswer, checkAnswer, list, same };
