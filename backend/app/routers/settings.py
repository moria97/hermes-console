import asyncio
import logging
import os
import signal

import httpx
from fastapi import APIRouter, HTTPException

from ..config import HERMES_GATEWAY_PIDFILE, HERMES_GATEWAY_URL
from ..core import settings_store
from ..models.schemas import BailianConfig, ConsoleSettings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/console/settings", tags=["settings"])


@router.get("")
def get_settings() -> ConsoleSettings:
    return settings_store.load()


@router.put("")
def update_settings(body: ConsoleSettings) -> ConsoleSettings:
    # settings_store.save() writes config.yaml + .env via hermes_config —
    # the old separate console-ui.yaml is gone. No second sync needed.
    try:
        return settings_store.save(body)
    except Exception as e:
        raise HTTPException(500, f"failed to persist settings: {e}")


@router.post("/test-bailian")
async def test_bailian(cfg: BailianConfig):
    """Ping the Bailian endpoint with the supplied key; report reachable + models count."""
    if not cfg.api_key:
        raise HTTPException(400, "api_key required")
    url = f"{cfg.base_url.rstrip('/')}/models"
    async with httpx.AsyncClient(timeout=10.0) as c:
        try:
            r = await c.get(url, headers={"Authorization": f"Bearer {cfg.api_key}"})
        except httpx.HTTPError as e:
            raise HTTPException(502, f"unreachable: {e}")
    if not r.is_success:
        raise HTTPException(r.status_code, r.text[:500])
    data = r.json()
    models = [m.get("id") for m in data.get("data", [])]
    return {"ok": True, "models": models[:50]}


async def _wait_gateway_health(timeout_s: float = 30.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout_s
    async with httpx.AsyncClient(timeout=2.0) as c:
        while asyncio.get_running_loop().time() < deadline:
            try:
                r = await c.get(f"{HERMES_GATEWAY_URL}/health")
                if r.is_success:
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
    return False


async def _read_pid() -> int | None:
    """Pidfile may be plain digits or JSON `{"pid": N, ...}`."""
    try:
        raw = HERMES_GATEWAY_PIDFILE.read_text().strip()
    except OSError:
        return None
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        import json
        data = json.loads(raw)
        pid = data.get("pid") if isinstance(data, dict) else None
        return int(pid) if pid else None
    except (ValueError, TypeError):
        return None


async def _wait_pid_exit(pid: int, timeout_s: float = 10.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout_s
    while asyncio.get_running_loop().time() < deadline:
        try:
            os.kill(pid, 0)  # still alive
        except (ProcessLookupError, PermissionError):
            return True
        await asyncio.sleep(0.2)
    return False


@router.post("/reload-gateway")
async def reload_gateway():
    """Terminate the current gateway via its pidfile; the supervisor loop
    in start.sh respawns it with the updated config.yaml + .env."""
    pid = await _read_pid()
    if pid is None:
        raise HTTPException(503, "gateway pidfile not found")

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        # Already dead; the supervisor should be bringing up a fresh one.
        pass
    except PermissionError as e:
        raise HTTPException(500, f"cannot signal gateway pid={pid}: {e}")

    log.info("sent SIGTERM to gateway pid=%s", pid)

    exited = await _wait_pid_exit(pid, timeout_s=10.0)
    if not exited:
        raise HTTPException(504, f"gateway pid={pid} did not exit within 10s")

    ready = await _wait_gateway_health(timeout_s=45.0)
    if not ready:
        raise HTTPException(504, "gateway restarted but /health did not come back within 45s")

    new_pid = await _read_pid()
    return {"reloaded": True, "old_pid": pid, "new_pid": new_pid}
