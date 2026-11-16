// routes/step/utils/stepCheck.js
//
// Проверка шага моделью: реально ли из этого сырья этим преобразованием
// получают эти продукты.
//
// Почему. Шаг строится по найденным источникам, и модель путает похожие
// названия: от «Этилцеллозольва» вышел «Синтез этилацетата из этилцеллозольва»
// (2026-11-11), хотя из этилцеллозольва и уксусной кислоты получают
// этилцеллозольвацетат. Ошибку заметил только расчёт материального баланса
// («Некорректный выбор») — через несколько шагов и минут. Отдельный короткий
// запрос без поиска, с одним вопросом «верно ли это химически и
// технологически», ловит такое сразу после построения шага, а для отказа
// баланса превращает его примечания в готовое исправление.
//
// Ответ — переименования, а не новый шаг: процесс почти всегда настоящий, не
// так названы продукты. Что не исправить переименованием, — «wrong»: человек
// решает сам (перестроить шаг, взять альтернативу).

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "renames", "transformation_name", "transformation_description"],
  properties: {
    verdict: { type: "string", enum: ["ok", "fix", "wrong"] },
    summary: { type: "string" },
    renames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "description"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    transformation_name: { type: "string" },
    transformation_description: { type: "string" },
  },
};

const STEP_CHECK_SYSTEM = `
Ты — инженер-технолог. Проверяешь один шаг производственной цепочки: преобразование, его сырьё и продукты. Шаг построила другая модель по найденным в интернете источникам, и она ошибается: путает продукт с похожим названием (из этилцеллозольва и уксусной кислоты получают этилцеллозольвацетат, а в шаге написано «этилацетат»), приписывает процессу сырьё или продукт другого процесса, называет продукт, которого из этого сырья не получают.

Реши по своим знаниям химии и технологии производства, верен ли шаг:
- ok — из этого сырья этим преобразованием действительно получают эти продукты: в промышленности или по описанной технологии. Неполный список побочных продуктов, не названные катализатор, растворитель или вода, порядок слов и уточнения в названиях — не ошибка.
- fix — преобразование реально, но продукты или само преобразование названы неверно, и переименование это исправляет. В renames — каждое исправление: from — название из шага дословно, to — верное название по-русски в именительном падеже (у химического вещества — с систематическим или общепринятым названием в скобках, если оно помогает отличить), description — одно-два предложения: что это за продукт и для чего он. Если неверно название преобразования — transformation_name (верное название) и transformation_description (одно-два предложения: что из чего получают и как); иначе обе строки пустые.
- wrong — так не бывает, и переименованием не исправить: такого процесса нет, сырьё и продукты не связаны, или ошибка в продукте, который переименовывать нельзя.

Правила:
- Продукты из списка «Не переименовывать» уже стоят на графе в других шагах: в renames их не включай. Если ошибка в них — wrong.
- Шаг сборки изделия (самолёт из двигателей, крыла и фюзеляжа; автомобиль из кузова и шасси) проверяй так же, но по устройству изделия: входит ли такой узел или агрегат в это изделие.
- Не придирайся: исправляй только неверное по существу. Сомневаешься — ok, а сомнение назови в summary.
- Если передано замечание (например, от расчёта материального баланса), проверь его по существу: верное учти в исправлении, неверному не следуй.
- summary — одно-два предложения по-русски: что не так и как правильно, или почему шаг верен.
- При ok и wrong renames — пустой список, transformation_name и transformation_description — пустые строки.
Верни СТРОГО JSON по схеме.
`.trim();

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Название без кавычек-ёлочек и лишних пробелов: модель копирует их из запроса. */
const unquote = (s) => clean(s).replace(/^[«"“„']+|[»"”']+$/g, "").trim();

/** Ключ сравнения названий: регистр, «ё», пробелы. */
const keyOf = (s) => unquote(s).toLowerCase().replace(/ё/g, "е");

/** То же без уточнения в скобках: «Этилацетат (этиловый эфир…)» = «Этилацетат». */
const baseKey = (s) => keyOf(s).replace(/\s*\([^)]*\)/g, "").trim();

/** Описание в запрос — одной строкой, не длиннее абзаца. */
function brief(text, max = 400) {
  const plain = clean(String(text || "").replace(/[#*_`>]+/g, " "));
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Продукт запроса: строка или { name, description }. */
function productOf(p) {
  if (typeof p === "string") return { name: unquote(p) };
  return { name: unquote(p?.name), description: brief(p?.description) || undefined };
}

/**
 * Тело запроса → проверенные списки. Невалидное — { error }.
 */
function readCheckBody(body) {
  const list = (v) => (Array.isArray(v) ? v.map(productOf).filter((p) => p.name).slice(0, 30) : []);
  const transformation = {
    name: unquote(body?.transformation?.name ?? body?.transformation),
    description: brief(body?.transformation?.description, 600) || undefined,
  };
  const inputs = list(body?.inputs);
  const outputs = list(body?.outputs);
  if (!transformation.name) return { error: "transformation.name is required" };
  if (!inputs.length || !outputs.length) return { error: "inputs and outputs are required" };
  return {
    direction: body?.direction === "up" ? "up" : body?.direction === "down" ? "down" : null,
    anchor: unquote(body?.anchor) || null,
    transformation,
    inputs,
    outputs,
    byproducts: list(body?.byproducts),
    fixed: (Array.isArray(body?.fixed) ? body.fixed : []).map(unquote).filter(Boolean).slice(0, 30),
    remark: String(body?.remark ?? "").trim().slice(0, 4000),
  };
}

/** Запрос к модели — шаг и замечание. */
function stepCheckInput(c) {
  const line = (p) => `- «${p.name}»${p.description ? ` — ${p.description}` : ""}`;
  const keep = [...new Set([c.anchor, ...c.fixed].filter(Boolean))];
  return [
    c.direction && c.anchor
      ? c.direction === "up"
        ? `Шаг «вверх» к продукту «${c.anchor}»: из чего его производят.`
        : `Шаг «вниз» от продукта «${c.anchor}»: что из него производят.`
      : "Шаг производственной цепочки на графе.",
    `Преобразование: «${c.transformation.name}».`,
    c.transformation.description ? `Описание преобразования: ${c.transformation.description}` : null,
    `Сырьё:\n${c.inputs.map(line).join("\n")}`,
    `Продукты:\n${c.outputs.map(line).join("\n")}`,
    c.byproducts.length ? `Побочные продукты:\n${c.byproducts.map(line).join("\n")}` : null,
    keep.length ? `Не переименовывать: ${keep.map((n) => `«${n}»`).join(", ")}.` : null,
    c.remark ? `Замечание:\n${c.remark}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Ответ модели → { verdict, summary, renames: [{ from, to, description }],
 * transformation: { name, description } | null }.
 *
 * from — название из шага, как его прислал клиент: по нему клиент находит
 * продукт. Переименования неизвестных и защищённых продуктов отбрасываются;
 * «fix», в котором не осталось ни одного исправления, — «wrong»: модель
 * считает шаг ошибочным, а исправить его переименованием нельзя.
 */
function parseStepCheck(parsed, c) {
  const verdict = ["ok", "fix", "wrong"].includes(parsed?.verdict) ? parsed.verdict : null;
  if (!verdict) return null;
  const summary = clean(parsed?.summary).slice(0, 800);
  if (verdict !== "fix") return { verdict, summary, renames: [], transformation: null };

  const products = [...c.inputs, ...c.outputs, ...c.byproducts].map((p) => p.name);
  const byKey = new Map(products.map((n) => [keyOf(n), n]));
  // Без скобок — только однозначное совпадение.
  const byBase = new Map();
  for (const n of products) byBase.set(baseKey(n), byBase.has(baseKey(n)) ? null : n);
  const locked = new Set([c.anchor, ...c.fixed].filter(Boolean).map(keyOf));

  const renames = [];
  let blocked = false;
  for (const r of Array.isArray(parsed?.renames) ? parsed.renames : []) {
    const from = byKey.get(keyOf(r?.from)) ?? byBase.get(baseKey(r?.from)) ?? null;
    const to = unquote(r?.to);
    if (!from || !to || keyOf(to) === keyOf(from)) continue;
    // Ошибка в продукте, от которого строили шаг, или в стоящем на графе в
    // других шагах: переименовать остальное значило бы скрыть её.
    if (locked.has(keyOf(from))) {
      blocked = true;
      continue;
    }
    if (renames.some((x) => x.from === from)) continue;
    renames.push({ from, to, description: clean(r?.description) || undefined });
  }

  const tName = unquote(parsed?.transformation_name);
  const transformation =
    tName && keyOf(tName) !== keyOf(c.transformation.name)
      ? { name: tName, description: clean(parsed?.transformation_description) || undefined }
      : null;

  if (blocked || (!renames.length && !transformation)) {
    return { verdict: "wrong", summary, renames: [], transformation: null };
  }
  return { verdict, summary, renames, transformation };
}

module.exports = { SCHEMA, STEP_CHECK_SYSTEM, readCheckBody, stepCheckInput, parseStepCheck };
