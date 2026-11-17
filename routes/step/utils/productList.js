// routes/step/utils/productList.js
//
// Список продуктов из строки обобщения: «[Адипиновая кислота,
// Гексаметилендиамин]» → два названия.
//
// Делим по запятой и точке с запятой, но не везде:
// - внутри скобок — уточнение одного продукта: «Смола (эпоксидная, жидкая)»;
// - между цифрами — часть названия: «Нейлон 6,6», «1,2-дихлорэтан»,
//   «2,4,6-трихлорфенол». Живой прогон 2026-11-17: «Нейлон 6,6» делился на
//   «Нейлон 6» и «6», и оба вставали на граф лишними узлами.
// Список через запятую с пробелом между числами («6, 6») — уже два
// элемента: так названий не пишут.

/** Запятая на позиции i стоит между цифрами: «6,6», «1,2-». */
function digitComma(s, i) {
  return /\d/.test(s[i - 1] || "") && /\d/.test(s[i + 1] || "");
}

/** Список «[А, Б (В, Г)]» — по запятым и точкам с запятой вне скобок и не между цифрами. */
function splitProductList(raw) {
  const s = String(raw || "");
  const items = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    const separator = ch === ";" || (ch === "," && !digitComma(s, i));
    if (separator && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map((x) => x.trim()).filter(Boolean);
}

module.exports = { splitProductList };
