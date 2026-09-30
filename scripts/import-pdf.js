#!/usr/bin/env node
//
// Локальная база источников — с сервера, без интерфейса.
//
//   node scripts/import-pdf.js <файл.pdf | папка> [...]  — загрузить PDF (папки — со всеми PDF внутри)
//   node scripts/import-pdf.js --list                    — что лежит в базе
//   node scripts/import-pdf.js --delete <номер>          — удалить документ
//   node scripts/import-pdf.js --find "Пропилен"         — что база отдаст продукту
//
// Пишет в ту же базу, что и загрузка через интерфейс (data/local-sources/),
// сервер перезапускать не нужно: новые документы видны сразу.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const store = require("../routes/local-sources/utils/store");

const args = process.argv.slice(2);

function kb(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Все PDF по списку путей: файлы как есть, папки — рекурсивно. */
function collectPdfs(paths) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
    } else if (/\.pdf$/i.test(p)) {
      out.push(p);
    }
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`Нет такого файла или папки: ${p}`);
      process.exitCode = 1;
      continue;
    }
    walk(p);
  }
  return out;
}

async function importFiles(paths) {
  const files = collectPdfs(paths);
  if (!files.length) {
    console.log("PDF не найдено.");
    return;
  }
  let added = 0;
  let dup = 0;
  let failed = 0;
  for (const file of files) {
    const name = path.basename(file);
    try {
      const { document: d, duplicate, warnings } = await store.addDocument(
        fs.readFileSync(file),
        { fileName: name, via: "script" },
      );
      if (duplicate) {
        dup++;
        console.log(`= ${name}: уже в базе (№${d.id} «${d.title}»)`);
      } else {
        added++;
        console.log(
          `+ ${name}: №${d.id} «${d.title}» — ${d.pages} стр., ${d.chunks} фрагментов, ${kb(d.bytes)}`,
        );
      }
      for (const w of warnings) console.log(`    ! ${w}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name}: ${e.message}`);
    }
  }
  console.log(`\nДобавлено: ${added}, уже были: ${dup}, с ошибкой: ${failed}.`);
  if (failed) process.exitCode = 1;
}

function list() {
  const docs = store.listDocuments();
  const st = store.stats();
  console.log(
    `В базе: ${st.documents} документов, ${st.chunks} фрагментов; веб-источников, найденных моделью: ${st.webSources}.\n${st.dir}\n`,
  );
  for (const d of docs) {
    console.log(
      `№${String(d.id).padEnd(4)} ${d.title}\n      ${d.fileName} — ${d.pages} стр., ${d.chunks} фрагментов, ${kb(d.bytes)}, ${d.addedAt.slice(0, 10)} (${d.addedVia === "script" ? "скрипт" : "интерфейс"})` +
        (d.textlessPages ? `, без текста: ${d.textlessPages} стр.` : ""),
    );
  }
}

function find(product) {
  const local = store.localSourcesFor(product);
  const up = store.webSourcesFor(product, "up");
  const down = store.webSourcesFor(product, "down");
  console.log(`«${product}»: PDF — ${local.length}, веб вверх — ${up.length}, веб вниз — ${down.length}\n`);
  for (const s of local) {
    console.log(`PDF  ${s.title} (№${s.docId}) — ${s.access_hint}`);
    console.log(`     ${s.technology_description.replace(/\s+/g, " ").slice(0, 200)}…`);
  }
  for (const [dir, items] of [["вверх", up], ["вниз", down]]) {
    for (const s of items) console.log(`веб ${dir}: ${s.title} — ${s.url}`);
  }
}

(async () => {
  try {
    if (!args.length || args.includes("--help")) {
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    } else if (args[0] === "--list") {
      list();
    } else if (args[0] === "--delete") {
      const id = Number(args[1]);
      console.log(store.deleteDocument(id) ? `Документ №${id} удалён.` : `Документа №${args[1]} нет.`);
    } else if (args[0] === "--find") {
      find(args.slice(1).join(" "));
    } else {
      await importFiles(args);
    }
  } finally {
    store.close();
  }
})();
