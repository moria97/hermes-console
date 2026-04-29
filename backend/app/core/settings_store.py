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
    ConsoleSettings,
    DingtalkConfig,
    FeishuConfig,
    ProviderConfig,
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
    # ── Providers ────────────────────────────────────────────────────────
    providers: list[ProviderConfig] = []
    for entry in (cfg.get("custom_providers") or []):
        if entry.get("api_mode") != hermes_config.CONSOLE_API_MODE:
            continue

        # New canonical shape: `models` is a dict {id: meta}. Take ids from
        # keys. Fall back to the legacy `console_models` list for entries
        # written by older hermes-console releases — they get rewritten to
        # the canonical shape on the next save.
        model_ids: list[str] = []
        models_field = entry.get("models")
        if isinstance(models_field, dict):
            model_ids = [k for k in models_field.keys() if isinstance(k, str)]
        else:
            legacy = entry.get(hermes_config.LEGACY_MODELS_KEY) or []
            model_ids = [m for m in legacy if isinstance(m, str)]

        # Preset id is fully determined by base_url, no need to persist it.
        # Legacy `console_provider_type` is silently ignored (URL wins).
        base_url = entry.get("base_url", "") or ""
        provider_type = hermes_config.preset_id_from_url(base_url)

        providers.append(ProviderConfig(
            name=entry.get("name", "") or "",
            type=provider_type,
            base_url=base_url,
            api_key=entry.get("api_key", "") or "",
            models=model_ids,
        ))

    cfg_provider = cfg.get("provider") or ""
    model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    cfg_default_model = model_cfg.get("default") or ""

    active_provider = ""
    active_model = ""
    matched = next((p for p in providers if p.name == cfg_provider), None)
    if matched and cfg_default_model and cfg_default_model in matched.models:
        active_provider = matched.name
        active_model = cfg_default_model

    # ── Feishu / Dingtalk ────────────────────────────────────────────────
    platforms = cfg.get("platforms") or {}

    f_cfg = platforms.get("feishu") or {}
    f_extra = (f_cfg.get("extra") or {})
    feishu = FeishuConfig(
        app_id=f_extra.get("app_id") or env.get("FEISHU_APP_ID", "") or "",
        app_secret=f_extra.get("app_secret") or env.get("FEISHU_APP_SECRET", "") or "",
    )

    d_cfg = platforms.get("dingtalk") or {}
    d_extra = (d_cfg.get("extra") or {})
    dingtalk = DingtalkConfig(
        client_id=d_extra.get("client_id") or env.get("DINGTALK_CLIENT_ID", "") or "",
        client_secret=d_extra.get("client_secret") or env.get("DINGTALK_CLIENT_SECRET", "") or "",
    )

    return ConsoleSettings(
        providers=providers,
        active_provider=active_provider,
        active_model=active_model,
        feishu=feishu,
        dingtalk=dingtalk,
    )


def _migrate_legacy_ui_yaml() -> None:
    """If the old console-ui.yaml exists, drop it. The legacy bailian-only
    schema doesn't map cleanly onto the new provider+model-list shape, so
    the user re-creates their providers via the new UI on first load. We
    still remove the file so it doesn't keep prompting migration attempts."""
    legacy = CONSOLE_SETTINGS_PATH
    if not legacy.exists():
        return
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
    Returns the settings normalized through the writer (auto-named + with
    invalid active selection cleared)."""
    with _lock:
        return hermes_config.sync_providers(settings)
