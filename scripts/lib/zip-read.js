// scripts/lib/zip-read.js
//
// Чтение отдельных файлов из zip-архива потоком.
//
// Книга Excel — это zip. Нам из неё нужны три-четыре записи, а не весь архив,
// и разворачивать их надо на лету: лист реестра в распакованном виде весит в
// восемь раз больше самой книги, и на диске для него места может не быть.
//
// Читаем оглавление архива с конца файла, затем открываем поток ровно на те
// записи, которые понадобились.

const fs = require("fs");
const zlib = require("zlib");

const SIG_EOCD = 0x06054b50; // конец центрального каталога
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50; // запись каталога
const LEN_EOCD = 22;
const LEN_CENTRAL = 46;
const LEN_LOCAL = 30;

/** Найти конец центрального каталога. Он в хвосте, но за ним бывает коммент. */
function findEocd(fd, size) {
  // Коммент архива не длиннее 65535 байт — дальше этого искать негде.
  const span = Math.min(size, 0xffff + LEN_EOCD);
  const buf = Buffer.alloc(span);
  fs.readSync(fd, buf, 0, span, size - span);

  for (let i = buf.length - LEN_EOCD; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return { buf, at: i, fileOffset: size - span + i };
    }
  }
  throw new Error("Файл не похож на zip-архив: не найден конец каталога.");
}

/**
 * Где начинается каталог и сколько в нём записей.
 *
 * В обычном zip эти числа лежат прямо в хвосте. Если хоть одно из них не
 * помещается в четыре байта, архив записан в формате zip64, и настоящие
 * значения лежат в отдельной записи перед хвостом.
 */
function locateCentral(fd, size) {
  const { buf, at, fileOffset } = findEocd(fd, size);
  let count = buf.readUInt16LE(at + 10);
  let offset = buf.readUInt32LE(at + 16);

  if (count !== 0xffff && offset !== 0xffffffff) return { count, offset };

  // zip64: сначала указатель на расширенный хвост, потом сам хвост.
  const loc = Buffer.alloc(20);
  fs.readSync(fd, loc, 0, 20, fileOffset - 20);
  if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) {
    throw new Error("Архив помечен как zip64, но расширенный хвост не найден.");
  }

  const eocd64At = Number(loc.readBigUInt64LE(8));
  const rec = Buffer.alloc(56);
  fs.readSync(fd, rec, 0, 56, eocd64At);
  if (rec.readUInt32LE(0) !== SIG_EOCD64) {
    throw new Error("Повреждён расширенный хвост zip64.");
  }

  count = Number(rec.readBigUInt64LE(32));
  offset = Number(rec.readBigUInt64LE(48));
  return { count, offset };
}

/**
 * Настоящие размеры и смещение записи.
 *
 * В zip64 поля в каталоге заполнены единицами, а значения вынесены в
 * дополнительное поле с меткой 0x0001 — и лежат там только те, что не
 * поместились, строго в этом порядке.
 */
function readZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.size === 0xffffffff) { entry.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.compressed === 0xffffffff) { entry.compressed = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.offset === 0xffffffff) { entry.offset = Number(extra.readBigUInt64LE(q)); q += 8; }
      return;
    }
    p += 4 + len;
  }
}

/** Прочитать оглавление архива: имя записи → где она лежит и как сжата. */
function readDirectory(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const { count, offset } = locateCentral(fd, size);

    // Каталог небольшой (по записи на файл внутри книги) — читаем целиком.
    const dir = Buffer.alloc(size - offset);
    fs.readSync(fd, dir, 0, dir.length, offset);

    const entries = new Map();
    let p = 0;

    for (let i = 0; i < count && p + LEN_CENTRAL <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== SIG_CENTRAL) break;

      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const entry = {
        method: dir.readUInt16LE(p + 10),
        compressed: dir.readUInt32LE(p + 20),
        size: dir.readUInt32LE(p + 24),
        offset: dir.readUInt32LE(p + 42),
      };
      const name = dir.toString("utf8", p + LEN_CENTRAL, p + LEN_CENTRAL + nameLen);

      if (entry.size === 0xffffffff || entry.compressed === 0xffffffff || entry.offset === 0xffffffff) {
        readZip64Extra(dir.subarray(p + LEN_CENTRAL + nameLen, p + LEN_CENTRAL + nameLen + extraLen), entry);
      }

      entries.set(name, entry);
      p += LEN_CENTRAL + nameLen + extraLen + commentLen;
    }

    return { file, entries };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Поток содержимого одной записи.
 *
 * Данные начинаются не сразу после заголовка: между ним и телом лежат имя и
 * дополнительные поля, и их длины в локальном заголовке свои, не такие, как в
 * каталоге. Поэтому заголовок приходится прочитать отдельно.
 */
function openEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;

  const fd = fs.openSync(zip.file, "r");
  let head;
  try {
    head = Buffer.alloc(LEN_LOCAL);
    fs.readSync(fd, head, 0, LEN_LOCAL, entry.offset);
  } finally {
    fs.closeSync(fd);
  }

  const start = entry.offset + LEN_LOCAL + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = fs.createReadStream(zip.file, {
    start,
    end: start + entry.compressed - 1,
  });

  if (entry.method === 0) return raw; // без сжатия
  if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
  throw new Error(`Внутри книги неизвестный метод сжатия (${entry.method}).`);
}

/** Есть ли такая запись в архиве. */
const hasEntry = (zip, name) => zip.entries.has(name);

module.exports = { readDirectory, openEntry, hasEntry };
