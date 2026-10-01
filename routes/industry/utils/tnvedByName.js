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
  // По коду — позиция и то, назвала ли она вещество целиком (whole) или
  // только в перечне; целиком побеждает.
  const add = (map, k, pos, whole) => {
    if (!map.has(k)) map.set(k, new Map());
    const prev = map.get(k).get(pos.code);
    map.get(k).set(pos.code, { pos, whole: whole || Boolean(prev?.whole) });
  };
  for (const pos of tnvedSubstancePositions()) {
    for (const v of pos.variants) {
      const canon = canonOf(v.text);
      if (canon) add(byCanon, canon, pos, v.whole);
      const key = strictKey(v.text);
      if (key) add(byKey, key, pos, v.whole);
    }
  }
  return { byCanon, byKey };
}

/**
 * Позиция ТН ВЭД вещества по названию продукта графа, или null.
 *
 * Нашлось несколько позиций — сперва те, что названы веществом целиком:
 * «водород» у 2804 10 000, а не часть перечня «…водород и его соединения,
 * обогащенные дейтерием». Среди равных — та, что глубже в иерархии (длиннее
 * код). Если и так не одна — не выбираем за человека: null.
 *
 * @returns {{ code: string, name: string } | null}
 */
function tnvedByName(rawName) {
  if (index === null) index = buildIndex();
  const found = new Map();
  const take = (hits) => {
    for (const h of hits?.values() ?? []) {
      const prev = found.get(h.pos.code);
      found.set(h.pos.code, { pos: h.pos, whole: h.whole || Boolean(prev?.whole) });
    }
  };
  take(index.byCanon.get(identify(rawName)?.canon));
  for (const spelling of spellingsOf(rawName)) take(index.byKey.get(strictKey(spelling)));
  if (!found.size) return null;
  const all = [...found.values()];
  const pool = all.some((f) => f.whole) ? all.filter((f) => f.whole) : all;
  const deepest = Math.max(...pool.map((f) => f.pos.code.length));
  const best = pool.filter((f) => f.pos.code.length === deepest);
  if (best.length !== 1) return null;
  return { code: formatTnved(best[0].pos.code), name: best[0].pos.name };
}

/** Сбросить указатели — после перечитывания справочника (для проверок). */
function resetTnvedIndex() {
  index = null;
}

module.exports = { tnvedByName, resetTnvedIndex };
