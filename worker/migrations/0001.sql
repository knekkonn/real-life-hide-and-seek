CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY CHECK(length(code) = 4),
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
