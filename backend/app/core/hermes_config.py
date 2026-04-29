"""Bridge console settings → hermes-agent config.yaml.

Keeps ~/.hermes/config.yaml's `custom_providers` and `platforms.*` in sync
with what the user configured through the console. Other fields are left
untouched.

Each console-managed provider entry in config.yaml has the canonical
hermes shape — every key here is in hermes_cli/config.py's
`_normalize_custom_provider_entry::_KNOWN_KEYS` whitelist:

    custom_providers:
      - name: bailian-tokenplan-1
        base_url: https://...
        api_key: sk-...
        api_mode: chat_completions             # marker → "console-managed"
        models:                                 # selected model cards (id → meta)
          qwen3.6-plus: {}                      # empty meta until UI exposes
          glm-5: {}                             # context_length etc.

The UI preset id (public/tokenplan/coding/custom) is derived from base_url
at load time — see `_preset_id_from_url` — instead of being persisted.

Earlier versions of hermes-console wrote two non-canonical fields here:
`console_provider_type` and `console_models`.  hermes ignored them but
emitted `unknown config keys ignored` warnings on every reload.  The
settings reader still understands those fields for backward-compat with
existing volumes; the next save rewrites them to the canonical shape.

Platform config follows upstream `gateway/config.py::PlatformConfig`:

    platforms:
      feishu:    { enabled: true, extra: {app_id, app_secret} }
      dingtalk:  { enabled: true, extra: {client_id, client_secret} }
"""
import threading
from pathlib import Path
import yaml

from ..config import HERMES_CONFIG_PATH, HERMES_HOME
from ..models.schemas import ConsoleSettings, ProviderConfig

_lock = threading.Lock()

# Marker in api_mode field — every console-managed provider uses this value.
CONSOLE_API_MODE = "chat_completions"
# Legacy field names — read-only, for migrating volumes written by older
# hermes-console releases. We never write these any more.
LEGACY_MODELS_KEY = "console_models"
LEGACY_TYPE_KEY = "console_provider_type"

# Canonical preset URLs (must mirror frontend's PROVIDER_PRESETS list).
_PRESET_URLS = {
    "public": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "tokenplan": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "coding": "https://coding.dashscope.aliyuncs.com/v1",
}


def preset_id_from_url(base_url: str) -> str:
    """Reverse-lookup a UI preset id from a saved base_url. Used to drop the
    persisted `console_provider_type` field — preset is fully determined by
    URL, no need to round-trip it through config.yaml."""
    if not base_url:
        return "custom"
    target = base_url.rstrip("/").lower()
    for pid, url in _PRESET_URLS.items():
        if target == url.rstrip("/").lower():
            return pid
    return "custom"


HERMES_ENV_PATH = HERMES_HOME / ".env"

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

    preserved = []
    for line in existing:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in MANAGED_ENV_KEYS:
                continue
        preserved.append(line)

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


def _ensure_unique_names(providers: list[ProviderConfig]) -> list[ProviderConfig]:
    """Auto-fill blank names + de-duplicate so each entry maps to a distinct
    custom_providers row. Names follow `bailian-{type}-{n}` for built-in
    presets, `provider-{n}` for custom."""
    seen: set[str] = set()
    out: list[ProviderConfig] = []
    for i, p in enumerate(providers):
        name = (p.name or "").strip()
        if not name:
            stem = (
                f"bailian-{p.type}" if p.type in {"public", "tokenplan", "coding"}
                else "provider"
            )
            name = f"{stem}-{i + 1}"
        base = name
        n = 1
        while name in seen:
            n += 1
            name = f"{base}-{n}"
        seen.add(name)
        out.append(p.model_copy(update={"name": name}))
    return out


