// Кириллица в 1251, прочитанная из PDF как латиница (routes/local-sources/utils/mojibake.js).
// Пример — учебник academia-moscow.ru из живого прогона 2026-11-17.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeCp1251, fixCp1251, fixPageLines } = require("../routes/local-sources/utils/mojibake");

const PAGE = "ÑÐÅÄÍÅÅ ÏÐÎÔÅÑÑÈÎÍÀËÜÍÎÅ ÎÁÐÀÇÎÂÀÍÈÅ\nñóðñà âñåãî èçäåëèÿ è åãî ñîñòàâíûõ ÷àñòåé. Êîëëåäæ ¹ 31, ¸ëêà, ¨æ";

test("страница в 1251 как латиница — обратно в кириллицу, «¹» — «№»", () => {
  assert.equal(looksLikeCp1251(PAGE), true);
  assert.equal(
    fixCp1251(PAGE),
    "СРЕДНЕЕ ПРОФЕССИОНАЛЬНОЕ ОБРАЗОВАНИЕ\nсурса всего изделия и его составных частей. Колледж № 31, ёлка, Ёж",
  );
});

test("латиница с умлаутами и обычный русский текст не трогаются", () => {
  for (const text of ["Größe und Qualität, été, café, Ålesund", "Нейлон 6,6 получают поликонденсацией.", "2 × 3 = 6 ÷ 1"]) {
    assert.equal(looksLikeCp1251(text), false, text);
    const lines = [{ y: 1, text }];
    assert.equal(fixPageLines(lines), lines);
  }
});

test("строки страницы PDF — чинятся все, если страница перекодирована", () => {
  const lines = [
    { y: 10, h: 12, text: "ÒÅÕÍÎËÎÃÈß ÑÁÎÐÊÈ" },
    { y: 30, h: 10, text: "â" },
    { y: 50, h: 10, text: "ГЛАВА 1" },
  ];
  assert.deepEqual(fixPageLines(lines).map((l) => l.text), ["ТЕХНОЛОГИЯ СБОРКИ", "в", "ГЛАВА 1"]);
});
