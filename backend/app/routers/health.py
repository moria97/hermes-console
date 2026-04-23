import httpx
from fastapi import APIRouter

from ..config import HERMES_DASHBOARD_URL, HERMES_GATEWAY_URL

router = APIRouter(prefix="/api/console", tags=["health"])


@router.get("/health")
async def health():
    out = {"console": "ok", "gateway": "unknown", "dashboard": "unknown"}
    async with httpx.AsyncClient(timeout=2.0) as c:
        try:
            r = await c.get(f"{HERMES_GATEWAY_URL}/health")
            out["gateway"] = "ok" if r.is_success else f"http {r.status_code}"
        except Exception as e:
            out["gateway"] = f"down: {type(e).__name__}"
        try:
            r = await c.get(f"{HERMES_DASHBOARD_URL}/api/status")
            out["dashboard"] = "ok" if r.is_success else f"http {r.status_code}"
        except Exception as e:
            out["dashboard"] = f"down: {type(e).__name__}"
    return out
