-- Pages: the user's own documents (a block editor), nested in a tree.
CREATE TABLE pages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  icon           TEXT,
  -- Editor document: TipTap JSON ('json'), or HTML from an import until the page is first edited ('html').
  content        TEXT,
  format         TEXT NOT NULL DEFAULT 'json',
  -- Plain text of the page, for search and the AI.
  text           TEXT NOT NULL DEFAULT '',
  position       REAL NOT NULL DEFAULT 0,
  -- Knowledge note the page was imported from, so an import runs once per note.
  source_note_id INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX pages_tree ON pages(user_id, parent_id, position);
CREATE UNIQUE INDEX pages_source_note ON pages(user_id, source_note_id) WHERE source_note_id IS NOT NULL;
