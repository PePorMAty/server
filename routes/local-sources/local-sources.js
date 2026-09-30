// routes/local-sources/local-sources.js
//
// База источников на сервере — HTTP.
//
//   GET    /api/local-sources/documents              — документы и ход разбора
//   POST   /api/local-sources/documents              — загрузить PDF (тело — сам файл,
//                                                       Content-Type: application/pdf,
//                                                       имя — в заголовке X-File-Name,
//                                                       модель разбора — X-Provider, X-Model)
//   DELETE /api/local-sources/documents/:id          — удалить документ
//   GET    /api/local-sources/documents/:id/file     — открыть PDF (#page=N — страница)
//   GET    /api/local-sources/documents/:id/sections — разделы документа и их продукты
//   POST   /api/local-sources/documents/:id/decode   — { only: "failed" | "all",
//                                                       provider?, model? } —
//                                                       разобрать разделы заново
//   POST   /api/local-sources/lookup                 — { products: [...] } → сколько
//                                                       источников у каждого продукта
//   POST   /api/local-sources/for-product            — { product, direction } →
//                                                       разделы документов и
//                                                       сохранённые веб-источники
//
// Продукт ищется, как при опознании: по всем написаниям из справочника.

const express = require("express");

const store = require("./utils/store");
const decode = require("./utils/decode");

const router = express.Router();

// Разбор разделов моделью идёт в фоне с запуска сервера: дочищает очередь,
// оставшуюся от прошлого процесса.
if (process.env.LOCAL_SOURCES_DECODE !== "off") decode.start();

/** Предел размера PDF. Больше — обычно книга сканов, которую текстом не прочесть. */
const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** Сколько продуктов разом принимает проверка — как у опознания. */
const MAX_PRODUCTS = 500;

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

/** Модель разбора из заголовков: та, что выбрана в интерфейсе. */
function modelFrom(req) {
  const clean = (v) => String(v || "").trim().slice(0, 100) || null;
  return { provider: clean(req.get("X-Provider")), model: clean(req.get("X-Model")) };
}

router.get("/local-sources/documents", (req, res) => {
  try {
    // Путь к базе на диске сервера наружу не отдаём: он нужен только скрипту.
    const stats = store.stats();
    delete stats.dir;
    res.json({ success: true, documents: store.listDocuments(), stats });
  } catch (e) {
    console.error("[local-sources] список:", e);
    fail(res, 500, `База источников недоступна: ${e.message}`);
  }
});

/**
 * Тело запроса — сам PDF. Превышение предела отдаём понятным текстом, а не
 * общим «Internal server error» центрального обработчика.
 */
const readPdfBody = (req, res, next) =>
  express.raw({
    type: ["application/pdf", "application/octet-stream"],
    limit: MAX_PDF_BYTES,
  })(req, res, (err) => {
    if (err?.type === "entity.too.large") {
      return fail(res, 413, `PDF больше ${MAX_PDF_BYTES / 1024 / 1024} МБ — такие не принимаем.`);
    }
    next(err);
  });

router.post(
  "/local-sources/documents",
  readPdfBody,
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) {
      return fail(res, 400, "Пустой запрос: пришлите PDF телом запроса (Content-Type: application/pdf).");
    }
    // Имя файла идёт заголовком: в теле — сам PDF. Кириллицу клиент кодирует.
    let fileName = "document.pdf";
    try {
      fileName = decodeURIComponent(String(req.get("X-File-Name") || "")) || fileName;
    } catch {
      // кривое кодирование имени — не повод отказывать в загрузке
    }
    fileName = fileName.replace(/[\\/]/g, "_").slice(0, 200);

    try {
      const result = await store.addDocument(buf, { fileName, via: "ui", ...modelFrom(req) });
      // Разделы записаны — модель разбирает их в фоне, клиент смотрит ход
      // по списку документов.
      if (!result.duplicate) decode.kick();
      res.json({ success: true, ...result });
    } catch (e) {
      // Ошибки разбора PDF написаны для человека — отдаём как есть.
      console.error(`[local-sources] загрузка «${fileName}»:`, e.message);
      fail(res, 422, e.message);
    }
  },
);

router.delete("/local-sources/documents/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 400, "Неверный номер документа.");
  try {
    if (!store.deleteDocument(id)) return fail(res, 404, "Такого документа нет.");
    res.json({ success: true });
  } catch (e) {
    console.error("[local-sources] удаление:", e);
    fail(res, 500, e.message);
  }
});

router.get("/local-sources/documents/:id/file", (req, res) => {
  const id = Number(req.params.id);
  const doc = Number.isInteger(id) ? store.getDocument(id) : null;
  if (!doc) return fail(res, 404, "Такого документа нет.");
  res.setHeader("Content-Type", "application/pdf");
  // inline — браузер открывает PDF у себя, #page=N из ссылки ведёт на страницу.
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
  );
  res.sendFile(doc.filePath, (err) => {
    if (err && !res.headersSent) fail(res, 404, "Файл документа не найден на диске.");
  });
});

router.get("/local-sources/documents/:id/sections", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 400, "Неверный номер документа.");
  try {
    const sections = store.listSections(id);
    if (!sections) return fail(res, 404, "Такого документа нет.");
    res.json({ success: true, sections });
  } catch (e) {
    console.error("[local-sources] разделы:", e);
    fail(res, 500, e.message);
  }
});

router.post("/local-sources/documents/:id/decode", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 400, "Неверный номер документа.");
  if (!store.getDocument(id)) return fail(res, 404, "Такого документа нет.");
  const only = req.body?.only === "all" ? "all" : "failed";
  const clean = (v) => (v ? String(v).trim().slice(0, 100) : undefined);
  try {
    const queued = store.requeue(id, {
      only,
      provider: clean(req.body?.provider),
      model: clean(req.body?.model),
    });
    decode.kick();
    const { filePath, ...document } = store.getDocument(id);
    res.json({ success: true, queued, document });
  } catch (e) {
    console.error("[local-sources] разбор заново:", e);
    fail(res, 500, e.message);
  }
});

router.post("/local-sources/lookup", (req, res) => {
  const products = Array.isArray(req.body?.products)
    ? [...new Set(req.body.products.map((p) => String(p || "").trim()).filter(Boolean))]
    : [];
  if (products.length > MAX_PRODUCTS) {
    return fail(res, 400, `Не больше ${MAX_PRODUCTS} продуктов за раз.`);
  }
  try {
    const out = {};
    for (const p of products) out[p] = store.countsFor(p);
    res.json({ success: true, products: out });
  } catch (e) {
    console.error("[local-sources] проверка продуктов:", e);
    fail(res, 500, e.message);
  }
});

router.post("/local-sources/for-product", (req, res) => {
  const product = String(req.body?.product || "").trim();
  const direction = req.body?.direction === "up" ? "up" : "down";
  if (!product) return fail(res, 400, "product is required");
  try {
    res.json({
      success: true,
      product,
      direction,
      local: store.sourcesFor(product, direction),
      web: store.webSourcesFor(product, direction),
    });
  } catch (e) {
    console.error("[local-sources] источники продукта:", e);
    fail(res, 500, e.message);
  }
});

module.exports = router;
