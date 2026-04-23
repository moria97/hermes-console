"""Single source of truth: `~/.hermes/config.yaml` + `~/.hermes/.env`.

Previously we kept a parallel `console-ui.yaml` and derived config.yaml
from it on save. That meant direct edits to config.yaml weren't reflected
in the UI. Now we read everything back from config.yaml + .env, and on
save we only write those two files (via `hermes_config.sync_providers`).
The old console-ui.yaml file, if present, is migrated + deleted the first
time we load.
"""
import threading
from pathlib import Path

import yaml

from ..config import CONSOLE_SETTINGS_PATH, HERMES_CONFIG_PATH
from ..models.schemas import (
    BailianConfig,
    ConsoleSettings,
    DingtalkConfig,
    FeishuConfig,
)
from . import hermes_config

_lock = threading.Lock()

DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _load_config_yaml() -> dict:
    if not HERMES_CONFIG_PATH.exists():
        return {}
    try:
        return yaml.safe_load(HERMES_CONFIG_PATH.read_text()) or {}
    except yaml.YAMLError:
        return {}


def _settings_from_config(cfg: dict, env: dict[str, str]) -> ConsoleSettings:
    # ── Bailian ──────────────────────────────────────────────────────────
    bailian_entry = next(
        (p for p in (cfg.get("custom_providers") or [])
         if p.get("name") == hermes_config.BAILIAN_PROVIDER_NAME),
        None,
    )
    model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    bailian_enabled = cfg.get("provider") == hermes_config.BAILIAN_PROVIDER_NAME

    bailian = BailianConfig(
        api_key=(bailian_entry or {}).get("api_key", "") or "",
        base_url=(bailian_entry or {}).get("base_url", "") or DEFAULT_BAILIAN_BASE_URL,
        default_model=model_cfg.get("default", "qwen3.6-plus") or "qwen3.6-plus",
        enabled=bailian_enabled,
    )

    # ── Feishu / Dingtalk ────────────────────────────────────────────────
    platforms = cfg.get("platforms") or {}

    f_cfg = platforms.get("feishu") or {}
    f_extra = (f_cfg.get("extra") or {})
    feishu = FeishuConfig(
        app_id=f_extra.get("app_id") or env.get("FEISHU_APP_ID", "") or "",
        app_secret=f_extra.get("app_secret") or env.get("FEISHU_APP_SECRET", "") or "",
        enabled=bool(f_cfg.get("enabled", False)),
    )

    d_cfg = platforms.get("dingtalk") or {}
    d_extra = (d_cfg.get("extra") or {})
    dingtalk = DingtalkConfig(
        client_id=d_extra.get("client_id") or env.get("DINGTALK_CLIENT_ID", "") or "",
        client_secret=d_extra.get("client_secret") or env.get("DINGTALK_CLIENT_SECRET", "") or "",
        enabled=bool(d_cfg.get("enabled", False)),
    )

    return ConsoleSettings(bailian=bailian, feishu=feishu, dingtalk=dingtalk)


def _migrate_legacy_ui_yaml() -> None:
    """If the old console-ui.yaml exists, fold any values that config.yaml is
    missing into config.yaml, then remove console-ui.yaml. Safe to call on
    every load() — a no-op once the migration has run."""
    legacy = CONSOLE_SETTINGS_PATH
    if not legacy.exists():
        return
    try:
        raw = yaml.safe_load(legacy.read_text()) or {}
        legacy_settings = ConsoleSettings.model_validate(raw)
    except (yaml.YAMLError, Exception):
        # Legacy file is corrupt — just drop it rather than crash.
        try:
            legacy.unlink()
        except OSError:
            pass
        return

    cfg_now = _load_config_yaml()
    env_now = _read_env_file(HERMES_CONFIG_PATH.parent / ".env")
    current = _settings_from_config(cfg_now, env_now)

    # Merge: if config.yaml is missing a credential we had in console-ui.yaml,
    # recover it. We DON'T touch `enabled` flags (config.yaml wins those).
    merged = ConsoleSettings(
        bailian=BailianConfig(
            api_key=current.bailian.api_key or legacy_settings.bailian.api_key,
            base_url=current.bailian.base_url or legacy_settings.bailian.base_url,
            default_model=current.bailian.default_model or legacy_settings.bailian.default_model,
            enabled=current.bailian.enabled,
        ),
        feishu=FeishuConfig(
            app_id=current.feishu.app_id or legacy_settings.feishu.app_id,
            app_secret=current.feishu.app_secret or legacy_settings.feishu.app_secret,
            enabled=current.feishu.enabled,
        ),
        dingtalk=DingtalkConfig(
            client_id=current.dingtalk.client_id or legacy_settings.dingtalk.client_id,
            client_secret=current.dingtalk.client_secret or legacy_settings.dingtalk.client_secret,
            enabled=current.dingtalk.enabled,
        ),
    )

    # Only write back if merge actually changed anything.
    if merged.model_dump() != current.model_dump():
        try:
            hermes_config.sync_providers(merged)
        except Exception:
            pass

    try:
        legacy.unlink()
    except OSError:
        pass


def load() -> ConsoleSettings:
    with _lock:
        _migrate_legacy_ui_yaml()
        cfg = _load_config_yaml()
        env = _read_env_file(HERMES_CONFIG_PATH.parent / ".env")
        return _settings_from_config(cfg, env)


def save(settings: ConsoleSettings) -> ConsoleSettings:
    """Persist via hermes_config — writes config.yaml + .env atomically.
    No separate console-ui.yaml anymore."""
    with _lock:
        hermes_config.sync_providers(settings)
    return settings
