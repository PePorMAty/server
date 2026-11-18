-- db/migrations/001_graphs.sql — этап 1 PG-MIGRATION.md: графы и всё, что рядом.
--
-- Отдельная схема app: старые пустые таблицы Sequelize (public.graphs,
-- nodes, edges) не мешают и удаляются потом отдельным шагом.
--
-- Граф — документом jsonb, как файл data/saved-graphs/<id>.json ({ meta,
-- graph: { nodes, edges }, state }): клиент сохраняет и открывает граф
-- целиком, и ответ API остаётся прежним. Закладки, история, расчёты баланса
-- и идентификаторы продуктов — строками на узел, а не документом: две
-- правки разных узлов не затирают друг друга, очереди в памяти не нужны.
--
-- Под пользователей (этап 5) — только место: created_by / updated_by пока
-- пустые, все графы — в области «Общая библиотека».

CREATE SCHEMA IF NOT EXISTS app;

-- Область — «чьи графы». Пока одна: «Общая библиотека».
CREATE TABLE app.workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'team',    -- 'personal' | 'team' | 'library'
  owner_id   uuid,                            -- REFERENCES app.users с этапа 5
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.workspaces (id, name, kind)
VALUES ('00000000-0000-0000-0000-000000000001', 'Общая библиотека', 'library');

CREATE TABLE app.graphs (
  id           text PRIMARY KEY,              -- прежнее имя файла: старые ссылки живут
  workspace_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
               REFERENCES app.workspaces,
  name         text NOT NULL,                 -- копия meta.name — для списка
  content      jsonb NOT NULL,                -- { meta, graph: { nodes, edges }, state }
  node_count   int NOT NULL DEFAULT 0,
  version      bigint NOT NULL DEFAULT 1,     -- растёт с каждым сохранением; meta.version — то же
  created_by   uuid,
  updated_by   uuid,                          -- пусто до этапа 5
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz                    -- удаление мягкое, восстановимо
);
CREATE INDEX graphs_workspace ON app.graphs (workspace_id) WHERE deleted_at IS NULL;

-- Прежние сохранения: откатить чужую правку, посмотреть, что было. Хранятся
-- последние несколько (GRAPH_REVISIONS_KEEP): места на диске сервера мало.
CREATE TABLE app.graph_revisions (
  graph_id text NOT NULL REFERENCES app.graphs ON DELETE CASCADE,
  version  bigint NOT NULL,
  content  jsonb NOT NULL,
  saved_by uuid,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, version)
);

CREATE TABLE app.graph_bookmarks (
  graph_id   text NOT NULL REFERENCES app.graphs ON DELETE CASCADE,
  node_id    text NOT NULL,
  label      text NOT NULL DEFAULT '',
  kind       text NOT NULL DEFAULT 'product',
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, node_id)
);

-- История: запись клиента целиком (id, at, kind, title, details, nodeIds);
-- свежие — с большим seq.
CREATE TABLE app.graph_history (
  graph_id text NOT NULL REFERENCES app.graphs ON DELETE CASCADE,
  seq      bigserial,
  entry    jsonb NOT NULL,
  user_id  uuid,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, seq)
);

CREATE TABLE app.graph_balances (
  graph_id   text NOT NULL REFERENCES app.graphs ON DELETE CASCADE,
  node_id    text NOT NULL,
  calcs      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, node_id)
);

CREATE TABLE app.graph_product_ids (
  graph_id   text NOT NULL REFERENCES app.graphs ON DELETE CASCADE,
  node_id    text NOT NULL,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_id, node_id)
);

-- Снимки «Поделиться» — копия графа только для чтения.
CREATE TABLE app.shares (
  id         text PRIMARY KEY,
  graph      jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Настройки сервера, которые правят с сайта (шаблон промпта «Создание графа»).
CREATE TABLE app.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
