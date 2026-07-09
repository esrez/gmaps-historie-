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
