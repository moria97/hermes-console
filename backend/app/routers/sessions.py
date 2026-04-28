"""Read-only view of hermes-agent's session history.

hermes persists every chat turn into ~/.hermes/state.db (sessions + messages
tables, with FTS5 over messages). This router exposes that data to the
console UI so the chat tab can show real conversation history rather than
the localStorage-only mirror it used before.

Connection mode is `mode=ro` URI so we never contend with hermes' writer
on the same db file (WAL mode keeps that mostly painless either way).
"""
import ast
import json
import logging
import os
import re
import sqlite3
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from ..config import HERMES_HOME

router = APIRouter(prefix="/api/console/sessions", tags=["sessions"])
log = logging.getLogger(__name__)

DB_PATH = HERMES_HOME / "state.db"
AGENT_LOG_PATH = HERMES_HOME / "logs" / "agent.log"

# Match hermes' run_agent.py error format:
#   YYYY-MM-DD HH:MM:SS,mmm ERROR [<session_id>] root: Non-retryable client error: Error code: 400 - {...python dict repr...}
_ERR_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+"
    r"(?P<level>ERROR|WARNING)\s+"
    r"\[(?P<session>[^\]]+)\]\s+"
    r"(?P<logger>[\w.]+):\s+"
    r"(?P<rest>.+)$"
)


def _tail_bytes(path, n_bytes: int = 200_000) -> str:
    """Return roughly the last n_bytes of a (possibly large) log file as a
    UTF-8 string, partial first line discarded."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return ""
    with open(path, "rb") as f:
        if size > n_bytes:
            f.seek(size - n_bytes)
            f.readline()  # discard the partial line at the seek boundary
        return f.read().decode("utf-8", errors="replace")

# Patterns that mark a session as a non-user-chat sub-call. These are
# completion calls hermes / open-webui / similar wrappers make on the user's
# behalf to do auto-tagging, title generation, follow-up suggestion, etc.
# The chat sidebar hides them by default so the list shows actual conversations.
_INTERNAL_PREVIEW_PATTERNS = [
    re.compile(r"^\s*###\s*Task\s*:", re.IGNORECASE),
    re.compile(r"^\s*Generate\s+\d+\s+(broad\s+tags|follow[-\s]?up)", re.IGNORECASE),
    re.compile(r"^\s*You are an? .{0,40} title generator", re.IGNORECASE),
    re.compile(r"^\s*Create a concise.{0,40}title", re.IGNORECASE),
]


def _is_internal(preview: str) -> bool:
    if not preview:
        return False
    return any(p.search(preview) for p in _INTERNAL_PREVIEW_PATTERNS)


def _connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(503, "hermes state.db not found yet — try after a chat turn")
    # Read-only URI so we don't compete with hermes' writer for the lock.
    conn = sqlite3.connect(
        f"file:{DB_PATH}?mode=ro",
        uri=True,
        timeout=2.0,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    return conn


def _maybe_json(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return value
    s = value.strip()
    if not s or (s[0] not in "[{"):
        return value
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return value


@router.get("")
def list_sessions(limit: int = 50, include_internal: bool = False):
    """Most-recent-first list of sessions with at least one message.

    By default, hides "internal" sub-call sessions (open-webui auto-tagging,
    title-generation completions, etc.) — pass `?include_internal=true` to
    see everything.

    Each row includes a `preview` field — the first user message in the
    session, trimmed — so the sidebar can render a meaningful title without
    a follow-up fetch per row.
    """
    limit = max(1, min(limit, 500))
    # Pull a few extra rows so post-filter we still hit `limit` real chats.
    fetch_n = limit if include_internal else min(limit * 4, 1000)
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT s.id, s.source, s.model, s.started_at, s.ended_at,
                   s.end_reason, s.message_count, s.title,
                   (SELECT content FROM messages
                    WHERE session_id = s.id AND role = 'user'
                    ORDER BY id ASC LIMIT 1) AS preview
            FROM sessions s
            WHERE s.message_count > 0
            ORDER BY s.started_at DESC, s.id DESC
            LIMIT ?
            """,
            (fetch_n,),
        ).fetchall()
    out = []
    for r in rows:
        prev = r["preview"] or ""
        if not include_internal and _is_internal(prev):
            continue
        d = dict(r)
        d["preview"] = prev[:120] + ("…" if len(prev) > 120 else "")
        out.append(d)
        if len(out) >= limit:
            break
    return out


@router.get("/{session_id}/last-error")
def get_session_last_error(session_id: str):
    """Scan the tail of `~/.hermes/logs/agent.log` for the most recent
    ERROR/WARNING line tagged with this session id.

    The chat UI calls this whenever a chat completion silently returns
    an empty stream (hermes wraps upstream 4xx/5xx as 200 + zero tokens
    instead of propagating the error), so the frontend can show the real
    cause — most often "model not activated on this Bailian key" or a
    quota / auth failure.
    """
    if not AGENT_LOG_PATH.exists():
        return {"found": False}

    sid_marker = f"[{session_id}]"
    tail = _tail_bytes(AGENT_LOG_PATH, 300_000)
    matches = []
    for line in tail.splitlines():
        if sid_marker not in line:
            continue
        m = _ERR_RE.match(line)
        if not m:
            continue
        matches.append(m.groupdict())

    if not matches:
        return {"found": False}

    last = matches[-1]
    rest = last["rest"]
    out = {
        "found": True,
        "ts": last["ts"],
        "level": last["level"],
        "logger": last["logger"],
        "raw": rest,
        "summary": rest,
        "status_code": None,
        "upstream_message": None,
    }
    # Try to parse: "Non-retryable client error: Error code: 400 - {...dict...}"
    code_m = re.search(r"Error code:\s*(\d+)\s*-\s*(.+)$", rest)
    if code_m:
        out["status_code"] = int(code_m.group(1))
        body = code_m.group(2).strip()
        # The body is a Python dict repr (single quotes, None) — try ast first.
        parsed: Optional[dict] = None
        try:
            parsed = ast.literal_eval(body)
        except (ValueError, SyntaxError):
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = None
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, dict):
                out["upstream_message"] = err.get("message")
                out["summary"] = err.get("message") or out["summary"]
    return out


@router.get("/{session_id}")
def get_session(session_id: str):
    with _connect() as conn:
        sess = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not sess:
            raise HTTPException(404, "session not found")
        msgs = conn.execute(
            """
            SELECT id, role, content, tool_call_id, tool_calls, tool_name,
                   timestamp, finish_reason, reasoning_content
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()
    return {
        "session": dict(sess),
        "messages": [
            {**dict(m), "tool_calls": _maybe_json(m["tool_calls"])}
            for m in msgs
        ],
    }
