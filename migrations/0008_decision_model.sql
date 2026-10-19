-- Decision model (e.g. Clef Flash on Ollama) for re-ranking, routing, note tags and grounding checks.
-- NULL: use the server's, if configured. 'off': never. Anything else: that model on the user's Ollama key.
ALTER TABLE users ADD COLUMN decision_model TEXT;
