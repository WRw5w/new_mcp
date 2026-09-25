from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
BLOCKING = {"submitting", "accepted", "awaiting_score", "outcome_unknown"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_zip(path: Path, *, max_bytes: int = 64 * 1024 * 1024) -> dict[str, Any]:
    if not path.is_file() or path.suffix.lower() not in {".zip", ".rar"}:
        raise ValueError("candidate must be a .zip or .rar file")
    if path.stat().st_size > max_bytes:
        raise ValueError("candidate exceeds archive size limit")
    if path.suffix.lower() == ".rar":
        return {"entries": None, "format": "rar"}
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if len(infos) != 1:
            raise ValueError("candidate ZIP must contain exactly one file")
        info = infos[0]
        if info.is_dir() or Path(info.filename).name != info.filename:
            raise ValueError("candidate ZIP contains an invalid entry")
        if info.file_size > 16 * 1024 * 1024:
            raise ValueError("uncompressed candidate is too large")
        if info.filename.lower().endswith(".json") is False:
            raise ValueError("candidate ZIP entry must be JSON")
        with z.open(info) as stream:
            json.load(stream)
        return {"entries": [info.filename], "format": "zip", "json_bytes": info.file_size}


def validate_candidate(path: str | Path) -> dict[str, Any]:
    p = Path(path).expanduser().resolve()
    archive = safe_zip(p)
    digest = sha256(p)
    return {"path": str(p), "sha256": digest, "bytes": p.stat().st_size, **archive}


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


class Queue:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.state_path = self.root / "aic_leaderboard_state.json"

    def read(self) -> dict[str, Any]:
        state = load_json(self.state_path, {"schemaVersion": SCHEMA_VERSION, "queue": []})
        if state.get("schemaVersion") != SCHEMA_VERSION or not isinstance(state.get("queue"), list):
            raise ValueError("queue schema mismatch")
        return state

    def write(self, state: dict[str, Any]) -> None:
        atomic_write(self.state_path, state)

    def status(self) -> dict[str, Any]:
        state = self.read()
        active = [x for x in state["queue"] if x.get("status") in BLOCKING]
        return {"schemaVersion": SCHEMA_VERSION, "state": "blocked" if active else "idle",
                "active": active[0] if active else None,
                "counts": {s: sum(x.get("status") == s for x in state["queue"])
                            for s in {x.get("status", "queued") for x in state["queue"]}},
                "queue": state["queue"]}

    def enqueue(self, candidate: str | Path, *, stage: str, team: str) -> dict[str, Any]:
        meta = validate_candidate(candidate)
        state = self.read()
        for item in state["queue"]:
            if item.get("sha256") == meta["sha256"] and item.get("stage") == stage:
                raise ValueError("candidate already exists in this stage")
        item = {"id": str(uuid.uuid4()), "createdAt": now(), "status": "queued",
                "stage": stage, "team": team, **meta}
        state["queue"].append(item)
        self.write(state)
        return item
