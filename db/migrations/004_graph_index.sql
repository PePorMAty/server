-- db/migrations/004_graph_index.sql — этап 3б PG-MIGRATION.md: указатель
-- узлов графов библиотеки.
--
-- Граф хранится документом (app.graphs.content), и на вопрос «в каких графах
-- есть фенол» пришлось бы разбирать каждый граф. Указатель — строки узлов с
-- ключами названий (те же, что у источников продукта): поиск по ним — один
-- запрос. Указатель производный (routes/knowledge/graphIndex.js):
-- пересчитывается при сохранении графа, при запуске сервера — у графов, где
-- версия указателя отстала.

CREATE TABLE app.graph_nodes (
  graph_id text NOT NULL REFERENCES app.graphs (id) ON DELETE CASCADE,
  node_id  text NOT NULL,
  type     text NOT NULL,
  label    text NOT NULL,
  -- Продукт: ключи названия.
  keys     text[] NOT NULL DEFAULT '{}',
  -- Преобразование: названия сырья и продуктов и их ключи.
  inputs   text[] NOT NULL DEFAULT '{}',
  outputs  text[] NOT NULL DEFAULT '{}',
  in_keys  text[] NOT NULL DEFAULT '{}',
  out_keys text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (graph_id, node_id)
);
CREATE INDEX graph_nodes_keys ON app.graph_nodes USING gin (keys);
CREATE INDEX graph_nodes_in_keys ON app.graph_nodes USING gin (in_keys);
CREATE INDEX graph_nodes_out_keys ON app.graph_nodes USING gin (out_keys);

-- С какой версии графа построен указатель.
CREATE TABLE app.graph_index (
  graph_id   text PRIMARY KEY REFERENCES app.graphs (id) ON DELETE CASCADE,
  version    bigint NOT NULL,
  nodes      integer NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
