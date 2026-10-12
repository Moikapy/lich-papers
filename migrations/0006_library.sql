-- Library: papers a user saved for later, grouped into their own named collections.

CREATE TABLE saved_papers (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arxiv_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, arxiv_id)
);
CREATE INDEX saved_papers_user ON saved_papers(user_id, created_at DESC);
CREATE INDEX saved_papers_recent ON saved_papers(created_at);

CREATE TABLE collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name COLLATE NOCASE)
);

-- A paper in a collection is always saved: unsaving removes it from every collection.
CREATE TABLE collection_papers (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  arxiv_id      TEXT NOT NULL,
  PRIMARY KEY (collection_id, arxiv_id),
  FOREIGN KEY (user_id, arxiv_id) REFERENCES saved_papers(user_id, arxiv_id) ON DELETE CASCADE
);
CREATE INDEX collection_papers_paper ON collection_papers(user_id, arxiv_id);

-- Popular papers look at recent conversations too.
CREATE INDEX chat_sessions_recent ON chat_sessions(created_at);
