#!/usr/bin/env node
//
// Добыть синонимы из названий на СВОИХ графах.
//
//   node scripts/mine-graph-synonyms.js              — сводка и кандидаты
//   node scripts/mine-graph-synonyms.js --all        — весь список
//   node scripts/mine-graph-synonyms.js --min 2      — встреченные на N графах
//   node scripts/mine-graph-synonyms.js --out файл   — записать на разбор
//
// Зачем. Модель называет узел так же, как производитель — запись реестра:
// имя, а следом в скобке второе. На живых графах таких названий 103 из 365
// неопознанных:
//
//   Соль (NaCl)
//   Жидкая ртуть (Hg)
//   н-бутиральдегид (n-butyraldehyde)
//   Кальцинированная сода (натрий карбонат, Na2CO3)
//
// Это готовые пары, и добывать их неоткуда не надо: они лежат в собственных
// сохранённых графах. Приём тот же, что у mine-gisp-synonyms, и правила
// разбора общие — scripts/lib/paren-pairs.js.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ РЕЕСТРА. Там латиница в скобке почти всегда торговое имя
// или артикул, и её отсеивают. Здесь она — главная добыча: формула «NaCl»,
// английское имя «n-butyraldehyde». Поэтому разбору говорят allowLatin.
//
// ВАЖНО. Скрипт НИЧЕГО не добавляет в справочник сам. Он печатает кандидатов,
// а решение за человеком: ошибочный синоним молча сливает два разных вещества
// в один узел графа, и заметить это потом нечем.

const fs = require("fs");

const { collectProducts } = require("./lib/graph-products");
const { parenPairs, key } = require("./lib/paren-pairs");
const { nameKind } = require("./lib/name-kind");
const { identify } = require("../routes/industry/utils/synonyms");

/**
 * На что похоже второе имя — подсказка человеку, а не решение.
 *
 * Формулу и английское имя почти всегда стоит брать ВТОРЫМ написанием, а
 * главным оставлять русское: канон — это то, что человек увидит в карточке.
 */
function altLooksLike(alt) {
  const s = String(alt).trim();
  if (/^[A-Z][a-z]?\d*([A-Z][a-z]?\d*)*$/.test(s) && /\d|[A-Z].*[A-Z]/.test(s)) {
    return "формула";
  }
  if (!/[а-яё]/i.test(s)) {
    return /^[A-ZА-ЯЁ0-9-]+$/.test(s) ? "сокращение" : "по-английски";
  }
  return "по-русски";
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    all: args.includes("--all"),
    min: Number(at("--min") ?? 1) || 1,
    out: at("--out"),
  };
}

