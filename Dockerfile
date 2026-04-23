# syntax=docker/dockerfile:1.6
# Hermes Console — single image: hermes-agent + FastAPI console-ui backend + static SPA.
# UI on :8000. Gateway/dashboard stay loopback-only.

# ─── stage 1: frontend build (React + Vite + Monaco + xterm) ─────────────
FROM node:22-slim AS frontend-build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /web
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ─── stage 2: runtime on the agent image ─────────────────────────────────
FROM nousresearch/hermes-agent:latest
USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates tini python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Install dingtalk-stream into the hermes-agent venv so the dingtalk platform
# adapter can start. feishu/lark SDK is already bundled upstream.
RUN /opt/hermes/.venv/bin/python -m ensurepip --upgrade \
 && /opt/hermes/.venv/bin/python -m pip install --no-cache-dir dingtalk-stream

# Build the console-ui Python venv using the runtime's python3 so shebangs match.
COPY backend/requirements.txt /opt/console/requirements.txt
RUN python3 -m venv /opt/console/.venv \
 && /opt/console/.venv/bin/pip install --upgrade pip \
 && /opt/console/.venv/bin/pip install --no-cache-dir -r /opt/console/requirements.txt

COPY backend/ /opt/console/backend/
COPY --from=frontend-build /web/dist /opt/console/web
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Expose `hermes` on the default PATH so interactive login shells in the web
# terminal find it even after /etc/profile clobbers PATH.
RUN ln -sf /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes

# Patch hermes's feishu.py so feishu + dingtalk can coexist. Upstream's
# `_connect_with_overrides` is declared `async def` and `await`s the real
# `websockets.connect` — but feishu ALSO assigns this wrapper onto the global
# `websockets.connect` module attribute. Any other caller in the same process
# using `async with websockets.connect(uri) as ws` (e.g. dingtalk-stream) then
# receives a coroutine instead of a Connect object, raising:
#     TypeError: 'coroutine' object does not support the asynchronous
#     context manager protocol
# The fix: make the wrapper a regular `def` that returns the Connect object
# directly. The real `websockets.connect` (v14+) returns a Connect object that
# is both awaitable and an async context manager, so every existing usage
# keeps working.
RUN python3 <<'PYEOF'
import sys
p = '/opt/hermes/gateway/platforms/feishu.py'
src = open(p).read()
old = (
    '    async def _connect_with_overrides(*args: Any, **kwargs: Any) -> Any:\n'
    '        if adapter._ws_ping_interval is not None and "ping_interval" not in kwargs:\n'
    '            kwargs["ping_interval"] = adapter._ws_ping_interval\n'
    '        if adapter._ws_ping_timeout is not None and "ping_timeout" not in kwargs:\n'
    '            kwargs["ping_timeout"] = adapter._ws_ping_timeout\n'
    '        return await original_connect(*args, **kwargs)\n'
)
new = (
    '    # ---- hermes-console patch (do not remove) ----\n'
    '    # This wrapper is monkey-patched onto the GLOBAL websockets.connect\n'
    '    # (see the `ws_client_module.websockets.connect = ...` assignment\n'
    '    # below). If it were `async def`, calling it would produce a coroutine\n'
    '    # and break any other library in the process that relies on\n'
    '    # `async with websockets.connect(uri) as ws` (notably dingtalk-stream).\n'
    '    # websockets.connect (>=14) returns a Connect object that is both\n'
    '    # awaitable and an async context manager, so a plain `def` wrapper\n'
    '    # returning it preserves all caller patterns.\n'
    '    def _connect_with_overrides(*args: Any, **kwargs: Any) -> Any:\n'
    '        if adapter._ws_ping_interval is not None and "ping_interval" not in kwargs:\n'
    '            kwargs["ping_interval"] = adapter._ws_ping_interval\n'
    '        if adapter._ws_ping_timeout is not None and "ping_timeout" not in kwargs:\n'
    '            kwargs["ping_timeout"] = adapter._ws_ping_timeout\n'
    '        return original_connect(*args, **kwargs)\n'
)
if old not in src:
    print('feishu.py: patch target not found; upstream may have changed. Skipping.', file=sys.stderr)
    sys.exit(0)
open(p, 'w').write(src.replace(old, new))
print('feishu.py: patched _connect_with_overrides (sync + no-await)')
PYEOF

ENV HERMES_HOME=/mnt/data/.hermes \
    CONSOLE_DATA_ROOT=/mnt/data \
    PORT=8000 \
    CONSOLE_STATIC_DIR=/opt/console/web \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=127.0.0.1 \
    PYTHONUNBUFFERED=1

RUN mkdir -p /mnt/data/.hermes && chown -R hermes:hermes /mnt/data /opt/console

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/console/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start.sh"]
