"""Testy vestavěného aktualizátoru."""
import json
import zipfile

from app.core.updater import (
    apply_update_zip,
    parse_version,
    read_install_config,
    write_install_config,
)


def test_parse_version():
    assert parse_version("2.0.0") > parse_version("1.9.9")
    assert parse_version("2.0") == (2, 0)


def test_install_config_roundtrip(tmp_path):
    write_install_config("2.0.0", "http://example.com/api/update", tmp_path)
    cfg = read_install_config(tmp_path)
    assert cfg["version"] == "2.0.0"
    assert cfg["update_url"] == "http://example.com/api/update"


def test_apply_update_zip(tmp_path):
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "GMapsHistorie.exe").write_bytes(b"old")
    write_install_config("1.0.0", "", app_dir)

    pkg_dir = tmp_path / "pkg"
    pkg_dir.mkdir()
    (pkg_dir / "dist").mkdir()
    (pkg_dir / "dist" / "GMapsHistorie.exe").write_bytes(b"new")
    (pkg_dir / "version.json").write_text(json.dumps({"release": "2.0.0"}), encoding="utf-8")

    with zipfile.ZipFile(tmp_path / "u.zip", "w") as zf:
        zf.write(pkg_dir / "dist" / "GMapsHistorie.exe", "dist/GMapsHistorie.exe")
        zf.write(pkg_dir / "version.json", "version.json")

    names = apply_update_zip(tmp_path / "u.zip", app_dir)
    assert "GMapsHistorie.exe" in names
    assert (app_dir / "GMapsHistorie.exe").read_bytes() == b"new"
    assert read_install_config(app_dir)["version"] == "2.0.0"


def test_run_update_downloads_and_applies(tmp_path, monkeypatch):
    """Celý tok aktualizace: meta → stažení balíku → instalace → verze."""
    import io
    import json
    import zipfile
    from contextlib import contextmanager

    from app.core import updater

    app_dir = tmp_path / "instalace"
    app_dir.mkdir()
    updater.write_install_config("1.0.0", "http://server/api/update", app_dir)

    pkg = io.BytesIO()
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("version.json", json.dumps({"release": "9.9.9"}))
        zf.writestr("dist/GMapsHistorie.exe", "EXE")

    responses = {
        "http://server/api/update": json.dumps(
            {"current": "9.9.9", "package_url": "/api/update/package"}).encode(),
        "http://server/api/update/package": pkg.getvalue(),
    }

    @contextmanager
    def fake_urlopen(url, timeout=0):
        yield io.BytesIO(responses[url])

    monkeypatch.setattr(updater.urllib.request, "urlopen", fake_urlopen)
    assert updater.run_update(app_dir, quiet=True) == 0
    assert (app_dir / "GMapsHistorie.exe").read_text() == "EXE"
    assert updater.read_install_config(app_dir)["version"] == "9.9.9"
    # druhé spuštění: už aktuální → 2
    assert updater.run_update(app_dir, quiet=True) == 2


def test_download_exe_checks(tmp_path, monkeypatch):
    """Stažení exe: kontrola velikosti dle vydání a MZ hlavičky."""
    import io
    from contextlib import contextmanager

    from app.core import updater

    payload = b"MZ" + b"\0" * updater.MIN_EXE_SIZE

    @contextmanager
    def fake_urlopen(req, timeout=0):
        yield io.BytesIO(payload)

    monkeypatch.setattr(updater.urllib.request, "urlopen", fake_urlopen)
    dest = tmp_path / "GMapsHistorie-new.exe"
    updater.download_exe("http://x/exe", dest, len(payload))
    assert dest.stat().st_size == len(payload)

    # nesouhlasí velikost udávaná vydáním → chyba a nic nezůstane
    import pytest
    with pytest.raises(ValueError, match="vydání udává"):
        updater.download_exe("http://x/exe", dest.with_name("b.exe"), 123)
    assert not dest.with_name("b.exe").exists()

    # není to PE soubor (chybí MZ)
    payload_bad = b"#!" + b"\0" * updater.MIN_EXE_SIZE
    monkeypatch.setattr(updater.urllib.request, "urlopen",
                        lambda req, timeout=0: _ctx(io.BytesIO(payload_bad)))
    with pytest.raises(ValueError, match="spustitelný"):
        updater.download_exe("http://x/exe", dest.with_name("c.exe"), None)


def _ctx(obj):
    from contextlib import contextmanager

    @contextmanager
    def cm():
        yield obj
    return cm()


def test_spawn_swap_helper_writes_bat(tmp_path, monkeypatch):
    """Pomocný skript: čeká na PID, prohodí exe a novou verzi spustí."""
    import subprocess

    from app.core import updater
    calls = {}
    monkeypatch.setattr(subprocess, "Popen",
                        lambda *a, **kw: calls.update(args=a, kw=kw))
    updater.spawn_swap_helper(tmp_path, 4242)
    bat = tmp_path / "gmaps-aktualizace.bat"
    assert bat.exists()
    text = bat.read_text(encoding="ascii")
    assert "PID eq 4242" in text
    assert 'move /y "GMapsHistorie-new.exe" "GMapsHistorie.exe"' in text
    assert 'start "" "GMapsHistorie.exe"' in text
    assert calls["args"][0][:2] == ["cmd", "/c"]


def test_find_exe_asset():
    from app.core import updater
    rel = {"assets": [
        {"name": "update.zip", "browser_download_url": "http://x/z", "size": 5},
        {"name": "GMapsHistorie.exe", "browser_download_url": "http://x/e", "size": 42},
    ]}
    assert updater.find_exe_asset(rel) == {"url": "http://x/e", "size": 42}
    assert updater.find_exe_asset({"assets": []}) is None
