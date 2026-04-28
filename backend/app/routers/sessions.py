"""Read-only view of hermes-agent's session history.

hermes persists every chat turn into ~/.hermes/state.db (sessions + messages
tables, with FTS5 over messages). This router exposes that data to the
console UI so the chat tab can show real conversation history rather than
the localStorage-only mirror it used before.

Connection mode is `mode=ro` URI so we never contend with hermes' writer
on the same db file (WAL mode keeps that mostly painless either way).
"""
import json
import logging
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException

from ..config import HERMES_HOME

router = APIRouter(prefix="/api/console/sessions", tags=["sessions"])
log = logging.getLogger(__name__)

DB_PATH = HERMES_HOME / "state.db"

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
