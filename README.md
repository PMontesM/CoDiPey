# Mostrito — Cobro por WhatsApp + CFDI 4.0

**Cobro digital para el mostrador:** tú operas el chat de WhatsApp (pedido, factura, ticket). El cliente **solo lee el QR y paga en la app de su banco** ($0 de comisión de tarjeta). Si pide factura, sale **CFDI 4.0**.

Mascota: ajolote **Mostrito**.

| | |
|---|---|
| **Repo** | https://github.com/PMontesM/CoDiPey |
| **Landing** | https://cobro-codi.inomali.workers.dev/ |
| **Panel** | https://cobro-codi.inomali.workers.dev/admin |
| **Superadmin** | https://cobro-codi.inomali.workers.dev/superadmin |
| **Health** | https://cobro-codi.inomali.workers.dev/health |

---

## Qué es (y qué no es)

| Sí | No |
|---|---|
| El **comercio** escribe el pedido en WhatsApp y muestra el QR | El cliente **no** chatea con el bot para armar el carrito |
| El **cliente** escanea y paga en su banca | No es una app que el cliente tenga que instalar |
| Factura CFDI si la piden (Sin RFC o con datos) | No sustituye tu cuenta pey / Facturapi / Twilio |

Rail de pago: **CoDi Banxico** vía **pey** (QR + payment link opcional). Timbrado: **Facturapi**.

Runtime: **solo Cloudflare Worker** (`src/index.ts` + `public/` + D1). No hay backend Python.

---

## Clonar y levantar (reproducible)

Requisitos: **Node ≥ 20**, cuenta Cloudflare, cuentas pey / Facturapi / Twilio (o mocks parciales en tests).

### Misma cuenta Cloudflare (este proyecto)

```bash
git clone https://github.com/PMontesM/CoDiPey.git
cd CoDiPey
npm install
cp .dev.vars.example .dev.vars   # rellena keys para local
npm run db:migrate:local
npm test
npm run dev                      # http://127.0.0.1:8787
```

Producción (Worker ya existente `cobro-codi` + D1 `cobro-db`):

```bash
npx wrangler login
npm run db:migrate:remote
# secrets: ver sección Deploy
npm run deploy
```

### Cuenta Cloudflare nueva (fork / otro tenant)

1. `npm install` + `npx wrangler login`
2. `npx wrangler d1 create cobro-db` → pega el `database_id` en `wrangler.jsonc`
3. Opcional: cambia `"name"` del Worker en `wrangler.jsonc`
4. `npm run db:migrate:remote`
5. Pon secrets (`wrangler secret put …` o carga desde `.env.example`)
6. `PUBLIC_URL=https://<worker>.<account>.workers.dev`
7. `npm run deploy`
8. En `/superadmin`: contraseña, webhooks, probar conexiones

Archivos de entorno:

| Archivo | Uso |
|---|---|
| `.env.example` | Plantilla / documentación de secrets |
| `.dev.vars.example` → `.dev.vars` | Vars locales de Wrangler (`npm run dev`) |
| `.dev.vars` / `.env` | **No** se commitean |

---

## Demo en vivo

### A) Panel (sin WhatsApp)

