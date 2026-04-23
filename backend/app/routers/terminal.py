import asyncio
import json
import logging
import os
import base64

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import DATA_ROOT, SHELL
from ..core.pty_session import PtySession

router = APIRouter()
log = logging.getLogger(__name__)


@router.websocket("/api/console/terminal")
async def terminal(ws: WebSocket):
    await ws.accept()
    cols = int(ws.query_params.get("cols", 80))
    rows = int(ws.query_params.get("rows", 24))

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    env = os.environ.copy()
    env.setdefault("HOME", str(DATA_ROOT))
    env["PS1"] = env.get("PS1", r"\u@hermes:\w\$ ")

    session = PtySession([SHELL, "-l"], cwd=str(DATA_ROOT), env=env, cols=cols, rows=rows)

    def on_output(data: bytes) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, data)

    def on_exit(_code: int) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, None)

    try:
        await session.start(on_output=on_output, on_exit=on_exit)
    except Exception as e:
        await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        await ws.close()
        return

    async def pump_out():
        while True:
            data = await queue.get()
            if data is None:
                await ws.send_text(json.dumps({"type": "exit"}))
                return
            await ws.send_text(json.dumps({
                "type": "output",
                "data": base64.b64encode(data).decode("ascii"),
            }))

    async def pump_in():
        while True:
            msg = await ws.receive_text()
            try:
                parsed = json.loads(msg)
            except json.JSONDecodeError:
                continue
            t = parsed.get("type")
            if t == "input":
                data = parsed.get("data", "")
                session.write(data.encode("utf-8"))
            elif t == "resize":
                session.resize(int(parsed.get("cols", 80)), int(parsed.get("rows", 24)))

    out_task = asyncio.create_task(pump_out())
    in_task = asyncio.create_task(pump_in())
    try:
        done, pending = await asyncio.wait(
            {out_task, in_task}, return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        session.close()
        try:
            await ws.close()
        except RuntimeError:
            pass