function main() {
  const opts = parseArgs(process.argv);
  const { graphs, counts } = collectProducts();

  if (!graphs.length) {
    console.error("Сохранённых графов не найдено — смотреть нечего.");
    process.exit(1);
  }
  console.log(`Графов: ${graphs.length}, различных названий продуктов: ${counts.size}\n`);

  // Ключ пары → сколько графов её принесли. Пара с нескольких графов надёжнее
  // одиночной: одна и та же скобка, написанная дважды, вряд ли случайность.
  const found = new Map();
  let withParens = 0;
  /** Пары, у которых голова — не вещество: там в скобке не синоним. */
  const notSubstance = new Map();

  for (const [label, freq] of counts) {
    if (String(label).includes("(")) withParens += 1;
    for (const [head, alt] of parenPairs(label, { allowLatin: true, minAlt: 2 })) {
      const k = `${key(head)}\u0000${key(alt)}`;
      // Голова — поток, класс или сырьё? Тогда скобка перечисляет СОСТАВ или
      // приводит ПРИМЕР, а не называет то же самое другим именем.
      // «Алкиленоксиды (пропиленоксид, этиленоксид)» — два разных вещества,
      // члены класса; записав их синонимами, мы слили бы их в один узел.
      // «Нитрующая смесь» — состав. Разметку спрашиваем ту же, что размечает
      // отчёт по графам: незачем двум местам думать об этом по-разному.
      const target = nameKind(head) === "substance" ? found : notSubstance;
      const prev = target.get(k);
      if (prev) prev.freq = Math.max(prev.freq, freq);
      else target.set(k, { head, alt, freq, from: label });
    }
  }

  // Что справочник уже знает как одно вещество — не кандидат.
  const fresh = [];
  let known = 0;
  for (const p of found.values()) {
    if (p.freq < opts.min) continue;
    const a = identify(p.head);
    const b = identify(p.alt);
    if (a && b && a.id === b.id) {
      known += 1;
      continue;
    }
    fresh.push({
      ...p,
      kind: altLooksLike(p.alt),
      // Половину пары справочник может знать: тогда канон уже выбран, и
      // дописывать надо второе написание к нему, а не заводить новое вещество.
      knownAs: a?.id ?? b?.id ?? null,
      knownSide: a ? "head" : b ? "alt" : null,
    });
  }
  fresh.sort((a, b) => b.freq - a.freq || a.head.localeCompare(b.head, "ru"));

  console.log(`Названий со скобкой:   ${withParens}`);
  console.log(`Пар «имя — второе»:    ${found.size}`);
  console.log(`Справочник уже знает:  ${known}`);
  console.log(`Кандидатов:            ${fresh.length}`);
  if (notSubstance.size) {
    console.log(
      `\nПропущено ${notSubstance.size}: голова пары — не вещество (поток,` +
        ` класс, сырьё).\n  Там в скобке состав или пример, а не второе имя:` +
        ` «Нитрующая смесь (азотная\n  и серная кислоты)» — две РАЗНЫЕ кислоты,` +
        ` синонимами их делать нельзя.`,
    );
  }

  const byKind = new Map();
  for (const p of fresh) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  if (byKind.size) {
    console.log(
      `  из них: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(", ")}`,
    );
  }
  const half = fresh.filter((p) => p.knownAs).length;
  if (half) {
    console.log(
      `  у ${half} половина уже известна — там не новое вещество,` +
        ` а второе написание к нему`,
    );
  }

  const shown = opts.all ? fresh : fresh.slice(0, 40);
  console.log(
    `\n── кандидаты${opts.all ? "" : ` (первые ${shown.length}, весь список — --all)`} ──`,
  );
  for (const p of shown) {
    console.log(
      `  ${String(p.freq).padStart(2)} граф(ов)  ${p.head}  |  ${p.alt}` +
        `   [${p.kind}]` +
        (p.knownAs
          ? `   ← справочник знает ${p.knownSide === "head" ? "первое" : "второе"} как «${p.knownAs}»`
          : ""),
    );
  }

  if (opts.out) {
    const lines = [
      "# Кандидаты в синонимы, добытые из названий на сохранённых графах.",
      "#",
      "# СОБРАНО МАШИНОЙ И НЕ ПРОВЕРЕНО. Это не справочник, а список на разбор:",
      "# перенесите верные строки в reference/synonyms.txt руками, остальные",
      "# выбросьте. Ошибочный синоним молча сольёт два разных вещества в один",
      "# узел графа, и заметить это будет нечем.",
      "#",
      "# ГЛАВНЫМ именем ставьте русское, а формулу и английское — вторым:",
      "# канон это то, что человек увидит в карточке.",
      "#",
      `# Собрано: ${new Date().toISOString().slice(0, 10)}, пар: ${fresh.length}`,
      "",
      ...fresh.map(
        (p) =>
          `${p.head} | ${p.alt}   # ${p.kind}, графов: ${p.freq}` +
          (p.knownAs ? `, половина известна как «${p.knownAs}»` : ""),
      ),
    ];
    fs.writeFileSync(opts.out, lines.join("\n") + "\n", "utf8");
    console.log(`\nЗаписано в ${opts.out}: ${fresh.length} строк.`);
    console.log("Это СПИСОК НА РАЗБОР, а не справочник — смотрите шапку файла.");
  } else {
    console.log(
      "\nЗаписать кандидатов в файл: --out reference/synonyms-graph-candidates.txt",
    );
  }
}

main();
