-- Fixed-window counters for throttling login and signup (keyed by IP and/or email).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
