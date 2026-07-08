"""Routery API."""
from .backup import router as backup_router
from .export import router as export_router
from .import_ import router as import_router
from .map_data import router as map_data_router
from .pages import router as pages_router
from .profiles import router as profiles_router
from .quality import router as quality_router
from .stats import router as stats_router
from .sync import router as sync_router

__all__ = [
    "backup_router", "export_router", "import_router", "map_data_router",
    "pages_router", "profiles_router", "quality_router", "stats_router", "sync_router",
]
