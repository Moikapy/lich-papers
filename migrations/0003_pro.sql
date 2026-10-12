-- Pro subscription (Stripe) -------------------------------------------------

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'; -- 'free' | 'pro'
ALTER TABLE users ADD COLUMN plan_status TEXT;                  -- Stripe subscription status
ALTER TABLE users ADD COLUMN plan_renews_at INTEGER;            -- ms epoch of current period end
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
CREATE UNIQUE INDEX users_stripe_customer ON users(stripe_customer_id);

-- Per-subscriber OpenRouter key, provisioned with a monthly spend limit. api_key is AES-GCM encrypted.
CREATE TABLE pro_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL,
  api_key    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Stripe webhook events already applied (idempotency).
CREATE TABLE stripe_events (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Token usage per assistant reply, for cost tracking.
CREATE TABLE usage_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  billed_to         TEXT NOT NULL, -- 'user' (their key) | 'pro' (our key, capped) | 'trial' (shared key)
  provider          TEXT,
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX usage_events_user ON usage_events(user_id, created_at);
