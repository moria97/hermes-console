from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ProviderConfig(BaseModel):
    """One OpenAI-compatible provider configured by the user.

    Maps 1:1 to a `custom_providers[]` entry in hermes' config.yaml. Extra
    UI metadata (preset id, selected model list) lives in console_-prefixed
    fields on that entry — hermes loads providers via plain `.get()` calls
    (no pydantic validation) so unknown keys are ignored, see
    `hermes_cli/providers.py::resolve_custom_provider`.
    """
    # custom_providers[i].name in config.yaml — auto-generated on create
    name: str = ""
    # UI preset: "public" | "tokenplan" | "coding" | "custom"
    type: str = "custom"
    base_url: str = ""
    api_key: str = ""
    # User-selected model IDs that should appear as cards in the UI
    models: List[str] = Field(default_factory=list)


class TestProviderRequest(BaseModel):
    api_key: str
    base_url: str
    # "fetch" — GET /models (returns the model list for the UI multi-select).
    # "auth"  — POST /chat/completions with a minimal payload, used to validate
    #           creds when /models isn't exposed (e.g., Bailian Coding Plan).
    mode: Literal["fetch", "auth"] = "fetch"
    # Required when mode=="auth": a model id to send in the probe request.
    model: str = ""


class FeishuConfig(BaseModel):
    app_id: str = ""
    app_secret: str = ""


class DingtalkConfig(BaseModel):
    client_id: str = ""
    client_secret: str = ""


class ConsoleSettings(BaseModel):
    providers: List[ProviderConfig] = Field(default_factory=list)
    # Name of the active provider (matches one ProviderConfig.name) and the
    # model id within its `models` list that's set as `model.default`.
    # Empty strings = no active default → hermes falls back to provider="auto".
    active_provider: str = ""
    active_model: str = ""
    feishu: FeishuConfig = Field(default_factory=FeishuConfig)
    dingtalk: DingtalkConfig = Field(default_factory=DingtalkConfig)


class FileNode(BaseModel):
    name: str
    path: str
    type: Literal["file", "dir"]
    size: Optional[int] = None
    mtime: Optional[float] = None


class FileWriteRequest(BaseModel):
    path: str
    content: str


class TerminalResize(BaseModel):
    type: Literal["resize"]
    cols: int
    rows: int


class TerminalInput(BaseModel):
    type: Literal["input"]
    data: str
