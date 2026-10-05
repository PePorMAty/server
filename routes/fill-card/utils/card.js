// routes/fill-card/utils/card.js
//
// Карточка узла: что показать модели и как прочесть её ответ.
//
// Промпт карточки (и серверный, и тот, что правится в интерфейсе) просит
// ответ в виде «Название продукта: …», а сервер ждёт JSON { productCard }.
// OpenAI держит схему принудительно, и противоречия не видно. Модели DashScope
// схему держат не всегда — и честно отвечали текстом по промпту, а сервер
// отказывал: «ответ не по схеме». Поэтому здесь три вещи:
//   — formatInstruction: явное описание JSON-ответа, дописывается к любому
//     промпту, в том числе к правленому;
//   — cardFromAnswer: карточка из ответа, даже если модель забыла обёртку
//     productCard или ответила текстом «Поле: значение»;
//   — buildCardContext: граф для модели без лишнего — раньше уходил весь
//     граф как есть, с источниками и описаниями каждого узла.

const { withoutProspective } = require("../../local-sources/utils/prospective");

/** Подписи полей — те же, что в интерфейсе (src/prompts/fillCardPrompts.ts). */
const FIELD_LABELS = {
  product: {
    product_name: "Название продукта",
    product_type: "Тип продукта",
    purity: "Степень чистоты",
    main_impurities: "Основные примеси",
    allowed_impurities: "Допустимые примеси",
    conversion_yield: "Коэффициент конверсии",
    typical_scale: "Типичный масштаб производства",
    production_volume_rf: "Объём производства в РФ (т/г)",
    import_volume_rf: "Объём импорта в РФ (т/г)",
    export_volume_rf: "Объём экспорта из РФ (т/г)",
    production_methods_share: "Распределение по способам производства",
    storage: "Условия хранения",
    carbon_footprint: "Углеродный след",
    producers: "Производители",
    applications: "Основные применения",
    derivatives_usage_share:
      "Распределение по объёмам использования в производных продуктах",
    price: "Цена",
  },
  transformation: {
    technology_name: "Название технологии",
    technology_short_description: "Краткое описание технологии",
    equipment: "Оборудование",
    conditions: "Условия",
    material_balance: "Материальный баланс (на тонну продукта)",
    by_products: "Побочные продукты",
    constraints_or_key_property: "Ограничения или ключевое свойство технологии",
    additional_materials_or_catalysts:
      "Дополнительные вещества, материалы, расходники или катализаторы",
    energy: "Энергетика",
    ecology: "Экология",
    enterprise_and_plant: "Предприятие и завод",
  },
};

/**
 * Что именно ждём в полях, где одной подписи мало: единицы, год, доли.
 * Те же пояснения — в интерфейсе (FillCardField.hint).
 */
const FIELD_HINTS = {
  production_volume_rf:
    "в тоннах в год, с годом, к которому относятся цифры, и источником, если он известен",
  import_volume_rf: "в тоннах в год, с годом и источником, если известны",
  export_volume_rf: "в тоннах в год, с годом и источником, если известны",
  production_methods_share:
    "способы получения продукта и их доли в выпуске (в процентах) в РФ и в мире",
  derivatives_usage_share:
    "производные продукты, на которые расходуется продукт, и их доли в потреблении (в процентах)",
  material_balance:
    "расход каждого вида сырья и вспомогательных веществ и выход продуктов на 1 тонну целевого продукта",
  by_products: "что образуется помимо целевого продукта, сколько и куда направляется",
  ecology: "выбросы, сбросы и отходы процесса, их опасность и способы обезвреживания",
};

function labelsFor(nodeType) {
  return nodeType === "transformation"
    ? FIELD_LABELS.transformation
    : FIELD_LABELS.product;
}
/** Подписи всех полей сразу — для пояснений к полям в промпте. */
labelsFor.all = { ...FIELD_LABELS.product, ...FIELD_LABELS.transformation };

