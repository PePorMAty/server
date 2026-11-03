// Резервная копия (scripts/backup.js): данные во временной папке, «GitHub» —
// локальный голый репозиторий, ключ age — свежий. Без программы age тест
// пропускается.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const hasAge = (() => {
  try {
    execFileSync("age-keygen", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SCRIPT = path.join(__dirname, "../scripts/backup.js");

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  const data = path.join(tmp, "data");
  fs.mkdirSync(path.join(data, "saved-graphs"), { recursive: true });
  fs.mkdirSync(path.join(data, "bookmarks"));
  fs.mkdirSync(path.join(data, "local-sources", "files"), { recursive: true });
  fs.writeFileSync(path.join(data, "saved-graphs", "g1.json"), JSON.stringify({ meta: { name: "Фенол" }, graph: { nodes: [], edges: [] } }));
  fs.writeFileSync(path.join(data, "bookmarks", "g1.json"), "[]");

  const sources = new Database(path.join(data, "local-sources", "sources.sqlite"));
  sources.pragma("journal_mode = WAL");
  sources.exec("CREATE TABLE sections (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO sections (title) VALUES ('Раздел 9');");
  sources.close();
  new Database(path.join(data, "material-balance.sqlite")).exec("CREATE TABLE balances (id TEXT)");
  new Database(path.join(data, "gisp.sqlite")).exec("CREATE TABLE products (name TEXT)");

  const pdf = Buffer.from("%PDF-1.4 ИТС 31");
  const sha = crypto.createHash("sha256").update(pdf).digest("hex");
  fs.writeFileSync(path.join(data, "local-sources", "files", `${sha}.pdf`), pdf);

  const key = path.join(tmp, "key.txt");
  execFileSync("age-keygen", ["-o", key], { stdio: "ignore" });
  const recipient = fs.readFileSync(key, "utf8").match(/public key: (age1\w+)/)[1];

  const remote = path.join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const repo = path.join(tmp, "backups");
  execFileSync("git", ["clone", "-q", remote, repo], { stdio: "ignore" });
  // Копии прошлых дней: после запуска остаются семь последних.
  fs.mkdirSync(path.join(repo, "daily"));
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(repo, "daily", `2026-01-0${d}.tar.gz.age`), "old");

  const env = {
    ...process.env,
    BACKUP_DATA_DIR: data,
    BACKUP_DIR: repo,
    BACKUP_AGE_RECIPIENT: recipient,
    LOCAL_SOURCES_DIR: "",
    MATERIAL_BALANCE_DB: "",
    DB_NAME: "",
  };
  const run = (...args) => execFileSync("node", [SCRIPT, ...args], { env, encoding: "utf8", stdio: "pipe" });
  const decrypt = (file) => execFileSync("age", ["-d", "-i", key, file]);
  return { tmp, data, repo, remote, sha, pdf, run, decrypt };
}

const today = new Date().toLocaleDateString("sv-SE");

test("копия: архив данных и снимки баз, PDF один раз, семь дней, один коммит", { skip: !hasAge && "нет age" }, () => {
  const t = setup();
  const out = t.run();
  assert.match(out, /графов 1; SQLite: sources [\d,]+ МБ, material-balance [\d,]+ МБ/);
  assert.match(out, /Отправлено/);

  const daily = path.join(t.repo, "daily", `${today}.tar.gz.age`);
  const list = execFileSync("tar", ["tzf", "-"], { input: t.decrypt(daily), encoding: "utf8" });
  assert.match(list, /snapshot\/data\/saved-graphs\/g1\.json/);
  assert.match(list, /snapshot\/data\/bookmarks\/g1\.json/);
  assert.match(list, /snapshot\/sqlite\/sources\.sqlite/);
  assert.match(list, /snapshot\/manifest\.json/);
  // Справочник ГИСП пересобирается скриптом; файлы баз — только снимком.
  assert.doesNotMatch(list, /gisp|data\/local-sources|data\/material-balance/);

  // Снимок базы в WAL — целый, с данными.
  const unpacked = path.join(t.tmp, "restore");
  fs.mkdirSync(unpacked);
  execFileSync("tar", ["xzf", "-", "-C", unpacked], { input: t.decrypt(daily) });
  const restored = new Database(path.join(unpacked, "snapshot", "sqlite", "sources.sqlite"), { readonly: true });
  assert.equal(restored.prepare("SELECT title FROM sections").get().title, "Раздел 9");
  restored.close();

  const pdfCopy = path.join(t.repo, "pdf", `${t.sha}.pdf.age`);
  assert.deepEqual(t.decrypt(pdfCopy), t.pdf);
  assert.ok(fs.existsSync(path.join(t.repo, "monthly", `${today.slice(0, 7)}.tar.gz.age`)));
  assert.equal(fs.readdirSync(path.join(t.repo, "daily")).length, 7);
  assert.ok(!fs.existsSync(path.join(t.repo, "daily", "2026-01-03.tar.gz.age")));

  // Второй запуск: PDF не шифруется заново, в «GitHub» по-прежнему один коммит.
  const pdfTime = fs.statSync(pdfCopy).mtimeMs;
  t.run();
  assert.equal(fs.statSync(pdfCopy).mtimeMs, pdfTime);
  const commits = execFileSync("git", ["-C", t.remote, "rev-list", "--count", "main"], { encoding: "utf8" });
  assert.equal(commits.trim(), "1");
  const files = execFileSync("git", ["-C", t.remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" });
  assert.match(files, new RegExp(`pdf/${t.sha}\\.pdf\\.age`));
  assert.doesNotMatch(files, /\.part|local\//);
});

test("без ключа или без папки графов копия не делается", { skip: !hasAge && "нет age" }, () => {
  const t = setup();
  const noKey = () =>
    execFileSync("node", [SCRIPT, "--no-push"], { env: { ...process.env, BACKUP_DATA_DIR: t.data, BACKUP_DIR: t.repo, BACKUP_AGE_RECIPIENT: "" }, stdio: "pipe" });
  assert.throws(noKey, (e) => e.status === 2 && /BACKUP_AGE_RECIPIENT/.test(e.stderr));

  fs.rmSync(path.join(t.data, "saved-graphs"), { recursive: true });
  assert.throws(() => t.run("--no-push"), (e) => e.status === 2 && /нет saved-graphs/.test(e.stderr));
  assert.equal(fs.readdirSync(path.join(t.repo, "daily")).length, 9);
});
