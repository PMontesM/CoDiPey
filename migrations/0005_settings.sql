-- Configuración editable desde /superadmin (override sobre secrets de Wrangler).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at);
