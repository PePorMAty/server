#!/usr/bin/env node
//
// Коды ОКПД2 и ТН ВЭД: у кого их нет.
//
//   node scripts/codes-coverage.js             — реестр и продукты всех графов
//   node scripts/codes-coverage.js --graph ТИТАН   — продукты одного графа
//   node scripts/codes-coverage.js --list      — и продукты без ТН ВЭД поимённо
//
// Зачем. Третий пункт плана ТН ВЭД (TODO.md) — перевод ТН ВЭД ↔ ОКПД2 по
// таблице заказчика. Он нужен, только если у заметной доли записей реестра
// нет одного из двух кодов: тогда второй код можно получить из первого. Если
// почти у всех есть оба, таблица ничего не даст. Отвечаем числами, а не
// догадкой.
//
// Вторая половина — что видит человек в карточке: у скольких продуктов графов
// код ТН ВЭД из записей реестра, у скольких — по классификатору, по названию
// вещества (tnvedByName.js), и у скольких его нет никак.
//
// Только чтение: база открывается на чтение, справочник не меняется.

const { getDb, status, lookupProduct } = require("../routes/industry/utils/store");
const { collectProducts } = require("./lib/graph-products");

function pct(n, total) {
  return total ? `${((100 * n) / total).toFixed(1)}%` : "—";
}

function main() {
  const args = process.argv.slice(2);
  const graphArg = args.indexOf("--graph");
  const onlyGraph = graphArg >= 0 ? args[graphArg + 1] : null;
  const wantList = args.includes("--list");

  const conn = getDb();
  if (!conn) {
    const s = status();
    console.log(`Реестр не подключён: ${s.reason ?? s.path ?? "базы нет"}`);
    process.exit(2);
  }

  // Пустая строка — тоже «нет кода»: так приходят незаполненные ячейки.
  const count = (where) =>
    conn.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${where}`).get().n;
  const noOkpd2 = "(okpd2 IS NULL OR TRIM(okpd2) = '')";
  const noTnved = "(tnved IS NULL OR TRIM(tnved) = '')";
  const total = count("1");
  const a = count(noOkpd2);
  const b = count(noTnved);
  const both = count(`${noOkpd2} AND ${noTnved}`);

  console.log(`── Записи реестра: ${total} ──`);
  console.log(`  без ОКПД2:          ${String(a).padStart(7)}  ${pct(a, total)}`);
  console.log(`  без ТН ВЭД:         ${String(b).padStart(7)}  ${pct(b, total)}`);
  console.log(`  без обоих:          ${String(both).padStart(7)}  ${pct(both, total)}`);
  console.log(
    `  один из двух есть:  ${String(a + b - 2 * both).padStart(7)}  ${pct(a + b - 2 * both, total)}` +
      "  ← столько выиграл бы перевод кодов",
  );

  const { graphs, counts } = collectProducts(onlyGraph);
  const names = [...counts.keys()];
  if (!names.length) {
    console.log(onlyGraph ? `\nГраф «${onlyGraph}» не найден или без продуктов.` : "\nСохранённых графов нет.");
    return;
  }

  const kinds = { registry: [], classifier: [], none: [] };
  for (const name of names) {
    const r = lookupProduct(name);
    if (r.placeholder) continue;
    if (r.found && r.tnved) kinds.registry.push(name);
    else if (r.tnvedCategory) kinds.classifier.push(`${name} → ${r.tnvedCategory.code} ${r.tnvedCategory.name}`);
    else kinds.none.push(`${name}${r.found ? " (в реестре есть, кода у записей нет)" : ""}`);
  }
  const shown = kinds.registry.length + kinds.classifier.length + kinds.none.length;

  console.log(
    `\n── Продукты ${onlyGraph ? `графа «${onlyGraph}»` : `графов (${graphs.length})`}: ${shown} названий ──`,
  );
  console.log(`  ТН ВЭД из записей реестра:   ${String(kinds.registry.length).padStart(5)}  ${pct(kinds.registry.length, shown)}`);
  console.log(`  по классификатору:           ${String(kinds.classifier.length).padStart(5)}  ${pct(kinds.classifier.length, shown)}`);
  console.log(`  кода нет:                    ${String(kinds.none.length).padStart(5)}  ${pct(kinds.none.length, shown)}`);

  console.log("\n── По классификатору (проверьте глазами) ──");
  for (const line of kinds.classifier.sort((x, y) => x.localeCompare(y, "ru"))) console.log(`  ${line}`);
  if (wantList) {
    console.log("\n── Без кода ТН ВЭД ──");
    for (const line of kinds.none.sort((x, y) => x.localeCompare(y, "ru"))) console.log(`  ${line}`);
  }
}

main();
