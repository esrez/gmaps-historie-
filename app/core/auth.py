"""Autentizace: HTTP Basic + volitelná session cookie (lokální nasazení)."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time

from fastapi import Request, Response

from .config import AUTH_PASSWORD, SESSION_MAX_AGE

_sessions: dict[str, float] = {}


def _session_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(response: Response) -> str:
    token = _session_token()
    _sessions[_hash_token(token)] = time.time() + SESSION_MAX_AGE
    response.set_cookie(
        "gmaps_session", token, httponly=True, samesite="lax",
        max_age=SESSION_MAX_AGE, path="/",
    )
    return token


def _valid_session(request: Request) -> bool:
    token = request.cookies.get("gmaps_session", "")
    if not token:
        return False
    exp = _sessions.get(_hash_token(token))
    if exp is None or exp < time.time():
        _sessions.pop(_hash_token(token), None)
        return False
    return True


def _basic_ok(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    if not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
        password = decoded.split(":", 1)[1] if ":" in decoded else ""
        return secrets.compare_digest(password, AUTH_PASSWORD)
    except Exception:
        return False


async def auth_middleware(request: Request, call_next):
    if not AUTH_PASSWORD:
        return await call_next(request)
    if request.url.path in ("/api/login", "/api/version", "/manifest.webmanifest", "/sw.js"):
        return await call_next(request)
    if _valid_session(request) or _basic_ok(request):
        return await call_next(request)
    return Response(
        status_code=401, content="Přihlaste se",
        headers={"WWW-Authenticate": 'Basic realm="GMaps Historie"'},
    )
