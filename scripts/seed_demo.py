"""Naplní databázi syntetickými demo daty (pro e2e testy a vyzkoušení UI).

Použití: DB_PATH=data/demo.db python scripts/seed_demo.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import importer  # noqa: E402
from tests.fixtures import make_timeline_android  # noqa: E402


def main():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        from pathlib import Path
        src = make_timeline_android(Path(tmp) / "demo.json", days=40)  # ~2 měsíce
        c = importer.import_path(str(src))
        print(f"Demo data: {c.points} bodů, {c.visits} návštěv, {c.activities} aktivit")


if __name__ == "__main__":
    main()
