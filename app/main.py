"""FastAPI server – API nad historií polohy + statický frontend."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import places, trips
from .core.auth import auth_middleware
from .core.config import STATIC_DIR
from .core.logging import log, setup_logging
from .routers import (
    backup_router,
    export_router,
    import_router,
    map_data_router,
    pages_router,
    profiles_router,
    quality_router,
    stats_router,
    sync_router,
)
from .routers.backup import background_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log.info("GMaps Historie startuje")
    task = None
    if os.environ.get("DISABLE_BACKGROUND") != "1":
        import asyncio
        task = asyncio.create_task(background_loop())
    yield
    if task:
        task.cancel()
        with suppress(Exception):
            await task
    log.info("GMaps Historie ukončena")


def _pmtiles_path() -> str:
    from .core.config import data_dir
    return os.path.join(data_dir(), "map.pmtiles")


app = FastAPI(
    title="GMaps Historie",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await auth_middleware(request, call_next)
    if isinstance(response, Response):
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: "
            "https://*.openstreetmap.org https://*.cartocdn.com https://server.arcgisonline.com; "
            "connect-src 'self' https://nominatim.openstreetmap.org",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


for r in (trips.router, places.router, backup_router, map_data_router,
          stats_router, export_router, quality_router, import_router,
          sync_router, profiles_router, pages_router):
    app.include_router(r)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
