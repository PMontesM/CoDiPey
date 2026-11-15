# CoDiPey — Cobro WhatsApp + CoDi + CFDI 4.0

**Cobro digital para tiendas de barrio:** el cliente pide por WhatsApp, arma un carrito, paga con **QR CoDi** ($0 de comisión de tarjeta) y, si lo necesita, recibe **factura CFDI 4.0**.

Pensado para mostrador: botones, menú, carrito multi-producto y pasos fiscales guiados (no cadenas del SAT).

---

## Pitch (hackathon)

| Campo | Valor |
|---|---|
| **Nombre** | CoDiPey |
| **Tagline** | Cobro CoDi + factura CFDI desde WhatsApp, listo para tienda |
| **Repo** | https://github.com/PMontesM/CoDiPey *(público)* |
| **Landing** | https://cobro-codi.inomali.workers.dev/ |
| **Panel** | https://cobro-codi.inomali.workers.dev/admin |
| **Health** | https://cobro-codi.inomali.workers.dev/health |
| **Video en landing** | `/demo-codipey.mp4` (también en `public/`) |
| **Demo sin WhatsApp** | Panel → **+ Simular Cobro WhatsApp** → abrir orden → **Simular Webhook Pago pey** |
| **Join Sandbox (vivo)** | `join writer-suggest` (vía landing o `GET /api/demo/whatsapp-join`) |

### Problema
En el abarrotes / negocio chico cobrar con tarjeta cuesta comisión; facturar a mano es lento y confuso. CoDi es gratis para el comercio, pero el flujo (QR + datos fiscales + CFDI) no está pensado para cajero.

### Solución
1. WhatsApp con **catálogo + carrito** (varios productos) y botones (Cobrar / Menú / Sí factura / Solo pagar / Sin RFC).
2. **Ticket térmico** (PNG) + página HTML `/ticket/:id` con QR grande.
3. **QR CoDi** vía pey (vigencia ~10 min; regenerar o cancelar desde chat o panel).
4. Factura: **Sin RFC** en un toque, RFC guardado (**Sí, esos** / **Otros datos**), o wizard de 5 pasos con reintento por campo si el SAT rechaza.
5. **Panel** en tiempo real: liquidación, CFDI, cancelar pendientes, simulación de cobro/pago.

### Stack
Cloudflare Worker (Hono + TypeScript) · D1 · Twilio WhatsApp · pey CoDi · Facturapi CFDI 4.0 · `@resvg/resvg-wasm` (ticket PNG)

### Cómo demostrar ante el jurado

