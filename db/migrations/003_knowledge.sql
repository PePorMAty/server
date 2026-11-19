-- db/migrations/003_knowledge.sql — этап 3а PG-MIGRATION.md: куски разделов
-- ИТС и поиск по их тексту.
--
-- Куски производные (routes/knowledge/chunks.js): пересобираются, когда
-- раздел записан или разобран заново, а при запуске сервера — у разделов,
-- где их нет. Поэтому миграция таблицу только создаёт: заполнит её сервер.
--
-- tsv — слова куска по-русски (основы: «фенола» найдёт «фенол»); заголовок
-- (документ · раздел) весит больше текста. hash — для векторов (этап 3в):
-- пересчитывать только изменившиеся куски.

CREATE TABLE app.section_chunks (
  section_id integer NOT NULL REFERENCES app.sections (id) ON DELETE CASCADE,
  ord        integer NOT NULL,
  heading    text NOT NULL,
  text       text NOT NULL,
  hash       text NOT NULL,
  tsv        tsvector GENERATED ALWAYS AS (
               setweight(to_tsvector('russian'::regconfig, heading), 'A') ||
               setweight(to_tsvector('russian'::regconfig, text), 'D')
             ) STORED,
  PRIMARY KEY (section_id, ord)
);
CREATE INDEX section_chunks_tsv ON app.section_chunks USING gin (tsv);
