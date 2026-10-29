// routes/material-balance/utils/followup.js
//
// Второй запрос к модели — в той же переписке, когда первого ответа мало:
//
// - источники, которые сервер не смог загрузить или подтвердить (failed):
//   по правилам промпта модель исключает их, ищет замену и пересчитывает;
// - у выбранных продуктов или у сырья нет массы («Нет данных»). Так
//   бывает, когда модель нашла раздел ИТС и дальше не искала: во фрагментах
//   ИТС часто есть расход сырья и выход основного продукта, но нет выходов
//   попутных (синильной кислоты и ацетонитрила при производстве
//   акрилонитрила). Второй запрос называет, чего не хватает, и требует
//   найти это в интернете.

const { checkLines } = require("./sources");
const { localChecks } = require("./local");
const { foundText } = require("./websearch");
const { refOf } = require("./parse");

/** Сырьё и выбранные продукты — то, чьи массы нужны человеку. Опорное задано им самим. */
const wanted = (refs) => refs.filter((r) => r.role === "target" || r.role === "input");

/** Сырьё и выбранные продукты без массы в «Результатах по продуктам». */
function missingRefs(parsed, refs) {
  const mass = new Map(parsed.products.filter((p) => p.ref).map((p) => [p.ref, p.massKg]));
  return wanted(refs).filter((r) => !mass.get(r.ref));
}

/** Допуск расхождения масс одного вещества в двух таблицах ответа. */
const MISMATCH_TOLERANCE = 0.05;

const plainName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[«»"'*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Диапазоны масс не сходятся и с допуском. */
const apart = (a, b) =>
  b.max < a.min * (1 - MISMATCH_TOLERANCE) || b.min > a.max * (1 + MISMATCH_TOLERANCE);

/**
 * Вещества, чьи массы в «Результатах по продуктам» и «Общем балансе
 * участка» расходятся. Интерфейс берёт массы из первой таблицы, а замкнутый
 * баланс модель сводит во второй. Расчёт капролактама 2026-10-29: водород
 * 1410 кг (тысячи м³, прочитанные как кг) против 134 и аммиак 948 (норма на
 * тонну продукта) против 1023 (пересчёт на базис) — сайт показал сырьё
 * «≈127 %». Поток узнаём по обозначению (P3) в названии, иначе по названию.
 */
function mismatches(parsed) {
  const flows = (parsed.flows || []).filter((f) => f.massKg);
  return (parsed.products || [])
    .filter((p) => p.massKg)
    .map((p) => {
      const f =
        (p.ref && flows.find((x) => refOf(x.name, "P") === p.ref)) ||
        flows.find((x) => plainName(x.name) === plainName(p.name));
      return f && apart(p.massKg, f.massKg)
        ? { ref: p.ref, name: p.name, products: p.massText, flows: f.massText }
        : null;
    })
    .filter(Boolean);
}

/** Сколько из нужных масс в ответе есть: второй ответ не должен быть хуже первого. */
const filledCount = (parsed, refs) => wanted(refs).length - missingRefs(parsed, refs).length;

const describe = (r) =>
  r.role === "input" ? `${r.ref} «${r.name}» — сырьё, расход` : `${r.ref} «${r.name}» — продукт, выход`;

/**
 * Текст второго запроса. checks — итоги проверки источников первого ответа,
 * failed — незагрузившиеся из них, missing — refs без массы, found —
 * найденное сервером в интернете и подтверждённое ([{ source, check }]).
 */
function followUpText({ transformation, local = [], checks = [], failed = [], missing = [], found = [], mismatched = [], basis = "" }) {
  const lines = [];
  if (checks.some((c) => c.status !== "local")) {
    lines.push("# Результаты серверной проверки источников", ...localChecks(local), ...checkLines(checks), "");
    lines.push(
      failed.length
        ? "Сервер загрузил источники из твоего ответа. Источники со status: failed сервер получить или подтвердить не смог: по правилам исключи их из используемых, найди замену и пересчитай зависимые результаты либо отметь их как неподтверждённые. Для источников со status: saved укажи server_status: saved и server_document_id."
        : "Сервер загрузил источники из твоего ответа. Для источников со status: saved укажи server_status: saved и server_document_id.",
      "",
    );
  }
  if (missing.length) {
    lines.push(
      "# Недостающие данные",
      `В ответе нет масс для: ${missing.map(describe).join("; ")}.`,
      "",
    );
    if (found.length) lines.push(foundText(found), "");
    lines.push(
      `${found.length ? "Возьми недостающее из найденных сервером документов выше. Чего нет и в них — " : "Не ограничивайся загруженными документами: "}обязательно выполни веб-поиск. Для каждого вещества из списка найди удельные показатели процесса «${transformation}» — выход продукта на тонну сырья или на тонну основного продукта, расход сырья на тонну продукта, конверсию и селективность, состав сырья — в справочниках, ИТС НДТ, отраслевых обзорах, научных статьях и патентах. Найденное оформи источниками [S…] по шаблону, пересчитай и заполни массы. Данные загруженных документов, которые ты уже использовал, сохрани. «Нет данных» оставь, только если не нашлось и в интернете, — тогда напиши в примечаниях, что искал.`,
      "",
    );
  }
  if (mismatched.length) {
    lines.push(
      "# Расхождение таблиц",
      `У одних и тех же веществ в «Результатах по продуктам» и в «Общем балансе участка» разные массы: ${mismatched
        .map((m) => `${m.ref ? `${m.ref} ` : ""}«${m.name}» — ${m.products} и ${m.flows}`)
        .join("; ")}.`,
      `Обе таблицы — на один и тот же базис${basis ? ` (${basis})` : ""}, и массы одного вещества в них должны совпадать. Перепроверь единицы (объём газа переведи в массу по плотности и укажи её в основании) и пересчёт удельных норм «на тонну продукта» на заданный базис, затем согласуй обе таблицы и итоги баланса.`,
      "",
    );
  }
  lines.push("Верни ответ заново, целиком, по тому же шаблону.");
  return lines.join("\n");
}

module.exports = { missingRefs, filledCount, mismatches, followUpText };
