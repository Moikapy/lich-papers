-- License per paper (from arXiv OAI-PMH), and short-lived full text instead of a permanent copy.
ALTER TABLE papers ADD COLUMN license TEXT;            -- license URI; NULL = arXiv default (not open)
ALTER TABLE papers ADD COLUMN license_checked_at INTEGER;
ALTER TABLE papers ADD COLUMN body_expires_at INTEGER;

-- Drop full text cached permanently by earlier versions.
UPDATE papers SET body = NULL, body_source = NULL;

-- Shared throttle so the whole app makes at most one arXiv request every few seconds.
CREATE TABLE arxiv_gate (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  next_at INTEGER NOT NULL
);
INSERT INTO arxiv_gate (id, next_at) VALUES (1, 0);
