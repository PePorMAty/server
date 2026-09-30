// routes/local-sources/utils/query.js
//
// Ключ продукта для сохранённых веб-источников.

const { normalizeName } = require("../../industry/utils/normalize");
const { identify } = require("../../industry/utils/synonyms");

/**
 * Ключ продукта для сохранённых источников: главное имя из справочника, а
 * если справочник продукт не знает — само название в приведённом виде.
 * Так источники, найденные для «ИПБ», видны и у «Кумола».
 */
function productKey(productName) {
  const canon = identify(productName)?.canon;
  return normalizeName(canon || productName);
}

module.exports = { productKey };
