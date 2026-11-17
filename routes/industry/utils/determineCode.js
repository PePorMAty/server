// routes/industry/utils/determineCode.js
//
// Код ОКПД2 или ТН ВЭД для продукта — моделью по файлу классификатора.
//
//   1. Поиск по файлу (codeSearch.js): позиции по названию, синонимам и — с
//      меньшим весом — по изделиям, куда продукт идёт по графу → их подгруппы.
//   2. Подгруппа без модели — только у вещества: позиция названа ровно как
//      оно (или подгруппа одна, а вещество знает справочник). У деталей и
//      изделий так ошибались: «Крылья» — куриные (0207), «Шасси» — прицепа
//      (8716), «Трансмиссия» — электросамоката (30.99), 2026-11-17.
//   3. Иначе модель выбирает подгруппу из найденных (groupPrompt). Не нашлось
//      ничего или модель отвергла все — сверху: класс ОКПД2 (группа ТН ВЭД) из
//      всех, потом подгруппа внутри него.
//   4. Конечный код — промпт владельца с фрагментом файла: все коды подгруппы.
//      NONE — с причиной (missing): какого признака товара не хватает.
//   5. Ответ сверяется с файлом: код есть, начинается с подгруппы и конечный.
//      Не так — один раз переспрашиваем в той же переписке; снова не так —
//      «не определён», а не чужой код.
//
// ask(messages) — запрос к модели (в codes.js — транспорт, в тестах —
// подставные ответы); messages — [{ role, content }].

const cs = require("./codeSearch");
const { groupPrompt, leafPrompt, usageText } = require("./codePrompts");
const { formatTnved, tnvedEntries } = require("./classifiers");
const { identify } = require("./synonyms");

/** Подгруппы химии: ОКПД2 20.xx, ТН ВЭД группы 28–29 — там названия позиций и есть вещества. */
const isChemistry = (kind, group) => (kind === "okpd2" ? /^20\./.test(group) : /^2[89]/.test(group));

