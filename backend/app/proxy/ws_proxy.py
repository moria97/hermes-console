"""WebSocket proxy → hermes gateway. Bidirectional byte/text pump."""
import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from ..config import HERMES_WS_URL

router = APIRouter()
log = logging.getLogger(__name__)


@router.websocket("/api/hermes/ws/{path:path}")
async def hermes_ws_proxy(client: WebSocket, path: str):
    await client.accept()
    upstream_url = f"{HERMES_WS_URL.rstrip('/')}/{path}"
    try:
        async with ws_connect(upstream_url, max_size=None) as upstream:

            async def client_to_upstream():
                try:
                    while True:
                        msg = await client.receive()
                        if msg["type"] == "websocket.disconnect":
                            await upstream.close()
                            return
                        if "bytes" in msg and msg["bytes"] is not None:
                            await upstream.send(msg["bytes"])
                        elif "text" in msg and msg["text"] is not None:
                            await upstream.send(msg["text"])
                except (WebSocketDisconnect, ConnectionClosed):
                    pass

            async def upstream_to_client():
                try:
                    async for msg in upstream:
                        if isinstance(msg, bytes):
                            await client.send_bytes(msg)
                        else:
                            await client.send_text(msg)
                except ConnectionClosed:
                    pass

            done, pending = await asyncio.wait(
                {asyncio.create_task(client_to_upstream()),
                 asyncio.create_task(upstream_to_client())},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    except Exception as e:
        log.warning("ws proxy error: %s", e)
    finally:
        try:
            await client.close()
        except RuntimeError:
            pass
