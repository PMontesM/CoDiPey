"""
Cobro WhatsApp + CoDi (pey) + CFDI 4.0 (Facturapi)
MVP hackathon — FastAPI + SQLite + Twilio
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Generator, Optional

import httpx
import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from twilio.rest import Client as TwilioClient

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public_files"
TEMPLATES_DIR = BASE_DIR / "templates"
DB_PATH = BASE_DIR / "hackathon.db"

PUBLIC_DIR.mkdir(exist_ok=True)
TEMPLATES_DIR.mkdir(exist_ok=True)

PEY_API_KEY = os.getenv("PEY_API_KEY", "")
PEY_QR_URL = "https://api.pey.mx/codi/qr"
FACTURAPI_KEY = os.getenv("FACTURAPI_KEY", "")
FACTURAPI_BASE = "https://www.facturapi.io/v2"
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")
PUBLIC_URL = os.getenv("PUBLIC_URL", "http://localhost:8765").rstrip("/")

# Línea de producto: "2 Cafe 45" o "1 Prueba CoDi 0.01"
PRODUCT_LINE_RE = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?)\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*$"
)

app = FastAPI(title="Cobro WhatsApp CoDi + CFDI", version="1.0.0")
app.mount("/files", StaticFiles(directory=str(PUBLIC_DIR)), name="files")


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def _connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    path = str(db_path or DB_PATH)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: Optional[sqlite3.Connection] = None) -> None:
    own = conn is None
    if own:
        conn = _connect()
    assert conn is not None
    conn.executescript(
        """
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
        """
    )
    conn.commit()
    if own:
        conn.close()


# Overridable for tests
_db_path_override: Optional[Path] = None


def get_db() -> Generator[sqlite3.Connection, None, None]:
    path = _db_path_override or DB_PATH
    conn = _connect(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def db_session() -> Generator[sqlite3.Connection, None, None]:
    gen = get_db()
    conn = next(gen)
    try:
        yield conn
        try:
            next(gen)
        except StopIteration:
            pass
    except Exception:
        try:
            gen.throw(Exception)
        except StopIteration:
            pass
        raise


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return dict(row)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _to_decimal(raw: str) -> Decimal:
    return Decimal(raw.replace(",", "."))


def parse_product_lines(text: str) -> tuple[Optional[list[dict[str, Any]]], Optional[str]]:
    """Parsea líneas 'cantidad nombre precio'. Retorna (items, error)."""
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        return None, "Envía productos, uno por línea. Ejemplo:\n2 Cafe 45\n1 Prueba CoDi 0.01"

    items: list[dict[str, Any]] = []
    for ln in lines:
        m = PRODUCT_LINE_RE.match(ln)
        if not m:
            return None, (
                f"No entendí: «{ln}»\n"
                "Formato: <cantidad> <concepto> <precio>\n"
                "Ejemplo: 2 Cafe 45"
            )
        try:
            qty = _to_decimal(m.group(1))
            price = _to_decimal(m.group(3))
        except InvalidOperation:
            return None, f"Cantidad o precio inválido en: «{ln}»"

        if qty <= 0 or price <= 0:
            return None, (
                f"Cantidad y precio deben ser mayores a 0. Revisé: «{ln}»"
            )

        name = m.group(2).strip()
        subtotal = (qty * price).quantize(Decimal("0.01"))
        items.append(
            {
                "cantidad": str(qty),
                "concepto": name,
                "precio_unitario": str(price),
                "subtotal": str(subtotal),
            }
        )

    return items, None


def sum_items(items: list[dict[str, Any]]) -> Decimal:
    total = sum((Decimal(i["subtotal"]) for i in items), Decimal("0"))
    return total.quantize(Decimal("0.01"))


def concept_for_pey(items: list[dict[str, Any]], orden_id: int) -> str:
    names = ", ".join(i["concepto"] for i in items)
    raw = f"Orden {orden_id}: {names}"
    return raw[:40]


def parse_fiscal_data(text: str) -> tuple[Optional[dict[str, str]], Optional[str]]:
    """Espera: RFC | Razón Social | CP | Régimen | UsoCFDI"""
    parts = [p.strip() for p in text.split("|")]
    if len(parts) != 5:
        return None, (
            "Datos incompletos. Envía exactamente:\n"
            "RFC | Razón Social | CP | Régimen | UsoCFDI\n"
            "Ejemplo: XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03"
        )
    rfc, razon, cp, regimen, uso = parts
    if not all([rfc, razon, cp, regimen, uso]):
        return None, "Todos los campos fiscales son obligatorios (RFC | Razón Social | CP | Régimen | UsoCFDI)."
    if len(cp) != 5 or not cp.isdigit():
        return None, "El código postal debe ser de 5 dígitos."
    return {
        "rfc": rfc.upper(),
        "razon_social": razon,
        "codigo_postal": cp,
        "regimen": regimen,
        "uso_cfdi": uso.upper(),
    }, None


# ---------------------------------------------------------------------------
# Twilio
# ---------------------------------------------------------------------------

def get_twilio_client() -> Optional[TwilioClient]:
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        return None
    return TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)


def send_whatsapp(to: str, body: str, media_url: Optional[str] = None) -> None:
    """Envía mensaje WhatsApp. En tests se puede monkeypatchar."""
    client = get_twilio_client()
    if client is None:
        # Modo local / tests sin credenciales
        print(f"[whatsapp mock] to={to} body={body!r} media={media_url}")
        return
    kwargs: dict[str, Any] = {
        "from_": TWILIO_WHATSAPP_FROM,
        "to": to if to.startswith("whatsapp:") else f"whatsapp:{to}",
        "body": body,
    }
    if media_url:
        kwargs["media_url"] = [media_url]
    client.messages.create(**kwargs)


# ---------------------------------------------------------------------------
# pey CoDi
# ---------------------------------------------------------------------------

async def crear_qr_pey(orden_id: int, amount: Decimal, concept: str) -> dict[str, Any]:
    """POST https://api.pey.mx/codi/qr — puede lanzar httpx errors."""
    payload = {
        "amount": float(amount),
        "concept": concept[:40],
        "expiration": 600,
        "numRef": str(orden_id),
    }
    headers = {
        "Authorization": f"Bearer {PEY_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(PEY_QR_URL, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


def generar_qr_png(data: str, orden_id: int) -> Path:
    path = PUBLIC_DIR / f"qr_{orden_id}.png"
    img = qrcode.make(data)
    img.save(str(path))
    return path


# ---------------------------------------------------------------------------
# Facturapi
# ---------------------------------------------------------------------------

async def timbrar_facturapi(
    orden: dict[str, Any],
    fiscal: dict[str, Any],
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    customer = {
        "legal_name": fiscal["razon_social"],
        "tax_id": fiscal["rfc"],
        "tax_system": fiscal["regimen"],
        "zip": fiscal["codigo_postal"],
        "address": {"zip": fiscal["codigo_postal"]},
    }
    products = []
    for it in items:
        products.append(
            {
                "description": it["concepto"][:100],
                "product_key": "01010101",
                "quantity": float(Decimal(it["cantidad"])),
                "price": float(Decimal(it["precio_unitario"])),
                "tax_included": True,
                "taxes": [{"type": "IVA", "rate": 0.16}],
            }
        )

    payload = {
        "customer": customer,
        "items": products,
        "payment_form": "03",  # Transferencia electrónica (CoDi)
        "payment_method": "PUE",
        "use": fiscal["uso_cfdi"],
    }
    headers = {
        "Authorization": f"Bearer {FACTURAPI_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{FACTURAPI_BASE}/invoices",
            json=payload,
            headers=headers,
        )
        if resp.status_code >= 400:
            try:
                detail = resp.json()
                msg = detail.get("message") or detail.get("error") or resp.text
            except Exception:
                msg = resp.text
            raise FacturapiError(str(msg), status_code=resp.status_code)
        return resp.json()


class FacturapiError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


async def descargar_factura_archivos(facturapi_id: str, orden_id: int) -> tuple[Path, Path]:
    """Descarga PDF y XML; valida 200 y contenido no vacío."""
    headers = {"Authorization": f"Bearer {FACTURAPI_KEY}"}
    pdf_path = PUBLIC_DIR / f"factura_{orden_id}.pdf"
    xml_path = PUBLIC_DIR / f"factura_{orden_id}.xml"

    async with httpx.AsyncClient(timeout=30.0) as client:
        pdf_resp = await client.get(
            f"{FACTURAPI_BASE}/invoices/{facturapi_id}/pdf",
            headers=headers,
        )
        xml_resp = await client.get(
            f"{FACTURAPI_BASE}/invoices/{facturapi_id}/xml",
            headers=headers,
        )

        if pdf_resp.status_code != 200 or len(pdf_resp.content) == 0:
            raise FacturapiError(
                f"PDF inválido o vacío (status={pdf_resp.status_code})",
                status_code=pdf_resp.status_code,
            )
        if xml_resp.status_code != 200 or len(xml_resp.content) == 0:
            raise FacturapiError(
                f"XML inválido o vacío (status={xml_resp.status_code})",
                status_code=xml_resp.status_code,
            )

        pdf_path.write_bytes(pdf_resp.content)
        xml_path.write_bytes(xml_resp.content)

    return pdf_path, xml_path


async def evaluar_y_timbrar(orden_id: int) -> Optional[dict[str, Any]]:
    """
    Disparo desacoplado: timbra solo si
    pago_estado == 'PAGADO' AND datos_fiscales_ok == 1 AND facturapi_id IS NULL.
    Idempotente respecto a facturapi_id.
    """
    with db_session() as conn:
        row = conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
        if row is None:
            return None
        orden = dict(row)

        if orden["pago_estado"] != "PAGADO":
            return orden
        if not orden["datos_fiscales_ok"]:
            return orden
        if orden["facturapi_id"]:
            return orden

        fiscal_row = None
        if orden["cliente_fiscal_id"]:
            fiscal_row = conn.execute(
                "SELECT * FROM clientes_fiscales WHERE id = ?",
                (orden["cliente_fiscal_id"],),
            ).fetchone()
        if fiscal_row is None:
            fiscal_row = conn.execute(
                "SELECT * FROM clientes_fiscales WHERE telefono = ?",
                (orden["telefono"],),
            ).fetchone()
        if fiscal_row is None:
            conn.execute(
                """
                UPDATE ordenes
                SET estado_chat = 'ERROR_FISCAL',
                    error_fiscal = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                ("No hay datos fiscales asociados a la orden.", now_iso(), orden_id),
            )
            conn.commit()
            return dict(
                conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
            )

        fiscal = dict(fiscal_row)
        items = json.loads(orden["conceptos"])

    try:
        invoice = await timbrar_facturapi(orden, fiscal, items)
        facturapi_id = invoice.get("id") or invoice.get("_id")
        if not facturapi_id:
            raise FacturapiError("Facturapi no devolvió id de factura")

        await descargar_factura_archivos(str(facturapi_id), orden_id)

        with db_session() as conn:
            conn.execute(
                """
                UPDATE ordenes
                SET facturapi_id = ?,
                    estado_chat = 'COMPLETADO',
                    error_fiscal = NULL,
                    updated_at = ?
                WHERE id = ? AND facturapi_id IS NULL
                """,
                (str(facturapi_id), now_iso(), orden_id),
            )
            conn.commit()
            updated = dict(
                conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
            )

        pdf_url = f"{PUBLIC_URL}/files/factura_{orden_id}.pdf"
        xml_url = f"{PUBLIC_URL}/files/factura_{orden_id}.xml"
        send_whatsapp(
            orden["telefono"],
            (
                f"✅ Factura CFDI 4.0 timbrada (orden #{orden_id}).\n"
                f"PDF: {pdf_url}\nXML: {xml_url}"
            ),
        )
        return updated

    except FacturapiError as exc:
        with db_session() as conn:
            conn.execute(
                """
                UPDATE ordenes
                SET estado_chat = 'ERROR_FISCAL',
                    error_fiscal = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (exc.message[:1000], now_iso(), orden_id),
            )
            conn.commit()
            updated = dict(
                conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
            )
        send_whatsapp(
            orden["telefono"],
            (
                f"⚠️ El pago de la orden #{orden_id} está confirmado, pero Facturapi "
                f"rechazó los datos fiscales:\n{exc.message}\n\n"
                "Corrige y reenvía:\n"
                "RFC | Razón Social | CP | Régimen | UsoCFDI\n"
                "No se volverá a cobrar."
            ),
        )
        return updated
    except (httpx.HTTPError, OSError) as exc:
        with db_session() as conn:
            conn.execute(
                """
                UPDATE ordenes
                SET estado_chat = 'ERROR_FISCAL',
                    error_fiscal = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (f"Error al timbrar/descargar: {exc}"[:1000], now_iso(), orden_id),
            )
            conn.commit()
            updated = dict(
                conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
            )
        send_whatsapp(
            orden["telefono"],
            (
                f"⚠️ Pago OK en orden #{orden_id}, pero falló el timbrado/descarga. "
                "Reintentaremos o usa el panel /admin → Reintentar timbrado."
            ),
        )
        return updated


# ---------------------------------------------------------------------------
# Chat state machine
# ---------------------------------------------------------------------------

def get_active_order(conn: sqlite3.Connection, telefono: str) -> Optional[dict[str, Any]]:
    row = conn.execute(
        """
        SELECT * FROM ordenes
        WHERE telefono = ?
          AND estado_chat NOT IN ('COMPLETADO', 'CANCELADO')
        ORDER BY id DESC
        LIMIT 1
        """,
        (telefono,),
    ).fetchone()
    return dict(row) if row else None


def upsert_cliente_fiscal(
    conn: sqlite3.Connection, telefono: str, data: dict[str, str]
) -> int:
    existing = conn.execute(
        "SELECT id FROM clientes_fiscales WHERE telefono = ?", (telefono,)
    ).fetchone()
    ts = now_iso()
    if existing:
        conn.execute(
            """
            UPDATE clientes_fiscales
            SET rfc = ?, razon_social = ?, codigo_postal = ?, regimen = ?,
                uso_cfdi = ?, updated_at = ?
            WHERE telefono = ?
            """,
            (
                data["rfc"],
                data["razon_social"],
                data["codigo_postal"],
                data["regimen"],
                data["uso_cfdi"],
                ts,
                telefono,
            ),
        )
        return int(existing["id"])
    cur = conn.execute(
        """
        INSERT INTO clientes_fiscales
            (telefono, rfc, razon_social, codigo_postal, regimen, uso_cfdi, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            telefono,
            data["rfc"],
            data["razon_social"],
            data["codigo_postal"],
            data["regimen"],
            data["uso_cfdi"],
            ts,
        ),
    )
    return int(cur.lastrowid)


async def _guardar_datos_fiscales(telefono: str, text: str, orden_id: int) -> tuple[Optional[str], Optional[str]]:
    """Persiste datos fiscales. Retorna (respuesta_error, None) o (None, ok_placeholder)."""
    data, err = parse_fiscal_data(text)
    if err:
        return err, None
    assert data is not None
    with db_session() as conn:
        cid = upsert_cliente_fiscal(conn, telefono, data)
        conn.execute(
            """
            UPDATE ordenes
            SET datos_fiscales_ok = 1,
                cliente_fiscal_id = ?,
                requiere_factura = 1,
                error_fiscal = NULL,
                estado_chat = 'ESPERANDO_PAGO',
                updated_at = ?
            WHERE id = ?
            """,
            (cid, now_iso(), orden_id),
        )
        conn.commit()
    return None, "ok"


async def _crear_qr_y_avanzar(
    telefono: str, orden_id: int, requiere: int, items: list[dict[str, Any]], monto: Decimal
) -> str:
    concepto = concept_for_pey(items, orden_id)
    with db_session() as conn:
        conn.execute(
            """
            UPDATE ordenes
            SET requiere_factura = ?, concepto_pey = ?, updated_at = ?
            WHERE id = ?
            """,
            (requiere, concepto, now_iso(), orden_id),
        )
        conn.commit()

    try:
        pey_data = await crear_qr_pey(orden_id, monto, concepto)
    except (httpx.TimeoutException, httpx.ConnectTimeout, httpx.HTTPStatusError, httpx.HTTPError) as exc:
        send_whatsapp(
            telefono,
            (
                "⚠️ No pudimos generar el QR CoDi en este momento "
                f"({type(exc).__name__}). Por favor reintenta en unos segundos "
                "enviando de nuevo tus productos."
            ),
        )
        with db_session() as conn:
            conn.execute(
                """
                UPDATE ordenes
                SET estado_chat = 'CANCELADO', updated_at = ?
                WHERE id = ?
                """,
                (now_iso(), orden_id),
            )
            conn.commit()
        return (
            "Hubo un problema temporal con CoDi. "
            "Reintenta enviando de nuevo la lista de productos."
        )

    qr_payload = (
        pey_data.get("qr")
        or pey_data.get("qrString")
        or pey_data.get("payload")
        or pey_data.get("data")
        or json.dumps(pey_data)
    )
    if isinstance(qr_payload, dict):
        qr_payload = (
            qr_payload.get("qr")
            or qr_payload.get("qrString")
            or json.dumps(qr_payload)
        )
    pey_qr_id = str(
        pey_data.get("id") or pey_data.get("qrId") or pey_data.get("uuid") or ""
    ) or None

    generar_qr_png(str(qr_payload), orden_id)
    media = f"{PUBLIC_URL}/files/qr_{orden_id}.png"

    with db_session() as conn:
        saved_fiscal = conn.execute(
            "SELECT * FROM clientes_fiscales WHERE telefono = ?", (telefono,)
        ).fetchone()

        if requiere == 1:
            if saved_fiscal:
                conn.execute(
                    """
                    UPDATE ordenes
                    SET datos_fiscales_ok = 1,
                        cliente_fiscal_id = ?,
                        pey_qr_id = ?,
                        estado_chat = 'ESPERANDO_PAGO',
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (saved_fiscal["id"], pey_qr_id, now_iso(), orden_id),
                )
                fiscal_msg = (
                    f"Usaremos tus datos fiscales guardados ({saved_fiscal['rfc']}). "
                    "Si deseas cambiarlos, envía:\n"
                    "RFC | Razón Social | CP | Régimen | UsoCFDI"
                )
            else:
                conn.execute(
                    """
                    UPDATE ordenes
                    SET pey_qr_id = ?,
                        estado_chat = 'ESPERANDO_DATOS_FISCALES',
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (pey_qr_id, now_iso(), orden_id),
                )
                fiscal_msg = (
                    "Para facturar envía tus datos:\n"
                    "RFC | Razón Social | CP | Régimen | UsoCFDI\n"
                    "Ejemplo SAT: XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03"
                )
        else:
            conn.execute(
                """
                UPDATE ordenes
                SET pey_qr_id = ?,
                    estado_chat = 'ESPERANDO_PAGO',
                    updated_at = ?
                WHERE id = ?
                """,
                (pey_qr_id, now_iso(), orden_id),
            )
            fiscal_msg = "Sin factura. Escanea el QR CoDi para pagar."
        conn.commit()

    msg = (
        f"Orden #{orden_id} por ${monto} MXN.\n"
        f"Concepto CoDi: {concepto}\n"
        f"Escanea el QR (válido 10 min).\n\n{fiscal_msg}"
    )
    send_whatsapp(telefono, msg, media_url=media)
    return msg


async def handle_whatsapp_message(telefono: str, body: str) -> str:
    text = (body or "").strip()

    with db_session() as conn:
        orden = get_active_order(conn, telefono)
        estado = orden["estado_chat"] if orden else "ESPERANDO_PRODUCTOS"
        orden_snapshot = dict(orden) if orden else None

    # --- Datos fiscales (captura o corrección) ---
    if orden_snapshot and estado in (
        "ESPERANDO_DATOS_FISCALES",
        "ERROR_FISCAL",
        "ESPERANDO_PAGO",
    ):
        if "|" in text:
            err, _ok = await _guardar_datos_fiscales(telefono, text, orden_snapshot["id"])
            if err:
                return err
            await evaluar_y_timbrar(orden_snapshot["id"])
            with db_session() as conn:
                o2 = dict(
                    conn.execute(
                        "SELECT * FROM ordenes WHERE id = ?", (orden_snapshot["id"],)
                    ).fetchone()
                )
            if o2.get("facturapi_id"):
                return (
                    f"✅ Datos fiscales guardados y factura timbrada para orden #{o2['id']}."
                )
            if o2.get("pago_estado") == "PAGADO" and o2.get("estado_chat") == "ERROR_FISCAL":
                return (
                    f"Datos guardados, pero el timbrado falló:\n{o2.get('error_fiscal')}\n"
                    "Corrige e intenta de nuevo (no se vuelve a cobrar)."
                )
            return (
                f"✅ Datos fiscales guardados para orden #{o2['id']}. "
                "Cuando se confirme el pago CoDi, timbraremos automáticamente."
            )
        if estado in ("ESPERANDO_DATOS_FISCALES", "ERROR_FISCAL"):
            return (
                "Para facturar envía:\n"
                "RFC | Razón Social | CP | Régimen | UsoCFDI"
            )
        # ESPERANDO_PAGO sin pipe: permitir nueva orden de productos más abajo

    # --- Confirmación factura 1/2 ---
    if orden_snapshot and estado == "ESPERANDO_FACTURA":
        if text not in ("1", "2"):
            return "Responde *1* para factura o *2* si no la necesitas."
        items = json.loads(orden_snapshot["conceptos"])
        monto = Decimal(orden_snapshot["monto"])
        return await _crear_qr_y_avanzar(
            telefono, orden_snapshot["id"], 1 if text == "1" else 0, items, monto
        )

    # --- Nueva orden de productos ---
    items, err = parse_product_lines(text)
    if err:
        return err

    assert items is not None
    total = sum_items(items)
    ts = now_iso()

    with db_session() as conn:
        # Cerrar órdenes previas pendientes del mismo teléfono
        if orden_snapshot and orden_snapshot["pago_estado"] == "PENDIENTE":
            conn.execute(
                """
                UPDATE ordenes
                SET estado_chat = 'CANCELADO', updated_at = ?
                WHERE id = ? AND pago_estado = 'PENDIENTE'
                """,
                (ts, orden_snapshot["id"]),
            )
        cur = conn.execute(
            """
            INSERT INTO ordenes
                (telefono, conceptos, monto, pago_estado, requiere_factura,
                 datos_fiscales_ok, estado_chat, created_at, updated_at)
            VALUES (?, ?, ?, 'PENDIENTE', 0, 0, 'ESPERANDO_FACTURA', ?, ?)
            """,
            (telefono, json.dumps(items, ensure_ascii=False), str(total), ts, ts),
        )
        new_id = int(cur.lastrowid)
        conn.commit()

    resumen = "\n".join(
        f"• {i['cantidad']} x {i['concepto']} @ ${i['precio_unitario']} = ${i['subtotal']}"
        for i in items
    )
    return (
        f"Orden #{new_id}\n{resumen}\n\n"
        f"*Total: ${total} MXN*\n\n"
        "¿Requieres factura CFDI 4.0?\n"
        "Responde *1* = Sí  |  *2* = No"
    )


# ---------------------------------------------------------------------------
# Webhooks & API
# ---------------------------------------------------------------------------

@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/whatsapp/webhook")
async def whatsapp_webhook(
    Body: str = Form(default=""),
    From: str = Form(default=""),
) -> PlainTextResponse:
    """Twilio WhatsApp webhook — siempre 200 para no reintentar en bucle."""
    telefono = From or "whatsapp:+0000000000"
    try:
        reply = await handle_whatsapp_message(telefono, Body)
    except Exception as exc:  # noqa: BLE001 — nunca 500 a Twilio
        print(f"[whatsapp] unhandled: {exc}")
        reply = (
            "Ocurrió un error temporal. Reintenta en unos segundos "
            "o contacta al comercio."
        )
        try:
            send_whatsapp(telefono, reply)
        except Exception:
            pass
    # Twilio acepta texto plano como cuerpo de respuesta en algunos setups;
    # enviamos también por API para media. Respuesta TwiML mínima.
    twiml = f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>{_xml_escape(reply)}</Message></Response>"
    return PlainTextResponse(content=twiml, media_type="application/xml")


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@app.post("/pey/webhook")
async def pey_webhook(request: Request) -> JSONResponse:
    """
    Webhook pey: codi.qr.payment_received / codi.pn.payment_received.
    Idempotente por transactionId.
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"ok": True, "ignored": "invalid json"})

    event = (
        payload.get("event")
        or payload.get("type")
        or payload.get("eventType")
        or ""
    )
    data = payload.get("data") or payload.get("payload") or payload

    if event and event not in (
        "codi.qr.payment_received",
        "codi.pn.payment_received",
    ):
        # Aceptar también si viene sin event pero con transactionId + numRef
        if not (data.get("transactionId") or data.get("transaction_id")):
            return JSONResponse({"ok": True, "ignored": f"event {event}"})

    tx_id = (
        data.get("transactionId")
        or data.get("transaction_id")
        or payload.get("transactionId")
    )
    num_ref = (
        data.get("numRef")
        or data.get("num_ref")
        or data.get("reference")
        or payload.get("numRef")
    )

    if not tx_id:
        return JSONResponse({"ok": True, "ignored": "no transactionId"})

    with db_session() as conn:
        # Idempotencia: mismo transactionId ya procesado
        existing_tx = conn.execute(
            "SELECT id FROM ordenes WHERE pey_transaction_id = ?",
            (str(tx_id),),
        ).fetchone()
        if existing_tx:
            return JSONResponse(
                {"ok": True, "duplicate": True, "orden_id": existing_tx["id"]}
            )

        orden = None
        if num_ref is not None and str(num_ref).isdigit():
            orden = conn.execute(
                "SELECT * FROM ordenes WHERE id = ?", (int(num_ref),)
            ).fetchone()

        if orden is None:
            # numRef desconocido — 200 OK, ignorar
            return JSONResponse({"ok": True, "ignored": "unknown numRef"})

        orden_id = int(orden["id"])
        conn.execute(
            """
            UPDATE ordenes
            SET pago_estado = 'PAGADO',
                pey_transaction_id = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (str(tx_id), now_iso(), orden_id),
        )
        conn.commit()
        telefono = orden["telefono"]
        monto = orden["monto"]

    send_whatsapp(
        telefono,
        f"💰 Pago CoDi confirmado: ${monto} MXN (orden #{orden_id}).",
    )
    await evaluar_y_timbrar(orden_id)
    return JSONResponse({"ok": True, "orden_id": orden_id, "pago": "PAGADO"})


# ---------------------------------------------------------------------------
# Admin API
# ---------------------------------------------------------------------------

def _fiscal_badge(orden: dict[str, Any]) -> str:
    if not orden.get("requiere_factura"):
        return "SIN FACTURA"
    if orden.get("facturapi_id"):
        return "TIMBRADO"
    if orden.get("estado_chat") == "ERROR_FISCAL" or orden.get("error_fiscal"):
        return "ERROR FISCAL"
    if not orden.get("datos_fiscales_ok"):
        return "PENDIENTE DATOS"
    return "PENDIENTE DATOS" if orden["pago_estado"] != "PAGADO" else "LISTO POR TIMBRAR"


def build_ordenes_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT o.*,
               c.rfc AS rfc,
               c.razon_social AS razon_social
        FROM ordenes o
        LEFT JOIN clientes_fiscales c ON c.id = o.cliente_fiscal_id
        ORDER BY o.id DESC
        """
    ).fetchall()

    ordenes = []
    total_cobrado = Decimal("0")
    facturas_timbradas = 0
    pendientes = 0

    for r in rows:
        o = dict(r)
        try:
            conceptos = json.loads(o["conceptos"])
        except Exception:
            conceptos = []
        if o["pago_estado"] == "PAGADO":
            total_cobrado += Decimal(o["monto"])
        else:
            pendientes += 1
        if o.get("facturapi_id"):
            facturas_timbradas += 1

        ordenes.append(
            {
                **{k: o[k] for k in o.keys()},
                "conceptos_parseados": conceptos,
                "rfc": o.get("rfc"),
                "razon_social": o.get("razon_social"),
                "fiscal_badge": _fiscal_badge(o),
            }
        )

    comisiones = (total_cobrado * Decimal("0.035")).quantize(Decimal("0.01"))
    return {
        "kpis": {
            "total_cobrado": float(total_cobrado),
            "facturas_timbradas": facturas_timbradas,
            "comisiones_ahorradas": float(comisiones),
            "ordenes_pendientes": pendientes,
        },
        "ordenes": ordenes,
    }


@app.get("/api/ordenes")
def api_ordenes() -> JSONResponse:
    with db_session() as conn:
        return JSONResponse(build_ordenes_payload(conn))


@app.post("/api/ordenes/{orden_id}/reintentar-timbrado")
async def api_reintentar_timbrado(orden_id: int) -> JSONResponse:
    with db_session() as conn:
        row = conn.execute(
            "SELECT * FROM ordenes WHERE id = ?", (orden_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Orden no encontrada")
        # Limpiar facturapi_id solo si queremos forzar — no; evaluar_y_timbrar
        # solo actúa si facturapi_id IS NULL. Si ya está timbrada, devolver estado.
        if row["facturapi_id"]:
            return JSONResponse({"orden": dict(row), "message": "Ya timbrada"})
        # Si hay error fiscal previo, permitir reintento limpiando bloqueo blando
        if row["estado_chat"] == "ERROR_FISCAL" and row["datos_fiscales_ok"]:
            pass

    updated = await evaluar_y_timbrar(orden_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    return JSONResponse({"orden": updated})


@app.get("/admin", response_class=HTMLResponse)
def admin_panel() -> HTMLResponse:
    path = TEMPLATES_DIR / "admin.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="admin.html no encontrado")
    return HTMLResponse(path.read_text(encoding="utf-8"))


# Inicializar DB al importar (útil para tests que no disparan startup)
init_db()
