"""Import souborů na pozadí."""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
import uuid
from contextlib import closing
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, UploadFile

from .. import db, importer
from ..core.config import IMPORT_RATE_LIMIT, data_dir
from ..core.events import event_bus
from ..core.logging import log
from ..core.rate_limit import RateLimiter

router = APIRouter(tags=["import"])

IMPORT_JOBS: dict[str, dict] = {}
_import_limiter = RateLimiter(IMPORT_RATE_LIMIT)


@router.post("/api/import")
async def api_import(request: Request, file: UploadFile):
    client = request.client.host if request.client else "local"
    if not _import_limiter.allow(client):
        raise HTTPException(429, f"Příliš mnoho importů (max {IMPORT_RATE_LIMIT}/hodinu)")
    tmpdir = data_dir()
    os.makedirs(tmpdir, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=tmpdir, suffix=".upload", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    job_id = uuid.uuid4().hex[:12]
    counters = importer.Counters()
    job = {"status": "running", "counters": counters, "error": None,
           "filename": file.filename}
    IMPORT_JOBS[job_id] = job
    # dokončené úlohy nedržet donekonečna (status si frontend čte hned po běhu)
    while len(IMPORT_JOBS) > 50:
        oldest = next(iter(IMPORT_JOBS))
        if IMPORT_JOBS[oldest]["status"] == "running":
            break
        IMPORT_JOBS.pop(oldest)

    def run():
        try:
            # import_path si přepočet agregací (after_import) udělá sám
            importer.import_path(tmp_path, counters=counters)
            with closing(db.connect()) as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO import_meta(key,value) VALUES(?,?)",
                    ("last_import", datetime.now().isoformat(timespec="seconds")))
                conn.commit()
            job["status"] = "done"
            event_bus.publish_sync("import_done", {"job_id": job_id, **counters.as_dict()})
        except Exception as exc:
            job["status"] = "error"
            job["error"] = str(exc)
            event_bus.publish_sync("import_error", {"job_id": job_id, "error": str(exc)})
            log.exception("Import selhal")
        finally:
            os.unlink(tmp_path)

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


@router.get("/api/import/status/{job_id}")
def api_import_status(job_id: str):
    job = IMPORT_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Neznámý import")
    return {"status": job["status"], "error": job["error"],
            "filename": job["filename"], **job["counters"].as_dict()}


@router.post("/api/demo")
def api_demo():
    """Naplní PRÁZDNOU databázi ukázkovými daty (vyzkoušení bez exportu)."""
    with closing(db.connect()) as conn:
        n = conn.execute("SELECT (SELECT COUNT(*) FROM points) + "
                         "(SELECT COUNT(*) FROM visits) c").fetchone()["c"]
    if n:
        raise HTTPException(409, "Databáze není prázdná – ukázková data by se "
                                 "smíchala s vašimi. Použijte nový profil.")
    from ..services.demo import generate_demo
    counts = generate_demo()
    log.info("Ukázková data vygenerována: %s", counts)
    return counts


@router.get("/api/import/since")
def api_import_since():
    """Čas posledního importu – pro inkrementální synchronizaci z telefonu."""
    with closing(db.connect()) as conn:
        row = conn.execute(
            "SELECT value FROM import_meta WHERE key='last_import'").fetchone()
        max_ts = conn.execute("SELECT MAX(ts) t FROM points").fetchone()["t"]
    return {"last_import": row["value"] if row else None, "max_ts": max_ts}
