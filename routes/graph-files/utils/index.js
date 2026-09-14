// routes/graph-files/utils/index.js
//
// Реэкспорт файлового хранилища плюс общая для роутов проверка графа.

const store = require("./store");

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

  const existing = await store.readGraphFile(fileName);
  if (!existing) {
    res.status(404).json({ error: "Graph not found" });
    return null;
  }

  return fileName;
}

module.exports = { ...store, resolveGraph };
