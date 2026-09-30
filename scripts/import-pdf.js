#!/usr/bin/env node
//
// База источников — с сервера, без интерфейса.
//
//   node scripts/import-pdf.js <файл.pdf | папка> [...]  — загрузить PDF (папки — со всеми PDF внутри)
//                                                          и разобрать разделы моделью
//        --model <модель> --provider <qwen|openai>        — чем разбирать (по умолчанию — модель сервера)
//        --no-decode                                      — только загрузить: разберёт сервер в фоне
//   node scripts/import-pdf.js --list                    — документы и ход разбора
//   node scripts/import-pdf.js --sections <номер>        — разделы документа и их продукты
//   node scripts/import-pdf.js --decode <номер> [--all]  — разобрать заново: упавшие (или все) разделы
//   node scripts/import-pdf.js --delete <номер>          — удалить документ
//   node scripts/import-pdf.js --find "Этилен"           — что база отдаст продукту вверх и вниз
//   node scripts/import-pdf.js --products [запрос]       — продукты базы (как во вкладке «База источников»)
//
// Пишет в ту же базу, что и загрузка через интерфейс (data/local-sources/).
// Сервер перезапускать не нужно: документы видны сразу, а неразобранные
// разделы сервер подхватит сам.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const store = require("../routes/local-sources/utils/store");
const decode = require("../routes/local-sources/utils/decode");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OPTIONS_WITH_VALUE = new Set(["--model", "--provider"]);
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !OPTIONS_WITH_VALUE.has(argv[i - 1]),
);

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

const STRUCTURE = {
  outline: "по закладкам",
  links: "по содержанию",
  headings: "по заголовкам",
  pages: "кусками по 10 страниц",
};

/**
 * Что раздел знает о веществах. Для продукта раздел — источник «вверх»
 * (как его получают), если продукт тут получают, и «вниз» (что из него
 * делают), если он тут сырьё.
 */
const ROLE_LINES = [
  ["products", "получают"],
  ["byproducts", "попутно"],
  ["raw", "сырьё"],
  ["intermediates", "промежуточные"],
  ["auxiliaries", "вспомогательное"],
  ["wastes", "отходы и выбросы"],
];

function printRoles(roles, indent) {
  for (const [key, label] of ROLE_LINES) {
    if (roles[key]?.length) console.log(`${indent}${label}: ${roles[key].join(", ")}`);
  }
}

/** Разобрать очередь моделью здесь же, показывая ход. */
async function decodeQueue() {
  // Разделы, брошенные прерванным прошлым запуском, — снова в очередь.
  store.resetStale();
  const pending = store.stats().sections.pending || 0;
  if (!pending) return;
  console.log(`\nРазбор моделью: разделов в очереди ${pending}. Можно прервать (Ctrl+C) — остальное разберёт сервер.\n`);
  let n = 0;
  const off = decode.onProgress((e) => {
    n++;
    const title = e.section.full_title || e.section.title;
    if (e.ok) {
      // Промежуточные — только в --sections: в ходе разбора они шум.
      const roles = store.assignRoles(e.result);
      delete roles.intermediates;
      console.log(`[${n}/${pending}] ✓ ${title}`);
      printRoles(roles, "        ");
    } else {
      console.log(`[${n}/${pending}] ✗ ${title}: ${e.error}`);
    }
  });
  await decode.kick();
  off();
}

