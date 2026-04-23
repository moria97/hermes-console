import re
import subprocess
from functools import lru_cache

import httpx
from fastapi import APIRouter

from ..config import HERMES_DASHBOARD_URL, HERMES_GATEWAY_URL

router = APIRouter(prefix="/api/console", tags=["health"])


@lru_cache(maxsize=1)
def _hermes_version() -> dict[str, str]:
    """Shell out to `hermes --version` once and cache the parsed bits.
    Typical output: 'Hermes Agent v0.10.0 (2026.4.16)'."""
    try:
        r = subprocess.run(
            ["hermes", "--version"],
            capture_output=True, text=True, timeout=5,
        )
        raw = (r.stdout or r.stderr or "").strip()
    except Exception:
        return {"raw": "", "version": "", "build": ""}
    # Pull out "vX.Y.Z" and the "(YYYY.M.D)" build date if present.
    m_ver = re.search(r"v\d+\.\d+\.\d+(?:\.\d+)?", raw)
    m_build = re.search(r"\(([^)]+)\)", raw)
    return {
        "raw": raw,
        "version": m_ver.group(0) if m_ver else "",
        "build": m_build.group(1) if m_build else "",
    }


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


@router.get("/version")
async def version():
    """Return hermes-agent version info (cached). Frontend fetches once
    on app mount to render the build badge in the header."""
    return _hermes_version()
