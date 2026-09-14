// routes/graph-files/utils/store.js
//
// Файловое хранилище библиотеки графов и приложенных к ним данных.
//
// Сам граф лежит в data/saved-graphs/<id>.json, где <id> — имя файла: он же
// служит идентификатором в API. Закладки и история хранятся не внутри графа, а
// отдельными файлами-сайдкарами под тем же именем в соседних каталогах. Так
// закладка сохраняется сразу, не дожидаясь, пока пользователь сохранит сам
// граф.

const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "../../../data");

const GRAPH_DIR = path.join(DATA_DIR, "saved-graphs");
const BOOKMARKS_DIR = path.join(DATA_DIR, "bookmarks");
const HISTORY_DIR = path.join(DATA_DIR, "history");

/** Шаблон промта, правленный пользователем. Пусто — берём из окружения. */
const PROMPT_LAYOUT_FILE = path.join(DATA_DIR, "prompt-layout.json");

/**
 * Идентификатор графа приходит из URL, а мы подставляем его в путь. Срезаем всё
 * до имени файла, иначе `../../` в запросе уводит чтение за пределы каталога.
 * Возвращаем null на пустом и на «.»/«..» — вызывающий отвечает 400.
 */
function safeId(id) {
  const base = path.basename(String(id ?? "").trim());
  if (!base || base === "." || base === "..") return null;
  return base;
}

/** Путь к сайдкару графа: то же имя, что у файла графа, в своём каталоге. */
function sidecarPath(dir, id) {
  return path.join(dir, `${id.replace(/\.json$/i, "")}.json`);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Удалить файл, молча пережив его отсутствие. */
async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

/** Прочитать файл графа. null — такого графа нет. */
async function readGraphFile(id) {
  const fileName = safeId(id);
  if (!fileName) return null;

  const filePath = path.join(GRAPH_DIR, fileName);
  const content = await readJson(filePath);
  if (!content) return null;

  return { fileName, filePath, content };
}

/**
 * Мета графа для списка библиотеки и ответов на изменение.
 *
 * Читается защитно: у графов, сохранённых ранними версиями, может не быть
 * `state`, `meta.updatedAt` или `meta.description` — на таких список всё равно
 * обязан отрисоваться, а не падать целиком.
 */
function graphMeta(fileName, content) {
  const meta = content?.meta ?? {};
  const state = content?.state ?? {};

  return {
    id: fileName,
    name: meta.name ?? fileName,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    leafCount: Array.isArray(state.leaf_nodes) ? state.leaf_nodes.length : 0,
    description: meta.description ?? null,
  };
}

/** Убрать закладки и историю графа — зовём при его удалении. */
async function removeSidecars(fileName) {
  await Promise.all([
    removeFile(sidecarPath(BOOKMARKS_DIR, fileName)),
    removeFile(sidecarPath(HISTORY_DIR, fileName)),
  ]);
}

module.exports = {
  DATA_DIR,
  GRAPH_DIR,
  BOOKMARKS_DIR,
  HISTORY_DIR,
  PROMPT_LAYOUT_FILE,
  safeId,
  sidecarPath,
  readJson,
  writeJson,
  removeFile,
  readGraphFile,
  graphMeta,
  removeSidecars,
};
