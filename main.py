"""
Legacy FastAPI entrypoint — retirado por seguridad.

El producto vivo es el Cloudflare Worker (`src/index.ts`).
Este stub evita exponer webhooks y APIs de admin sin autenticación
si alguien despliega el Dockerfile antiguo.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="CoDiPey (deprecated)", docs_url=None, redoc_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "gone",
        "runtime": "fastapi-stub",
        "message": "Use the Cloudflare Worker (src/index.ts), not this entrypoint.",
    }


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def gone(path: str) -> JSONResponse:
    return JSONResponse(
        {
            "detail": "This FastAPI surface was removed. Deploy the Cloudflare Worker.",
            "path": path,
        },
        status_code=410,
    )
