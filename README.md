# hermes-console

Single-image control panel for `hermes-agent`. One container runs the hermes
gateway, the hermes dashboard, a FastAPI backend, and a React SPA that
replaces the upstream `hermes-workspace` v2 UI.

- **UI (SPA + API)** → port `8000`
- **Hermes gateway** → port `8642` (loopback only)
- **Hermes dashboard** → port `9119` (loopback only)

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Directory layout](#directory-layout)
- [Runtime data layout](#runtime-data-layout)
- [Configuration flow](#configuration-flow)
- [Hot reload](#hot-reload)
- [**Hidden issues & gotchas**](#hidden-issues--gotchas) ← 真正有价值的部分

---

## Quick start

```bash
docker build -t hermes-console:latest .
docker run -d --name hermes-console --restart unless-stopped \
  -p 8000:8000 \
  -v hermes-console-data:/mnt/data \
  hermes-console:latest
```

Open `http://<host>:8000`. On first run, go to **设置 → 百炼**, paste your
DashScope API Key, pick an endpoint preset, click 刷新 to load models, pick a
default model, save. The save handler writes `config.yaml` + `.env` and hot-
reloads the gateway via its pidfile.

---

## Architecture

```
┌─────────────────────────── container ───────────────────────────┐
│  tini → start.sh (supervisor)                                   │
│    ├─ hermes gateway run       ← pidfile in respawn loop        │
│    ├─ hermes dashboard                                          │
│    └─ uvicorn app.main:app     ← FastAPI on :8000               │
│                                                                 │
│  FastAPI app:                                                   │
│    /api/console/*         backend (settings, files, terminal)   │
│    /api/hermes/*          HTTP proxy → gateway :8642 (SSE-safe) │
│    /api/hermes/ws/*       WebSocket proxy → gateway             │
│    /api/dashboard/*       HTTP proxy → dashboard :9119          │
│    /                      SPA static + history fallback         │
│    /sw.js, /service-worker.js  SW kill-switch (see gotchas)     │
│                                                                 │
│  Static SPA (React + Vite + Monaco + xterm):                    │
│    聊天 / 文件 / 终端 / 设置                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Why no nginx?** A FastAPI app can do static hosting, SSE proxying, and
WebSocket proxying in ~200 lines, and the console is single-user. If you ever
need HTTPS or multi-tenant fanout, put Caddy/Traefik in front of the console
backend — cleaner than running three services inside.

**Why one image?** Starting console-ui + hermes-agent + dashboard as a
docker-compose stack means three sets of config, three health checks, and
cross-container networking. One image is easier to ship and debug. The
tradeoff is a ~5GB image (hermes-agent base is ~5GB).

---

## Directory layout

```
hermes-console/
├── Dockerfile                  multi-stage: frontend (node+pnpm) → runtime (agent+python)
├── start.sh                    supervisor; gateway respawn loop
├── README.md                   ← you are here
│
├── backend/                    FastAPI (Python 3.13)
│   ├── requirements.txt
│   └── app/
│       ├── main.py             mounts routers + SPA + SW kill-switch
│       ├── config.py           HERMES_HOME, DATA_ROOT, endpoint URLs
│       ├── proxy/
│       │   ├── http_proxy.py   /api/hermes/* SSE-safe pass-through
│       │   └── ws_proxy.py     /api/hermes/ws/* bidirectional pump
│       ├── routers/
│       │   ├── health.py       /api/console/health
│       │   ├── files.py        tree / read / write / mkdir / delete
│       │   ├── terminal.py     /api/console/terminal (WS + PTY)
│       │   └── settings.py     GET/PUT settings, test-bailian, reload-gateway
│       ├── core/
│       │   ├── settings_store.py   /mnt/data/.hermes/console-ui.yaml
│       │   ├── hermes_config.py    sync to config.yaml + platforms + .env
│       │   └── pty_session.py      pure-asyncio PTY (loop.add_reader)
│       └── models/schemas.py   pydantic
│
└── frontend/                   React + Vite + TS
    ├── package.json
    ├── vite.config.ts          proxies /api + /ws to :8000 during dev
    ├── index.html              contains SW-cleanup inline script
    └── src/
        ├── main.tsx / App.tsx  tab shell
        ├── api.ts              fetch wrappers + types
        ├── styles.css          design tokens + component styles
        └── tabs/
            ├── ChatTab.tsx     SSE streaming + markdown + tool chips
            ├── FilesTab.tsx    Monaco + multi-tab editor
            ├── TerminalTab.tsx xterm + WebSocket PTY
            └── SettingsTab.tsx Bailian / 飞书 / 钉钉
```

---

## Runtime data layout

Named volume `hermes-console-data` mounts at `/mnt/data`:

```
/mnt/data/                       user workspace root (shell cwd, file tree root)
├── .bashrc                      seeded by start.sh (fixes PATH in web terminal)
└── .hermes/                     all hermes-agent state (HERMES_HOME)
    ├── config.yaml              provider + platforms + model config
    ├── .env                     DINGTALK_CLIENT_ID/SECRET + FEISHU_APP_ID/SECRET
    ├── console-ui.yaml          console settings (what SettingsTab saves)
    ├── sessions/, skills/, memories/, ...
    ├── gateway.pid              JSON: `{"pid": N, ...}` — used for hot reload
    └── ...
```

First boot migrates any legacy flat layout (old `HERMES_HOME=/mnt/data`) into
`.hermes/`.

---

## Configuration flow

UI **保存** in Settings → `PUT /api/console/settings`:

1. Validate + write `/mnt/data/.hermes/console-ui.yaml` (authoritative for UI)
2. `hermes_config.sync_providers()` does three things atomically:
   - **config.yaml** `custom_providers[]` (Bailian as OpenAI-compatible provider)
   - **config.yaml** `platforms.feishu.extra.{app_id,app_secret}` and
     `platforms.dingtalk.extra.{client_id,client_secret}`
   - **config.yaml** `model.{default, provider, base_url}` — overwrites the
     upstream default (which is `anthropic/claude-opus-4.6`)
   - **.env** — `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` /
     `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (see gotchas below for why env)
3. UI calls `POST /api/console/settings/reload-gateway` → SIGTERM the pidfile
   PID → supervisor respawns gateway with fresh config

---

## Hot reload

`start.sh` wraps `hermes gateway run` in a respawn loop; `/api/console/
settings/reload-gateway` reads `/mnt/data/.hermes/gateway.pid`, sends
`SIGTERM`, polls `/health` until the new process comes up (~30s).

The dashboard and console backend run outside the loop — changes to settings
don't restart them.

---

## Hidden issues & gotchas

All of these cost real debugging time. Keep reading before you refactor.

### 1. Old `hermes-workspace` v2 Service Worker survives in browsers

Previous tenants of `:8000` (the upstream `hermes-workspace` PWA) register a
Service Worker scoped to this origin. That SW survives even after you swap
containers, and intercepts all requests — including serving cached old HTML.
Symptoms:
- Network tab shows `GET /api/connection-status`, `/api/context-usage`,
  `/api/hermes-proxy/health` all 404
- User sees the old UI even when our new SPA is deployed

**Mitigations shipped:**
- `frontend/index.html` has an inline script that detects any registered SW,
  unregisters it, nukes all caches, and force-reloads once (guarded by
  `sessionStorage` to avoid loops)
- Backend serves a self-unregistering SW at `/sw.js`, `/service-worker.js`,
  `/registerSW.js`, `/workbox-sw.js` — browsers periodically re-fetch their
  registered SW; when they see this one, they install it and it auto-cleans

**When it still doesn't clear:** DevTools → Application → Service Workers →
Unregister + Storage → Clear site data, then hard refresh twice.

### 2. `crypto.randomUUID()` throws on HTTP

Secure-context-only API. If you access the UI via public IP over HTTP (not
`localhost` / `127.0.0.1` / HTTPS), calling `crypto.randomUUID()` throws
`TypeError`. Early versions had this in `newSession()`, silently crashing the
initial session creation → send button permanently grey.

**Fix in `ChatTab.tsx::randomId()`:** try `crypto.randomUUID` first, fall
back to `crypto.getRandomValues` + UUID v4 formatter, fall back to
`Math.random`. Covers HTTP, HTTPS, and deep insecure contexts.

If you add any new code that needs random IDs, use this helper or you'll
reintroduce the bug.

### 3. Hermes gateway's anti-CSRF rejects requests with `Origin` header

`hermes/gateway/platforms/api_server.py` refuses any request that carries an
`Origin` header. Browsers always send `Origin` on cross-origin requests. Our
proxy used to forward all headers → gateway returned 403 on every chat
completion from the SPA.

**Fix in `backend/app/proxy/http_proxy.py::REQUEST_STRIP`:** strips
`origin`, `referer`, `cookie` from the forwarded request. Our proxy is a
trusted loopback client, so browser CSRF metadata is meaningless past it.

If you ever add a new proxy route, make sure it reuses `REQUEST_STRIP`.

### 4. Dingtalk's requirement check reads env vars, not `config.yaml`

`gateway/platforms/dingtalk.py::check_dingtalk_requirements()` checks
`os.getenv("DINGTALK_CLIENT_ID")` / `DINGTALK_CLIENT_SECRET`. The adapter
itself prefers `extra.client_id` from `platforms.dingtalk.extra`, but the
requirement check runs **before** the adapter is instantiated. If the env
vars aren't set, hermes logs *"dingtalk-stream not installed or
DINGTALK_CLIENT_ID/SECRET not set"* and skips the platform entirely — even
with valid `platforms.dingtalk.extra` in config.yaml.

**Fix in `core/hermes_config.py::_sync_env()`:** mirror DINGTALK_* (and
FEISHU_*, defensively) into `~/.hermes/.env`. `hermes gateway run` loads
dotenv at boot, so the env vars are visible when the requirement check fires.

Managed entries in `.env` are fenced with a comment so repeated saves don't
duplicate them.

### 5. Feishu breaks DingTalk via global `websockets.connect` monkey-patch

Upstream `gateway/platforms/feishu.py::_run_official_feishu_ws_client`
assigns an `async def` wrapper onto **`ws_client_module.websockets.connect`**.
Because `ws_client_module.websockets` is a reference to the global
`websockets` module, this reassignment is process-global. While feishu is
running (even in a retry loop with fake credentials), any other library
using `async with websockets.connect(uri) as ws` — notably
`dingtalk-stream` — receives a coroutine and crashes:

```
TypeError: 'coroutine' object does not support the asynchronous
context manager protocol
```

**Fix in `Dockerfile`:** a build-time Python patch rewrites feishu.py's
`_connect_with_overrides` from `async def` (returning a coroutine) to a
sync `def` that returns the Connect object directly. A long comment at the
patched site explains the rationale — please don't remove it.

If upstream hermes fixes this, the patch's `if old not in src: skip` guard
will silently no-op and print a warning to the build log.

### 6. DashScope public endpoint returns stale model IDs

`/v1/models` on `dashscope.aliyuncs.com/compatible-mode/v1` includes old
model names (notably `qwen3-plus`, superseded by `qwen3.6-plus`).

**Fix in `SettingsTab.tsx::MODEL_DENY` and `ChatTab.tsx::MODEL_DENY`:**
client-side deny-list. Add names here if more stale IDs show up.

Token Plan and Coding Plan endpoints don't expose `/v1/models` at all; the
UI uses a static fallback list defined in `BAILIAN_PRESETS[*].staticModels`.

### 7. `hermes` binary isn't on PATH in the web terminal

The web terminal spawns `bash -l` (login shell). `/etc/profile` on Debian
unconditionally resets `PATH` to `/usr/local/sbin:/usr/local/bin:...`,
wiping the `/opt/hermes/.venv/bin` we set in uvicorn's env.

**Fix in `Dockerfile`:** `ln -sf /opt/hermes/.venv/bin/hermes
/usr/local/bin/hermes` so `hermes` is on the default PATH regardless.

**Fix in `start.sh`:** writes a `/mnt/data/.bashrc` that re-exports the
venv PATH + `HERMES_HOME`, so other tools from `/opt/hermes/.venv/bin` are
also reachable.

### 8. `set -e` kills the gateway respawn loop

`start.sh` used to start with `set -e`. When the console-ui hot-reload
endpoint sends SIGTERM to the gateway, `wait "$GW_CHILD"` returns non-zero,
and under `set -e` that propagates and terminates the respawn subshell.
Result: first reload works, every subsequent reload exits cleanly with
"Exit 1" and the gateway never comes back.

**Fix in `start.sh`:** no `set -e`. Explicit error handling everywhere. A
comment in the header explains why.

### 9. `gateway.pid` is JSON, not a plain integer

Upstream hermes writes `{"pid": N, "kind": "hermes-gateway", "argv": [...],
"start_time": ...}` (pretty-printed JSON). Any code reading this file has
to handle both plain-integer and JSON shapes.

**Fix in `backend/app/routers/settings.py::_read_pid()` and
`start.sh::cleanup()`:** detect the format, parse accordingly.

### 10. Gateway refuses to bind `0.0.0.0` without `API_SERVER_KEY`

By default `API_SERVER_HOST=0.0.0.0` forces hermes's safety gate on, and
it refuses to start:
*"Refusing to start: binding to 0.0.0.0 requires API_SERVER_KEY."*

**Fix in `Dockerfile` + `start.sh`:** bind to `127.0.0.1` inside the
container; the FastAPI proxy is the only client. If you ever need to
expose the gateway directly to the host network, set `API_SERVER_KEY`
and flip `API_SERVER_HOST=0.0.0.0`.

### 11. Upstream `dist/server/server.js` is not runnable

Earlier iterations tried to build on upstream `hermes-workspace` v2 and run
`node dist/server/server.js` (as upstream's own Dockerfile CMD does). That
file only exports handler factories — it never calls `.listen()`. Running
it makes node exit silently with code 0. The upstream prebuilt ghcr image
is bitten by the same issue on current `main`.

**Consequence:** we don't depend on `hermes-workspace` at all; this project
is standalone.

### 12. Hermes venv has no `pip`

The hermes-agent base image uses `uv` to install its deps — there's no
`pip` module in `/opt/hermes/.venv`. Trying `pip install dingtalk-stream`
fails with `Exit 127`.

**Fix in `Dockerfile`:** `python -m ensurepip --upgrade` first, then
`python -m pip install`.

### 13. `config.yaml::model` is a nested dict, not a string

Looks innocuous but cost time:

```yaml
model:                       # this is a dict
  default: qwen3.6-plus
  provider: bailian
  base_url: https://...
```

Early versions did `cfg.setdefault("model", b.default_model)` — (a)
`setdefault` is a no-op when the key already exists (it does here,
inherited from `cli-config.yaml.example`), and (b) writing a string to
`model` would break hermes's schema.

**Fix in `core/hermes_config.py::_sync_bailian()`:** load the existing dict,
overwrite `.default/.provider/.base_url`, preserve unknown keys.

### 14. HTTP port exposure invites external probes

When you publish `-p 8000:8000` to a public IP you will see noise in the
access log from scanners hitting old hermes-workspace paths
(`/api/connection-status`, `/api/context-usage`, etc). Those all return
404 — safe, but loud.

For production, bind to loopback + put Caddy or Tailscale in front:

```bash
docker run ... -p 127.0.0.1:8000:8000 ...
```

---

## Upgrading hermes-agent base image

If upstream ships a new tag for `nousresearch/hermes-agent`, rebuild and:

1. Check the patch in `Dockerfile` applied cleanly (build log should say
   `feishu.py: patched _connect_with_overrides (sync + no-await)`). If it
   says `patch target not found; upstream may have changed`, the feishu bug
   may have been fixed upstream — verify, then drop the patch. If not,
   re-target the patch at the new line numbers.
2. Verify the pidfile format in `gateway.pid` hasn't changed (see gotcha 9).
3. Verify the `api_server` anti-CSRF behavior hasn't loosened (see gotcha 3)
   — in case upstream added a proper allowlist, we can stop stripping Origin.
4. Verify `check_dingtalk_requirements` still reads env vars (see gotcha 4).

---

## Changing ports

- UI port: `PORT` env var (default `8000`) — passed to uvicorn
- Gateway: hardcoded `8642` (hermes-agent default), loopback
- Dashboard: hardcoded `9119` (hermes-agent default), loopback

Only `8000` is `EXPOSE`d.

---

## License

Inherits from the hermes-agent base image's license terms. Our wrapper is
provided as-is with no warranty.