/** Поля карточки: выбранные в интерфейсе или все поля этого типа узла. */
function cardKeys(nodeType, selectedFields) {
  return Array.isArray(selectedFields) && selectedFields.length > 0
    ? selectedFields.map(String)
    : Object.keys(labelsFor(nodeType));
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Ключ своего поля по подписи — так же, как его строит интерфейс (labelToKey):
 * иначе поле, добавленное пользователем, из текстового ответа не узнать.
 */
function labelToKey(label) {
  return String(label)
    .toLowerCase()
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Как отвечать — дописывается к промпту последним абзацем.
 *
 * Прямо сказано, что форма «Поле: …» выше — перечень полей, а не формат
 * ответа: иначе модель без принудительной схемы выбирала текст.
 */
function formatInstruction(nodeType, keys) {
  const labels = labelsFor(nodeType);
  const lines = keys.map((k) =>
    labels[k] ? `  "${k}": "…"  — ${labels[k]}` : `  "${k}": "…"  — своё поле (подпись в перечне выше)`,
  );
  return [
    "ФОРМАТ ОТВЕТА. Перечень выше — это поля карточки, а не форма ответа.",
    "Ответ верни одним JSON-объектом, без пояснений до и после:",
    '{ "productCard": {',
    lines.join(",\n"),
    "} }",
    "Значение каждого поля — строка на русском. Если данных нет, так и напиши в строке.",
  ].join("\n");
}

/**
 * Карточка из текста «Поле: значение».
 *
 * Модель, отвечающая по промпту, пишет подпись поля и значение — в той же
 * строке или ниже, иногда с жирным шрифтом Markdown. Подпись узнаём по списку
 * полей или по ключу своего поля. Строки без подписи (заголовок «Параметры»)
 * к предыдущему полю не липнут, если стоят отдельным абзацем.
 */
function cardFromText(text, nodeType, keys) {
  const labels = labelsFor(nodeType);
  // «Объём» модель пишет и как «Объем» — подписи сравниваем без «ё».
  const fold = (t) => String(t).toLowerCase().replace(/ё/g, "е");
  const byLabel = new Map();
  for (const k of keys) {
    byLabel.set(fold(labels[k] ?? ""), k);
    byLabel.set(k, k);
  }

  const card = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current && !card[current]) {
      const value = buf.join("\n").trim();
      if (value && value !== "...") card[current] = value;
    }
    buf = [];
  };

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]\s+|#+\s*)/, "");
    const m = /^\**\s*([^:*]{2,90}?)\s*\**\s*:\s*\**\s*(.*)$/.exec(line);
    const key = m
      ? byLabel.get(fold(m[1].trim())) ?? byLabel.get(labelToKey(m[1].trim()))
      : undefined;
    if (key) {
      flush();
      current = key;
      if (m[2].trim()) buf.push(m[2].trim());
      continue;
    }
    if (!line.trim()) {
      // Пустая строка закрывает значение, если оно уже есть: так заголовок
      // раздела после абзаца не приклеится к полю.
      if (buf.length) {
        flush();
        current = null;
      }
      continue;
    }
    if (current) buf.push(line.trim());
  }
  flush();
  return Object.keys(card).length ? card : null;
}

/**
 * Значение поля строкой. Модель без строгой схемы кладёт в поле то число,
 * то список — String() дал бы «[object Object]» или слипшийся список.
 */
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("; ");
  if (typeof v === "object") {
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${asText(x)}`)
      .join("; ");
  }
  return String(v);
}

/**
 * Карточка из ответа модели, в каком бы виде он ни пришёл.
 *
 * @param parsed  JSON из ответа (или null)
 * @param text    сам ответ — на случай, если JSON нет
 * @returns       объект полей или null
 */
function cardFromAnswer(parsed, text, nodeType, keys) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const k of ["productCard", "product_card", "card", "transformationCard"]) {
      const v = parsed[k];
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
    // Обёртку забыли — поля лежат на верхнем уровне.
    if (keys.some((k) => typeof parsed[k] === "string")) return parsed;
  }
  // Текст «Поле: значение» разбираем, только если это не JSON: оборванный
  // посередине JSON дал бы поля с кавычками и запятыми. Обрыв — это обрыв,
  // о нём и скажем.
  if (!text || /^\s*(?:```(?:json)?\s*)?[{[]/i.test(text)) return null;
  return cardFromText(text, nodeType, keys);
}

