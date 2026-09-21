#!/usr/bin/env node
//
// Собрать справочник синонимов из Wikidata по номеру CAS.
//
//   node scripts/fetch-wikidata-synonyms.js --dry-run   — посмотреть, что придёт
//   node scripts/fetch-wikidata-synonyms.js             — записать файл
//   node scripts/fetch-wikidata-synonyms.js --all       — включая вещества с одним названием
//
// Зачем именно Wikidata. Номер CAS — единственный ходовой идентификатор
// ВЕЩЕСТВА: ОКПД2 и ТН ВЭД классифицируют товарные категории, и под одним их
// кодом лежат разные продукты. Базы CAS в открытом доступе нет, но Wikidata
// хранит номер свойством P231 и рядом с ним — русские название и синонимы.
// То есть даёт ровно то, что мы писали руками: «эти шесть русских названий —
// одно вещество», но с происхождением, которое можно проверить, а не по
// памяти составителя.
//
// Результат ложится в reference/synonyms-wikidata.txt отдельным файлом.
// Правленный человеком synonyms.txt читается первым и при расхождениях
// побеждает — собранное машиной не затирает проверенное.
//
// ВНИМАНИЕ. Скрипт ходит в интернет, и написан он был в окружении, откуда
// Wikidata недоступна: на живой выдаче он не проверялся. Первый запуск и есть
// проверка — начните с --dry-run.

const fs = require("fs");
const path = require("path");

// Адрес можно подменить: так скрипт целиком прогоняется на заглушке, не
// трогая живую Wikidata.
const ENDPOINT =
  process.env.WIKIDATA_ENDPOINT || "https://query.wikidata.org/sparql";
const OUT = path.resolve(__dirname, "../reference/synonyms-wikidata.txt");

/** Сколько веществ просим за раз. Больше — выше риск упереться в таймаут. */
const PAGE = 1000;
/** Сколько страниц готовы забрать за один запуск. */
const MAX_PAGES = 100;
/** Пауза между запросами: публичная точка, вести себя надо прилично. */
const DELAY_MS = 1200;
/** Сколько ждём один ответ. */
const TIMEOUT_MS = 90_000;

/**
 * Русские название и синонимы всех веществ, у которых есть номер CAS.
 *
 * Синонимы сворачиваем в одну строку прямо на стороне Wikidata: иначе каждая
 * пара «вещество + синоним» приехала бы отдельной строкой, и постраничная
 * выборка поехала бы.
 */
function query(offset) {
  return `
SELECT ?item ?cas ?label (GROUP_CONCAT(DISTINCT ?alias; separator="||") AS ?aliases)
WHERE {
  ?item wdt:P231 ?cas .
  ?item rdfs:label ?label . FILTER(LANG(?label) = "ru")
  OPTIONAL { ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "ru") }
}
GROUP BY ?item ?cas ?label
ORDER BY ?item
LIMIT ${PAGE} OFFSET ${offset}`.trim();
}

async function fetchPage(offset) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query(offset))}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      // Wikidata просит представляться; безымянные запросы она режет.
      // Только латиница: HTTP-заголовки кириллицу не принимают, и запрос
      // падает ещё до отправки.
      "User-Agent": "gpt-graph/1.0 (chemical synonyms by CAS)",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikidata ответила ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data?.results?.bindings ?? [];
}

/** Чистка названия: Wikidata иногда отдаёт формулы и пометки в скобках. */
function cleanName(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Годится ли название в справочник.
 *
 * Отсекаем то, что названием вещества на графе быть не может: пустое, слишком
 * короткое (одна-две буквы совпадут с чем угодно) и чисто цифровое.
 */
function usableName(name) {
  if (name.length < 3) return false;
  if (!/[а-яё]/i.test(name)) return false; // нужен русский: латинские имена не наш случай
  if (/^\d+$/.test(name)) return false;
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepSingles = args.includes("--all");

  console.log(`Спрашиваю Wikidata: вещества с номером CAS и русским названием.`);
  console.log(`Страница по ${PAGE}, пауза ${DELAY_MS} мс. Это займёт несколько минут.\n`);

  const entries = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    let rows;
    try {
      rows = await fetchPage(offset);
    } catch (e) {
      console.error(`\nЗапрос со смещения ${offset} не прошёл: ${e.message}`);
      if (!entries.length) {
        console.error(
          "Ни одной страницы забрать не удалось — записывать нечего.\n" +
            "Проверьте, открыт ли с этой машины query.wikidata.org.",
        );
        process.exit(1);
      }
      console.error(`Оставляю то, что успели забрать: ${entries.length} веществ.\n`);
      break;
    }

    if (!rows.length) break;

    for (const row of rows) {
      const label = cleanName(row.label?.value);
      if (!usableName(label)) continue;

      const aliases = String(row.aliases?.value ?? "")
        .split("||")
        .map(cleanName)
        .filter((a) => usableName(a) && a.toLowerCase() !== label.toLowerCase());

      entries.push({
        canon: label,
        spellings: [label, ...new Set(aliases)],
        cas: String(row.cas?.value ?? "").trim(),
        qid: String(row.item?.value ?? "").split("/").pop(),
      });
    }

    process.stdout.write(`\rзабрано веществ: ${entries.length}`);
    offset += PAGE;
    if (rows.length < PAGE) break;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n`);

  // Вещество с единственным написанием в справочнике бесполезно: одинаковые
  // названия схлопываются и без него. Держим только разнописание — если не
  // попросили обратного.
  const useful = keepSingles
    ? entries
    : entries.filter((e) => e.spellings.length > 1);

  const multi = entries.filter((e) => e.spellings.length > 1).length;
  console.log(`Всего веществ с русским названием: ${entries.length}`);
  console.log(`Из них с двумя и более написаниями: ${multi}`);
  console.log(
    `Пойдёт в файл: ${useful.length}` +
      (keepSingles ? " (--all: вместе с одиночными)" : ""),
  );
  console.log("");

  if (!useful.length) {
    console.log("Записывать нечего.");
    return;
  }

  console.log("Первые десять записей:");
  for (const e of useful.slice(0, 10)) {
    console.log(`  ${e.spellings.join(" | ")}   # CAS ${e.cas} ${e.qid}`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: файл не тронут. Уберите флаг, чтобы записать ${OUT}`);
    return;
  }

  const head = [
    "# Справочник синонимов, собранный из Wikidata по номеру CAS.",
    "#",
    "# СОБРАН МАШИНОЙ, ПРАВИТЬ РУКАМИ НЕ НАДО — перезапишется при следующем",
    "# сборе (scripts/fetch-wikidata-synonyms.js). Нашли ошибку — поправьте",
    "# запись в reference/synonyms.txt: тот файл читается первым и побеждает.",
    "#",
    "# В хвосте каждой строки номер CAS и код элемента Wikidata: по ним запись",
    "# можно проверить — https://www.wikidata.org/wiki/Q…",
    "#",
    `# Собрано: ${new Date().toISOString().slice(0, 10)}, веществ: ${useful.length}`,
    "",
  ].join("\n");

  const body = useful
    .map((e) => `${e.spellings.join(" | ")}   # CAS ${e.cas} ${e.qid}`)
    .join("\n");

  fs.writeFileSync(OUT, `${head}${body}\n`, "utf8");
  console.log(`\nЗаписано: ${OUT}`);
  console.log("Проверьте, что вышло:  node scripts/audit-products.js");
}

main().catch((e) => {
  console.error("Сорвалось:", e.message);
  process.exit(1);
});