/** Причина после NONE: «NONE: код зависит от тяги» → «код зависит от тяги». */
function noneReason(answer) {
  const m = /^\s*NONE\s*[:—–-]?\s*(.*)$/is.exec(String(answer ?? ""));
  return m ? m[1].replace(/\s+/g, " ").trim().replace(/[.«»"]+$/, "").slice(0, 200) : "";
}

/**
 * Код подгруппы из ответа — только из списка кандидатов. Ответ подробнее
 * спрошенного («20.14», когда выбирали класс «20») — по его началу.
 */
function pickFrom(kind, answer, candidates) {
  const text = String(answer ?? "");
  if (/^\s*NONE\b/i.test(text)) return null;
  const codes = candidates.map((c) => c.code);
  const found =
    kind === "okpd2"
      ? text.match(/\b\d{2}(?:\.\d{1,3})*\b/g) ?? []
      : (text.match(/\b\d{2}(?:\s?\d{2,3})*\b/g) ?? []).map((c) => c.replace(/\s+/g, ""));
  for (const c of found) {
    const hit = codes.find((code) => c === code || c.startsWith(kind === "okpd2" ? `${code}.` : code));
    if (hit) return hit;
  }
  return null;
}

/** Почему код из ответа не годится; null — годится. */
function leafProblem(kind, code, subgroup) {
  if (!code) return "в ответе нет кода";
  if (kind === "okpd2") {
    if (!cs.exists(kind, code)) return `кода ${code} нет в классификаторе`;
    if (!code.startsWith(`${subgroup}.`)) return `код ${code} не из подгруппы ${subgroup}`;
    if (!cs.isLeaf(kind, code)) return `код ${code} — группа, под ним есть более подробные коды`;
    return null;
  }
  const inFile = cs.tnvedInFile(code);
  if (!inFile) return `кода ${formatTnved(code)} нет в номенклатуре`;
  if (!inFile.startsWith(subgroup)) return `код ${formatTnved(code)} не из позиции ${subgroup}`;
  if (!cs.isLeaf(kind, inFile)) return `код ${formatTnved(inFile)} — не конечный, под ним есть более подробные коды`;
  return null;
}

/** Найденный код — как его хранят и показывают. */
function resultOf(kind, code, subgroup) {
  if (kind === "okpd2") {
    return { code, name: cs.nameOf(kind, code), subgroup, subgroupName: cs.nameOf(kind, subgroup) };
  }
  const inFile = cs.tnvedInFile(code);
  const full = cs.tnvedFull(inFile);
  const e = tnvedEntries().get(inFile);
  return {
    code: full,
    display: formatTnved(full),
    name: e?.name ?? null,
    path: e?.path ?? null,
    subgroup,
    subgroupName: cs.nameOf(kind, subgroup),
  };
}

/**
 * @param {"okpd2"|"tnved"} kind
 * @param {{ name: string, description?: string, usedFor?: string[], madeFrom?: string[], current?: string, prompt?: string }} product
 * @param {(messages: {role: string, content: string}[]) => Promise<string>} ask
 * @returns {Promise<{ status: "found"|"none", code?, name?, subgroup?, reason?, requests: number, steps: object[] }>}
 */
async function determineCode(kind, product, ask) {
  const steps = [];
  let requests = 0;
  const call = async (messages) => {
    requests++;
    return String((await ask(messages)) ?? "").trim();
  };
  const none = (reason) => ({ status: "none", reason, requests, steps });

  const usage = usageText(product);
  const own = cs.spellingsFor(product.name);
  const found = cs.searchByName(kind, [...own, ...cs.contextSpellings(product.usedFor)], { contextFrom: own.length });
  let candidates = found.groups;
  // Код, что уже стоит в карточке (реестр, справочник), — ещё один кандидат:
  // чаще всего он верен хотя бы до подгруппы.
  const currentGroup = product.current ? cs.groupOf(kind, product.current) : null;
  if (currentGroup && cs.groupExists(kind, currentGroup) && !candidates.some((c) => c.code === currentGroup)) {
    candidates = [...candidates, { code: currentGroup, name: cs.nameOf(kind, currentGroup), hits: [] }];
  }

  // Вещество, названное позицией ровно как оно, — подгруппа без модели.
  const substance = Boolean(identify(product.name));
  const exactGroups = [...new Set(found.hits.filter((h) => h.exact && !h.context).map((h) => cs.groupOf(kind, h.code)))];
  let subgroup =
    exactGroups.length === 1 && (substance || isChemistry(kind, exactGroups[0]))
      ? exactGroups[0]
      : substance && candidates.length === 1
        ? candidates[0].code
        : null;
  if (subgroup) steps.push({ stage: "group", by: "search", subgroup });

  const ask1 = (list, opts) =>
    call([{ role: "user", content: groupPrompt(kind, { product: product.name, description: product.description, usage, candidates: list, ...opts }) }]);

  if (!subgroup && candidates.length) {
    const answer = await ask1(candidates, { searched: true });
    subgroup = pickFrom(kind, answer, candidates);
    steps.push({ stage: "group", answer, subgroup, candidates: candidates.map((c) => c.code) });
  }
  if (!subgroup) {
    // Поиск не нашёл ничего или модель отвергла все найденное — сверху.
    const tops = cs.topLevels(kind);
    const answer = await ask1(tops, { top: true, searched: false });
    const top = pickFrom(kind, answer, tops);
    steps.push({ stage: "top", answer, top });
    if (!top) return none("модель не отнесла товар ни к одному разделу классификатора");
    const under = cs.groupsUnder(kind, top);
    if (under.length === 1) {
      subgroup = under[0].code;
    } else {
      const a2 = await ask1(under, { searched: false });
      subgroup = pickFrom(kind, a2, under);
      steps.push({ stage: "group-top", answer: a2, subgroup });
    }
    if (!subgroup) return none("модель не выбрала подгруппу классификатора");
  }

  const fragment = cs.fragmentOf(kind, subgroup);
  const prompt = leafPrompt(kind, product.prompt, {
    product: product.name,
    description: product.description,
    usage,
    subgroup,
    fragment,
  });
  const messages = [{ role: "user", content: prompt }];
  let answer = await call(messages);
  let code = /^\s*NONE\b/i.test(answer) ? null : cs.codeFromAnswer(kind, answer);
  let problem = /^\s*NONE\b/i.test(answer) ? null : leafProblem(kind, code, subgroup);
  steps.push({ stage: "leaf", subgroup, answer, problem });

  if (problem) {
    messages.push({ role: "assistant", content: answer });
    messages.push({
      role: "user",
      content: `Проверка по файлу: ${problem}. Выбери конечный код из фрагмента файла выше — он должен там быть, начинаться с ${subgroup} и не иметь более подробных кодов под собой — или ответь NONE. Только код.`,
    });
    answer = await call(messages);
    code = /^\s*NONE\b/i.test(answer) ? null : cs.codeFromAnswer(kind, answer);
    problem = /^\s*NONE\b/i.test(answer) ? null : leafProblem(kind, code, subgroup);
    steps.push({ stage: "leaf-retry", answer, problem });
  }

  if (!code || /^\s*NONE\b/i.test(answer)) {
    const missing = noneReason(answer);
    return {
      ...none(missing || "модель не нашла в подгруппе подходящего кода"),
      ...(missing ? { missing } : {}),
      subgroup,
      subgroupName: cs.nameOf(kind, subgroup),
    };
  }
  if (problem) return { ...none(problem), subgroup, subgroupName: cs.nameOf(kind, subgroup) };
  return { status: "found", ...resultOf(kind, code, subgroup), requests, steps };
}

module.exports = { determineCode, pickFrom, leafProblem, noneReason };
