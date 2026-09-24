#!/usr/bin/env bash
#
# Проверка снимком одной командой: что реестр отвечает на наши названия
# старым кодом и что — текущим.
#
#   bash scripts/snapshot-check.sh ORIG_HEAD    сразу после git pull: «до» —
#                                               то, что стояло до него
#   bash scripts/snapshot-check.sh 37dce42      «до» — указанный коммит
#
# Зачем. Снимок «до» обязан сниматься СТАРЫМ кодом (см. lookup-snapshot.js),
# а после git pull старого кода в папке уже нет — отсюда и путаница. Скрипт
# достаёт старый код во временную папку (git worktree — вторая рабочая копия
# того же репозитория), снимает снимок им, снимает второй текущим кодом и
# сравнивает.
#
# Что НЕ трогается: рабочая папка, запущенный сервер, база. База открывается
# только на чтение, а временная папка удаляется при выходе, даже если что-то
# упало посередине.
#
# Код выхода — как у сравнения: 1, если что-то ПРОПАЛО; 2 — не смогли начать.

set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "Укажите, с каким кодом сравнивать:" >&2
  echo "  bash scripts/snapshot-check.sh ORIG_HEAD   — сразу после git pull" >&2
  echo "  bash scripts/snapshot-check.sh 37dce42     — с конкретным коммитом" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! git -C "$ROOT" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "Коммита «$BASE» в репозитории нет." >&2
  exit 2
fi
if [ ! -d "$ROOT/node_modules" ] || [ ! -d "$ROOT/data" ]; then
  echo "Нет $ROOT/node_modules или $ROOT/data — запускайте там, где стоит сервер." >&2
  exit 2
fi

TMP="$(mktemp -d)"
OLD="$TMP/old"

cleanup() {
  # Ссылки убираем ПЕРВЫМИ и без косой черты на конце: так удаляется сама
  # ссылка, а не то, на что она указывает.
  rm -f "$OLD/node_modules" "$OLD/data"
  git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! git -C "$ROOT" worktree add --detach "$OLD" "$BASE" >/dev/null 2>&1; then
  echo "Не удалось достать код «$BASE» во временную папку." >&2
  exit 2
fi
if [ -e "$OLD/node_modules" ] || [ -e "$OLD/data" ]; then
  echo "В коммите «$BASE» лежат node_modules или data — сравнить не выйдет." >&2
  exit 2
fi
# Старому коду нужны те же библиотеки и те же данные: база реестра и
# сохранённые графы в git не лежат.
ln -s "$ROOT/node_modules" "$OLD/node_modules"
ln -s "$ROOT/data" "$OLD/data"

echo "Снимок ДО — код $(git -C "$ROOT" rev-parse --short "$BASE")…"
(cd "$OLD" && node scripts/lookup-snapshot.js --quiet --out "$TMP/before.json")
echo "Снимок ПОСЛЕ — текущий код $(git -C "$ROOT" rev-parse --short HEAD)…"
(cd "$ROOT" && node scripts/lookup-snapshot.js --quiet --out "$TMP/after.json")
echo
node "$ROOT/scripts/lookup-snapshot.js" "$TMP/before.json" "$TMP/after.json"
