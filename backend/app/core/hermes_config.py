"""Bridge console settings → hermes-agent config.yaml.

Keeps ~/.hermes/config.yaml's `custom_providers` and `platforms.*` in sync
with what the user configured through the console. Other fields are left
untouched.

Platform config shape follows upstream `gateway/config.py::PlatformConfig`:

    platforms:
      feishu:
        enabled: true
        extra: { app_id: "...", app_secret: "..." }
      dingtalk:
        enabled: true
        extra: { client_id: "...", client_secret: "..." }
"""
import threading
from pathlib import Path
import yaml

from ..config import HERMES_CONFIG_PATH, HERMES_HOME
from ..models.schemas import ConsoleSettings

_lock = threading.Lock()

BAILIAN_PROVIDER_NAME = "bailian"
HERMES_ENV_PATH = HERMES_HOME / ".env"

# Env vars we manage; anything not in this set is preserved untouched.
MANAGED_ENV_KEYS = {
    "DINGTALK_CLIENT_ID",
    "DINGTALK_CLIENT_SECRET",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
}


def _upsert_env(path: Path, updates: dict[str, str]) -> None:
    """Merge `updates` into a dotenv-style file. Unmanaged lines are preserved."""
    existing: list[str] = []
    if path.exists():
        existing = path.read_text().splitlines()

    # Strip prior managed entries; keep everything else.
    preserved = []
    for line in existing:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in MANAGED_ENV_KEYS:
                continue
        preserved.append(line)

    # Append fresh managed block.
    if any(v for v in updates.values()):
        if preserved and preserved[-1].strip() != "":
            preserved.append("")
        preserved.append("# managed by hermes-console (do not edit below manually)")
        for k, v in updates.items():
            if v:
                preserved.append(f"{k}={v}")

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(preserved) + "\n")
    tmp.replace(path)


def _load_hermes_config() -> dict:
    path = HERMES_CONFIG_PATH
    if not path.exists():
        return {}
    try:
        return yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError:
        return {}


def _write_hermes_config(data: dict) -> None:
    path: Path = HERMES_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    tmp.replace(path)


def _sync_bailian(cfg: dict, settings: ConsoleSettings) -> None:
    """Keep the bailian entry in `custom_providers` whenever there are
    credentials to preserve — even when the user toggles it off. "Disabled"
    just means the top-level `provider` field points elsewhere so hermes
    doesn't route to bailian. This way toggling off/on doesn't wipe the
    user's API key."""
    providers = [p for p in (cfg.get("custom_providers") or [])
                 if p.get("name") != BAILIAN_PROVIDER_NAME]
    b = settings.bailian

    if b.api_key:
        providers.append({
            "name": BAILIAN_PROVIDER_NAME,
            "base_url": b.base_url,
            "api_key": b.api_key,
            "api_mode": "chat_completions",
        })

    model_cfg = cfg.get("model")
    if not isinstance(model_cfg, dict):
        model_cfg = {}

    if b.enabled and b.api_key:
        cfg["provider"] = BAILIAN_PROVIDER_NAME
        model_cfg["default"] = b.default_model
        model_cfg["provider"] = BAILIAN_PROVIDER_NAME
        model_cfg["base_url"] = b.base_url
    else:
        # Disabled: flip provider off bailian but leave credentials/model-
        # defaults alone so re-enable is one toggle away.
        if cfg.get("provider") == BAILIAN_PROVIDER_NAME:
            cfg["provider"] = "auto"
        if model_cfg.get("provider") == BAILIAN_PROVIDER_NAME:
            model_cfg["provider"] = "auto"

    cfg["model"] = model_cfg
    cfg["custom_providers"] = providers


def _sync_platforms(cfg: dict, settings: ConsoleSettings) -> None:
    platforms = cfg.get("platforms") or {}

    f = settings.feishu
    if f.enabled and f.app_id and f.app_secret:
        existing = platforms.get("feishu") or {}
        extra = dict(existing.get("extra") or {})
        extra["app_id"] = f.app_id
        extra["app_secret"] = f.app_secret
        platforms["feishu"] = {**existing, "enabled": True, "extra": extra}
    else:
        if "feishu" in platforms:
            platforms["feishu"] = {**platforms["feishu"], "enabled": False}

    d = settings.dingtalk
    if d.enabled and d.client_id and d.client_secret:
        existing = platforms.get("dingtalk") or {}
        extra = dict(existing.get("extra") or {})
        extra["client_id"] = d.client_id
        extra["client_secret"] = d.client_secret
        platforms["dingtalk"] = {**existing, "enabled": True, "extra": extra}
    else:
        if "dingtalk" in platforms:
            platforms["dingtalk"] = {**platforms["dingtalk"], "enabled": False}

    cfg["platforms"] = platforms


def _sync_env(settings: ConsoleSettings) -> None:
    """Mirror platform credentials into ~/.hermes/.env.

    Hermes's dingtalk `check_dingtalk_requirements` only reads env vars, not
    config.yaml — so platforms.dingtalk entries alone don't satisfy the
    startup gate. We write the managed keys here and the gateway picks them
    up via load_hermes_dotenv() on next start.
    """
    updates: dict[str, str] = {}
    d = settings.dingtalk
    if d.enabled and d.client_id and d.client_secret:
        updates["DINGTALK_CLIENT_ID"] = d.client_id
        updates["DINGTALK_CLIENT_SECRET"] = d.client_secret
    f = settings.feishu
    if f.enabled and f.app_id and f.app_secret:
        updates["FEISHU_APP_ID"] = f.app_id
        updates["FEISHU_APP_SECRET"] = f.app_secret
    _upsert_env(HERMES_ENV_PATH, updates)


def sync_providers(settings: ConsoleSettings) -> None:
    """Sync all console settings into hermes config.yaml + .env.

    Name kept as `sync_providers` for backward compatibility with existing
    callers; now covers providers, platforms, and required env vars in one
    atomic write.
    """
    with _lock:
        cfg = _load_hermes_config()
        _sync_bailian(cfg, settings)
        _sync_platforms(cfg, settings)
        _write_hermes_config(cfg)
        _sync_env(settings)
