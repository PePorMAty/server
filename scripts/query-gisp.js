#!/usr/bin/env node
//
// Спросить реестр из командной строки — тем же кодом, что и сервер.
//
//   node scripts/query-gisp.js "Бутан технический" "изобутилен"
//   node scripts/query-gisp.js --json "Метанол"
//   node scripts/query-gisp.js --why "Янтарная кислота"   — разбор по записям
//
// Реестр очень дробный: «Электрокорунд белый 25А фракция 0-0,020 мм» и
// «…фракция 0-0,1 мм» — разные записи. Поэтому точное совпадение с названием
// узла графа почти никогда не случается, и работает лестница всё более мягких
// запросов. Насколько она попадает, видно только на живых данных — а лезть
// ради этого в браузер долго.
//
// Без аргументов показывает состояние базы.

const { lookupProduct, status } = require("../routes/industry/utils/store");

const MATCH_LABELS = {
  exact: "точное совпадение",
  "all-words": "все слова",
  "core-words": "значимые слова",
  partial: "часть слов",
  prefix: "по началу слова",
};

function showStatus() {
  const s = status();
  if (!s.ready) {
    console.log(`Реестр не подключён: ${s.reason}`);
    console.log(`Ожидается файл: ${s.path}`);
    return false;
  }
  console.log(
    `Реестр: ${s.entries} записей, ${s.products} продуктов, ` +
      `${s.producers} производителей` +
      (s.actualAt ? `, актуально на ${s.actualAt}` : ""),
  );
  return true;
}

function report(query) {
  const r = lookupProduct(query);

  if (!r.found) {
    console.log(`\n«${query}» — не найдено`);
    return;
  }

  console.log(
    `\n«${query}» — ${r.producerCount} производителей, ` +
      `${r.entryCount} записей` +
      `  [${MATCH_LABELS[r.match] ?? r.match}]`,
  );

  // Показываем, что именно нашлось: при мягком совпадении легко подцепить
  // соседний продукт, и увидеть это надо сразу.
  const products = [...new Set(r.producers.map((p) => p.product))];
  if (products.length > 1 || products[0] !== query) {
    console.log(`  нашлось по названиям: ${products.slice(0, 4).join(" | ")}` +
      (products.length > 4 ? ` … и ещё ${products.length - 4}` : ""));
  }

  for (const p of r.producers.slice(0, 5)) {
    console.log(
      `  • ${p.producer}` +
        (p.inn ? ` · ИНН ${p.inn}` : "") +
        (p.region ? ` · ${p.region}` : "") +
        ` · ${p.statusLabel}`,
    );
  }
  if (r.producers.length > 5) {
    console.log(`  … и ещё ${r.producers.length - 5}`);
  }
}

const args = process.argv.slice(2);
const why = args.includes("--why");
const asJson = args.includes("--json");
const queries = args.filter((a) => !a.startsWith("--"));

if (!showStatus()) process.exit(1);

if (!queries.length) {
  console.log("\nУкажите названия продуктов:");
  console.log('  node scripts/query-gisp.js "Бутан технический" "изобутилен"');
  process.exit(0);
}

if (why) {
  // Разбор по каждой найденной записи: видно, какая ветка правила её
  // пропустила, а какая отбросила. Нужен, когда спорное подтверждение надо
  // чинить точно, а не на глаз.
  for (const q of queries) {
    const r = lookupProduct(q, { explain: true });
    console.log(`\n══ «${q}» ══`);
    if (!r.explain?.length) {
      console.log("  записей не найдено — разбирать нечего");
      continue;
    }
    for (const e of r.explain) {
      const marks = [
        `место ${e.at}`,
        `значимых ${e.strong}`,
        `покрытие ${(e.share ?? 0).toFixed(2)}`,
        e.parens ? `скобка: ${e.parens}` : null,
        e.foreignClass ? `чужой класс: ${e.foreignClass}` : null,
        e.onlyClass ? "совпал только класс" : null,
      ].filter(Boolean);
      console.log(
        `  ${e.confirmed ? "ПОДТВЕРДИЛ" : "отбросил  "}  ${String(e.name).slice(0, 62)}`,
      );
      console.log(`               ${marks.join(", ")}`);
    }
  }
} else if (asJson) {
  const out = {};
  for (const q of queries) out[q] = lookupProduct(q);
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const q of queries) report(q);
}
