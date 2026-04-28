"""Transparent HTTP proxy → hermes gateway, SSE-safe."""
import re

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ..config import HERMES_API_KEY, HERMES_DASHBOARD_URL, HERMES_GATEWAY_URL

router = APIRouter()

# When the upstream is mid-restart we get ConnectError / ConnectTimeout from
# httpx because the listener isn't up yet. Surface a deliberate 503 + JSON
# body instead of letting FastAPI's default exception handler turn it into a
# generic 500 — the frontend can then show a friendly "请稍候" message.
GATEWAY_RESTART_MSG = "网关重启中，请稍候…"
_RESTART_EXC = (httpx.ConnectError, httpx.ConnectTimeout)

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

# Headers stripped before forwarding to the gateway. `origin` / `referer` are
# dropped because hermes's api_server has a CSRF guard that rejects any
# browser-cross-origin request — but our proxy is a trusted loopback client,
# so passing the browser's Origin through is meaningless and causes 403s.
REQUEST_STRIP = HOP_BY_HOP | {"origin", "referer", "cookie"}


async def _proxy(upstream_base: str, path: str, request: Request):
    upstream = f"{upstream_base.rstrip('/')}/{path}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in REQUEST_STRIP}
    # Auto-attach the gateway API key on hermes-bound requests. Required for
    # X-Hermes-Session-Id continuation (hermes refuses to load session history
    # without an authenticated bearer). Always overrides whatever the browser
    # might have sent.
    if upstream_base == HERMES_GATEWAY_URL and HERMES_API_KEY:
        headers["authorization"] = f"Bearer {HERMES_API_KEY}"

    client = httpx.AsyncClient(timeout=None)
    req = client.build_request(
        request.method, upstream,
        headers=headers,
        content=request.stream(),
        params=request.query_params,
    )
    try:
        resp = await client.send(req, stream=True)
    except _RESTART_EXC:
        await client.aclose()
        return JSONResponse(
            {"detail": GATEWAY_RESTART_MSG},
            status_code=503,
            headers={"Retry-After": "3"},
        )
    except httpx.HTTPError as e:
        await client.aclose()
        return JSONResponse(
            {"detail": f"网关连接失败: {e}"},
            status_code=502,
        )

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

# Rewrite `src="/foo"` / `href="/foo"` (but skip `/api/dashboard/...`) so the
# dashboard SPA's hardcoded asset paths resolve through this proxy when it's
# wrapped in an iframe at our origin.
_DASH_ABS_PATH_RE = re.compile(
    r'((?:src|href)\s*=\s*")(/(?!api/dashboard/)(?!//)[^"]*)"'
)

# Injected ahead of the dashboard's main bundle: wraps fetch/XHR so any
# absolute /api/* path the dashboard JS calls at runtime is rerouted through
# the /api/dashboard/ prefix that this proxy actually forwards.
_DASH_FETCH_SHIM = """<script>(function(){
var PFX='/api/dashboard';
function rw(u){
  if(typeof u!=='string')return u;
  if(u.charAt(0)==='/'&&u.indexOf(PFX)!==0&&u.charAt(1)!=='/')return PFX+u;
  return u;
}
var of=window.fetch;
window.fetch=function(input,init){
  if(typeof input==='string')input=rw(input);
  else if(input&&typeof Request!=='undefined'&&input instanceof Request){
    try{
      var url=new URL(input.url);
      if(url.origin===window.location.origin){
        var p=url.pathname+url.search+url.hash;
        var rp=rw(p);
        if(rp!==p)input=new Request(window.location.origin+rp,input);
      }
    }catch(e){}
  }
  return of.call(this,input,init);
};
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  var args=Array.prototype.slice.call(arguments,2);
  return oo.apply(this,[m,rw(u)].concat(args));
};
})();</script>"""


def _rewrite_dashboard_html(body: bytes) -> bytes:
    text = body.decode("utf-8", errors="replace")
    text = _DASH_ABS_PATH_RE.sub(r'\1/api/dashboard\2"', text)
    # Slip the shim in right after <head>; it must run before the bundled
    # main script so fetch is wrapped before the dashboard issues calls.
    text = text.replace("<head>", "<head>" + _DASH_FETCH_SHIM, 1)
    return text.encode("utf-8")


@router.api_route("/api/dashboard/{path:path}", methods=_GATEWAY_METHODS)
async def dashboard_proxy(path: str, request: Request):
    # For HTML responses (the dashboard root + any pushState fallbacks),
    # buffer + rewrite. Everything else streams as-is via _proxy().
    if request.method.upper() not in {"GET", "HEAD"}:
        return await _proxy(HERMES_DASHBOARD_URL, path, request)

    upstream = f"{HERMES_DASHBOARD_URL.rstrip('/')}/{path}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in REQUEST_STRIP}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(upstream, headers=headers, params=request.query_params)
    except _RESTART_EXC:
        return JSONResponse(
            {"detail": GATEWAY_RESTART_MSG}, status_code=503,
            headers={"Retry-After": "3"},
        )
    except httpx.HTTPError as e:
        return JSONResponse({"detail": f"dashboard 连接失败: {e}"}, status_code=502)

    content_type = (r.headers.get("content-type") or "").lower()
    resp_headers = {k: v for k, v in r.headers.items() if k.lower() not in HOP_BY_HOP}

    if "text/html" in content_type:
        body = _rewrite_dashboard_html(r.content)
        # content-length will be wrong post-rewrite — drop it; FastAPI's
        # Response will compute the right one for the new body.
        resp_headers.pop("content-length", None)
        return Response(
            content=body, status_code=r.status_code,
            headers=resp_headers, media_type=content_type,
        )
    return Response(
        content=r.content, status_code=r.status_code,
        headers=resp_headers, media_type=content_type or None,
    )
