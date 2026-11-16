export type Env = {
  DB: D1Database;
  ASSETS?: Fetcher;
  PEY_API_KEY: string;
  /** Secreto Standard Webhooks de pey (whsec_…). Obliga firma en /pey/webhook. */
  PEY_WEBHOOK_SECRET?: string;
  FACTURAPI_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_FROM: string;
  /** Código del Sandbox, ej. "writer-suggest" (sin la palabra join). */
  TWILIO_SANDBOX_JOIN_CODE?: string;
  /** Número Twilio SMS (E.164) para mandar la instrucción antes del join. Opcional. */
  TWILIO_SMS_FROM?: string;
  /**
   * Token de operador para panel/APIs cuando no hay identidad Cursor
   * (p. ej. Worker en workers.dev). Header: Authorization Bearer o x-admin-token.
   */
  ADMIN_API_SECRET?: string;
  /** HMAC para URLs firmadas de facturas; cae a ADMIN_API_SECRET / PEY_WEBHOOK_SECRET. */
  FILE_SIGNING_SECRET?: string;
  PUBLIC_URL?: string;
};

export type Orden = {
  id: number;
  telefono: string;
  conceptos: string;
  monto: string;
  concepto_pey: string | null;
  pago_estado: string;
  requiere_factura: number;
  datos_fiscales_ok: number;
  facturapi_id: string | null;
  cfdi_uuid?: string | null;
  pey_transaction_id: string | null;
  pey_qr_id: string | null;
  /** Link de checkout pey (POST /payment-link/create), aparte del QR CoDi. */
  pey_payment_url?: string | null;
  estado_chat: string;
  error_fiscal: string | null;
  cliente_fiscal_id: number | null;
  created_at: string;
  updated_at: string;
};

export type ClienteFiscal = {
  id: number;
  telefono: string;
  rfc: string;
  razon_social: string;
  codigo_postal: string;
  regimen: string;
  uso_cfdi: string;
  updated_at: string;
};

export type Item = {
  cantidad: string;
  concepto: string;
  precio_unitario: string;
  subtotal: string;
};
