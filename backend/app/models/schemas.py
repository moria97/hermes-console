from typing import Literal, Optional
from pydantic import BaseModel, Field


class BailianConfig(BaseModel):
    api_key: str = ""
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    default_model: str = "qwen-plus"
    enabled: bool = True


class FeishuConfig(BaseModel):
    app_id: str = ""
    app_secret: str = ""
    enabled: bool = False


class DingtalkConfig(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    enabled: bool = False


class ConsoleSettings(BaseModel):
    bailian: BailianConfig = Field(default_factory=BailianConfig)
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
