#!/usr/bin/env node
//
// Импорт выгрузки ECICS — таможенного реестра химических веществ ЕС — в
// reference/ecics.txt: номер CAS → код Комбинированной номенклатуры ЕС.
//
//   curl -L -o ecics.zip "https://ec.europa.eu/taxation_customs/dds2/ecics/ecics_export_management.jsp?message=extractFull"
//   unzip ecics.zip                     # внутри один лист ECICS.xlsx
//   node scripts/import-ecics.js ECICS.xlsx
//
// Зачем. Код ТН ВЭД по названию (tnvedByName.js) находит только вещества, у
// которых в ТН ВЭД своя строка, а малеиновая кислота, глицин, ацетилен лежат
// в «прочих» — по названию туда не попасть. ECICS ведёт таможня ЕС, и в нём
// у вещества по номеру CAS — его код. Первые шесть знаков кода — общая для
// ЕС и ЕАЭС Гармонизированная система, дальше они делят по-своему; как это
// переводится в код ТН ВЭД — utils/ecics.js.
//
// Источник: © Европейский союз, ECICS. Лицензия CC BY 4.0
// (https://commission.europa.eu/legal-notice_en): брать можно, указав
// источник и что изменено. Изменено: оставлены только номер CAS и код.
// Сведения ECICS справочные, юридической силы не имеют (FAQ ECICS, вопрос 3).
//
// Выгрузка обновляется ежедневно; брать заново стоит раз в месяц-другой.
// Файл переписывается целиком, отсортированным по номеру CAS — чтобы разница
// между выгрузками была видна в git построчно.

const fs = require("fs");
const path = require("path");

const { forEachXlsxRow } = require("./lib/xlsx-stream");

const OUT = path.resolve(__dirname, "../reference/ecics.txt");

/** Номер CAS по виду и контрольной цифре: «71-43-2». */
function validCas(cas) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas);
  if (!m) return false;
  const digits = (m[1] + m[2]).split("").reverse();
  const sum = digits.reduce((s, d, i) => s + Number(d) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error("Укажите лист выгрузки: node scripts/import-ecics.js ECICS.xlsx");
    process.exit(2);
  }

  let header = null;
  let col = null;
  let rows = 0;
  let badCas = 0;
  const byCas = new Map();

  await forEachXlsxRow(file, {
    onHeader: (h) => {
      header = h.map((x) => String(x ?? "").trim().toUpperCase());
      col = {
        cas: header.indexOf("CAS REGISTRY NUMBERS"),
        cn: header.indexOf("CN CODE"),
      };
      if (col.cas < 0 || col.cn < 0) {
        throw new Error(`нет столбцов «CAS REGISTRY NUMBERS» и «CN CODE»; есть: ${header.join(", ")}`);
      }
    },
    onRow: (row) => {
      rows += 1;
      const r = Array.isArray(row) ? row : header.map((k) => row[k]);
      const cn = String(r[col.cn] ?? "").replace(/\D+/g, "");
      if (!cn) return;
      // В ячейке бывает несколько номеров — у смесей и солей.
      for (const cas of String(r[col.cas] ?? "").split(/[^\d-]+/).filter(Boolean)) {
        // Обрывки вроде «2» из «(2:1)» — не номера; номер по виду, но с
        // неверной контрольной цифрой — опечатка, её считаем.
        if (!/^\d{2,7}-\d{2}-\d$/.test(cas)) continue;
        if (!validCas(cas)) {
          badCas += 1;
          continue;
        }
        if (!byCas.has(cas)) byCas.set(cas, new Set());
        byCas.get(cas).add(cn);
      }
    },
  });

  // Сортируем по числам номера, а не по строке: «50-00-0» раньше «100-00-0».
  const key = (cas) => cas.split("-").map((p) => p.padStart(7, "0")).join("-");
  const list = [...byCas.keys()].sort((a, b) => key(a).localeCompare(key(b)));
  const several = list.filter((cas) => byCas.get(cas).size > 1).length;

  const head = [
    "# ECICS — таможенный реестр химических веществ ЕС (European Customs",
    "# Inventory of Chemical Substances): номер CAS → код Комбинированной",
    "# номенклатуры ЕС. Первые шесть знаков — Гармонизированная система, общая",
    "# с ТН ВЭД ЕАЭС (как переводится — routes/industry/utils/ecics.js).",
    "#",
    "# Источник: © Европейский союз, ECICS —",
    "#   https://ec.europa.eu/taxation_customs/dds2/ecics/",
    "# Лицензия CC BY 4.0 (https://commission.europa.eu/legal-notice_en).",
    "# Изменено: оставлены только номер CAS и код. Сведения справочные,",
    "# юридической силы не имеют.",
    "#",
    "# СОБРАН МАШИНОЙ: node scripts/import-ecics.js ECICS.xlsx — руками не",
    "# править. Несколько кодов у номера — через пробел.",
    "#",
    `# Выгрузка: ${new Date().toISOString().slice(0, 10)}, строк ECICS: ${rows}, номеров CAS: ${list.length},`,
    `# из них с несколькими кодами: ${several}.`,
    "",
  ].join("\n");
  const body = list.map((cas) => `${cas}\t${[...byCas.get(cas)].sort().join(" ")}`).join("\n");
  fs.writeFileSync(OUT, `${head}${body}\n`, "utf8");

  console.log(`Строк ECICS: ${rows}`);
  console.log(`Номеров CAS: ${list.length}, с несколькими кодами: ${several}`);
  if (badCas) console.log(`Отброшено номеров с неверной контрольной цифрой: ${badCas}`);
  console.log(`Записано: ${OUT}`);
}

main().catch((e) => {
  console.error("Сорвалось:", e.message);
  process.exit(1);
});