async function importFiles(paths) {
  const files = collectPdfs(paths);
  if (!files.length) {
    console.log("PDF не найдено.");
    return;
  }
  const provider = option("--provider");
  const model = option("--model");
  let added = 0;
  let dup = 0;
  let failed = 0;
  for (const file of files) {
    const name = path.basename(file);
    try {
      const { document: d, duplicate, warnings } = await store.addDocument(
        fs.readFileSync(file),
        { fileName: name, via: "script", provider, model },
      );
      if (duplicate) {
        dup++;
        console.log(`= ${name}: уже в базе (№${d.id} «${d.title}»)`);
      } else {
        added++;
        console.log(
          `+ ${name}: №${d.id} «${d.title}» — ${d.pages} стр., ${kb(d.bytes)}; разделов-источников: ${d.sections.total} (${STRUCTURE[d.structure] || d.structure})`,
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
  if (!flag("--no-decode")) await decodeQueue();
}

function list() {
  const st = store.stats();
  const s = st.sections;
  console.log(
    `В базе: ${st.documents} документов; разделов разобрано ${s.done || 0}, в очереди ${(s.pending || 0) + (s.working || 0)}, с ошибкой ${s.failed || 0}; веб-источников, найденных моделью: ${st.webSources}.\n${st.dir}\n`,
  );
  for (const d of store.listDocuments()) {
    console.log(
      `№${String(d.id).padEnd(4)} ${d.title}\n      ${d.fileName} — ${d.pages} стр., ${kb(d.bytes)}, ${d.addedAt.slice(0, 10)} (${d.addedVia === "script" ? "скрипт" : "интерфейс"})` +
        (d.textlessPages ? `, без текста: ${d.textlessPages} стр.` : "") +
        `\n      разделов ${d.sections.total} (${STRUCTURE[d.structure] || d.structure}): разобрано ${d.sections.done}, в очереди ${d.sections.pending}, с ошибкой ${d.sections.failed}`,
    );
  }
}

function sections(id) {
  const list = store.listSections(id);
  if (!list) {
    console.log(`Документа №${id} нет.`);
    return;
  }
  const mark = { done: "✓", failed: "✗", pending: "…", working: "…" };
  for (const s of list) {
    console.log(`${mark[s.status] || "?"} ${s.title} (${s.pages})${s.error ? ` — ${s.error}` : ""}`);
    printRoles(s.products, "    ");
  }
}

function find(product) {
  for (const dir of ["up", "down"]) {
    const local = store.sourcesFor(product, dir);
    const web = store.webSourcesFor(product, dir);
    console.log(`«${product}» ${dir === "up" ? "вверх (из чего делают)" : "вниз (что делают из него)"}: разделов ${local.length}, найдено моделью раньше ${web.length}`);
    for (const s of local) {
      console.log(`  ${s.title} — ${s.access_hint}`);
      console.log(`    ${s.technology_description.replace(/\s+/g, " ").slice(0, 200)}…`);
    }
    for (const s of web) console.log(`  веб: ${s.title} — ${s.url}`);
    console.log("");
  }
}

/** Продукты базы: ↑ — разделов «как получают», ↓ — «что из него делают». */
function products(query) {
  const q = query.trim().toLowerCase();
  const { products: all, hidden } = store.listProducts();
  const shown = q
    ? all.filter((p) => [p.label, ...p.names].some((n) => n.toLowerCase().includes(q)))
    : all;
  for (const p of shown) {
    const web = p.web.up + p.web.down;
    console.log(
      `${p.label}${p.names.length ? ` (${p.names.join(", ")})` : ""} — ↑${p.up} ↓${p.down}${web ? `, из интернета ${web}` : ""}`,
    );
  }
  console.log(
    `\nПродуктов: ${shown.length}${q ? ` из ${all.length}` : ""}; только промежуточных потоков, не показаны: ${hidden.intermediates}.`,
  );
}

(async () => {
  try {
    if (!argv.length || flag("--help")) {
      console.log(
        fs
          .readFileSync(__filename, "utf8")
          .split("\n")
          .slice(2, 19)
          .map((l) => l.replace(/^\/\/ ?/, ""))
          .join("\n"),
      );
    } else if (flag("--list")) {
      list();
    } else if (flag("--sections")) {
      sections(Number(option("--sections")));
    } else if (flag("--decode")) {
      const id = Number(option("--decode"));
      if (!store.getDocument(id)) {
        console.log(`Документа №${option("--decode")} нет.`);
      } else {
        const n = store.requeue(id, {
          only: flag("--all") ? "all" : "failed",
          provider: option("--provider"),
          model: option("--model"),
        });
        console.log(`В очередь разбора: ${n} разделов.`);
        await decodeQueue();
      }
    } else if (flag("--delete")) {
      const id = Number(option("--delete"));
      console.log(store.deleteDocument(id) ? `Документ №${id} удалён.` : `Документа №${option("--delete")} нет.`);
    } else if (flag("--find")) {
      find(argv.slice(argv.indexOf("--find") + 1).join(" "));
    } else if (flag("--products")) {
      products(argv.slice(argv.indexOf("--products") + 1).join(" "));
    } else {
      await importFiles(positional);
    }
  } finally {
    store.close();
  }
})();
