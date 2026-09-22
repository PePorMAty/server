#!/usr/bin/env node
//
// Какие коды ОКПД2 из нашего файла исключены из классификатора.
//
//   node scripts/okpd2-retired.js <свежий okpd.xlsx>            — показать
//   node scripts/okpd2-retired.js <файл> --out reference/okpd2-retired.txt
//
// Зачем. Выгрузка ГИСП несёт код, присвоенный записи ПРИ РЕГИСТРАЦИИ, а
// классификатор с тех пор меняется: изменением №133/2026 сняты, например,
// 20.15.31.000 (мочевина), 20.13.63.000 (пероксид водорода) и 20.14.61.000
// (соединения с альдегидной группой). В карточке такой код выглядит как
// действующий, хотя его уже нет.
//
// Колонки со статусом у нас нет — и она не нужна. Берём СВЕЖИЙ классификатор
// и сравниваем с нашим: коды, которые есть у нас и отсутствуют в свежем, и
// есть исключённые. Разность двух версий не зависит от того, в каком формате
// выложили изменения, и потому надёжнее любой колонки.
//
// ОБРАТНОЕ НАПРАВЛЕНИЕ НЕ ТРОГАЕМ: коды, которых нет у нас, а в свежем есть,
// — это просто новые, и помечать по ним нечего.

const fs = require("fs");
const path = require("path");

const { forEachXlsxRow } = require("./lib/xlsx-stream");

const OURS = path.resolve(__dirname, "../reference/okpd2.txt");

/** Код ОКПД2: от двух до шести групп цифр через точку. */
const CODE_RE = /^\d{2}(?:\.\d+){0,5}$/;

/** Привести код к сравнимому виду: без пробелов и хвостовых точек. */
const clean = (s) => String(s ?? "").trim().replace(/\.+$/, "");

/** Прочитать наш плоский файл «код<таб>название». */
function readOurs() {
  const out = new Map();
  const text = fs
    .readFileSync(OURS, "utf8")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    const [code, ...rest] = line.split("\t");
    const key = clean(code);
    if (!CODE_RE.test(key)) continue;
    out.set(key, rest.join("\t").trim());
  }
  return out;
}

/**
 * Собрать коды из свежей выгрузки.
 *
 * Колонку с кодом ищем не по заголовку, а по содержимому: выгрузки
 * классификаторов приходят с разными шапками (а то и вовсе без них), зато
 * код ОКПД2 узнаётся с одного взгляда. Берём ту колонку, где кодов больше
 * всего, — ошибиться ею трудно.
 */
async function readFresh(file) {
  const hits = new Map(); // номер колонки → сколько похожих на код значений
  const byColumn = new Map(); // номер колонки → набор кодов
  let rows = 0;

  await forEachXlsxRow(file, {
    onHeader: () => {},
    onRow: (row) => {
      rows += 1;
      const values = Array.isArray(row) ? row : Object.values(row);
      for (let i = 0; i < values.length; i++) {
        const key = clean(values[i]);
        if (!CODE_RE.test(key)) continue;
        hits.set(i, (hits.get(i) ?? 0) + 1);
        if (!byColumn.has(i)) byColumn.set(i, new Set());
        byColumn.get(i).add(key);
      }
    },
  });

  const best = [...hits].sort((a, b) => b[1] - a[1])[0];
  return {
    rows,
    column: best?.[0] ?? null,
    codes: best ? byColumn.get(best[0]) : new Set(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : null;

  if (!file) {
    console.error("Укажите свежий файл классификатора: node scripts/okpd2-retired.js <okpd.xlsx>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
  }

  const ours = readOurs();
  console.log(`Наш файл: ${ours.size} кодов (${OURS})`);

  const fresh = await readFresh(file);
  console.log(`Свежий:   ${fresh.codes.size} кодов из ${fresh.rows} строк, колонка №${fresh.column}`);

  // Защита от разбора не того файла. Если свежих кодов подозрительно мало,
  // сравнивать нельзя: мы объявим исключённым весь классификатор.
  if (fresh.codes.size < ours.size / 2) {
    console.error(
      `\nСвежих кодов (${fresh.codes.size}) меньше половины наших (${ours.size}).` +
        "\nПохоже, разобрана не та колонка или не тот файл — сравнение отменено.",
    );
    process.exit(2);
  }

  const retired = [...ours].filter(([code]) => !fresh.codes.has(code));
  const added = [...fresh.codes].filter((code) => !ours.has(code));

  console.log(`\nИсключено из классификатора: ${retired.length}`);
  console.log(`Появилось нового (не наше дело): ${added.length}`);

  console.log("\n── первые 25 исключённых ──");
  for (const [code, name] of retired.slice(0, 25)) {
    console.log(`  ${code}\t${name}`);
  }
  if (retired.length > 25) console.log(`  … и ещё ${retired.length - 25}`);

  // Три кода, на которые натыкался заказчик, — заодно проверка, что разобрали
  // именно то, что нужно.
  console.log("\n── проверка на известных случаях ──");
  for (const code of ["20.15.31.000", "20.13.63.000", "20.14.61.000"]) {
    const inOurs = ours.has(code);
    const inFresh = fresh.codes.has(code);
    console.log(
      `  ${code}: у нас ${inOurs ? "есть" : "нет"}, в свежем ${inFresh ? "есть" : "нет"}` +
        ` → ${inOurs && !inFresh ? "ИСКЛЮЧЁН" : "не исключён"}`,
    );
  }

  if (out) {
    const lines = [
      "# Коды ОКПД2, исключённые из классификатора.",
      "#",
      "# Получены разностью: есть в reference/okpd2.txt, отсутствуют в свежей",
      "# выгрузке классификатора. Выгрузка ГИСП несёт код, присвоенный записи",
      "# при регистрации, и с тех пор классификатор менялся — в карточке такой",
      "# код выглядел бы действующим.",
      "#",
      `# Собрано: ${new Date().toISOString().slice(0, 10)}, кодов: ${retired.length}`,
      "",
      ...retired.map(([code, name]) => `${code}\t${name}`),
    ];
    fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
    console.log(`\nЗаписано в ${out}: ${retired.length} кодов.`);
  } else {
    console.log("\nЗаписать: --out reference/okpd2-retired.txt");
  }
}

main().catch((e) => {
  console.error("Не вышло:", e.message);
  process.exit(1);
});
