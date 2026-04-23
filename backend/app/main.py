import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

from .config import STATIC_DIR
from .proxy import http_proxy, ws_proxy
from .routers import files, health, settings, terminal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Hermes Console", version="0.1.0")

# API routers first — SPA fallback is last.
app.include_router(health.router)
app.include_router(files.router)
app.include_router(settings.router)
app.include_router(terminal.router)
app.include_router(http_proxy.router)
app.include_router(ws_proxy.router)


# Kill-switch for any Service Worker cached from a previous app at this origin
# (hermes-workspace v2 PWA). Browsers periodically re-fetch the SW file; when
# they see this noop-then-unregister script, they install it and self-destruct.
_SW_KILL_SWITCH = """// hermes-console SW kill-switch (stale PWA cleanup).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url));
    } catch (_) {}
  })());
});
self.addEventListener('fetch', () => { /* pass through */ });
"""

_SW_KILL_PATHS = ("/sw.js", "/service-worker.js", "/registerSW.js", "/workbox-sw.js")

for _p in _SW_KILL_PATHS:
    def _make(path=_p):
        @app.get(path, include_in_schema=False)
        async def _kill():
            return PlainTextResponse(
                _SW_KILL_SWITCH,
                media_type="application/javascript",
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Service-Worker-Allowed": "/",
                },
            )
        return _kill
    _make()


# SPA static mount with history fallback.
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets") if (STATIC_DIR / "assets").exists() else None

    # Paths that are NEVER the SPA — even if the specific method/route
    # didn't match an API router, we 404 instead of returning index.html.
    _API_PREFIXES = ("api/", "v1/", "responses/", "admin/")
    _API_EXACT = {"health"}

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str, request: Request):
        if full_path.startswith(_API_PREFIXES) or full_path in _API_EXACT:
            return PlainTextResponse("not found", status_code=404)
        candidate = STATIC_DIR / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return PlainTextResponse("console UI not installed", status_code=503)
else:
    @app.get("/", include_in_schema=False)
    async def root():
        return PlainTextResponse(
            "Hermes Console backend is up but static frontend is missing. "
            f"Expected at {STATIC_DIR}.",
        )
