// routes/industry/utils/determineCode.js
//
// Код ОКПД2 или ТН ВЭД для продукта — моделью по файлу классификатора.
//
//   1. Поиск по файлу (codeSearch.js): позиции по названию и синонимам → их
//      подгруппы. Позиция с названием ровно как у товара или единственная
//      подгруппа — подгруппа известна без модели.
//   2. Иначе модель выбирает подгруппу из найденных (groupPrompt). Поиск не
//      нашёл ничего — сперва верхний уровень (класс ОКПД2, группа ТН ВЭД) из
//      всех, потом подгруппу внутри него.
//   3. Конечный код — промпт владельца с фрагментом файла: все коды подгруппы.
//   4. Ответ сверяется с файлом: код есть, начинается с подгруппы и конечный.
//      Не так — один раз переспрашиваем в той же переписке; снова не так —
//      «не определён», а не чужой код.
//
// ask(messages) — запрос к модели (в codes.js — транспорт, в тестах —
// подставные ответы); messages — [{ role, content }].

const cs = require("./codeSearch");
const { groupPrompt, leafPrompt } = require("./codePrompts");
const { formatTnved, tnvedEntries } = require("./classifiers");

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
 * @param {{ name: string, description?: string, current?: string, prompt?: string }} product
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

  const spellings = cs.spellingsFor(product.name);
  const found = cs.searchByName(kind, spellings);
  let candidates = found.groups;
  // Код, что уже стоит в карточке (реестр, справочник), — ещё один кандидат:
  // чаще всего он верен хотя бы до подгруппы.
  const currentGroup = product.current ? cs.groupOf(kind, product.current) : null;
  if (currentGroup && cs.groupExists(kind, currentGroup) && !candidates.some((c) => c.code === currentGroup)) {
    candidates = [...candidates, { code: currentGroup, name: cs.nameOf(kind, currentGroup), hits: [] }];
  }

  // Позиция названа ровно как товар — и только в одной подгруппе.
  const exactGroups = [...new Set(found.hits.filter((h) => h.exact).map((h) => cs.groupOf(kind, h.code)))];
  let subgroup = exactGroups.length === 1 ? exactGroups[0] : candidates.length === 1 ? candidates[0].code : null;
  if (subgroup) steps.push({ stage: "group", by: "search", subgroup });

  if (!subgroup) {
    let searched = true;
    if (!candidates.length) {
      // Поиск по названию ничего не дал: верхний уровень — из всех.
      const tops = cs.topLevels(kind);
      const answer = await call([{ role: "user", content: groupPrompt(kind, { product: product.name, description: product.description, candidates: tops, top: true, searched: false }) }]);
      const top = pickFrom(kind, answer, tops);
      steps.push({ stage: "top", answer, top });
      if (!top) return none("модель не отнесла товар ни к одному разделу классификатора");
      candidates = cs.groupsUnder(kind, top);
      searched = false;
    }
    if (candidates.length === 1) {
      subgroup = candidates[0].code;
    } else {
      const answer = await call([{ role: "user", content: groupPrompt(kind, { product: product.name, description: product.description, candidates, searched }) }]);
      subgroup = pickFrom(kind, answer, candidates);
      steps.push({ stage: "group", answer, subgroup, candidates: candidates.map((c) => c.code) });
      if (!subgroup) return none("модель не выбрала подгруппу классификатора");
    }
  }

  const fragment = cs.fragmentOf(kind, subgroup);
  const prompt = leafPrompt(kind, product.prompt, {
    product: product.name,
    description: product.description,
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

  if (!code || /^\s*NONE\b/i.test(answer)) return { ...none("модель не нашла в подгруппе подходящего кода"), subgroup, subgroupName: cs.nameOf(kind, subgroup) };
  if (problem) return { ...none(problem), subgroup, subgroupName: cs.nameOf(kind, subgroup) };
  return { status: "found", ...resultOf(kind, code, subgroup), requests, steps };
}

module.exports = { determineCode, pickFrom, leafProblem };
