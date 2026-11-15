CREATE TABLE IF NOT EXISTS demo_whatsapp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  e164 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sms_enviado INTEGER NOT NULL DEFAULT 0,
  sms_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_demo_whatsapp_e164 ON demo_whatsapp(e164);
