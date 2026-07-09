"""Řízení běhu procesu – čisté ukončení serveru zvenčí (tlačítko „Ukončit",
zavření okna). run.py si sem uloží instanci uvicorn serveru; endpoint
/api/shutdown a obsluha zavření konzole ji použijí k zastavení."""
from __future__ import annotations

import os
import threading

_server = None


def set_server(server) -> None:
    """Zavolá run.py po vytvoření uvicorn.Server."""
    global _server
    _server = server


def request_shutdown(delay: float = 0.4) -> None:
    """Požádá server o ukončení. Nejdřív korektně (uvicorn should_exit),
    a jako pojistka po chvíli tvrdě ukončí proces, aby aplikace vždy skončila
    (i kdyby drželo otevřené spojení prohlížeče)."""
    if _server is not None:
        _server.should_exit = True

    def _finish() -> None:
        import time
        time.sleep(delay + 1.6)
        os._exit(0)   # jistota, že .exe opravdu skončí

    threading.Thread(target=_finish, daemon=True).start()
