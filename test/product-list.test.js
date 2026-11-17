// Деление списка продуктов из строки обобщения (routes/step/utils/productList.js).
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { splitProductList } = require("../routes/step/utils/productList");
const { mainStep } = require("../routes/step/utils/levelSkip");

test("запятая между цифрами — часть названия", () => {
  assert.deepEqual(splitProductList("Нейлон 6,6"), ["Нейлон 6,6"]);
  assert.deepEqual(splitProductList("1,2-Дихлорэтан, Хлор"), ["1,2-Дихлорэтан", "Хлор"]);
  assert.deepEqual(splitProductList("2,4,6-Трихлорфенол; Вода"), ["2,4,6-Трихлорфенол", "Вода"]);
  assert.deepEqual(splitProductList("Адипиновая кислота, Гексаметилендиамин"), ["Адипиновая кислота", "Гексаметилендиамин"]);
});

test("запятые в скобках — уточнение одного продукта; «6, 6» с пробелом — два элемента", () => {
  assert.deepEqual(splitProductList("Смола (эпоксидная, жидкая), Отвердитель"), ["Смола (эпоксидная, жидкая)", "Отвердитель"]);
  assert.deepEqual(splitProductList("6, 6"), ["6", "6"]);
  assert.deepEqual(splitProductList(""), []);
});

test("основной шаг обобщения: «Нейлон 6,6» в выходах — один продукт", () => {
  const md = `# Новый производственный шаг
## Шаг
- **Что производят:** [Нейлон 6,6]
- **Из чего производят:** [Адипиновая кислота, Гексаметилендиамин]
- **Описание:** Поликонденсация.
# Альтернативы`;
  const m = mainStep(md);
  assert.deepEqual(m.outputs, ["Нейлон 6,6"]);
  assert.deepEqual(m.inputs, ["Адипиновая кислота", "Гексаметилендиамин"]);
});
