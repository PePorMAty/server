// routes/local-sources/utils/uploads.js
//
// Загрузка PDF кусками.
//
// Перед сервером стоит nginx: он пропускает запросы не больше
// client_max_body_size (по умолчанию 1 МБ) и сам ставит CORS-заголовки — со
// своим списком разрешённых. PDF одним запросом упирался и в предел, и в
// список (имя файла шло своим заголовком). Поэтому клиент шлёт файл кусками
// по 512 КБ, имя и модель — в адресе, а сервер собирает куски во временный
// файл и, получив последний, добавляет документ в базу.

const fs = require("fs");
const path = require("path");

const store = require("./store");

/** Незаконченная загрузка старше этого брошена (закрыли вкладку, пропала сеть). */
const STALE_MS = 6 * 60 * 60 * 1000;
/** Номер загрузки придумывает клиент — только буквы, цифры, «-» и «_». */
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

class UploadError extends Error {
  /**
   * @param status   HTTP-статус ответа
   * @param message  причина для человека
   * @param received сколько байт файла уже на сервере — с этого места клиент
   *                 продолжает
   */
  constructor(status, message, received) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

function uploadsDir() {
  return path.join(store.baseDir(), "uploads");
}

function partPath(id) {
  return path.join(uploadsDir(), `${id}.part`);
}

/** Убрать брошенные загрузки. */
function sweep(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(uploadsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(uploadsDir(), name);
    try {
      if (now - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true });
    } catch {
      // файл уже убрал кто-то другой
    }
  }
}

/**
 * Дописать кусок файла. Возвращает, сколько байт уже на сервере.
 *
 * Кусок с начала (offset = 0) начинает загрузку заново. Кусок, который
 * сервер уже получил (ответ потерялся, и клиент повторил), второй раз не
 * дописывается. Кусок не с того места — ошибка 409 с received: клиент
 * продолжит оттуда, где сервер.
 */
function appendChunk(id, offset, total, chunk, maxBytes) {
  if (!UPLOAD_ID.test(String(id))) throw new UploadError(400, "Неверный номер загрузки.");
  if (!Number.isInteger(total) || total <= 0) {
    throw new UploadError(400, "Не указан размер файла (size).");
  }
  if (total > maxBytes) {
    throw new UploadError(413, `PDF больше ${Math.round(maxBytes / 1024 / 1024)} МБ — такие не принимаем.`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset >= total) {
    throw new UploadError(400, "Неверное место куска в файле (offset).");
  }
  if (!Buffer.isBuffer(chunk) || !chunk.length) throw new UploadError(400, "Пустой кусок файла.");
  if (offset + chunk.length > total) {
    throw new UploadError(400, "Кусок выходит за объявленный размер файла.");
  }

  fs.mkdirSync(uploadsDir(), { recursive: true });
  const p = partPath(id);
  if (offset === 0) {
    // PDF начинается с «%PDF-» (допускается мусор перед ним в первом
    // килобайте). Не PDF — отказ сразу, а не после загрузки всего файла.
    if (!chunk.subarray(0, 1024).includes("%PDF-")) {
      throw new UploadError(400, "Это не PDF — принимаются только файлы .pdf.");
    }
    sweep();
    fs.writeFileSync(p, chunk);
    return chunk.length;
  }
  let have;
  try {
    have = fs.statSync(p).size;
  } catch {
    throw new UploadError(409, "Начало файла на сервер не пришло — загрузка начнётся заново.", 0);
  }
  if (have === offset + chunk.length) return have;
  if (have !== offset) {
    throw new UploadError(409, `Сервер получил ${have} байт, а кусок начинается с ${offset}.`, have);
  }
  fs.appendFileSync(p, chunk);
  return have + chunk.length;
}

/** Собранный файл: забрать и убрать с диска. */
function takeUpload(id) {
  const p = partPath(id);
  try {
    return fs.readFileSync(p);
  } finally {
    fs.rmSync(p, { force: true });
  }
}

module.exports = { appendChunk, takeUpload, sweep, UploadError, UPLOAD_ID };