**A) Sin WhatsApp (2 min)**  
1. Abrir el [panel](https://cobro-codi.inomali.workers.dev/admin).  
2. Con seed: la orden más reciente (`ESPERANDO_PAGO` $25) → **Simular Webhook Pago pey**.  
   O bien: **+ Simular Cobro WhatsApp** → abrir la orden nueva → simular pago.  
   Filtro **Fiscal**: 3 órdenes de atención (error CP, RFC inválido, listo por timbrar).

**B) Con su WhatsApp (auto-servicio)**  
1. En la [landing](https://cobro-codi.inomali.workers.dev/) → *Probar en mi WhatsApp*.  
2. Registrar número → **Abrir WhatsApp con el join** (`join writer-suggest`).  
3. Enviar el join → cuando confirme, escribir `hola`.  
4. Elegir productos → **Cobrar** → factura o solo pagar → escanear QR.

> El Sandbox no deja mandar WhatsApp *antes* del join. La instrucción va por `wa.me` (SMS opcional si hay `TWILIO_SMS_FROM`). El juez se une solo.

---

## Descripción corta (copiar/pegar)

> CoDiPey es un MVP que permite a un comercio cobrar por WhatsApp con QR CoDi (pey) y emitir CFDI 4.0 (Facturapi): carrito multi-producto, botones, Sin RFC, captura fiscal guiada con corrección por campo, ticket + panel operativo. Demo pública en `/admin` sin unir números al Sandbox de Twilio.

---

## Producción

| | |
|---|---|
| Worker | `https://cobro-codi.inomali.workers.dev` |
| Landing | `/` → `public/index.html` |
| Panel | `/admin` → `public/admin.html` |
| Ticket HTML | `/ticket/:id` |
| Archivos (QR/PDF/XML) | `/files/:key` |
| Health | `/health` |
| Repo | https://github.com/PMontesM/CoDiPey |

| Binding / secret | Uso |
|---|---|
| `DB` (D1 `cobro-db`) | Órdenes, fiscales, blobs, demo_whatsapp |
| `ASSETS` | Estáticos de `public/` (landing, panel, video, shots) |
| `PEY_API_KEY` | QR CoDi |
| `FACTURAPI_KEY` | Timbrado CFDI 4.0 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | WhatsApp |
| `TWILIO_SANDBOX_JOIN_CODE` | Código del Sandbox (hoy: `writer-suggest`) |
| `TWILIO_SMS_FROM` | (Opcional) SMS con la instrucción de join |
| `PUBLIC_URL` | Base HTTPS del Worker |

### Webhooks y APIs

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/whatsapp/webhook` | Twilio inbound → FSM del chat |
| POST | `/pey/webhook` | Pago CoDi → marca PAGADO + timbra si aplica |
| GET | `/api/ordenes` | Lista + KPIs para el panel |
| POST | `/api/ordenes/:id/cancelar` | Cancela pendiente |
| POST | `/api/ordenes/:id/reintentar-timbrado` | Reintenta CFDI |
| GET | `/api/demo/whatsapp-join` | Join code + `wa.me` |
| POST | `/api/demo/registrar-whatsapp` | Registra juez (+ SMS opcional) |
| POST | `/api/demo/simular-cobro` | Crea orden + QR real (sin Sandbox) |
| POST | `/api/demo/simular-pago/:id` | Liquida como pey + intenta CFDI |

> Las rutas `/api/demo/*` y el panel son **públicos a propósito** para el hackathon. No son aptos para producción multi-comercio.

---

## Flujo WhatsApp (como está en `src/lib/chat.ts`)

1. `hola` / **Menú** → catálogo (Prueba CoDi, Café, Agua, o texto libre `2 Cafe 45`).
2. Cada producto entra al **carrito** (`ARMAR_PEDIDO`). Botones: **Cobrar** / **Agregar más** (+ **Menú** en el 3er slot).
3. **Cobrar** → `ESPERANDO_FACTURA` → **Sí, factura** o **Solo pagar**.
4. **Solo pagar** → ticket + QR de inmediato (`ESPERANDO_PAGO`).
5. **Sí, factura**:
   - Sin datos guardados → **Sin RFC** / **Sí tengo RFC**.
   - Con RFC guardado → **Sí, esos** / **Otros datos** / **Sin RFC** (aquí no se fuerza Menú: WhatsApp solo da 3 botones).
6. Wizard (5 pasos): RFC → nombre → CP → régimen → uso → validación SAT.
   - Si el SAT rechaza, **re-pide el campo concreto** (CP, nombre, RFC o régimen) y revalida; no solo “empezar de nuevo”.
7. Pago CoDi (webhook pey o simular-pago) → `PAGADO` → timbrado automático si hay datos fiscales.

### Reglas importantes del FSM

| Situación | Comportamiento |
|---|---|
| Tap de producto (`PROD_*`) durante el wizard | Abandona el fiscal y abre **carrito** (no valida el texto como RFC) |
| **Menú** durante el wizard | Cancela la orden fiscal pendiente y muestra el catálogo |
| RFC / CP / nombre inválido a mitad de paso | Vuelve a pedir **ese** dato con el error arriba |
| Fallo SAT al final del wizard | Mensaje de hints + re-pide el campo según `fiscalRetryStepFromHints` |

Estados útiles en panel: `ARMAR_PEDIDO`, `ESPERANDO_FACTURA`, `ESPERANDO_FISCAL_*`, `ESPERANDO_DATOS_FISCALES`, `ESPERANDO_PAGO`, `COMPLETADO`, `ERROR_FISCAL`, `CANCELADO`.

---

## Seed de presentación

Borra `ordenes` / `blobs` / `clientes_fiscales` / `demo_whatsapp` y planta **10 escenarios** (`scripts/seed-presentacion.mjs`):

| # | Estado | Para qué |
|---|---|---|
| 1 | PAGADO + COMPLETADO + CFDI | Happy path café/pan |
| 2 | PAGADO sin factura | Flujo Sin RFC |
| 3 | PAGADO + CFDI $1016 | KPI $0 comisión |
| 4 | CANCELADO | Historial / filtros |
| 5 | PAGADO + ERROR_FISCAL (CP) | Filtro Atención fiscal |
| 6 | PAGADO + ERROR_FISCAL (RFC) | Filtro Atención fiscal |
| 7 | PAGADO + listo por timbrar | Filtro Atención fiscal |
| 8 | ESPERANDO_FISCAL_RFC | Wizard a medias |
| 9 | ARMAR_PEDIDO | Carrito en curso |
| 10 | ESPERANDO_PAGO $25 | **Simular Webhook Pago pey** |

```bash
npm run db:seed:remote   # D1 de producción (panel en vivo)
npm run db:seed:local    # D1 local de wrangler dev
```

Tras un smoke o demos que ensucien el panel, vuelve a correr `db:seed:remote` antes del pitch.

---

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
npx wrangler secret put TWILIO_SANDBOX_JOIN_CODE   # ej. writer-suggest
npx wrangler secret put PUBLIC_URL
npm run deploy
```

Migraciones en `migrations/` (`0001_init`, `0002_cfdi_uuid`, `0003_demo_whatsapp`).

> Los cambios en `public/` y en el Worker **solo se ven en vivo tras** `npm run deploy`. Un push a git no actualiza Cloudflare solo.

---

## Dev / tests

```bash
npm run dev              # wrangler dev
npm run db:migrate:local
npm run db:seed:local
npm test                 # vitest — 35 tests (Worker + parse + e2e)
npm run smoke            # health + webhook carrito + Twilio config (prod)
npm run check            # test + smoke
npm run typecheck
```

### Qué cubren los tests

| Área | Cobertura |
|---|---|
| Carrito | Primer producto → `ARMAR_PEDIDO`; varios ítems; `PROD_*` de lista; Cobrar → `ESPERANDO_FACTURA` |
| Factura | Solo pagar → QR; Sí factura → Sin RFC; Sí tengo RFC / Otros datos → wizard |
| Wizard | Pasos con botones; RFC inválido re-pide; tap `PROD_*` en wizard → carrito (no error RFC); Menú cancela fiscal |
| SAT hints | `fiscalRetryStepFromHints` enruta a CP / nombre / RFC / régimen |
| Botones WA | `ensureMenuActions` (Menú en 3er slot; `stickyMenu: false` preserva Otros datos) |
| Demo API | simular-cobro / simular-pago / ticket HTML / join WhatsApp |
| Smoke live | Espera `ARMAR_PEDIDO` y cancela la orden de prueba para no ensuciar el panel |

---

## Estructura (path vivo)

| Ruta | Rol |
|---|---|
| `src/index.ts` | Rutas Hono |
| `src/lib/chat.ts` | FSM WhatsApp + carrito + wizard fiscal |
| `src/lib/fiscal-wizard.ts` | Borrador fiscal, validadores, routing de reintento SAT |
| `src/lib/sat-validate.ts` | EFOS + validación Facturapi/SAT |
| `src/lib/twilio.ts` | Quick-reply / listas; `ensureMenuActions` |
| `src/lib/pey.ts` | QR CoDi + TTL + ticket PNG |
| `src/lib/ticket.ts` | SVG/PNG térmico + HTML `/ticket` |
| `src/lib/facturapi.ts` | Timbrado CFDI |
| `src/lib/demo.ts` | Simular cobro/pago |
| `src/lib/demo-whatsapp.ts` | Join Sandbox + registro juez |
| `public/` | Landing, panel, video, shots |
| `migrations/` | Schema D1 |
| `scripts/seed-presentacion.mjs` | Seed de pitch |
| `scripts/smoke-live.mjs` | Smoke contra prod |
| `test/worker.spec.ts` | Tests Worker + bloque **e2e WhatsApp flows** |

`main.py` y `templates/` son **legacy** (no se despliegan). El runtime de producción es solo el Worker.

---

## Licencia

Hackathon / demo educativo.
