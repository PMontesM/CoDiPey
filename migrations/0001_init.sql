CREATE TABLE IF NOT EXISTS clientes_fiscales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL UNIQUE,
  rfc TEXT NOT NULL,
  razon_social TEXT NOT NULL,
  codigo_postal TEXT NOT NULL,
  regimen TEXT NOT NULL,
  uso_cfdi TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ordenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  conceptos TEXT NOT NULL,
  monto TEXT NOT NULL,
  concepto_pey TEXT,
  pago_estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  requiere_factura INTEGER NOT NULL DEFAULT 0,
  datos_fiscales_ok INTEGER NOT NULL DEFAULT 0,
  facturapi_id TEXT,
  pey_transaction_id TEXT UNIQUE,
  pey_qr_id TEXT,
  estado_chat TEXT NOT NULL DEFAULT 'ESPERANDO_PRODUCTOS',
  error_fiscal TEXT,
  cliente_fiscal_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (cliente_fiscal_id) REFERENCES clientes_fiscales(id)
);

CREATE INDEX IF NOT EXISTS idx_ordenes_telefono ON ordenes(telefono);
CREATE INDEX IF NOT EXISTS idx_ordenes_pey_tx ON ordenes(pey_transaction_id);

-- Archivos (QR/PDF/XML) sin R2: cabe en plan free / cuentas preview
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
