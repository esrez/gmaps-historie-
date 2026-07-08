"""Více profilů (rodinný režim) – oddělené databáze."""
from __future__ import annotations

import os
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api/profiles", tags=["profily"])


class ProfileCreate(BaseModel):
    name: str


@router.get("")
def list_profiles():
    return {"active": db.active_profile(), "profiles": db.list_profiles()}


@router.post("")
def create_profile(body: ProfileCreate):
    safe = db.set_profile(body.name)
    os.makedirs(os.path.dirname(db.DB_PATH), exist_ok=True)
    conn = db.connect()
    conn.execute(
        "INSERT OR IGNORE INTO profiles(name, created_ts, is_default) VALUES(?,?,0)",
        (safe, int(time.time())))
    conn.commit()
    conn.close()
    return {"name": safe, "db_path": db.DB_PATH}


@router.post("/switch")
def switch_profile(body: ProfileCreate):
    profiles = {p["name"] for p in db.list_profiles()}
    if body.name not in profiles:
        path = os.path.join(db.profile_root(), body.name, "history.db")
        if not os.path.exists(path):
            raise HTTPException(404, "Profil neexistuje")
    name = db.set_profile(body.name)
    return {"active": name, "db_path": db.DB_PATH}
