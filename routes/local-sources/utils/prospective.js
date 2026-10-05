// Разделы справочников о перспективных технологиях («Раздел 9. Перспективные
// технологии» в ИТС) — не источник.
//
// Это процессы, которые промышленность ещё не освоила. Раньше такие разделы
// разбирались моделью и шли в обобщение с пометкой, по которой их маршрут
// становился альтернативой шага. Теперь (просьба заказчика, 2026-10-05) база их
// не хранит и не разбирает, а пометку из источников, сохранённых в графах
// раньше, отсекаем на входе маршрутов.

const PROSPECTIVE = /перспективн/i;

/** Пометка, которой такие разделы раньше начинали текст источника. */
const LEGACY_MARK = "[Перспективная технология";

/** Раздел о перспективных технологиях — по его заголовку или по пути к нему. */
function isProspectiveSection(path, title) {
  return PROSPECTIVE.test(`${path || ""} › ${title || ""}`);
}

/** Источник из такого раздела, сохранённый в графе до этой правки. */
function isProspectiveSource(s) {
  return (
    s?.prospective === true ||
    String(s?.technology_description || "").trimStart().startsWith(LEGACY_MARK)
  );
}

/** Список источников без разделов о перспективных технологиях. */
function withoutProspective(list) {
  return Array.isArray(list) ? list.filter((s) => !isProspectiveSource(s)) : [];
}

module.exports = { isProspectiveSection, isProspectiveSource, withoutProspective };
