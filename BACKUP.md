# Резервные копии

Скрипт `scripts/backup.js` (`npm run backup`) раз в сутки собирает данные
сервера, шифрует их и отправляет в отдельный приватный репозиторий GitHub.
Почему так устроено — в шапке скрипта; здесь — как настроить и как
восстановить.

## Что попадает в копию

| Что | Как | Сколько хранится |
|---|---|---|
| `data/`: графы, закладки, история, расчёты баланса графов, идентификаторы, ссылки «Поделиться», шаблон промпта | ежедневный архив `daily/<дата>.tar.gz.age` | 7 последних дней + первый архив каждого месяца (`monthly/`) за полгода |
| База источников `sources.sqlite` и расчёты баланса `material-balance.sqlite` | в том же архиве, снимком (сервер в это время может писать) | так же |
| PostgreSQL (`pg_dump`, если в `.env` есть `DB_NAME`) | в том же архиве, `postgres.dump` | так же |
| PDF документов базы | `pdf/<sha256>.pdf.age`, каждый один раз | все |
| `data/gisp.sqlite` | **не копируется**: справочник, его целиком пересобирает `scripts/import-gisp.js` из выгрузки реестра | — |

Всё зашифровано открытым ключом [age](https://age-encryption.org): на сервере
лежит только он. Прочитать копию можно лишь закрытым ключом, а он есть только
у владельца. **Потерять закрытый ключ — значит потерять все копии.**

В репозитории всегда один коммит с текущим набором файлов: старые копии
уходят вместе с прежним коммитом, поэтому репозиторий не растёт с каждым днём.
Это нормально для репозитория копий, но **не** для обычного: туда никто,
кроме сервера, не пишет.

## Настройка (один раз, ~15 минут)

Команды — на сервере, от пользователя, под которым работает pm2.

**1. Ключ шифрования.**

```bash
sudo apt install age
age-keygen -o ~/graph-backup-key.txt
# Public key: age1…  ← это открытый ключ, он пойдёт в .env
```

Файл `graph-backup-key.txt` — закрытый ключ. Скопируйте его к себе (в
менеджер паролей и ещё в одно место), затем удалите с сервера:

```bash
cat ~/graph-backup-key.txt     # скопировать целиком, вместе со строкой AGE-SECRET-KEY-…
shred -u ~/graph-backup-key.txt
```

Зачем удалять: если сервер взломают, старые копии в репозитории останутся
нечитаемыми.

**2. Репозиторий копий.** На GitHub — новый **приватный** пустой репозиторий,
например `PePorMAty/graph-backups` (без README и лицензии).

**3. Доступ сервера только к этому репозиторию** — ключ развёртывания:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/graph_backups -C "graph-backups"
cat ~/.ssh/graph_backups.pub
```

Этот текст — в репозиторий копий: Settings → Deploy keys → Add deploy key,
галочка **Allow write access**. Затем:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-backups
  HostName github.com
  User git
  IdentityFile ~/.ssh/graph_backups
  IdentitiesOnly yes
EOF
git clone git@github-backups:PePorMAty/graph-backups.git ~/graph-backups
```

(«You appear to have cloned an empty repository» — так и должно быть.)

**4. Настройки** — в `.env` сервера:

```
BACKUP_AGE_RECIPIENT=age1…        # открытый ключ из шага 1
# BACKUP_DIR=/home/…/graph-backups  — если клон не в ~/graph-backups
```

**5. Первый запуск руками** (из папки сервера):

```bash
npm run backup
```

Ожидаемый вывод — три строки («Копия …: графов 17; SQLite: …», «PDF
документов: …», «В папке копий …») и «Отправлено в репозиторий копий.»
Строки с «⚠» — проблемы: копия при этом сделана из того, что удалось
собрать, а код выхода 1.

**6. Расписание** — `crontab -e`, раз в сутки ночью:

```
17 3 * * * cd /путь/к/server && /полный/путь/к/node scripts/backup.js >> $HOME/graph-backup.log 2>&1
```

Полный путь к node — из `which node` (pm2 часто стоит через nvm, а у cron
своего `PATH` нет).

**7. Проверить восстановление** — один раз сразу и потом раз в квартал (ниже).

## Восстановление

На своём компьютере или на сервере, где лежит закрытый ключ:

```bash
git clone git@github.com:PePorMAty/graph-backups.git
cd graph-backups
age -d -i ~/graph-backup-key.txt daily/2026-10-30.tar.gz.age | tar xz
cat snapshot/manifest.json        # дата, число графов, коммит сервера
```

В `snapshot/` лежат:
- `data/` — как папка `data/` сервера;
- `sqlite/sources.sqlite` и `sqlite/material-balance.sqlite`;
- `postgres.dump`, если база была настроена.

Вернуть на сервер:

```bash
pm2 stop all
cp -a snapshot/data/. /путь/к/server/data/
# хвосты журнала старой базы рядом с восстановленной испортят её
rm -f /путь/к/server/data/local-sources/sources.sqlite-{wal,shm} /путь/к/server/data/material-balance.sqlite-{wal,shm}
cp snapshot/sqlite/sources.sqlite /путь/к/server/data/local-sources/
cp snapshot/sqlite/material-balance.sqlite /путь/к/server/data/
# PDF документов базы:
mkdir -p /путь/к/server/data/local-sources/files
for f in pdf/*.age; do age -d -i ~/graph-backup-key.txt -o "/путь/к/server/data/local-sources/files/$(basename "$f" .age)" "$f"; done
# PostgreSQL, если нужен:
pg_restore --clean --if-exists --no-owner -d <база> snapshot/postgres.dump
pm2 start all
```

Проверка без возврата на сервер — достаточно, что архив расшифровался,
`manifest.json` читается и число графов то, что ожидалось.

## Когда этого станет мало

- **Файл больше 95 МБ** GitHub не принимает: скрипт оставит его только на
  сервере (`local/`) и скажет «⚠». Тогда — объектное хранилище в РФ
  (Yandex Object Storage, Selectel): тот же архив, другая команда отправки.
- **Учётные записи пользователей** (этап 3 `PG-MIGRATION.md`): копия с
  персональными данными на GitHub — это их передача за границу (152-ФЗ).
  Шифрование снижает риск, но от требований закона не освобождает: к этому
  этапу копии переезжают в хранилище в РФ.
