# Cobro WhatsApp + CoDi (pey) + CFDI 4.0 (Facturapi)

MVP: cobro por WhatsApp con **QR CoDi** y **CFDI 4.0** automático.

## Producción actual

| | |
|---|---|
| Worker | `https://cobro-codi.inomali.workers.dev` |
| Runtime | Cloudflare Worker (TypeScript + Hono) + D1 |
| Consola | `https://cobro-codi.inomali.workers.dev/admin` |
| Health | `https://cobro-codi.inomali.workers.dev/health` |

Stack: **Worker + D1** (órdenes, fiscales, blobs PNG/PDF/XML). URL fija `*.workers.dev` — sin tunnels.

| Binding / secret | Uso |
|---|---|
| `DB` (D1 `cobro-db`) | Órdenes, datos fiscales, archivos |
| `ASSETS` | Consola `/admin` |
| `PEY_API_KEY` | QR CoDi (`portal.mipey.mx`) |
| `FACTURAPI_KEY` | Timbrado CFDI 4.0 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | WhatsApp |
| `PUBLIC_URL` | Base HTTPS del Worker |

### Webhooks (deben coincidir)

| Proveedor | URL |
|---|---|
| **Twilio Sandbox** → *When a message comes in* | `https://cobro-codi.inomali.workers.dev/whatsapp/webhook` (HTTP POST) |
| **Channels/Senders** (API) | misma URL |
| **portal.mipey.mx** | `https://cobro-codi.inomali.workers.dev/pey/webhook` |

Si Twilio Sandbox sigue en un `*.trycloudflare.com`, los mensajes fallan con **error 11210** aunque Channels/Senders esté bien.

Otros endpoints: `GET /admin`, `GET /api/ordenes`, `POST /api/ordenes/:id/reintentar-timbrado`, `GET /files/...`, `GET /health`.

## Flujo WhatsApp

Captura con **botones / lista** (Twilio Content API). Si fallan, queda texto de respaldo.

1. Escribe `hola` → lista *Ver opciones* (productos, **Estado**, **Historial**, **Nuevo QR**)
2. Tras el pedido → **Sí, factura** / **Solo pagar** → imagen QR CoDi (**vigencia ~10 min**)
3. Si el QR vence: Banxico ya no lo acepta; la orden sigue `PENDIENTE` hasta que uses **Nuevo QR** (mismo monto) o abras otro pedido desde el menú
4. Fiscal (pensado para mostrador): **Sin RFC** (un toque) o **Sí tengo RFC** → 5 pasos
   simples (RFC → nombre → CP → régimen en lista → uso en lista). Sin cadenas raras.
5. Revisar: WhatsApp `estado` / `historial`, o consola `/admin` (ticket por fila)
6. Compat texto: `1`/`2` = factura; `qr` = reenviar; `nuevo qr` = regenerar

El cobro y la captura fiscal avanzan en paralelo. Timbrado solo si:

1. `pago_estado == PAGADO`
2. `datos_fiscales_ok == 1`
3. `facturapi_id IS NULL`

## Deploy / secrets

```bash
npm install
npx wrangler login          # o: npx wrangler login --device
# wrangler.jsonc ya apunta al D1 de producción
npx wrangler d1 migrations apply cobro-db --remote
# secrets (mismo contenido que .env.example → .dev.vars)
npx wrangler secret put PEY_API_KEY
npx wrangler secret put FACTURAPI_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM
npx wrangler secret put PUBLIC_URL
npm run deploy
```

> Cuentas *preview* temporales pueden activar challenge anti-bot y romper Twilio. Usa la cuenta free real (login).

## Tests

```bash
npm test          # Vitest en runtime Workers (parse, WhatsApp, pey idempotente, CFDI)
npm run smoke     # Live: /health, step1, Twilio webhook, último inbound 11210
npm run check     # test + smoke
```

Tras cada cambio relevante: `npm run check` antes de dar por bueno el deploy.

## Desarrollo local (opcional)

```bash
npm install
cp .env.example .dev.vars
npx wrangler d1 migrations apply cobro-db --local
npx wrangler dev
```

Hay un legado FastAPI + SQLite en el repo (histórico). El camino soportado es el Worker.

## Licencia

Proyecto de hackathon — uso demo / educativo.
