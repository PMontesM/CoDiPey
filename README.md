# CoDiPey — Cobro WhatsApp + CoDi + CFDI 4.0

**Cobro digital para tiendas de barrio:** el cliente pide por WhatsApp, paga con **QR CoDi** (sin comisión de tarjeta) y, si lo necesita, recibe **factura CFDI 4.0** sin cadenas fiscales raras.

Pensado para mostrador: botones, menús y pasos guiados (no tecnicismos del SAT).

---

## Pitch (para envío / hackathon)

| Campo | Valor |
|---|---|
| **Nombre** | CoDiPey |
| **Tagline** | Cobro CoDi + factura CFDI desde WhatsApp, listo para tienda |
| **Repo** | https://github.com/PMontesM/CoDiPey *(público)* |
| **Landing** | https://cobro-codi.inomali.workers.dev/ |
| **App / consola** | https://cobro-codi.inomali.workers.dev/admin |
| **Health** | https://cobro-codi.inomali.workers.dev/health |
| **Demo sin WhatsApp** | En la consola: **+ Simular Cobro WhatsApp** → abrir orden → **Simular Webhook Pago pey** (flujo completo sin unir números al Sandbox) |
| **Video demo** | Adjuntar `codipey-demo-hackathon.mp4` (consola: cobro → QR → liquidación + CFDI) |
### Problema
En el abarrotes / negocio chico cobrar con tarjeta cuesta comisión; facturar a mano es lento y confuso. CoDi es gratis para el comercio, pero el flujo (QR + datos fiscales + CFDI) no está pensado para cajero.

### Solución
1. WhatsApp con **lista de productos** y botones (Sí factura / Solo pagar / Sin RFC / Cancelar).
2. **QR CoDi** vía pey (vigencia ~10 min; se regenera o cancela desde chat o consola).
3. Factura: **Sin RFC** en un toque, o wizard de 5 pasos; validación SAT con Facturapi.
4. **Consola operativa** en tiempo real: liquidación, CFDI, cancelar pendientes.

### Stack
Cloudflare Worker (Hono + TypeScript) · D1 · Twilio WhatsApp · pey CoDi · Facturapi CFDI 4.0

### Cómo demoea el jurado (2 min, sin Sandbox)
1. Abrir la [consola](https://cobro-codi.inomali.workers.dev/admin).
2. **+ Simular Cobro WhatsApp** → crea orden real + QR CoDi (`POST /api/demo/simular-cobro`).
3. Abrir el ticket → **Simular Webhook Pago pey** → liquidación + timbrado CFDI (`POST /api/demo/simular-pago/:id`).
4. (Opcional) WhatsApp real solo si el número ya hizo `join` al Twilio Sandbox.

> El Sandbox de Twilio **no permite** autorizar números por API: cada teléfono debe enviar `join …`. La consola pública simula cobro y pago sin unir números.

---

## Descripción corta (copiar/pegar)

> CoDiPey es un MVP que permite a un comercio cobrar por WhatsApp con QR CoDi (pey) y emitir CFDI 4.0 (Facturapi) con un flujo pensado para tienda de barrio: botones, Sin RFC en un toque, captura fiscal guiada y consola operativa. Demo pública en `/admin` con simulación de cobro y pago, sin necesidad de unir números al Sandbox de Twilio.

---

## Producción

| | |
|---|---|
| Worker | `https://cobro-codi.inomali.workers.dev` |
| Landing | `https://cobro-codi.inomali.workers.dev/` |
| Consola | `https://cobro-codi.inomali.workers.dev/admin` || Health | `https://cobro-codi.inomali.workers.dev/health` |
| Repo | https://github.com/PMontesM/CoDiPey |

| Binding / secret | Uso |
|---|---|
| `DB` (D1 `cobro-db`) | Órdenes, fiscales, blobs |
| `ASSETS` | Consola `/admin` |
| `PEY_API_KEY` | QR CoDi |
| `FACTURAPI_KEY` | Timbrado CFDI 4.0 |
| `TWILIO_*` | WhatsApp |
| `PUBLIC_URL` | Base HTTPS del Worker |

### Webhooks

| Proveedor | URL |
|---|---|
| Twilio | `https://cobro-codi.inomali.workers.dev/whatsapp/webhook` |
| pey | `https://cobro-codi.inomali.workers.dev/pey/webhook` |

## Flujo WhatsApp (real)

1. `hola` → productos / estado / historial / nuevo QR / cancelar  
2. **Solo pagar** → QR inmediato  
3. **Sí, factura** → Sin RFC o wizard → **QR al final** (no se pierde en el chat)  
4. Pago CoDi → timbrado automático si hay datos fiscales  

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply cobro-db --remote
npx wrangler secret put PEY_API_KEY
npx wrangler secret put FACTURAPI_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM
npx wrangler secret put PUBLIC_URL
npm run deploy
```

## Tests

```bash
npm test
npm run smoke
npm run check
```

## Licencia

Hackathon / demo educativo.