// ---------------------------------------------------------------------------
// Контекст графа
// ---------------------------------------------------------------------------

function clip(s, limit) {
  const t = String(s ?? "").trim();
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

const KIND = { product: "продукт", transformation: "преобразование" };

/** Граф больше этого — показываем модели участок вокруг узла. */
const MAX_NODES = 150;
/** Радиус участка вокруг узла в больших графах, в рёбрах. */
const NEIGHBOURHOOD = 4;

/** Узлы в пределах radius рёбер от start, без учёта направления. */
function neighbourhood(startId, edges, radius) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let d = 0; d < radius && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Выбранный узел — только то, что говорит о нём самом. */
function compactSelected(node) {
  const d = node?.data ?? {};
  const out = {
    id: node?.id,
    type: node?.type === "transformation" ? "transformation" : "product",
    label: clip(d.label, 300),
  };
  const text = {
    description: 1500,
    mainPurpose: 400,
    industry: 200,
    techDescriptionDown: 1500,
    techDescriptionUp: 1500,
    techDescription: 1500,
    aggregatedDescription: 3000,
  };
  for (const [key, limit] of Object.entries(text)) {
    if (typeof d[key] === "string" && d[key].trim()) out[key] = clip(d[key], limit);
  }
  // Без разделов о перспективных технологиях (см. prospective.js).
  const sources = withoutProspective([
    ...(Array.isArray(d.sourcesDown) ? d.sourcesDown : []),
    ...(Array.isArray(d.sourcesUp) ? d.sourcesUp : []),
    ...(Array.isArray(d.sources) ? d.sources : []),
  ])
    .filter((s) => s && (s.title || s.technology_description))
    .slice(0, 5)
    .map((s) => ({
      title: clip(s.title, 200),
      url: s.url || undefined,
      technology_description: clip(s.technology_description, 500),
    }));
  if (sources.length) out.sources = sources;
  return out;
}

/**
 * Что уходит модели вместо «всего графа как есть».
 *
 * Раньше в запрос шли все узлы со всеми данными: источники с текстами,
 * обобщения, прошлые карточки, координаты. На большом графе это сотни тысяч
 * символов — запрос шёл минутами и упирался в окно контекста модели. Для
 * карточки нужны место узла в цепочке и сведения о нём самом, а это —
 * названия и связи плюс данные выбранного узла.
 */
function buildCardContext(nodeObj, chainObj) {
  const parts = [];
  if (nodeObj && typeof nodeObj === "object") {
    parts.push(`SELECTED_NODE:\n${JSON.stringify(compactSelected(nodeObj), null, 2)}`);
  }

  const nodes = Array.isArray(chainObj?.nodes) ? chainObj.nodes : [];
  const edges = (Array.isArray(chainObj?.edges) ? chainObj.edges : []).filter(
    (e) => e && e.source && e.target,
  );
  if (nodes.length) {
    let shown = nodes;
    let note = "";
    if (nodes.length > MAX_NODES && nodeObj?.id) {
      const near = neighbourhood(nodeObj.id, edges, NEIGHBOURHOOD);
      shown = nodes.filter((n) => near.has(n.id));
      note = ` — участок в ${NEIGHBOURHOOD} шага вокруг узла из ${nodes.length} узлов графа`;
    }
    const ids = new Set(shown.map((n) => n.id));
    const nodeLines = shown.map(
      (n) => `${n.id} · ${KIND[n.type] ?? n.type ?? "узел"} · ${clip(n?.data?.label, 200)}`,
    );
    const edgeLines = edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => `${e.source} → ${e.target}`);
    parts.push(
      `FULL_CHAIN${note}:\nУзлы (id · тип · название):\n${nodeLines.join("\n")}` +
        (edgeLines.length ? `\n\nСвязи (откуда → куда):\n${edgeLines.join("\n")}` : ""),
    );
  }
  return parts.join("\n\n");
}

module.exports = {
  FIELD_LABELS,
  FIELD_HINTS,
  labelsFor,
  cardKeys,
  labelToKey,
  formatInstruction,
  cardFromText,
  cardFromAnswer,
  buildCardContext,
  asText,
};
