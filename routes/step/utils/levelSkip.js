// routes/step/utils/levelSkip.js
//
// Перепрыгивание уровня в обобщении шага «вниз» — проверка по тексту ответа.
//
// Правило промпта «А → П → X: выход шага — П» модель нарушает уверенно: от
// фенола выдаёт капролактам и сама же пишет в «Описании», что фенол
// гидрируют до циклогексанола, а того — до циклогексанона. Правки промпта её
// не переубедили (живые прогоны prompt-check 2026-10-29: капролактам снова и
// снова, с новыми объяснениями). Поэтому проверяет сервер: если в описании
// основного шага названы промежуточные продукты раздела базы, а выход — не
// один из них, модель переспрашивают один раз в той же переписке.

/** Технологические потоки — не продукты: выходом шага их не предлагаем. */
const STREAM =
  /(реакционн|масс[аы]?$|смес|сырец|масло|раствор|суспензи|плав|газ|аддукт|фракци|поток|алкилат|расплав|форполимер|остат|кислые|отработ)/i;

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Основной шаг ответа: выходы и описание. Раздел «## Шаг» — до
 * «Альтернатив» или следующего заголовка первого уровня.
 */
function mainStep(markdown) {
  const text = String(markdown || "");
  const from = text.search(/^##\s*Шаг(?![а-яё])/im);
  if (from < 0) return null;
  const rest = text.slice(from);
  const end = rest.slice(2).search(/^#{1,2}\s*(?!Шаг(?![а-яё]))\S/im);
  const section = end >= 0 ? rest.slice(0, end + 2) : rest;
  const field = (label) => {
    const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]*)`).exec(section);
    return m ? m[1].trim() : "";
  };
  const list = (label) =>
    field(label)
      .replace(/^\[|\]\.?$/g, "")
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  return { outputs: list("Что производят"), inputs: list("Из чего производят"), description: field("Описание") };
}

/** Падежные окончания: «циклогексанон» → «циклогексанона», но не «циклогексан» → «циклогексанол». */
const ENDING = "(?:а|я|у|ю|ом|ем|ой|ей|е|и|ы|ов|ев|ам|ям|ами|ями|ах|ях|ого|его|ому|ему|ым|им|ых|их|ую|юю|ая|яя|ое|ее|ые|ие|ий|ый)?";

const words = (name) => norm(name).split(/[\s-]+/).filter(Boolean);
const stemOf = (w) => w.replace(/[аеиоуыэюяйь]{1,2}$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Назван ли продукт в тексте — с поправкой на падежи: слова названия подряд,
 * каждое — основой без конечной гласной и с падежным окончанием («серная
 * кислота» находит «серной кислотой»). Именно фразой: по отдельным словам
 * «Целевой алкилфенол» находился в «выделяется целевой продукт — алкилфенол»
 * (живой прогон 2026-10-29) — и сервер переспросил модель зря.
 */
function mentions(text, name) {
  const ws = words(name);
  if (!ws.some((w) => w.length >= 4)) return false;
  const phrase = ws.map((w) => `${stemOf(w)}${ENDING}`).join("[\\s-]+");
  return new RegExp(`(^|[^а-яё])${phrase}(?![а-яё])`).test(text);
}

/**
 * Тот же продукт с уточнением — не ступень: «Целевой алкилфенол», «Сырой
 * алкилфенол» при выходе «Алкилфенол». Сравниваем слова названий: все слова
 * выхода есть в названии промежуточного.
 */
function refinesOutput(mid, outputs) {
  const m = words(mid).map(stemOf);
  return outputs.some((o) => {
    const ow = words(o).map(stemOf).filter((w) => w.length >= 4);
    return ow.length > 0 && ow.every((w) => m.includes(w));
  });
}

/** Поток (алкилат, реакционная масса, сырец) — не продукт шага. */
const isStream = (name) => STREAM.test(norm(name));

/**
 * Промежуточные продукты, через которые основной шаг перепрыгнул: названы в
 * его описании, а выход — не один из них. Пусто — всё в порядке (или
 * проверять не по чему).
 *
 * Выход, который сам есть в списке промежуточных (циклогексанон при
 * упомянутом циклогексаноле), не трогаем: это уже первая ступень или
 * соседняя с ней, лишний запрос того не стоит.
 */
function skippedIntermediates(markdown, productName, intermediates) {
  const main = mainStep(markdown);
  if (!main || !main.outputs.length || !main.description) return [];
  const list = [...new Set((intermediates || []).map((s) => String(s).trim()).filter(Boolean))];
  const isMid = (o) => list.some((p) => norm(p) === norm(o));
  if (main.outputs.some(isMid)) return [];
  const desc = norm(main.description);
  const target = norm(productName);
  return list.filter(
    (p) =>
      !isStream(p) &&
      norm(p) !== target &&
      !main.outputs.some((o) => norm(o) === norm(p)) &&
      !refinesOutput(p, main.outputs) &&
      // Второе сырьё шага (дифенилкарбонат при бисфеноле А) — не ступень.
      !main.inputs.some((i) => norm(i) === norm(p)) &&
      mentions(desc, p),
  );
}

/** Дозапрос: что исправить и как — в той же переписке. */
function levelFollowUp(productName, outputs, skipped) {
  return [
    "Проверка сервера: шаг перепрыгивает уровень.",
    `В «Описании» основного шага названы промежуточные продукты, которые получают из «${productName}» по пути к «${outputs.join(", ")}»: ${skipped.join(", ")}.`,
    `По правилу «Не перепрыгивай через уровень» выход шага от «${productName}» — первый из них по ходу процесса, а «${outputs.join(", ")}» — уже следующий шаг, от него. Выход — только один из названных здесь продуктов; технологический поток (реакционная масса, алкилат, сырец) выходом не бывает.`,
    "Верни ответ целиком заново по тому же шаблону: исправь «Что производят» основного шага, его «Из чего производят» (то, что подают на эту ступень), «Краткую формулу шага», «Описание» и строку в «Контроле шага». Альтернативы и остальное оставь как было.",
    `Если ни один из названных продуктов не получают из «${productName}» на первой ступени этого процесса, верни прежний ответ без изменений и объясни это в «Примечаниях».`,
  ].join("\n");
}

/**
 * Принять ли ответ на дозапрос: новый выход основного шага — один из
 * названных сервером промежуточных и не поток. Иначе остаётся первый ответ:
 * в живом прогоне 2026-10-29 модель на дозапрос ответила «Алкилат»
 * (реакционной массой), которого сервер вовсе не называл.
 */
function acceptFollowUp(markdown, skipped) {
  const main = mainStep(markdown);
  if (!main?.outputs.length) return false;
  const named = new Set(skipped.map(norm));
  return main.outputs.every((o) => !isStream(o)) && main.outputs.some((o) => named.has(norm(o)));
}

module.exports = { skippedIntermediates, levelFollowUp, acceptFollowUp, mainStep, isStream };
