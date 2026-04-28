import os
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/mnt/data/.hermes"))
DATA_ROOT = Path(os.environ.get("CONSOLE_DATA_ROOT", "/mnt/data"))
HERMES_GATEWAY_URL = os.environ.get("HERMES_GATEWAY_URL", "http://127.0.0.1:8642")
# Shared with `hermes gateway run` — exported by start.sh from ~/.hermes/.env.
# When set, the console proxy injects `Authorization: Bearer <key>` on every
# request to the gateway so X-Hermes-Session-Id continuation works without
# leaking the key to the browser.
HERMES_API_KEY = os.environ.get("API_SERVER_KEY", "")
HERMES_DASHBOARD_URL = os.environ.get("HERMES_DASHBOARD_URL", "http://127.0.0.1:9119")
HERMES_WS_URL = os.environ.get("HERMES_WS_URL", "ws://127.0.0.1:18789")

CONSOLE_SETTINGS_PATH = HERMES_HOME / "console-ui.yaml"
HERMES_CONFIG_PATH = HERMES_HOME / "config.yaml"
HERMES_GATEWAY_PIDFILE = Path(
    os.environ.get("HERMES_GATEWAY_PIDFILE", str(HERMES_HOME / "gateway.pid"))
)

STATIC_DIR = Path(os.environ.get("CONSOLE_STATIC_DIR", "/opt/console/web"))

SHELL = os.environ.get("CONSOLE_SHELL", "/bin/bash")
