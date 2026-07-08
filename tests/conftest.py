import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DISABLE_BACKGROUND"] = "1"

from app import db  # noqa: E402
from tests.fixtures import (  # noqa: E402, F401 – re-export pro testy
    HOME,
    WORK,
    iso,
    make_records,
    make_semantic,
    make_takeout_zip,
    make_timeline_android,
)


@pytest.fixture
def test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setattr(db, "_schema_done", False)
    return db


@pytest.fixture
def client(test_db):
    from fastapi.testclient import TestClient

    from app.main import app
    with TestClient(app) as c:
        yield c
