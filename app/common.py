"""Sdílené pomocné funkce pro API moduly."""
from __future__ import annotations

import io
import math
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi.responses import Response

# Lokální časová zóna serveru (v Dockeru nastavená přes TZ v docker-compose).
# Používá se pro převod unix časů na lokální datum/čas včetně letního času –
# pevný minutový offset od klienta by u historických dat přes hranici DST lhal.
LOCAL_TZ = ZoneInfo(os.environ.get("TZ") or "Europe/Prague")

MAX_TS = 2**53


def ts_range(from_ts: int | None, to_ts: int | None) -> tuple[int, int]:
    return (from_ts if from_ts is not None else 0,
            to_ts if to_ts is not None else MAX_TS)


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def local_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, LOCAL_TZ)


def fmt_dt(ts: int | None) -> datetime | None:
    """Naivní lokální datetime pro zápis do Excelu."""
    if ts is None:
        return None
    return local_dt(ts).replace(tzinfo=None)


def xlsx_response(wb, filename: str) -> Response:
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def sheet(wb, title: str, headers: list, rows, widths: list | None = None):
    from openpyxl.styles import Font
    ws = wb.create_sheet(title)
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    for i, w in enumerate(widths or []):
        ws.column_dimensions[chr(ord("A") + i)].width = w
    ws.freeze_panes = "A2"
    return ws
