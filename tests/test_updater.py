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
