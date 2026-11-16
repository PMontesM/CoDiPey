-- Errores recientes visibles en /superadmin (sin Sentry).
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'error',
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  context TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at DESC);
