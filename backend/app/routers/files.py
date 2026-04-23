"""File browser rooted at HERMES_HOME (/mnt/data/.hermes).

The UI needs direct access to hermes agent state files (config.yaml,
sessions, skills, memories, etc.) — exposing /mnt/data would put user
workspace files in the tree too, which isn't what the settings/debug
use cases want. Everything is scoped to HERMES_HOME; traversal back up
to /mnt/data or elsewhere is rejected.
"""
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query

from ..config import HERMES_HOME
from ..models.schemas import FileNode, FileWriteRequest

router = APIRouter(prefix="/api/console/files", tags=["files"])

FILES_ROOT = HERMES_HOME


def _resolve(relpath: str) -> Path:
    """Resolve a path inside FILES_ROOT. Reject traversal."""
    root = FILES_ROOT.resolve()
    if relpath in ("", "/", "."):
        return root
    candidate = (root / relpath.lstrip("/")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise HTTPException(400, f"path escapes files root: {relpath}")
    return candidate


def _to_node(p: Path) -> FileNode:
    try:
        st = p.stat()
    except OSError:
        return FileNode(
            name=p.name, path=str(p.relative_to(FILES_ROOT)),
            type="file" if p.is_file() else "dir",
        )
    return FileNode(
        name=p.name,
        path=str(p.relative_to(FILES_ROOT)),
        type="dir" if p.is_dir() else "file",
        size=st.st_size if p.is_file() else None,
        mtime=st.st_mtime,
    )


@router.get("/tree")
def tree(path: str = Query("")):
    d = _resolve(path)
    if not d.exists():
        raise HTTPException(404, "not found")
    if not d.is_dir():
        raise HTTPException(400, "not a directory")
    try:
        entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except PermissionError:
        raise HTTPException(403, "permission denied")
    return {"path": str(d.relative_to(FILES_ROOT)) if d != FILES_ROOT else "",
            "entries": [_to_node(e) for e in entries]}


@router.get("/read")
def read(path: str = Query(...)):
    p = _resolve(path)
    if not p.exists():
        raise HTTPException(404, "not found")
    if not p.is_file():
        raise HTTPException(400, "not a file")
    if p.stat().st_size > 10 * 1024 * 1024:
        raise HTTPException(413, "file too large (>10MB)")
    try:
        content = p.read_text(encoding="utf-8")
        binary = False
    except UnicodeDecodeError:
        content = ""
        binary = True
    return {"path": str(p.relative_to(FILES_ROOT)), "content": content,
            "size": p.stat().st_size, "binary": binary}


@router.put("/write")
def write(req: FileWriteRequest):
    p = _resolve(req.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(req.content, encoding="utf-8")
    return {"path": str(p.relative_to(FILES_ROOT)), "size": p.stat().st_size}


@router.delete("")
def delete(path: str = Query(...)):
    p = _resolve(path)
    if not p.exists():
        raise HTTPException(404, "not found")
    if p == FILES_ROOT.resolve():
        raise HTTPException(400, "cannot delete root")
    if p.is_dir():
        import shutil
        shutil.rmtree(p)
    else:
        p.unlink()
    return {"deleted": str(p.relative_to(FILES_ROOT))}


@router.post("/mkdir")
def mkdir(path: str = Query(...)):
    p = _resolve(path)
    p.mkdir(parents=True, exist_ok=True)
    return {"path": str(p.relative_to(FILES_ROOT))}
