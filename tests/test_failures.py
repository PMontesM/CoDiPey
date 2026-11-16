"""Legacy FastAPI suite retired — surface is a 410 stub. Worker tests live in test/."""

from __future__ import annotations

from fastapi.testclient import TestClient

import main


def test_fastapi_stub_is_gone() -> None:
    client = TestClient(main.app)
    assert client.get("/health").json()["status"] == "gone"
    assert client.post("/pey/webhook", json={}).status_code == 410
    assert client.post("/whatsapp/webhook").status_code == 410
    assert client.get("/api/ordenes").status_code == 410
