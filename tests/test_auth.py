"""Autentizace: brzda proti hádání hesla + persistence sessions."""
import importlib
import time


def test_login_rate_limit():
    from app.core import auth
    ip = "10.0.0.1"
    auth._login_fails.pop(ip, None)
    assert auth.login_allowed(ip)
    for _ in range(auth._LOGIN_MAX_FAILS):
        auth.note_login_fail(ip)
    assert not auth.login_allowed(ip)          # po limitu blokováno
    auth.note_login_ok(ip)                      # úspěch limit vynuluje
    assert auth.login_allowed(ip)


def test_sessions_persist_across_reload(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from app.core import auth
    importlib.reload(auth)                      # znovu načíst s novým DATA_DIR

    class _Resp:
        def __init__(self):
            self.cookie = None

        def set_cookie(self, name, value, **kw):
            self.cookie = value

    r = _Resp()
    token = auth.create_session(r)
    assert r.cookie == token
    assert (tmp_path / "auth_sessions.json").exists()

    # nová instance modulu (jako po restartu) session najde
    auth2 = importlib.reload(auth)
    assert auth._hash_token(token) in auth2._sessions


def test_expired_sessions_pruned(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from app.core import auth
    importlib.reload(auth)
    auth._sessions["stary"] = time.time() - 10   # už expirovaná
    auth._prune()
    assert "stary" not in auth._sessions


def test_middleware_basic_and_login_cookie(tmp_path, monkeypatch):
    """S nastaveným heslem: 401 bez přihlášení, Basic auth i session cookie."""
    from fastapi.testclient import TestClient

    from app import db
    from app.core import auth
    from app.main import app
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setattr(db, "_schema_done", False)
    monkeypatch.setattr(auth, "AUTH_PASSWORD", "tajne-heslo")
    monkeypatch.setattr("app.routers.pages.AUTH_PASSWORD", "tajne-heslo")
    monkeypatch.setattr(auth, "_SESSION_FILE", str(tmp_path / "sessions.json"))
    monkeypatch.setattr(auth, "_sessions", {})
    monkeypatch.setattr(auth, "_login_fails", {})

    with TestClient(app) as c:
        assert c.get("/api/range").status_code == 401
        # výjimky ze zámku: version a login samotný
        assert c.get("/api/version").status_code == 200
        # HTTP Basic (jméno je libovolné)
        assert c.get("/api/range", auth=("kdokoli", "tajne-heslo")).status_code == 200
        assert c.get("/api/range", auth=("x", "spatne")).status_code == 401
        # login nastaví cookie a ta pak platí sama o sobě
        r = c.post("/api/login", json={"password": "tajne-heslo"})
        assert r.status_code == 200 and "gmaps_session" in r.cookies
        assert c.get("/api/range").status_code == 200
