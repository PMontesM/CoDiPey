# Cobro WhatsApp + CoDi (pey) + CFDI 4.0 (Facturapi)

MVP: cobro por WhatsApp con **QR CoDi** y **CFDI 4.0** automático.

## Runtime principal: Cloudflare Worker (gratis)

Stack productivo: **Worker (TypeScript + Hono) + D1 + blobs en D1**. URL fija `*.workers.dev` sin tunnels.

| Binding / secret | Uso |
|---|---|
| `DB` (D1) | Órdenes, datos fiscales, archivos QR/PDF/XML |
| `ASSETS` | Consola `/admin` |
| `PEY_API_KEY` | QR CoDi |
| `FACTURAPI_KEY` | Timbrado CFDI 4.0 |
| `TWILIO_*` | WhatsApp |
| `PUBLIC_URL` | Base HTTPS pública del Worker |

### Deploy a tu cuenta Cloudflare free

```bash
npm install
npx wrangler login          # o: npx wrangler login --device
npx wrangler d1 create cobro-db
# pega el database_id en wrangler.jsonc
npx wrangler d1 migrations apply cobro-db --remote
npx wrangler secret bulk .dev.vars   # o secret put uno a uno
npm run deploy
```

Webhooks (URL fija):

| Proveedor | Path |
|---|---|
| Twilio Sandbox | `https://<worker>.<subdomain>.workers.dev/whatsapp/webhook` |
| portal.mipey.mx | `https://<worker>.<subdomain>.workers.dev/pey/webhook` |

También: `GET /admin`, `GET /api/ordenes`, `GET /files/...`, `GET /health`.

> En cuentas *preview* temporales Cloudflare puede activar challenge anti-bot y romper Twilio. Usa **tu cuenta free** (login) o reclama la preview y desactiva Bot Fight Mode.

## Máquina de estados

El cobro y la captura fiscal avanzan en paralelo. Timbrado solo si:

1. `pago_estado == PAGADO`
2. `datos_fiscales_ok == 1`
3. `facturapi_id IS NULL`

## Demo $0.01 MXN

1. Configura webhooks Twilio/pey a la URL del Worker.
2. WhatsApp: `1 Prueba CoDi 0.01` → `1` (factura).
3. Escanea QR CoDi y paga $0.01.
4. Factura PDF/XML por WhatsApp si hay datos fiscales.

## Tests (obligatorio antes/después de cambios)

```bash
npm test          # Vitest en runtime Workers (parse + webhooks + pey idempotente + CFDI)
npm run smoke     # Live: /health, WhatsApp step1, Twilio webhook URL, alertas 11210
npm run check     # test + smoke
```

El smoke **falla** si Twilio Sandbox sigue apuntando a un tunnel `*.trycloudflare.com` (error 11210).
La URL correcta es siempre:

`https://cobro-codi.inomali.workers.dev/whatsapp/webhook`

## Desarrollo local (opcional)

### Worker

```bash
npm install
cp .env.example .dev.vars   # mismas keys
npx wrangler d1 migrations apply cobro-db --local
npx wrangler dev
```

### Legacy FastAPI + SQLite (repo histórico)

```bash
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8765
pytest -v
```

## Licencia

Proyecto de hackathon — uso demo / educativo.
