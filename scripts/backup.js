#!/usr/bin/env node
//
// Резервная копия данных сервера — зашифрованной, в приватный репозиторий
// GitHub. Настройка, расписание и восстановление — BACKUP.md.
//
//   node scripts/backup.js            сделать копию и отправить
//   node scripts/backup.js --no-push  только сложить в папку копий
//
// Настройки — в .env:
//   BACKUP_AGE_RECIPIENT  открытый ключ age (age1…), обязателен
//   BACKUP_DIR            папка копий — клон репозитория копий
//                         (по умолчанию ~/graph-backups)
//
// Почему так. Графы, база источников (разбор разделов ИТС стоил запросов к
// модели) и расчёты баланса лежат только на этом сервере, в одном экземпляре.
// Копия уходит в отдельный приватный репозиторий — в другое место и бесплатно.
// Шифруем открытым ключом age: на сервере лежит только он, закрытый — у
// владельца, поэтому утечка репозитория копии не раскрывает. История
// репозитория не копится: каждая отправка — один коммит с текущим набором
// файлов, а git досылает только то, чего на GitHub ещё нет.
//
// Что в копии: data/ (графы и всё рядом с ними, ссылки «Поделиться»), снимки
// баз SQLite источников и балансов, дамп PostgreSQL — ежедневным архивом
// (хранятся 7 последних и по одному на месяц за полгода); PDF документов
// базы — каждый один раз, под своим sha256. Не копируется data/gisp.sqlite:
// это справочник, который целиком пересобирает scripts/import-gisp.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const Database = require("better-sqlite3");

// BACKUP_DATA_DIR — для теста; на сервере данные в data/ рядом с кодом.
const DATA = path.resolve(process.env.BACKUP_DATA_DIR || path.join(ROOT, "data"));
const SOURCES_DIR = path.resolve(process.env.LOCAL_SOURCES_DIR || path.join(DATA, "local-sources"));
const BALANCE_DB = path.resolve(process.env.MATERIAL_BALANCE_DB || path.join(DATA, "material-balance.sqlite"));
const REPO = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), "graph-backups"));
const RECIPIENT = String(process.env.BACKUP_AGE_RECIPIENT || "").trim();
const PUSH = !process.argv.includes("--no-push");

const KEEP_DAILY = 7;
const KEEP_MONTHLY = 6;
/** GitHub не принимает файлы больше 100 МБ. */
const MAX_FILE = 95 * 1024 * 1024;

// Дата по часам сервера: копия «за 30-е» — та, что снята 30-го.
const today = new Date().toLocaleDateString("sv-SE");
const month = today.slice(0, 7);