1. Abre [/admin](https://cobro-codi.inomali.workers.dev/admin).
2. **+ Simular Cobro WhatsApp** → abre la orden → **Simular Webhook Pago**.
3. Filtros: **Hoy** (por defecto) / Ayer / 7 días / Todas, estado (Liquidadas, Pendientes, Atención Fiscal) y paginación (15 por página).
4. El logo **Mostrito** o **Inicio** regresan a la landing; **Superadmin** abre la configuración.
5. En móvil, **atrás** cierra el modal de la orden (no te saca al landing).
6. Los WhatsApp se muestran **enmascarados** (`+52•••••••0104`) porque el panel demo suele ir abierto.

### B) WhatsApp Sandbox

1. Landing → *Probar en mi WhatsApp* → registra tu número → abre el `join`.
2. Envía el join (`join writer-suggest`) → escribe `hola`.
3. Armas el pedido en el chat (tú) → Cobrar → Solo pagar o factura → muestras el QR al cliente.

> El Sandbox de Twilio exige el `join` antes de poder recibir mensajes del Worker.

### C) Superadmin

1. Abre [/superadmin](https://cobro-codi.inomali.workers.dev/superadmin).
2. Entra con la **contraseña del panel** (o el `SUPERADMIN_SECRET` de Wrangler la primera vez).
3. Navega con el **menú lateral** (desktop) o los **chips** (móvil): Resumen → Errores → Webhooks → Conexiones → Config → Acceso.
4. Desde **Resumen** saltas a lo que necesites; **Cerrar sesión** está arriba a la derecha.

---

## Stack

Cloudflare Worker (**Hono** + TypeScript) · **D1** · Twilio WhatsApp · pey (CoDi + payment link) · Facturapi CFDI 4.0 · `@resvg/resvg-wasm` (ticket PNG) · estáticos en `public/`

---

## Producción

| Ruta | Qué es |
|---|---|
| `/` | Landing (`public/index.html`) |
| `/admin` | Panel operador (`public/admin.html`) |
| `/superadmin` | Centro de control: resumen, errores, webhooks, conexiones, config, acceso |
| `/ticket/:id` | Ticket HTML con QR grande |
| `/files/:key` | QR PNG, facturas PDF/XML |
| `/health` | Healthcheck |
| `POST /whatsapp/webhook` | Twilio → FSM del chat |
| `POST /pey/webhook` | Pago confirmado → PAGADO + timbra |
| `GET /api/ordenes` | Lista + KPIs (teléfonos enmascarados) |
| `GET /api/ordenes/:id/factura.pdf` / `.xml` | Redirect a archivo firmado |
| `POST /api/ordenes/:id/cancelar` | Cancela pendiente |
| `POST /api/ordenes/:id/reintentar-timbrado` | Reintenta CFDI |
| `GET /api/demo/whatsapp-join` | Config pública del join |
| `POST /api/demo/registrar-whatsapp` | Registro público → `wa.me` |
| `POST /api/demo/simular-cobro` | Orden + QR sin Sandbox |
| `POST /api/demo/simular-pago/:id` | Liquida como pey + CFDI |
| `GET /api/superadmin/status` | ¿Hay `SUPERADMIN_SECRET`? + URLs webhook |
| `GET/PUT /api/superadmin/settings` | Overrides D1 (Bearer / `x-superadmin-token`) |
| `PUT /api/superadmin/password` | Contraseña memorable del panel |
| `GET/DELETE /api/superadmin/errors` | Log de errores recientes |
| `POST /api/superadmin/errors/sample` | Escribe un aviso de prueba |
| `POST /api/superadmin/test/:id` | Prueba `pey` / `facturapi` / `twilio` |
| `GET/POST /api/superadmin/e2e` | Prueba E2E (config → APIs → cobro → pago → ticket) |

### Auth y privacidad

| Situación | Comportamiento |
|---|---|
| **Sin** `ADMIN_API_SECRET` | Panel y APIs de operador **abiertos** (single-tenant / demo) |
| **Con** `ADMIN_API_SECRET` | Hay que pegar el token en el panel (botón **Token**) |
| Teléfonos en `/api/ordenes` | Siempre **enmascarados** (país + últimos 4). El número completo solo vive en D1 / WhatsApp |
| **Sin** `SUPERADMIN_SECRET` | `/superadmin` apagado (503 en APIs) |
| **Con** `SUPERADMIN_SECRET` | Primer acceso; luego defines **contraseña** en el panel (el secret queda de respaldo) |
| Facturas PDF/XML | Si hay secreto de firma (`FILE_SIGNING_SECRET` / `ADMIN_API_SECRET` / `PEY_WEBHOOK_SECRET`), requieren URL firmada (`?exp=&sig=`). **Sin** secreto, se sirven abiertas |
| QR (`qr_*.png`) y `/ticket/:id` | Públicos |
| Join WhatsApp | Público (`registrar-whatsapp` no pide token) |
| Webhooks Twilio / pey | Siempre con firma |

> Un push a GitHub **no** actualiza Cloudflare. Hay que `npm run deploy` (o `wrangler deploy`).

---

## Superadmin

Sirve para operar el comercio sin tocar Wrangler en cada cambio de API key o webhook. UI en `public/superadmin.html`.

### Activación (una vez)

```bash
npx wrangler secret put SUPERADMIN_SECRET   # llave maestra / respaldo
npm run deploy
# Opcional si tu token CF tiene permiso D1:
# npx wrangler d1 migrations apply cobro-db --remote
```

Las tablas `settings` y `error_log` también se crean solas la primera vez que el Worker las usa (útil si el token de deploy no puede aplicar migraciones D1).

### Navegación

| Vista | Qué hace |
|---|---|
| **Resumen** | Nombre del negocio, conteo de errores y atajos a Errores / Conexiones / Config |
| **Errores** | Log reciente (Actualizar / Probar log / Limpiar). Complementa Cloudflare → Workers → Logs |
| **Webhooks** | URLs Twilio y pey con botón **Copiar** |
| **Conexiones** | Ping a pey / Facturapi / Twilio con las keys efectivas |
| **Prueba E2E** | Chequeo completo: config, D1, APIs, cobro demo + QR, liquidación, CFDI, ticket |
| **Configuración** | Overrides agrupados: Negocio, pey, Facturapi, Twilio, Panel/archivos |
| **Acceso** | Contraseña memorable del panel (≥ 6). El secret de Wrangler queda de respaldo |

- **Desktop:** menú lateral sticky (rail).
- **Móvil:** chips horizontales arriba del contenido.
- La pestaña activa se recuerda en la sesión del navegador.

### Reglas

- Valores en D1 `settings` **pisan** los secrets de Wrangler.
- En secretos: input vacío = no tocar; `__CLEAR__` = quitar el override.
- `SUPERADMIN_SECRET` **nunca** se edita desde la UI (solo Wrangler).
- La contraseña del panel **sí** se cambia en **Acceso**; el secret sigue valiendo para entrar si la olvidas.
- **Cerrar sesión** limpia el token de la pestaña (arriba a la derecha).

---

## Secrets / bindings

| Nombre | Uso |
|---|---|
| `DB` (D1 `cobro-db`) | Órdenes, fiscales, blobs, demo_whatsapp, **settings**, **error_log** |
| `ASSETS` | `public/` |
| `PEY_API_KEY` | QR CoDi + payment links |
| `PEY_WEBHOOK_SECRET` | Firma `/pey/webhook` |
| `FACTURAPI_KEY` | Timbrado CFDI 4.0 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | WhatsApp |
| `TWILIO_SANDBOX_JOIN_CODE` | Ej. `writer-suggest` |
| `TWILIO_SMS_FROM` | (Opcional) SMS con el join |
| `ADMIN_API_SECRET` | (Opcional) Cierra el panel operador |
| `FILE_SIGNING_SECRET` | (Opcional) HMAC dedicado de facturas |
| `PUBLIC_URL` | Base HTTPS del Worker |
| `SUPERADMIN_SECRET` | Desbloquea `/superadmin` — **solo Wrangler** |
| `BUSINESS_NAME` | Nombre en tickets / WhatsApp (también vía superadmin) |

Plantilla local: [`.env.example`](.env.example).

---

## Flujo WhatsApp (`src/lib/chat.ts`)

1. `hola` / **Menú** → catálogo (Prueba Mostrito, Café, Agua, o `2 Cafe 45`).
2. Productos al **carrito** (`ARMAR_PEDIDO`) → **Cobrar** / **Agregar más**.
3. **Cobrar** → **Sí, factura** o **Solo pagar**.
4. **Solo pagar** → ticket + QR (+ payment link si pey lo da).
5. **Sí, factura** → Sin RFC / wizard RFC (5 pasos con reintento por campo si el SAT rechaza).
6. Webhook pey (o simular-pago) → `PAGADO` → timbra si hay datos fiscales → PDF/XML por WhatsApp.

Estados útiles en panel: `ARMAR_PEDIDO`, `ESPERANDO_FACTURA`, `ESPERANDO_FISCAL_*`, `ESPERANDO_DATOS_FISCALES`, `ESPERANDO_PAGO`, `COMPLETADO`, `ERROR_FISCAL`, `CANCELADO`.

---

## Panel (`/admin`)

- KPIs: volumen liquidado, ahorro vs tarjeta, CFDIs, pendientes.
- Libro de órdenes con filtros de estado + **día** (Hoy / Ayer / 7 días / Todas) + **paginación**.
- Columna **Cliente / WhatsApp** con número **enmascarado** (privacidad con panel abierto).
- Inspector (drawer): QR, simular pago, cancelar, reintentar timbrado, abrir PDF/XML.
- En móvil, **atrás** cierra el drawer y te deja en el panel.
- Enlace **Inicio** / logo → landing.
- Enlace **Superadmin** → `/superadmin`.

---

## Observabilidad

| Dónde | Qué ver |
|---|---|
| `/superadmin` → Errores recientes | Últimos ~200 eventos (error/aviso) con fuente, mensaje y detalle |
| Cloudflare Dashboard → Workers → `cobro-codi` → Logs | Stream en vivo / histórico de `console.log` |
| `npx wrangler tail` | Tail local contra el Worker desplegado |

Se registran, entre otros: excepciones HTTP, fallos del FSM WhatsApp, timbrado Facturapi, envíos Twilio y avisos de pey payment-link. Los teléfonos en el log también van enmascarados.

---

## Seed de presentación

```bash
npm run db:seed:remote   # D1 producción
npm run db:seed:local    # D1 local
```

`scripts/seed-presentacion.mjs` planta escenarios (pagado+CFDI, pendientes, errores fiscales, carrito, etc.). Vuelve a sembrarlo si el panel se ensucia en demos.

---

## Deploy (Cloudflare Workers)

```bash
npm install
npx wrangler login
npm run db:migrate:remote
npx wrangler secret put PEY_API_KEY
npx wrangler secret put PEY_WEBHOOK_SECRET
npx wrangler secret put FACTURAPI_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM
npx wrangler secret put TWILIO_SANDBOX_JOIN_CODE
npx wrangler secret put PUBLIC_URL   # https://cobro-codi.inomali.workers.dev
# Opcional:
# npx wrangler secret put ADMIN_API_SECRET
# npx wrangler secret put FILE_SIGNING_SECRET
# npx wrangler secret put SUPERADMIN_SECRET
# npx wrangler secret put BUSINESS_NAME
npm run deploy
```

Migraciones: `migrations/0001` … `0006_error_log` (también se auto-crean `settings` / `error_log` al usarse).

Webhooks (o cópialos desde `/superadmin`):

- pey → `https://cobro-codi.inomali.workers.dev/pey/webhook`
- Twilio → `https://cobro-codi.inomali.workers.dev/whatsapp/webhook`

---

## Dev / tests

```bash
cp .dev.vars.example .dev.vars   # keys locales
npm run db:migrate:local
npm run db:seed:local            # opcional, datos de demo
npm run dev                      # wrangler dev
npm test                         # vitest (plugin Cloudflare)
npm run typecheck
npm run smoke                    # health contra prod (SMOKE_URL opcional)
npm run check                    # test + smoke
```

Scripts opcionales (no hacen falta para clonar):

| Script | Uso |
|---|---|
| `scripts/seed-presentacion.mjs` | Semilla D1 de demo |
| `scripts/smoke-live.mjs` | Smoke contra URL pública |
| `scripts/demo-video.mjs` | Grabación Playwright (requiere `npm i -D playwright`) |
| `scripts/ticket-preview.mjs` / `wa-shots.html` | Helpers visuales de marketing |

---

## Estructura

| Ruta | Rol |
|---|---|
| `wrangler.jsonc` | Worker `cobro-codi` + D1 `cobro-db` |
| `src/index.ts` | Rutas Hono |
| `src/lib/*` | Chat, pey, Facturapi, ticket, security, settings, superadmin, privacy, e2e-health, error-log… |
| `src/wasm/resvg.wasm` | Render de ticket PNG |
| `public/index.html` | Landing |
| `public/admin.html` | Panel operador |
| `public/superadmin.html` | Superadmin (rail / chips) |
| `migrations/` | Schema D1 |
| `cursor/identity.ts` | Identidad Cursor (panel publicado privado/team) |
| `scripts/` | Seed, smoke, helpers |
| `test/` | Vitest |

---

## Marca y assets (en uso)

| Archivo | Uso |
|---|---|
| `public/mostrito-mascot.png` | Ajolote en landing |
| `public/mostrito-icon.jpg` | Avatar / favicon |
| `public/hero-barrio.jpg` | Fondo |
| `public/wa-*.png` | Mockups WhatsApp |
| `public/shot-admin-ticket.png` | Shot del panel en landing |
| `public/demo-mostrito.mp4` (+ poster) | Video de la landing |

---

## Licencia

Hackathon / demo educativo. No uses las marcas **CoDi** ni **pey** en el nombre del producto; Mostrito es la marca propia. El rail de pago y los proveedores se mencionan solo como integración técnica. El nombre del repo en GitHub (`CoDiPey`) es histórico; el producto se llama **Mostrito**.
