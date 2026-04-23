"""Transparent HTTP proxy → hermes gateway, SSE-safe."""
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..config import HERMES_DASHBOARD_URL, HERMES_GATEWAY_URL

router = APIRouter()

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

# Headers stripped before forwarding to the gateway. `origin` / `referer` are
# dropped because hermes's api_server has a CSRF guard that rejects any
# browser-cross-origin request — but our proxy is a trusted loopback client,
# so passing the browser's Origin through is meaningless and causes 403s.
REQUEST_STRIP = HOP_BY_HOP | {"origin", "referer", "cookie"}


async def _proxy(upstream_base: str, path: str, request: Request) -> StreamingResponse:
    upstream = f"{upstream_base.rstrip('/')}/{path}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in REQUEST_STRIP}

    client = httpx.AsyncClient(timeout=None)
    req = client.build_request(
        request.method, upstream,
        headers=headers,
        content=request.stream(),
        params=request.query_params,
    )
    resp = await client.send(req, stream=True)

    resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP_BY_HOP}

    async def body_iter():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        body_iter(),
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get("content-type"),
    )


# Hermes-native paths — forwarded to the gateway at their original URLs so
# the frontend can use the same paths OpenAI-compatible clients would.
# Registered BEFORE the SPA fallback in main.py so they take precedence.

_GATEWAY_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]


@router.api_route("/v1/{path:path}", methods=_GATEWAY_METHODS)
async def gateway_v1(path: str, request: Request):
    return await _proxy(HERMES_GATEWAY_URL, f"v1/{path}", request)


@router.api_route("/health", methods=_GATEWAY_METHODS)
async def gateway_health(request: Request):
    return await _proxy(HERMES_GATEWAY_URL, "health", request)


@router.api_route("/responses/{path:path}", methods=_GATEWAY_METHODS)
async def gateway_responses(path: str, request: Request):
    return await _proxy(HERMES_GATEWAY_URL, f"responses/{path}", request)


# Dashboard stays behind an explicit prefix so it doesn't collide with
# `/api/console/*`. Register on main.py AFTER console routers.
@router.api_route("/api/dashboard/{path:path}", methods=_GATEWAY_METHODS)
async def dashboard_proxy(path: str, request: Request):
    return await _proxy(HERMES_DASHBOARD_URL, path, request)