const problems = [];

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${cmd}: ${why}`);
  }
}

function stop(message) {
  console.error(`Копию не сделал: ${message}`);
  process.exit(2);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;

function checkSetup() {
  if (!/^age1[0-9a-z]{58}$/.test(RECIPIENT)) {
    stop("в .env нет BACKUP_AGE_RECIPIENT — открытого ключа age вида age1… (BACKUP.md, шаг 1).");
  }
  try {
    sh("age", ["--version"]);
  } catch {
    stop("нет программы age: sudo apt install age");
  }
  // Пустая или чужая папка данных дала бы пустую копию, а через неделю
  // ротация вытеснила бы ею все хорошие.
  if (!fs.existsSync(path.join(DATA, "saved-graphs"))) {
    stop(`в ${DATA} нет saved-graphs — это не папка данных сервера.`);
  }
  if (PUSH && !fs.existsSync(path.join(REPO, ".git"))) {
    stop(`${REPO} — не клон репозитория копий (BACKUP.md, шаг 3). Только локально — с --no-push.`);
  }
  for (const sub of ["daily", "monthly", "pdf", "local"]) fs.mkdirSync(path.join(REPO, sub), { recursive: true });
}

/** Снимок данных в dir: data/, базы SQLite, дамп PostgreSQL. Возвращает манифест. */
async function snapshot(dir) {
  // Базы SQLite — не копией файла: сервер может писать в них прямо сейчас,
  // и копия посреди записи битая. Их снимает backup() ниже.
  fs.cpSync(DATA, path.join(dir, "data"), {
    recursive: true,
    filter: (src) =>
      path.resolve(src) !== SOURCES_DIR && path.resolve(src) !== REPO && !/\.sqlite(-wal|-shm|-journal)?$/.test(src),
  });

  const sqlite = {};
  fs.mkdirSync(path.join(dir, "sqlite"));
  for (const [name, src] of [
    ["sources.sqlite", path.join(SOURCES_DIR, "sources.sqlite")],
    ["material-balance.sqlite", BALANCE_DB],
  ]) {
    if (!fs.existsSync(src)) continue;
    const out = path.join(dir, "sqlite", name);
    try {
      const db = new Database(src, { readonly: true, fileMustExist: true });
      try {
        await db.backup(out);
      } finally {
        db.close();
      }
      sqlite[name] = fs.statSync(out).size;
    } catch (e) {
      problems.push(`база ${name} не снялась: ${e.message}`);
    }
  }

  let postgres = "не настроен (в .env нет DB_NAME)";
  if (process.env.DB_NAME) {
    const args = ["-Fc", "--no-owner", "-w", "-f", path.join(dir, "postgres.dump"), "-d", process.env.DB_NAME];
    if (process.env.DB_HOST) args.push("-h", process.env.DB_HOST);
    if (process.env.DB_PORT) args.push("-p", process.env.DB_PORT);
    if (process.env.DB_USER) args.push("-U", process.env.DB_USER);
    try {
      sh("pg_dump", args, { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || "" } });
      postgres = mb(fs.statSync(path.join(dir, "postgres.dump")).size);
    } catch (e) {
      postgres = "не снят";
      problems.push(`дамп PostgreSQL не снялся — ${e.message}`);
    }
  }

  let serverCommit = null;
  try {
    serverCommit = sh("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).trim();
  } catch {
    /* сервер развёрнут не из git — не страшно */
  }
  const manifest = {
    date: today,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    serverCommit,
    graphs: fs.readdirSync(path.join(DATA, "saved-graphs")).filter((f) => f.endsWith(".json")).length,
    sqlite,
    postgres,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Готовый файл — в репозиторий, если GitHub его примет; иначе в local/
 * (в git не попадает) и в список проблем.
 */
function place(tmp, target) {
  const size = fs.statSync(tmp).size;
  if (size > MAX_FILE) {
    const kept = path.join(REPO, "local", path.basename(target));
    fs.renameSync(tmp, kept);
    problems.push(
      `${path.relative(REPO, target)} — ${mb(size)}, GitHub такой файл не примет; лежит только на сервере (${kept}). Пора переносить копии в объектное хранилище (BACKUP.md).`,
    );
    return false;
  }
  fs.renameSync(tmp, target);
  return true;
}

function archive(stage) {
  const target = path.join(REPO, "daily", `${today}.tar.gz.age`);
  const tmp = `${target}.part`;
  // tar сразу в age: незашифрованного архива на диске не бывает.
  sh("bash", ["-c", 'set -o pipefail; tar -C "$1" -czf - snapshot | age -r "$2" -o "$3"', "backup", stage, RECIPIENT, tmp]);
  const size = fs.statSync(tmp).size;
  if (!place(tmp, target)) return size;
  const monthly = path.join(REPO, "monthly", `${month}.tar.gz.age`);
  if (!fs.existsSync(monthly)) fs.copyFileSync(target, monthly);
  return size;
}

/** PDF документов базы — каждый один раз: файл назван по sha256, он не меняется. */
function pdfs() {
  const dir = path.join(SOURCES_DIR, "files");
  if (!fs.existsSync(dir)) return { added: 0, total: 0 };
  let added = 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"));
  for (const f of files) {
    const target = path.join(REPO, "pdf", `${f}.age`);
    if (fs.existsSync(target) || fs.existsSync(path.join(REPO, "local", `${f}.age`))) continue;
    sh("age", ["-r", RECIPIENT, "-o", `${target}.part`, path.join(dir, f)]);
    if (place(`${target}.part`, target)) added++;
  }
  return { added, total: files.length };
}

function rotate(sub, keep) {
  const dir = path.join(REPO, sub);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tar.gz.age")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  return Math.min(files.length, keep);
}

/**
 * Один коммит без родителя с текущим набором файлов — и на GitHub с заменой.
 * Старые копии уходят из репозитория вместе с прежним коммитом, поэтому он не
 * растёт с каждым днём; досылаются только новые файлы.
 */
function publish() {
  const git = (...args) =>
    sh("git", ["-C", REPO, "-c", "user.name=graph-backup", "-c", "user.email=graph-backup@localhost", ...args]).trim();
  fs.writeFileSync(path.join(REPO, ".gitignore"), "local/\n*.part\n");
  git("add", "-A");
  const tree = git("write-tree");
  const commit = git("commit-tree", tree, "-m", `Копия ${today}`);
  git("update-ref", "refs/heads/main", commit);
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("push", "-q", "--force", "origin", "main");
  // Прежние коммиты больше ни на что не нужны — и место на диске тоже.
  git("reflog", "expire", "--expire=now", "--all");
  git("prune", "--expire=now");
}

function repoSize() {
  let total = 0;
  for (const sub of ["daily", "monthly", "pdf"]) {
    for (const f of fs.readdirSync(path.join(REPO, sub))) total += fs.statSync(path.join(REPO, sub, f)).size;
  }
  return total;
}

async function main() {
  checkSetup();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "graph-backup-"));
  try {
    const manifest = await snapshot(path.join(stage, "snapshot"));
    const size = archive(stage);
    const pdf = pdfs();
    const daily = rotate("daily", KEEP_DAILY);
    const monthly = rotate("monthly", KEEP_MONTHLY);

    const dbs = Object.entries(manifest.sqlite).map(([n, s]) => `${n.replace(".sqlite", "")} ${mb(s)}`);
    console.log(
      `Копия ${today}: графов ${manifest.graphs}; SQLite: ${dbs.join(", ") || "нет"}; PostgreSQL: ${manifest.postgres}; архив ${mb(size)}.`,
    );
    console.log(`PDF документов: ${pdf.total}, новых в копии ${pdf.added}.`);
    console.log(`В папке копий ${REPO}: ежедневных ${daily}, помесячных ${monthly}, всего ${mb(repoSize())}.`);

    if (PUSH) {
      try {
        publish();
        console.log("Отправлено в репозиторий копий.");
      } catch (e) {
        problems.push(`не отправилось на GitHub — ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  for (const p of problems) console.error(`⚠ ${p}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`Копия не удалась: ${e.message}`);
  process.exit(1);
});