def _sync_providers_to_yaml(cfg: dict, settings: ConsoleSettings) -> ConsoleSettings:
    """Rewrite custom_providers from the provider list and apply the
    user-selected (active_provider, active_model) as cfg.provider /
    model.default. Returns the normalized settings (with auto-filled
    provider names + cleared actives if invalid)."""
    providers = _ensure_unique_names(settings.providers)

    existing = cfg.get("custom_providers") or []

    # Index existing console-managed entries by name so we can preserve any
    # per-model metadata (context_length, …) the user may have hand-edited
    # into models[id].* — the UI doesn't expose those today, but rewriting
    # would silently drop them on every save otherwise.
    existing_models_meta: dict[str, dict] = {}
    for e in existing:
        if e.get("api_mode") != CONSOLE_API_MODE:
            continue
        models_field = e.get("models")
        if isinstance(models_field, dict):
            existing_models_meta[e.get("name", "")] = models_field

    # Drop console-managed entries; preserve any other custom_providers the
    # user may have hand-edited into config.yaml.
    keep = [e for e in existing if e.get("api_mode") != CONSOLE_API_MODE]

    new_entries = []
    for p in providers:
        if not p.api_key:
            continue  # skip empty placeholders
        prev_meta = existing_models_meta.get(p.name, {})
        # Build a canonical {id: meta} dict for hermes' `models` field.
        # Preserves prior per-model meta when the model id is still selected;
        # newly-selected models start with an empty meta dict {}.
        models_dict = {
            mid: dict(prev_meta.get(mid, {}) or {})
            for mid in p.models
        }
        new_entries.append({
            "name": p.name,
            "base_url": p.base_url,
            "api_key": p.api_key,
            "api_mode": CONSOLE_API_MODE,
            "models": models_dict,
        })
    cfg["custom_providers"] = keep + new_entries

    model_cfg = cfg.get("model")
    if not isinstance(model_cfg, dict):
        model_cfg = {}

    managed_names = {p.name for p in providers}

    # Validate the active selection: provider must exist + have credentials,
    # active_model must be in that provider's selected models list.
    active = next((p for p in providers if p.name == settings.active_provider), None)
    if (
        active
        and active.api_key
        and settings.active_model
        and settings.active_model in active.models
    ):
        cfg["provider"] = active.name
        model_cfg["default"] = settings.active_model
        model_cfg["provider"] = active.name
        model_cfg["base_url"] = active.base_url
        new_active_provider = active.name
        new_active_model = settings.active_model
    else:
        # No valid active selection: flip provider off any console-managed
        # entry but leave model.default alone so re-enable is one click away.
        if cfg.get("provider") in managed_names:
            cfg["provider"] = "auto"
        if model_cfg.get("provider") in managed_names:
            model_cfg["provider"] = "auto"
        new_active_provider = ""
        new_active_model = ""

    cfg["model"] = model_cfg
    return settings.model_copy(update={
        "providers": providers,
        "active_provider": new_active_provider,
        "active_model": new_active_model,
    })


def _sync_platforms(cfg: dict, settings: ConsoleSettings) -> None:
    """Channel `enabled` is derived from credential presence — the UI no
    longer exposes an explicit toggle."""
    platforms = cfg.get("platforms") or {}

    f = settings.feishu
    if f.app_id and f.app_secret:
        existing = platforms.get("feishu") or {}
        extra = dict(existing.get("extra") or {})
        extra["app_id"] = f.app_id
        extra["app_secret"] = f.app_secret
        platforms["feishu"] = {**existing, "enabled": True, "extra": extra}
    else:
        if "feishu" in platforms:
            platforms["feishu"] = {**platforms["feishu"], "enabled": False}

    d = settings.dingtalk
    if d.client_id and d.client_secret:
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
    """Mirror platform credentials into ~/.hermes/.env. Hermes' dingtalk
    `check_dingtalk_requirements` only reads env vars, not config.yaml."""
    updates: dict[str, str] = {}
    d = settings.dingtalk
    if d.client_id and d.client_secret:
        updates["DINGTALK_CLIENT_ID"] = d.client_id
        updates["DINGTALK_CLIENT_SECRET"] = d.client_secret
    f = settings.feishu
    if f.app_id and f.app_secret:
        updates["FEISHU_APP_ID"] = f.app_id
        updates["FEISHU_APP_SECRET"] = f.app_secret
    _upsert_env(HERMES_ENV_PATH, updates)


def sync_providers(settings: ConsoleSettings) -> ConsoleSettings:
    """Sync all console settings into hermes config.yaml + .env.

    Returns the settings with auto-filled provider names + validated active
    selection so the caller can echo the canonical form back to the client.
    """
    with _lock:
        cfg = _load_hermes_config()
        normalized = _sync_providers_to_yaml(cfg, settings)
        _sync_platforms(cfg, settings)
        _write_hermes_config(cfg)
        _sync_env(settings)
    return normalized
