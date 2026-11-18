// routes/graph-files/utils/index.js
//
// Реэкспорт файловых помощников плюс общая для роутов проверка графа.
// Сами данные графов — через хранилище (../store: файлы или PostgreSQL).

const store = require("./store");
const { getStore } = require("../store");

/**
 * Начало любого роута, работающего с приложением к графу (закладки, история):
 * проверить id и убедиться, что сам граф на месте.
 *
 * Возвращает имя файла графа либо null — в этом случае ответ уже отправлен и
 * роуту остаётся только выйти.
 */
async function resolveGraph(req, res) {
  const fileName = store.safeId(req.params.id);
  if (!fileName) {
    res.status(400).json({ error: "Bad graph id" });
    return null;
  }

  if (!(await getStore().graphExists(fileName))) {
    res.status(404).json({ error: "Graph not found" });
    return null;
  }

  return fileName;
}

module.exports = { ...store, resolveGraph };
