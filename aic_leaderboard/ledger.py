"""Submission ledger: the hard guards in front of a real leaderboard submit.

The MCP and the CLI can both drive a browser click, but neither knows anything
about the competition's submission rules.  This module is that knowledge, kept
in one append-only file so a crash can never lose the count:

* a round closes at a fixed wall-clock time (semi-final: 2026-10-05 20:00 +08:00);
* at most ``AIC_DAILY_SUBMIT_LIMIT`` (default 5) real submissions per calendar
  day, counted in competition local time;
* the same archive is never uploaded twice within one stage -- re-uploading
  burns a daily slot and cannot improve the score, because the round keeps the
  best result.

The ledger is JSONL, not JSON, so an interrupted write can only damage the last
line, and :func:`read` skips a torn line instead of refusing to start.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

CN = timezone(timedelta(hours=8))
DEFAULT_DEADLINE = "2026-10-05T20:00:00+08:00"
DEFAULT_DAILY_LIMIT = 5
LEDGER_NAME = "submission_ledger.jsonl"

#: Statuses that consumed (or probably consumed) a daily slot.  ``outcome_unknown``
#: is deliberately included: the click may have landed, so counting it is the
#: conservative side of the quota.
SPENT = {
    "submitting",
    "submitted",
    "accepted",
    "unconfirmed",
    "awaiting_score",
    "outcome_unknown",
}


def ledger_path(root: str | Path) -> Path:
    return Path(root).expanduser().resolve() / LEDGER_NAME


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=CN)


def now_cn() -> datetime:
    return datetime.now(CN)


def deadline() -> datetime:
    return _parse_dt(os.environ.get("AIC_LEADERBOARD_DEADLINE") or DEFAULT_DEADLINE)


def daily_limit() -> int:
    raw = os.environ.get("AIC_DAILY_SUBMIT_LIMIT")
    try:
        return max(0, int(raw)) if raw else DEFAULT_DAILY_LIMIT
    except ValueError:
        return DEFAULT_DAILY_LIMIT


def read(root: str | Path) -> list[dict[str, Any]]:
    path = ledger_path(root)
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn tail from an interrupted write is skipped, not fatal
    return records


def append(root: str | Path, record: dict[str, Any]) -> dict[str, Any]:
    path = ledger_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"at": now_cn().isoformat(timespec="seconds"), **record}
    with path.open("a", encoding="utf-8", newline="") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return payload


def spent_today(root: str | Path, *, stage: str | None = None) -> list[dict[str, Any]]:
    today = now_cn().date()
    out = []
    for record in read(root):
        if record.get("dry_run") or record.get("status") not in SPENT:
            continue
        if stage and record.get("stage") != stage:
            continue
        try:
            if _parse_dt(record["at"]).date() == today:
                out.append(record)
        except (KeyError, ValueError):
            continue
    return out


def seen(root: str | Path, sha256: str | None, stage: str | None) -> dict[str, Any] | None:
    """A real submission of these exact bytes in this stage, if any."""
    if not sha256:
        return None
    for record in read(root):
        if record.get("dry_run") or record.get("status") not in SPENT:
            continue
        if record.get("sha256") == sha256 and (stage is None or record.get("stage") == stage):
            return record
    return None


def best(root: str | Path, stage: str | None = None) -> dict[str, Any] | None:
    rows = [r for r in read(root) if r.get("score") is not None and (not stage or r.get("stage") == stage)]
    return max(rows, key=lambda r: r["score"]) if rows else None


def newest_submission_time(root: str | Path) -> str | None:
    """Latest platform submission timestamp we have already seen, for new-row detection."""
    stamps = [r["submitted_at"] for r in read(root) if r.get("submitted_at")]
    return max(stamps) if stamps else None


def guards(root: str | Path, *, sha256: str | None = None, stage: str | None = None) -> dict[str, Any]:
    """Pre-flight: what would block a real submission right now.  No side effects."""
    close = deadline()
    now = now_cn()
    used = spent_today(root, stage=stage)
    limit = daily_limit()
    duplicate = seen(root, sha256, stage)
    best_row = best(root, stage)

    reasons: list[str] = []
    if now > close:
        reasons.append(f"ROUND_CLOSED:{close.isoformat()}")
    if len(used) >= limit:
        reasons.append(f"DAILY_LIMIT_REACHED:{len(used)}/{limit}")
    if duplicate:
        reasons.append(f"ALREADY_SUBMITTED:{duplicate.get('at')}")

    return {
        "now": now.isoformat(timespec="seconds"),
        "deadline": close.isoformat(),
        "hours_left": round((close - now).total_seconds() / 3600, 1),
        "daily_limit": limit,
        "spent_today": len(used),
        "remaining_today": max(0, limit - len(used)),
        "already_submitted": duplicate,
        "best_score": (best_row or {}).get("score"),
        "best_score_at": (best_row or {}).get("at"),
        "records": len(read(root)),
        "blocked": bool(reasons),
        "reasons": reasons,
    }


def summary(root: str | Path, stage: str | None = None) -> dict[str, Any]:
    records = read(root)
    rows = [r for r in records if not r.get("dry_run") and r.get("status") in SPENT]
    return {
        "ledger": str(ledger_path(root)),
        "records": len(records),
        "real_submissions": len(rows),
        "by_status": {s: sum(r.get("status") == s for r in records) for s in sorted({r.get("status") for r in records}) if s},
        "today": len(spent_today(root, stage=stage)),
        "best": best(root, stage),
        "last": records[-1] if records else None,
    }
