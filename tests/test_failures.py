"""
Suite de fallos críticos — cobro WhatsApp CoDi + CFDI 4.0
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any, Generator
from unittest.mock import MagicMock

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import main


PHONE = "whatsapp:+5215512345678"
FISCAL_OK = "XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03"
FISCAL_BAD_CP = "XAXX010101000 | PUBLICO EN GENERAL | 000 | 616 | G03"


@pytest.fixture()
def app_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[TestClient, None, None]:
    db_path = tmp_path / "test.db"
    public = tmp_path / "public_files"
    public.mkdir()
    templates = Path(main.TEMPLATES_DIR)

    monkeypatch.setattr(main, "DB_PATH", db_path)
    monkeypatch.setattr(main, "_db_path_override", db_path)
    monkeypatch.setattr(main, "PUBLIC_DIR", public)
    monkeypatch.setattr(main, "PEY_API_KEY", "test_pey")
    monkeypatch.setattr(main, "FACTURAPI_KEY", "test_facturapi")
    monkeypatch.setattr(main, "PUBLIC_URL", "http://test.local")
    monkeypatch.setattr(main, "TWILIO_ACCOUNT_SID", "")
    monkeypatch.setattr(main, "TWILIO_AUTH_TOKEN", "")

    sent: list[dict[str, Any]] = []

    def fake_send(to: str, body: str, media_url: str | None = None) -> None:
        sent.append({"to": to, "body": body, "media_url": media_url})

    monkeypatch.setattr(main, "send_whatsapp", fake_send)
    main.init_db()

    client = TestClient(main.app)
    client.sent_messages = sent  # type: ignore[attr-defined]
    client.public_dir = public  # type: ignore[attr-defined]
    client.db_path = db_path  # type: ignore[attr-defined]
    yield client


def _wa(client: TestClient, body: str, frm: str = PHONE) -> httpx.Response:
    return client.post(
        "/whatsapp/webhook",
        data={"Body": body, "From": frm},
    )


def _pey_payment(client: TestClient, orden_id: int, tx_id: str = "tx-1") -> httpx.Response:
    return client.post(
        "/pey/webhook",
        json={
            "event": "codi.qr.payment_received",
            "data": {
                "transactionId": tx_id,
                "numRef": str(orden_id),
                "amount": 0.01,
            },
        },
    )


def _get_orden(client: TestClient, orden_id: int) -> dict[str, Any]:
    with main.db_session() as conn:
        row = conn.execute("SELECT * FROM ordenes WHERE id = ?", (orden_id,)).fetchone()
        assert row is not None
        return dict(row)


def _latest_orden_id(client: TestClient) -> int:
    with main.db_session() as conn:
        row = conn.execute("SELECT id FROM ordenes ORDER BY id DESC LIMIT 1").fetchone()
        assert row is not None
        return int(row["id"])


def _mock_pey_ok(respx_mock: respx.MockRouter) -> None:
    respx_mock.post("https://api.pey.mx/codi/qr").mock(
        return_value=httpx.Response(
            200,
            json={"id": "qr-1", "qr": "codi://pay?demo=1"},
        )
    )


def _mock_facturapi_ok(respx_mock: respx.MockRouter, invoice_id: str = "inv_1") -> None:
    respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": invoice_id})
    )
    respx_mock.get(f"https://www.facturapi.io/v2/invoices/{invoice_id}/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-1.4 fake")
    )
    respx_mock.get(f"https://www.facturapi.io/v2/invoices/{invoice_id}/xml").mock(
        return_value=httpx.Response(200, content=b"<?xml version='1.0'?><cfdi/>")
    )


# ---------------------------------------------------------------------------
# 1. Idempotencia webhook pey
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_1_idempotencia_webhook_pey(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    _mock_pey_ok(respx_mock)
    invoice_route = respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_idem"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_idem/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-ok")
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_idem/xml").mock(
        return_value=httpx.Response(200, content=b"<xml>ok</xml>")
    )

    assert _wa(client, "1 Prueba CoDi 0.01").status_code == 200
    oid = _latest_orden_id(client)
    assert _wa(client, "1").status_code == 200
    assert _wa(client, FISCAL_OK).status_code == 200

    r1 = _pey_payment(client, oid, tx_id="same-tx")
    r2 = _pey_payment(client, oid, tx_id="same-tx")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r2.json().get("duplicate") is True

    orden = _get_orden(client, oid)
    assert orden["pago_estado"] == "PAGADO"
    assert orden["facturapi_id"] == "inv_idem"
    assert invoice_route.call_count == 1


# ---------------------------------------------------------------------------
# 2. Carrera A: pago primero → datos fiscales después
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_2_carrera_pago_luego_fiscales(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    _mock_pey_ok(respx_mock)
    invoice_route = respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_race_a"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_race_a/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-a")
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_race_a/xml").mock(
        return_value=httpx.Response(200, content=b"<xml>a</xml>")
    )

    _wa(client, "1 Cafe 45")
    oid = _latest_orden_id(client)
    _wa(client, "1")  # quiere factura → ESPERANDO_DATOS_FISCALES

    # Pago llega ANTES de datos fiscales
    assert _pey_payment(client, oid, "tx-race-a").status_code == 200
    orden = _get_orden(client, oid)
    assert orden["pago_estado"] == "PAGADO"
    assert orden["facturapi_id"] is None
    assert invoice_route.call_count == 0

    # Luego datos fiscales → timbra una vez
    assert _wa(client, FISCAL_OK).status_code == 200
    orden = _get_orden(client, oid)
    assert orden["facturapi_id"] == "inv_race_a"
    assert orden["estado_chat"] == "COMPLETADO"
    assert invoice_route.call_count == 1


# ---------------------------------------------------------------------------
# 3. Carrera B: datos fiscales primero → pago después
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_3_carrera_fiscales_luego_pago(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    _mock_pey_ok(respx_mock)
    invoice_route = respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_race_b"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_race_b/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-b")
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_race_b/xml").mock(
        return_value=httpx.Response(200, content=b"<xml>b</xml>")
    )

    _wa(client, "2 Tacos 30")
    oid = _latest_orden_id(client)
    _wa(client, "1")
    _wa(client, FISCAL_OK)

    orden = _get_orden(client, oid)
    assert orden["datos_fiscales_ok"] == 1
    assert orden["pago_estado"] == "PENDIENTE"
    assert orden["facturapi_id"] is None
    assert invoice_route.call_count == 0

    assert _pey_payment(client, oid, "tx-race-b").status_code == 200
    orden = _get_orden(client, oid)
    assert orden["pago_estado"] == "PAGADO"
    assert orden["facturapi_id"] == "inv_race_b"
    assert invoice_route.call_count == 1


# ---------------------------------------------------------------------------
# 4. Fallo / timeout pey al crear QR
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_4_pey_timeout_o_500(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    respx_mock.post("https://api.pey.mx/codi/qr").mock(
        side_effect=httpx.ConnectTimeout("timeout")
    )

    _wa(client, "1 Prueba CoDi 0.01")
    r = _wa(client, "2")
    assert r.status_code == 200
    assert "problema temporal" in r.text.lower() or "CoDi" in r.text

    # Debe haber avisado por WhatsApp
    assert any("QR CoDi" in m["body"] or "CoDi" in m["body"] for m in client.sent_messages)  # type: ignore[attr-defined]

    # HTTP 500
    respx_mock.post("https://api.pey.mx/codi/qr").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    _wa(client, "1 Prueba CoDi 0.01")
    r2 = _wa(client, "2")
    assert r2.status_code == 200


# ---------------------------------------------------------------------------
# 5. Rechazo fiscal Facturapi + recuperación
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_5_rechazo_fiscal_y_reintento(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    _mock_pey_ok(respx_mock)

    # Primer intento: 400 CP inválido
    respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(400, json={"message": "Código postal inválido"})
    )

    _wa(client, "1 Demo 0.01")
    oid = _latest_orden_id(client)
    _wa(client, "1")
    # CP inválido pasa parse local (5 dígitos) pero Facturapi rechaza
    _wa(client, "XAXX010101000 | PUBLICO EN GENERAL | 99999 | 616 | G03")
    _pey_payment(client, oid, "tx-fiscal-bad")

    orden = _get_orden(client, oid)
    assert orden["pago_estado"] == "PAGADO"
    assert orden["estado_chat"] == "ERROR_FISCAL"
    assert orden["error_fiscal"]
    assert orden["facturapi_id"] is None

    # Recuperación: Facturapi OK + reintento API
    respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_recovered"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_recovered/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-rec")
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_recovered/xml").mock(
        return_value=httpx.Response(200, content=b"<xml>rec</xml>")
    )

    # Corregir datos por WhatsApp dispara timbrado
    r = _wa(client, FISCAL_OK)
    assert r.status_code == 200
    orden = _get_orden(client, oid)
    assert orden["facturapi_id"] == "inv_recovered"
    assert orden["estado_chat"] == "COMPLETADO"
    assert orden["pago_estado"] == "PAGADO"

    # Endpoint de reintento sobre orden ya timbrada
    rr = client.post(f"/api/ordenes/{oid}/reintentar-timbrado")
    assert rr.status_code == 200


# ---------------------------------------------------------------------------
# 6. Entradas malformadas y numRef desconocido
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_6_malformados_y_numref_desconocido(
    app_env: TestClient, respx_mock: respx.MockRouter
) -> None:
    client = app_env

    # Basura
    r = _wa(client, "hola mundo xyz")
    assert r.status_code == 200
    assert "No entendí" in r.text or "Formato" in r.text or "productos" in r.text.lower()

    # Precio 0
    r0 = _wa(client, "1 Cafe 0")
    assert r0.status_code == 200
    assert "mayores a 0" in r0.text

    # Precio negativo
    rn = _wa(client, "1 Cafe -50")
    assert rn.status_code == 200
    # -50 no matchea el regex o es inválido
    assert "mayores a 0" in rn.text or "No entendí" in rn.text or "Formato" in rn.text

    # Orden válida + factura + datos incompletos
    _mock_pey_ok(respx_mock)
    _wa(client, "1 Agua 10")
    oid = _latest_orden_id(client)
    _wa(client, "1")
    incomplete = _wa(client, "RFC | Nombre")
    assert incomplete.status_code == 200
    assert "incompletos" in incomplete.text.lower() or "exactamente" in incomplete.text.lower()

    # Webhook pey con numRef inexistente
    unknown = client.post(
        "/pey/webhook",
        json={
            "event": "codi.qr.payment_received",
            "data": {"transactionId": "tx-orphan", "numRef": "999999"},
        },
    )
    assert unknown.status_code == 200
    assert unknown.json().get("ignored")


# ---------------------------------------------------------------------------
# 7. PDF vacío + panel admin KPIs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_7_pdf_vacio_y_admin_kpis(app_env: TestClient, respx_mock: respx.MockRouter) -> None:
    client = app_env
    _mock_pey_ok(respx_mock)

    respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_empty"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_empty/pdf").mock(
        return_value=httpx.Response(200, content=b"")  # vacío
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_empty/xml").mock(
        return_value=httpx.Response(200, content=b"<xml/>")
    )

    _wa(client, "1 Item 100")
    oid = _latest_orden_id(client)
    _wa(client, "1")
    _wa(client, FISCAL_OK)
    _pey_payment(client, oid, "tx-empty-pdf")

    orden = _get_orden(client, oid)
    assert orden["pago_estado"] == "PAGADO"
    assert orden["facturapi_id"] is None  # no marcar COMPLETADO
    assert orden["estado_chat"] == "ERROR_FISCAL"
    pdf = client.public_dir / f"factura_{oid}.pdf"  # type: ignore[attr-defined]
    assert not pdf.exists() or pdf.stat().st_size == 0

    # Admin HTML
    admin = client.get("/admin")
    assert admin.status_code == 200
    assert "text/html" in admin.headers.get("content-type", "")
    assert "Volumen Liquidado" in admin.text or "Total Cobrado" in admin.text
    assert "Consola de Tesorería" in admin.text or "CFDI" in admin.text

    # KPIs: hay una orden PAGADA de 100 sin factura
    api = client.get("/api/ordenes")
    assert api.status_code == 200
    data = api.json()
    assert data["kpis"]["total_cobrado"] == 100.0
    assert data["kpis"]["facturas_timbradas"] == 0
    assert data["kpis"]["comisiones_ahorradas"] == 3.5  # 100 * 0.035
    assert data["kpis"]["ordenes_pendientes"] == 0

    # Completar con PDF/XML OK vía reintento
    respx_mock.post("https://www.facturapi.io/v2/invoices").mock(
        return_value=httpx.Response(200, json={"id": "inv_ok2"})
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_ok2/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF-ok2")
    )
    respx_mock.get("https://www.facturapi.io/v2/invoices/inv_ok2/xml").mock(
        return_value=httpx.Response(200, content=b"<xml>ok2</xml>")
    )
    retry = client.post(f"/api/ordenes/{oid}/reintentar-timbrado")
    assert retry.status_code == 200
    orden = _get_orden(client, oid)
    assert orden["facturapi_id"] == "inv_ok2"
    assert (client.public_dir / f"factura_{oid}.pdf").stat().st_size > 0  # type: ignore[attr-defined]

    api2 = client.get("/api/ordenes")
    assert api2.json()["kpis"]["facturas_timbradas"] == 1
