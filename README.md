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
npx wrangler d1 migrations apply cobro-db --remote
npx wrangler secret put PEY_API_KEY
npx wrangler secret put PEY_WEBHOOK_SECRET
npx wrangler secret put FACTURAPI_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM
npx wrangler secret put TWILIO_SANDBOX_JOIN_CODE
npx wrangler secret put PUBLIC_URL   # https://cobro-codi.inomali.workers.dev
# Opcional endurecimiento:
# npx wrangler secret put ADMIN_API_SECRET
# npx wrangler secret put FILE_SIGNING_SECRET
# Superadmin:
# npx wrangler secret put SUPERADMIN_SECRET
npm run deploy
```

Migraciones en `migrations/` (`0001` … `0006_error_log`).

Webhook pey → `https://cobro-codi.inomali.workers.dev/pey/webhook`.  
Webhook Twilio → `https://cobro-codi.inomali.workers.dev/whatsapp/webhook`.  
(También las copias desde `/superadmin`.)

---

## Dev / tests

```bash
npm run dev              # wrangler dev
npm run db:migrate:local
npm run db:seed:local
npm test                 # vitest
npm run smoke            # health + smoke contra prod
npm run check            # test + smoke
npm run typecheck
```

---

## Estructura

| Ruta | Rol |
|---|---|
| `src/index.ts` | Rutas Hono |
| `src/lib/chat.ts` | FSM WhatsApp |
| `src/lib/fiscal-wizard.ts` | Wizard fiscal + reintentos SAT |
| `src/lib/pey.ts` | QR + payment link + blobs |
| `src/lib/ticket.ts` | Ticket PNG/HTML |
| `src/lib/facturapi.ts` | Timbrado + links firmados |
| `src/lib/security.ts` | Firmas Twilio/pey + operador + facturas |
| `src/lib/privacy.ts` | Enmascarado de WhatsApp en APIs / logs |
| `src/lib/settings.ts` | Overrides D1 + `withSettings` |
| `src/lib/superadmin.ts` | Auth secret + contraseña del panel |
| `public/superadmin.html` | UI Superadmin (rail / chips / pestañas) |
| `src/lib/connection-tests.ts` | Ping pey / Facturapi / Twilio |
| `src/lib/error-log.ts` | Errores recientes (D1 → Superadmin) |
| `src/lib/demo.ts` / `demo-whatsapp.ts` | Simulación y join |
| `public/` | Landing, panel, superadmin, mascota, video, shots |
| `migrations/` | Schema D1 |
| `scripts/` | Seed, smoke |
| `test/` | Vitest |

`main.py` y `templates/` son **legacy** (no se despliegan).

---

## Marca y assets

| Archivo | Uso |
|---|---|
| `public/mostrito-mascot.png` | Ajolote (PNG transparente) en landing |
| `public/mostrito-icon.jpg` | Avatar / favicon |
| `public/hero-barrio.jpg` | Fondo de barrio |
| `public/wa-*.png` | Mockups WhatsApp (marca Mostrito) |
| `public/demo-codipey.mp4` | Video de la landing |

---

## Licencia

Hackathon / demo educativo. No uses las marcas **CoDi** ni **pey** en el nombre del producto; Mostrito es la marca propia. El rail de pago y los proveedores se mencionan solo como integración técnica.
