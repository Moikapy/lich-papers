-- Accounts --------------------------------------------------------------

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,
  default_provider TEXT NOT NULL DEFAULT 'openrouter',
  default_model    TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

-- BYOK: one row per (user, provider). api_key is AES-GCM encrypted.
CREATE TABLE provider_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'ollama')),
  api_key    TEXT,
  base_url   TEXT,
  source     TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'oauth'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Daily request counter for the server-funded free router.
CREATE TABLE free_usage (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Papers (cache of arXiv metadata + extracted full text) -------------------

CREATE TABLE papers (
  arxiv_id    TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  authors     TEXT NOT NULL, -- JSON array
  abstract    TEXT NOT NULL,
  categories  TEXT NOT NULL, -- JSON array
  published   TEXT,
  updated     TEXT,
  body        TEXT,          -- extracted full text (may be truncated)
  body_source TEXT,          -- 'html' | 'pdf' | 'abstract'
  fetched_at  INTEGER NOT NULL
);

-- Conversations -----------------------------------------------------------

CREATE TABLE chat_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arxiv_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  builds_on  TEXT NOT NULL DEFAULT '[]', -- JSON array of chat_session ids
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_sessions_user ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX chat_sessions_paper ON chat_sessions(user_id, arxiv_id, updated_at DESC);

CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  meta       TEXT, -- JSON: { model, provider, tools: [{name, args, ok}] , usage }
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_session ON chat_messages(session_id, id);

-- Cross-session knowledge -------------------------------------------------

CREATE TABLE knowledge (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  arxiv_id   TEXT,
  kind       TEXT NOT NULL DEFAULT 'note', -- 'note' | 'summary'
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX knowledge_user ON knowledge(user_id, created_at DESC);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, tags,
  content = 'knowledge', content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO knowledge_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
