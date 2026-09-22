#!/usr/bin/env node
//
// Свежий классификатор ОКПД2: обновить названия и найти снятые коды.
//
//   node scripts/okpd2-refresh.js <okpd.xlsx>                        — что даст
//   node scripts/okpd2-refresh.js <файл> --names reference/okpd2.txt — переписать
//   node scripts/okpd2-refresh.js <файл> --retired reference/okpd2-retired.txt
//
// Зачем. Наш reference/okpd2.txt содержит только ШЕСТИЗНАЧНЫЕ коды — 1736
// строк вида «20.15.31⇥Мочевина (карбамид)». А в реестре коды полные:
// «20.15.31.000». Поэтому карточка показывает название ГРУППЫ, в которую код
// попал, и честно об этом пишет. В свежей выгрузке классификатора кодов
// двадцать с лишним тысяч, всех уровней, — значит, у большинства записей
// появится точное название вместо названия группы.
//
// Второе. Выгрузка ГИСП несёт код, присвоенный записи ПРИ РЕГИСТРАЦИИ, а
// классификатор с тех пор меняется. Коды, которые в реестре есть, а в свежем
// классификаторе отсутствуют, — это снятые. Три таких мы уже видели глазами на
// карточках: 20.15.31.000 (мочевина), 20.13.63.000 (пероксид водорода),
// 20.14.61.000 (соединения с альдегидной группой). Скрипт на них и проверяется:
// если он не назовёт снятыми хотя бы эти три, сравнение сделано неверно.
//
// ПОЧЕМУ СРАВНИВАЕМ С РЕЕСТРОМ, А НЕ СО СВОИМ ФАЙЛОМ. Первая версия скрипта
// брала разность нашего файла и свежего — и дала ноль. Наш файл шестизначный,
// снятых полных кодов в нём отродясь не было, вычитать было нечего. Снятый код
// живёт не у нас, а в записях реестра, там его и надо искать.

const fs = require("fs");
const path = require("path");

const { forEachXlsxRow } = require("./lib/xlsx-stream");

const DEFAULT_DB = path.resolve(__dirname, "../data/gisp.sqlite");

/** Код ОКПД2: от двух до шести групп цифр через точку. */
const CODE_RE = /^\d{2}(?:\.\d+){0,5}$/;

const clean = (s) => String(s ?? "").trim().replace(/\.+$/, "");

/**
 * Разобрать выгрузку классификатора.
 *
 * Колонки ищем по содержимому, а не по заголовку: выгрузки приходят с разными
 * шапками, а то и вовсе без них. Код узнаётся по виду, название — это самый
 * длинный текст в строке, не являющийся кодом.
 */
async function readFresh(file) {
  const codeHits = new Map();
  const rowsRaw = [];

  // Колонки читаем по списку заголовков, а не через Object.values: если
  // заголовок окажется числом («1», «2»), JS поставит такие ключи объекта
  // вперёд остальных и порядок колонок перемешается.
  let keys = null;
  const take = (values) => {
    rowsRaw.push(values);
    for (let i = 0; i < values.length; i++) {
      if (CODE_RE.test(clean(values[i]))) {
        codeHits.set(i, (codeHits.get(i) ?? 0) + 1);
      }
    }
  };

  await forEachXlsxRow(file, {
    onHeader: (header) => {
      keys = header;
      // Заголовок может оказаться и первой строкой данных: чтение считает
      // заголовком первую строку, где заполнены хотя бы две ячейки, а в
      // выгрузке без шапки это уже код с названием. Терять её незачем.
      take(header.map((v) => String(v ?? "").trim()));
    },
    onRow: (row) => {
      const values = (keys ?? Object.keys(row)).map((k) =>
        String(row[k] ?? "").trim(),
      );
      take(values);
    },
  });

  const codeCol = [...codeHits].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (codeCol === null) {
    return { codes: new Map(), rows: rowsRaw.length, codeCol: null, nameRivals: [] };
  }

  // Название — колонка, заполненная ЧАЩЕ прочих, а при равенстве — та, где
  // больше букв. Считать одни только буквы нельзя: рядом бывает «Примечание»
  // с длинными пояснениями у десятка записей, и по сумме букв оно способно
  // обойти название. Название же стоит у каждой строки.
  const fill = new Map();
  const textLen = new Map();
  for (const values of rowsRaw) {
    for (let i = 0; i < values.length; i++) {
      if (i === codeCol) continue;
      if (!/[а-яё]/i.test(values[i])) continue;
      fill.set(i, (fill.get(i) ?? 0) + 1);
      textLen.set(i, (textLen.get(i) ?? 0) + values[i].length);
    }
  }
  const ranked = [...fill].sort(
    (a, b) => b[1] - a[1] || (textLen.get(b[0]) ?? 0) - (textLen.get(a[0]) ?? 0),
  );
  const nameCol = ranked[0]?.[0] ?? null;
  const nameRivals = ranked
    .slice(0, 3)
    .map(([i, n]) => `№${i}: ${n} строк, ${textLen.get(i)} букв`);

  const codes = new Map();
  for (const values of rowsRaw) {
    const code = clean(values[codeCol]);
    if (!CODE_RE.test(code)) continue;
    const name = nameCol === null ? "" : values[nameCol];
    if (!codes.has(code)) codes.set(code, name);
  }
  return { codes, rows: rowsRaw.length, codeCol, nameCol, nameRivals };
}

