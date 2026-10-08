// routes/material-balance/utils/fetch-source.js
//
// Загрузить веб-источник, который назвала модель: HTML-страницу или PDF, и
// достать из него текст.
//
// Адрес пришёл из ответа модели, поэтому сервер ходит только наружу:
// внутренние адреса (localhost, 10.x, 192.168.x, 169.254.x, IPv6-локальные)
// отсекаются и сразу, и на каждом перенаправлении — иначе ответ модели мог
// бы заставить сервер заглянуть в свою сеть. Лимиты — время, размер,
// число перенаправлений.
//
// MB_SOURCES_ALLOW_PRIVATE=1 снимает запрет на внутренние адреса — только
// для стенда, где страницы-заглушки живут на 127.0.0.1.

const dns = require("dns").promises;
const net = require("net");

const { extractPdf } = require("../../local-sources/utils/pdf");

const TIMEOUT_MS = Number(process.env.MB_SOURCE_TIMEOUT_MS) || 25000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Меньше текста — страница входа, капча, ошибка или пустой каркас. */
const MIN_CHARS = 800;
/** PDF-скан даёт почти ноль знаков; короткий текстовый PDF — нормален. */
const MIN_PDF_CHARS = 200;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

class SourceError extends Error {}

/** Внутренний адрес: петля, частные сети, link-local, служебные. */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80")
  );
}

async function assertPublic(url) {
  if (process.env.MB_SOURCES_ALLOW_PRIVATE === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || host.endsWith(".localhost")) {
    throw new SourceError("внутренний адрес — сервер туда не ходит");
  }
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new SourceError("адрес сайта не найден (DNS)");
      });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new SourceError("внутренний адрес — сервер туда не ходит");
  }
}

/** Тело ответа целиком, но не больше MAX_BYTES. */
async function readBody(resp, signal) {
  const declared = Number(resp.headers.get("content-length"));
  if (declared > MAX_BYTES) throw new SourceError(`файл больше ${MAX_BYTES / 1024 / 1024} МБ`);
  const reader = resp.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    if (signal?.aborted) throw new SourceError("загрузка прервана");
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new SourceError(`файл больше ${MAX_BYTES / 1024 / 1024} МБ`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * GET с ручными перенаправлениями: каждое — снова через assertPublic.
 * Возвращает { finalUrl, status, contentType, body }.
 */
async function download(rawUrl, { signal } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new SourceError("неверный адрес");
  }
  if (!/^https?:$/.test(url.protocol)) throw new SourceError("адрес не http(s)");
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(url);
      let resp;
      try {
        resp = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru,en;q=0.8",
          },
        });
      } catch (e) {
        if (controller.signal.aborted) {
          throw new SourceError(signal?.aborted ? "загрузка прервана" : `сайт не ответил за ${TIMEOUT_MS / 1000} с`);
        }
        throw new SourceError(`сайт недоступен (${e.cause?.code || e.message})`);
      }
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
        url = new URL(resp.headers.get("location"), url);
        if (!/^https?:$/.test(url.protocol)) throw new SourceError("перенаправление не на http(s)");
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new SourceError(`доступ закрыт (HTTP ${resp.status}): нужен вход или сайт не пускает сервер`);
      }
      if (resp.status === 404 || resp.status === 410) throw new SourceError(`страницы нет (HTTP ${resp.status})`);
      if (resp.status === 429) throw new SourceError("сайт ограничил частоту запросов (HTTP 429)");
      if (resp.status >= 400) throw new SourceError(`ошибка сайта (HTTP ${resp.status})`);
      const body = await readBody(resp, controller.signal);
      return {
        finalUrl: url.toString(),
        status: resp.status,
        contentType: String(resp.headers.get("content-type") || "").toLowerCase(),
        body,
      };
    }
    throw new SourceError("слишком много перенаправлений");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", deg: "°", times: "×", minus: "−", middot: "·", sup2: "²", sup3: "³" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d?);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Кодировка страницы: из заголовка, из <meta>, иначе UTF-8. */
function charsetOf(contentType, body) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const head = body.subarray(0, 4096).toString("latin1");
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || "utf-8";
}

/** HTML → заголовок и текст: без скриптов, стилей, меню; блоки — строками. */
function htmlToText(html) {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre|dd|dt)\b[^>]*>/gi, "\n")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    // Ячейки таблицы — через «|», без разделителя в конце строки.
    .replace(/ *\| *(?=\n|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** Признаки страницы-заглушки: вход, капча, «доступ запрещён». */
const BLOCKED =
  /captcha|recaptcha|cloudflare|access denied|are you a robot|enable javascript|sign in to continue|log in to continue|подтвердите,? что вы не робот|войдите,? чтобы|доступ (запрещ|ограничен)/i;

/**
 * Загрузить источник и достать текст.
 * Возвращает { finalUrl, kind: "pdf" | "html", contentType, body, title,
 * text } или бросает SourceError с понятной человеку причиной.
 */
async function fetchSource(url, { signal } = {}) {
  const got = await download(url, { signal });
  const isPdf =
    got.contentType.includes("pdf") || got.body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) {
    let doc;
    try {
      doc = await extractPdf(got.body);
    } catch (e) {
      throw new SourceError(`PDF не читается: ${e.message}`);
    }
    const text = doc.pages.map((p) => p.text).join("\n\n").trim();
    if (text.replace(/\s/g, "").length < MIN_PDF_CHARS) {
      throw new SourceError("в PDF нет текстового слоя — похоже, скан");
    }
    return { ...got, kind: "pdf", title: doc.metaTitle || "", text };
  }
  if (!/html|text\/plain|xml/.test(got.contentType) && got.contentType) {
    throw new SourceError(`не страница и не PDF (${got.contentType.split(";")[0]})`);
  }
  let html;
  try {
    html = new TextDecoder(charsetOf(got.contentType, got.body)).decode(got.body);
  } catch {
    html = got.body.toString("utf8");
  }
  const { title, text } = /text\/plain/.test(got.contentType) ? { title: "", text: html.trim() } : htmlToText(html);
  if (text.replace(/\s/g, "").length < MIN_CHARS) {
    throw new SourceError(
      BLOCKED.test(text) || BLOCKED.test(title)
        ? "вместо текста — вход, капча или запрет доступа"
        : "на странице почти нет текста: нужен вход, страница собирается скриптом или это ошибка",
    );
  }
  if (BLOCKED.test(text.slice(0, 1500)) && text.length < 5000) {
    throw new SourceError("вместо текста — вход, капча или запрет доступа");
  }
  return { ...got, kind: "html", title, text };
}

module.exports = { fetchSource, htmlToText, isPrivateIp, SourceError };
