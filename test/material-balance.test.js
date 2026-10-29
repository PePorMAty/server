// Материальный баланс: разбор ответа модели и сверка его таблиц
// (routes/material-balance/utils/parse.js, followup.js). Модель не нужна.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseAmount, parseAnswer } = require("../routes/material-balance/utils/parse");
const { mismatches, followUpText } = require("../routes/material-balance/utils/followup");

test("«Часть от 1632» — у вещества нет своей массы, а не 1632 кг", () => {
  for (const cell of ["Часть от 1632", "часть из 1632 кг", "в составе 1763", "Совместный расход 1632"]) {
    assert.equal(parseAmount(cell, { massKg: true }), null, cell);
  }
  assert.deepEqual(parseAmount("≈1410*", { massKg: true }), { min: 1410, max: 1410, approx: true });
  assert.deepEqual(parseAmount("0,5–0,7 т", { massKg: true }), { min: 500, max: 700, approx: false });
});

// Ответ по шаблону — как у расчёта капролактама 2026-10-29: в «Результатах»
// нормы на тонну продукта и водород в «кг» из тысяч м³, в «Общем балансе» —
// пересчёт на базис.
const answer = `# Материальный баланс
- **Статус:** Частично рассчитан
- **Базис:** 1000 кг фенола

# Результаты по продуктам
| ID продукта | Продукт | Масса, кг | Подпись на графе | Основание |
|---|---|---:|---|---|
| P1 | Фенол | 1000 | 1000 кг | Заданный базис |
| P3 | Водород | ≈1410* | Нет данных | Оценка по объёмному расходу |
| P4 | Аммиак | ≈948 | Нет данных | Норма расхода |
| P5 | Серная кислота | Часть от 1632 | Нет данных | Совместный расход |
| P2 | Капролактам | ≈1080 | ≈1080 кг | Расчёт |

# Общий баланс участка
| Внешний поток | Вход / выход | Масса, кг | Основание |
|---|---|---:|---|
| Фенол | Вход | 1000 | Базис |
| Водород | Вход | 134 | Оценка |
| Аммиак (P4) | Вход | 1023 | Оценка |
| Серная кислота/Олеум | Вход | 1763 | Оценка |
| Капролактам | Выход | 1080 | Расчёт |
`;
const refs = [
  { ref: "P1", name: "Фенол", role: "basis" },
  { ref: "P3", name: "Водород", role: "input" },
  { ref: "P4", name: "Аммиак", role: "input" },
  { ref: "P5", name: "Серная кислота", role: "input" },
  { ref: "P2", name: "Капролактам", role: "target" },
];

test("массы одного вещества в двух таблицах расходятся — это видно", () => {
  const found = mismatches(parseAnswer(answer, refs));
  // Водород — по названию, аммиак — по обозначению (P4) в названии потока;
  // фенол и капролактам сходятся, у серной кислоты своей массы нет.
  assert.deepEqual(
    found.map((m) => [m.name, m.products, m.flows]),
    [
      ["Водород", "≈1410*", "134"],
      ["Аммиак", "≈948", "1023"],
    ],
  );
});

test("расхождение в пределах 5 % и пересекающиеся диапазоны — не расхождение", () => {
  const close = answer.replace("| P4 | Аммиак | ≈948 |", "| P4 | Аммиак | ≈1000 |").replace("| P3 | Водород | ≈1410* |", "| P3 | Водород | 120–140 |");
  assert.deepEqual(mismatches(parseAnswer(close, refs)), []);
});

test("второй запрос называет расхождения и базис", () => {
  const text = followUpText({
    transformation: "Синтез капролактама",
    mismatched: mismatches(parseAnswer(answer, refs)),
    basis: "1000 кг «Фенол»",
  });
  assert.match(text, /# Расхождение таблиц/);
  assert.match(text, /P3 «Водород» — ≈1410\* и 134/);
  assert.match(text, /\(1000 кг «Фенол»\)/);
  assert.match(text, /Верни ответ заново, целиком/);
});
