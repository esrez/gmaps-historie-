"""Autentizace: HTTP Basic + volitelná session cookie (lokální nasazení).

Sessions se ukládají do souboru, takže přežijí restart i aktualizaci aplikace
(uživatel se nemusí po každém updatu znovu přihlašovat). Expirované se
promazávají. Přihlášení má jednoduchou brzdu proti hádání hesla.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time

from fastapi import Request, Response

from .config import AUTH_PASSWORD, SESSION_MAX_AGE

# sessions leží mimo profil (globálně), ať platí i po přepnutí profilu
_SESSION_FILE = os.path.join(os.environ.get("DATA_DIR") or "data", "auth_sessions.json")
_lock = threading.Lock()


def _load_sessions() -> dict[str, float]:
    try:
        with open(_SESSION_FILE, encoding="utf-8") as f:
            data = json.load(f)
        now = time.time()
        return {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > now}
    except Exception:
        return {}


_sessions: dict[str, float] = _load_sessions()


def _persist() -> None:
    try:
        os.makedirs(os.path.dirname(_SESSION_FILE) or ".", exist_ok=True)
        tmp = _SESSION_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_sessions, f)
        os.replace(tmp, _SESSION_FILE)
    except Exception:
        pass


def _prune() -> None:
    now = time.time()
    for k in [k for k, v in _sessions.items() if v < now]:
        _sessions.pop(k, None)


def _session_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(response: Response, secure: bool = False) -> str:
    token = _session_token()
    with _lock:
        _prune()
        _sessions[_hash_token(token)] = time.time() + SESSION_MAX_AGE
        _persist()
    # secure=True při HTTPS (i za reverse proxy) – cookie neunikne přes HTTP
    response.set_cookie(
        "gmaps_session", token, httponly=True, samesite="lax",
        max_age=SESSION_MAX_AGE, path="/", secure=secure,
    )
    return token


def _valid_session(request: Request) -> bool:
    token = request.cookies.get("gmaps_session", "")
    if not token:
        return False
    key = _hash_token(token)
    exp = _sessions.get(key)
    if exp is None or exp < time.time():
        if exp is not None:
            with _lock:
                _sessions.pop(key, None)
                _persist()
        return False
    return True


# --- brzda proti hádání hesla (v paměti, per IP) -------------------------
_LOGIN_WINDOW = 300      # 5 minut
_LOGIN_MAX_FAILS = 8
_login_fails: dict[str, list[float]] = {}


def login_allowed(ip: str) -> bool:
    now = time.time()
    # promazání ostatních IP, ať slovník neroste donekonečna
    if len(_login_fails) >= 1000:
        for k in [k for k, v in _login_fails.items()
                  if not v or now - v[-1] >= _LOGIN_WINDOW]:
            _login_fails.pop(k, None)
    fails = [t for t in _login_fails.get(ip, []) if now - t < _LOGIN_WINDOW]
    _login_fails[ip] = fails
    return len(fails) < _LOGIN_MAX_FAILS


def note_login_fail(ip: str) -> None:
    _login_fails.setdefault(ip, []).append(time.time())


def note_login_ok(ip: str) -> None:
    _login_fails.pop(ip, None)


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