/** Какие коды и как часто стоят в записях реестра. */
function readRegistryCodes(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT okpd2 AS code, COUNT(*) AS n FROM products
       WHERE okpd2 IS NOT NULL AND okpd2 <> '' GROUP BY okpd2 ORDER BY n DESC`,
    )
    .all();
  db.close();
  return rows;
}

async function main() {
  // Разбираем по порядку: у флага своё значение, всё остальное — путь к
  // выгрузке. Через indexOf делать нельзя — он находит ПЕРВОЕ вхождение, и два
  // одинаковых пути в строке запуска ломали бы разбор.
  const args = process.argv.slice(2);
  const WITH_VALUE = new Set(["--names", "--retired", "--db"]);
  const flags = {};
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      if (file === null) file = args[i];
    } else if (WITH_VALUE.has(args[i])) {
      flags[args[i]] = args[i + 1] ?? "";
      i += 1;
    } else {
      // Флаг без значения: следующее слово — не его, а, скорее всего, путь.
      flags[args[i]] = true;
    }
  }
  const namesOut = flags["--names"] || null;
  const retiredOut = flags["--retired"] || null;
  const dbFile = flags["--db"] || DEFAULT_DB;
  const force = "--force" in flags;

  if (!file || !fs.existsSync(file)) {
    console.error("Укажите файл классификатора: node scripts/okpd2-refresh.js <okpd.xlsx>");
    process.exit(1);
  }

  const fresh = await readFresh(file);
  console.log(
    `Свежий классификатор: ${fresh.codes.size} кодов из ${fresh.rows} строк` +
      ` (код в колонке №${fresh.codeCol}, название в №${fresh.nameCol})`,
  );

  const byDepth = new Map();
  for (const code of fresh.codes.keys()) {
    const d = code.split(".").length;
    byDepth.set(d, (byDepth.get(d) ?? 0) + 1);
  }
  console.log(
    "  по уровням: " +
      [...byDepth].sort().map(([d, n]) => `${d} групп цифр: ${n}`).join(", "),
  );
  if (fresh.nameRivals?.length > 1) {
    console.log(`  колонки с текстом: ${fresh.nameRivals.join("; ")} — взята первая`);
  }

  console.log("\n── как выглядят разобранные строки ──");
  for (const [code, name] of [...fresh.codes].slice(0, 5)) {
    console.log(`  ${code}\t${name}`);
  }

  /* ── что даст обновление названий ── */
  const registry = readRegistryCodes(dbFile);
  if (!registry) {
    console.log(`\nБазы ГИСП нет (${dbFile}) — про снятые коды сказать нечего.`);
  } else {
    const used = registry.length;
    const exact = registry.filter((r) => fresh.codes.has(clean(r.code))).length;
    const missing = registry.filter((r) => !fresh.codes.has(clean(r.code)));
    const missingRecords = missing.reduce((s, r) => s + r.n, 0);

    console.log(`\nВ реестре разных кодов: ${used}`);
    console.log(`  есть в свежем классификаторе: ${exact} — у них будет ТОЧНОЕ название`);
    console.log(
      `  отсутствуют: ${missing.length}` +
        ` (записей с такими кодами: ${missingRecords})`,
    );

    console.log("\n── отсутствуют в действующем классификаторе, по частоте ──");
    for (const r of missing.slice(0, 25)) {
      console.log(`  ${String(r.n).padStart(5)} записей  ${r.code}`);
    }
    if (missing.length > 25) console.log(`  … и ещё ${missing.length - 25}`);

    console.log("\n── проверка на известных случаях ──");
    for (const code of ["20.15.31.000", "20.13.63.000", "20.14.61.000"]) {
      const inReg = registry.find((r) => clean(r.code) === code);
      const inFresh = fresh.codes.has(code);
      console.log(
        `  ${code}: в реестре ${inReg ? `${inReg.n} записей` : "нет"},` +
          ` в свежем ${inFresh ? "есть" : "нет"}` +
          ` → ${inReg && !inFresh ? "СНЯТ" : "не снят"}`,
      );
    }

    if (retiredOut) {
      // Снятых кодов должны быть единицы или десятки — это правки
      // классификатора, а не его половина. Если «отсутствует» заметная доля
      // реестра, значит, сравниваются коды разной длины: в классификаторе
      // позиция записана шестью цифрами, а в реестре девятью, или наоборот.
      // Записать такой список — значит объявить снятой половину реестра.
      const share = missing.length / Math.max(used, 1);
      if (share > 0.1 && !force) {
        console.error(
          `\nОтсутствует ${(share * 100).toFixed(1)}% кодов реестра — это не правки` +
            " классификатора, а разная длина кода. Посмотрите на разбор выше:" +
            " сколько кодов в свежем файле на каждом уровне и как выглядят" +
            " отсутствующие. Файл не записан; если разбор всё же верен — --force.",
        );
        process.exit(2);
      }

      const lines = [
        "# Коды ОКПД2, которых нет в действующем классификаторе.",
        "#",
        "# Получены сравнением: код стоит в записях реестра ГИСП, но в свежей",
        "# выгрузке классификатора отсутствует. Выгрузка ГИСП несёт код,",
        "# присвоенный записи при регистрации, и с тех пор классификатор менялся.",
        "#",
        "# Говорим осторожно — «нет в действующем классификаторе», а не",
        "# «исключён»: код мог и не существовать вовсе, если заявитель ошибся.",
        "# Для карточки разницы нет: доверять такому коду нельзя в обоих случаях.",
        "#",
        `# Собрано: ${new Date().toISOString().slice(0, 10)}, кодов: ${missing.length}`,
        "",
        ...missing.map((r) => `${clean(r.code)}\t${r.n}`),
      ];
      fs.writeFileSync(retiredOut, lines.join("\n") + "\n", "utf8");
      console.log(`\nЗаписано в ${retiredOut}: ${missing.length} кодов.`);
    }
  }

  /* ── переписать справочник названий ── */
  if (namesOut) {
    const sorted = [...fresh.codes].sort(([a], [b]) => a.localeCompare(b));
    const bad = sorted.filter(([, name]) => !name).length;
    if (bad > sorted.length / 10 && !force) {
      console.error(
        `\nБез названия ${bad} кодов из ${sorted.length} — похоже, колонка названия`,
        "определена неверно. Файл не переписан; если разбор всё же верен — --force.",
      );
      process.exit(2);
    }
    fs.writeFileSync(
      namesOut,
      sorted.map(([code, name]) => `${code}\t${name}`).join("\n") + "\n",
      "utf8",
    );
    console.log(`\nЗаписано в ${namesOut}: ${sorted.length} кодов.`);
    console.log("Это ЗАМЕНА reference/okpd2.txt — посмотрите git diff, прежде чем коммитить.");
  }

  if (!namesOut && !retiredOut) {
    console.log("\nЗаписать: --names reference/okpd2.txt и/или --retired reference/okpd2-retired.txt");
  }
}

main().catch((e) => {
  console.error("Не вышло:", e.message);
  process.exit(1);
});
