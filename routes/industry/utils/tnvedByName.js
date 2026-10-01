// routes/industry/utils/tnvedByName.js
//
// Код ТН ВЭД по НАЗВАНИЮ вещества — по классификатору, без реестра.
//
// Код в карточке до сих пор брался только из записей реестра ГИСП: нет
// записи — нет и кода, хотя у бензола в ТН ВЭД своя позиция 2902 20 000.
// Здесь он находится по названию — и только по точному: идентификатором
// продукта код НЕ становится (под одним кодом бывают десятки веществ), это
// справка в карточке с пометкой «по классификатору».
//
// Сверяем двумя способами, и оба — про вещество, а не про похожие слова:
//
//   • через справочник синонимов: позиция и продукт опознаются как одно
//     вещество (identify). «фторид водорода (кислота плавиковая)» —
//     «Фтороводород», «пропан-2-ол (спирт изопропиловый)» — «Изопропанол»;
//   • по самим словам названия, если в нём нет коротких частей и цифр:
//     «Диметилфосфит» — «диметилфосфит», даже если справочник его не знает.
//     Название с цифрами и буквами-приставками по словам не сверяется:
//     «пропан-2-ол» без «2» и «ол» — это «пропан», и пропан получил бы код
//     изопропанола (то же, из-за чего «П-Ксилол» находил орто-изомер).
//
// Название из одного слова сверяется буквально (с точностью до числа:
// «бутен» — «бутены»), без основ: в ТН ВЭД это часто продолжение заголовка в
// родительном падеже — «кремния» под «Карбиды…» значит «карбиды кремния», а
// по основе совпало бы с кремнием.

const { formatTnved, tnvedSubstancePositions } = require("./classifiers");
const { identify, spellingsOf } = require("./synonyms");
const { normalizeName, words, stemName } = require("./normalize");

/** Одно слово без дефисов и цифр: «азот», «кремния». */
function isSingleWord(text) {
  return /^[a-zа-яё]+$/i.test(normalizeName(text));
}

/**
 * Одно слово без окончания множественного числа: «бутены» и «бутен»,
 * «дибромтетрафторэтаны» и «дибромтетрафторэтан» — одно. Падежи так не
 * сводятся: «кремния» остаётся «кремния».
 */
function singular(text) {
  const w = normalizeName(text);
  return w.length > 4 ? w.replace(/[ыи]$/, "") : w;
}

/**
 * Ключ названия для сверки по словам: основы слов без порядка, а у одного
 * слова — само слово. null — название с короткими частями или цифрами, по
 * словам его не сверяем.
 */
function strictKey(text) {
  if (isSingleWord(text)) return singular(text);
  const all = words(stemName(text));
  if (!all.length || all.some((w) => w.length < 3 || /\d/.test(w))) return null;
  return [...new Set(all)].sort().join(" ");
}

/**
 * Вещество справочника, которое называет вариант позиции. Одно слово — только
 * если оно и есть одно из написаний вещества (с точностью до числа):
 * «кремния» опознаётся как кремний по основе, но написания «кремния» у
 * кремния нет.
 */
function canonOf(variant) {
  const hit = identify(variant);
  if (!hit) return null;
  if (!isSingleWord(variant)) return hit.canon;
  const v = singular(variant);
  return [...(hit.spellings ?? [])].some((s) => isSingleWord(s) && singular(s) === v)
    ? hit.canon
    : null;
}

/** Указатели «вещество → позиции»: по канону справочника и по ключу слов. */
let index = null;

function buildIndex() {
  const byCanon = new Map();
  const byKey = new Map();
  const add = (map, k, pos) => {
    if (!map.has(k)) map.set(k, new Map());
    map.get(k).set(pos.code, pos);
  };
  for (const pos of tnvedSubstancePositions()) {
    for (const v of pos.variants) {
      const canon = canonOf(v);
      if (canon) add(byCanon, canon, pos);
      const key = strictKey(v);
      if (key) add(byKey, key, pos);
    }
  }
  return { byCanon, byKey };
}

/**
 * Позиция ТН ВЭД вещества по названию продукта графа, или null.
 *
 * Нашлось несколько позиций — отдаём ту, что глубже в иерархии (длиннее
 * код): «бутен (бутилен) и его изомеры» точнее товарной позиции над ним. Если
 * и так не одна — не выбираем за человека: null.
 *
 * @returns {{ code: string, name: string } | null}
 */
function tnvedByName(rawName) {
  if (index === null) index = buildIndex();
  const found = new Map();
  const canon = identify(rawName)?.canon;
  for (const pos of index.byCanon.get(canon)?.values() ?? []) found.set(pos.code, pos);
  for (const spelling of spellingsOf(rawName)) {
    const key = strictKey(spelling);
    for (const pos of index.byKey.get(key)?.values() ?? []) found.set(pos.code, pos);
  }
  if (!found.size) return null;
  const deepest = Math.max(...[...found.keys()].map((c) => c.length));
  const best = [...found.values()].filter((p) => p.code.length === deepest);
  if (best.length !== 1) return null;
  return { code: formatTnved(best[0].code), name: best[0].name };
}

/** Сбросить указатели — после перечитывания справочника (для проверок). */
function resetTnvedIndex() {
  index = null;
}

module.exports = { tnvedByName, resetTnvedIndex };
