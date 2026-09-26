"""One-command automatic AIC leaderboard submission (复赛 / 半决赛).

    python -m aic_leaderboard.auto submit <result.zip> --dry-run
    python -m aic_leaderboard.auto submit <result.zip> --team YOUR_TEAM --confirm-real-submit
    python -m aic_leaderboard.auto submit --pick-best runs/semi_merged_v2 --dry-run
    python -m aic_leaderboard.auto status

Every step that used to be a manual instruction is performed here, in order, and
each one has a hard guard in front of it:

===========  ==========================================================
 0  guards    deadline / daily quota / duplicate sha256      (``ledger``)
 1  browser   probe the Playwright debugging pipe (CDP is an optional backend)
 2  login     detect the login wall, then WAIT for the human, auto-continue
 3  validate  ``core.validate_candidate`` (UTF-8 safe)
 4  enqueue   ``Queue.enqueue(stage, team)``
 5  submit    ``cli submit --confirm-real-submit``  <- the only step that clicks
 6  capture   poll the leaderboard for the NEW row, archive the evidence
 7  ledger    append one record so the guards hold on the next run
===========  ==========================================================

The human is only needed once, for the CAS login inside the dedicated Chrome
profile.  Everything after that -- including waiting for the platform to
evaluate and recording the score -- runs unattended.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import ledger
from .core import Queue, sha256 as file_sha256, validate_candidate

ROOT = Path(
    os.environ.get("AIC_LEADERBOARD_ROOT") or Path(__file__).resolve().parent.parent
).expanduser().resolve()
CDP_URL = (os.environ.get("AIC_LEADERBOARD_DEBUG_URL") or "http://127.0.0.1:9222").rstrip("/")
TEAM_DEFAULT = os.environ.get("AIC_LEADERBOARD_TEAM_ID") or ""
STAGE_DEFAULT = "semi"
BROWSER_BACKEND = os.environ.get("AIC_LEADERBOARD_BROWSER", "pipe").lower()
CDP_JS = ROOT / "tools" / ("leaderboard_pipe.mjs" if BROWSER_BACKEND == "pipe" else "leaderboard_cdp.mjs")
CHROME_PS1 = ROOT / "tools" / "start_leaderboard_chrome.ps1"
REPORT_DIR = ROOT / "auto_submit"

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_LOGIN_TIMEOUT = 2
EXIT_NO_BROWSER = 3
EXIT_GUARD_REFUSED = 4
EXIT_SUBMIT_REJECTED = 5
EXIT_SCORE_TIMEOUT = 6

#: rc -> (status, human readable) for browser submit-one helpers
SUBMIT_RC = {
    0: ("accepted", "clicked and accepted by the platform form"),
    2: ("login_required", "LOGIN_REQUIRED: finish login in the Chrome window"),
    3: ("page_not_ready", "SUBMIT_PAGE_NOT_READY / NO_FILE_INPUT"),
    4: ("upload_not_ready", "the uploaded file never became ready on the form"),
    5: ("no_click", "SUBMIT_NOT_DISPATCHED: no submit button was clicked"),
    6: ("rejected", "SUBMIT_REJECTED_OR_STALE: the platform refused it"),
    77: ("gate_rejected", "the local submit fence refused (confirm/hash mismatch)"),
}

# "19 | AIC-2026-93096493 | 鱼不吃猫 | 2026-09-16 10:38:45 | 98.6500 | 2026-09-16 10:38:54"
ROW_RE = re.compile(
    r"(?P<team>AIC-\d{4}-\d+)\s*\|\s*(?P<name>[^|\n]+?)\s*\|\s*"
    r"(?P<submitted>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\|\s*"
    r"(?P<score>\d+(?:\.\d+)?)\s*\|\s*"
    r"(?P<evaluated>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"
)
TS_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")


# --------------------------------------------------------------------------- io


def say(step: str, message: str) -> None:
    print(f"[{step}] {message}", flush=True)


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def node_exe() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for candidate in (
        Path(r"C:\Program Files\nodejs\node.exe"),
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def child_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() != "PYTHONIOENCODING"}
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["AIC_LEADERBOARD_ROOT"] = str(ROOT)
    node = node_exe()
    if node:
        env["PATH"] = str(Path(node).parent) + os.pathsep + env.get("PATH", "")
    env.update({k: v for k, v in extra.items() if v is not None})
    return env


def run_node(args: list[str], *, env: dict[str, str], inherit: bool, timeout: float | None = None):
    node = node_exe()
    if not node:
        raise RuntimeError("node executable not found on PATH")
    cmd = [node, str(CDP_JS), *args]
    if inherit:
        return subprocess.run(cmd, cwd=ROOT, env=env).returncode, ""
    proc = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    return proc.returncode, (proc.stdout or "")


def extract_last_json(text: str) -> dict[str, Any] | None:
    """The CDP script prints progress lines and then one pretty JSON object."""
    for i in range(len(text) - 1, -1, -1):
        if text[i] != "{":
            continue
        try:
            value = json.loads(text[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def parse_rows(text: str, team: str | None) -> list[dict[str, Any]]:
    rows = [m.groupdict() for m in ROW_RE.finditer(text or "")]
    if team:
        rows = [r for r in rows if r["team"] == team]
    for row in rows:
        row["score"] = float(row["score"])
    return rows


def newest_row(text: str, team: str | None) -> dict[str, Any] | None:
    rows = parse_rows(text, team)
    if rows:
        return max(rows, key=lambda r: r["submitted"])
    # Tolerate a layout change: any line carrying the team id plus a score.
    if team:
        for line in (text or "").splitlines():
            if team not in line:
                continue
            stamp = TS_RE.search(line)
            score = re.search(r"\d+\.\d+", line)
            if stamp and score:
                return {"team": team, "submitted": stamp.group(0), "score": float(score.group(0)),
                        "evaluated": "", "name": "", "raw": line.strip()}
    return None


# ------------------------------------------------------------------------ steps


def step_cdp(*, launch: bool, timeout: float, url: str | None = None) -> tuple[bool, str]:
    global CDP_URL
    if BROWSER_BACKEND == "pipe":
        if not launch:
            return False, "--no-launch-chrome cannot be used with the pipe browser"
        try:
            rc, out = run_node(["probe"], env=child_env(), inherit=False, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f"Chrome pipe probe failed: {type(exc).__name__}: {exc}"
        payload = extract_last_json(out) or {}
        return rc == 0 and payload.get("ok") is True, payload.get("reason") or f"pipe probe exited {rc}"
    if url:
        CDP_URL = url.rstrip("/")

    state = cdp_state(timeout=3)
    if state["http"]:
        say("cdp", f"debug port already up at {CDP_URL}")
        return True, "already-up"

    profile = Path(os.environ.get("AIC_LEADERBOARD_CHROME_PROFILE")
                   or Path(os.environ.get("TEMP", ".")) / "aic_leaderboard_chrome_profile")
    if state["tcp"]:
        # The port answers TCP but not HTTP.  Either the DevTools endpoint is
        # wedged, or something between us and it swallows loopback HTTP (a
        # sandboxed agent sees exactly this).  Relaunching would fail on the
        # profile singleton lock, so report it and stop.
        say("cdp", f"WARNING: {CDP_URL} accepts TCP but never answers HTTP; "
                   "reusing it and NOT relaunching Chrome (relaunch would hit the profile lock)")
        return False, "CDP port accepts TCP but HTTP is unreachable; browser control unavailable"

    if not launch:
        return False, f"CDP down and --no-launch-chrome set (profile would be {profile})"
    if not CHROME_PS1.is_file():
        return False, f"launcher missing: {CHROME_PS1}"

    say("cdp", f"debug port down; launching the battle Chrome (profile {profile})")
    if not profile.exists():
        say("cdp", "this profile does not exist yet -> the first run needs a MANUAL CAS login")
    # -Restart makes the launch idempotent: a stale instance holding the profile
    # singleton lock would otherwise make Chrome abort and the port stay dark.
    launch = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(CHROME_PS1), "-Restart"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
    )
    detail = (launch.stdout or "").strip() or (launch.stderr or "").strip()
    if launch.returncode != 0:
        say("cdp", f"launcher exited {launch.returncode}: {detail[:400]}")

    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if cdp_alive(timeout=3):
            say("cdp", f"debug port up after {int(time.monotonic() - start)}s")
            return True, "launched"
        time.sleep(3)
    tail = f" launcher said: {detail[:200]}" if detail else ""
    return False, (f"Chrome did not expose {CDP_URL} within {int(timeout)}s.{tail} "
                   "If Chrome did open, this caller may be sandboxed away from loopback HTTP -- "
                   "run the command from your own terminal instead.")


def cdp_state(timeout: float = 3) -> dict[str, Any]:
    """Probe the DevTools endpoint two ways.

    HTTP is authoritative, but a sandboxed caller can connect to the port and
    still never get a response -- the socket accepts and the request is
    swallowed.  Treating that as "CDP is down" would make the caller relaunch
    Chrome, which then dies on the profile singleton lock.  So TCP is a second
    opinion, not a fallback for correctness.
    """
    host, port = "127.0.0.1", 9222
    match = re.match(r"https?://([^:/]+):(\d+)", CDP_URL)
    if match:
        host, port = match.group(1), int(match.group(2))

    http_ok = False
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=timeout) as resp:
            http_ok = resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        http_ok = False

    tcp_ok = False
    if not http_ok:
        import socket
        try:
            with socket.create_connection((host, port), timeout=timeout):
                tcp_ok = True
        except OSError:
            tcp_ok = False
    return {"url": CDP_URL, "http": http_ok, "tcp": tcp_ok,
            "detail": "http" if http_ok else ("tcp-only" if tcp_ok else "down")}


def cdp_alive(timeout: float = 3) -> bool:
    state = cdp_state(timeout)
    return bool(state["http"])


def step_login(*, team: str, timeout: float) -> tuple[bool, str]:
    rc, out = run_node(["heartbeat"], env=child_env(AIC_LEADERBOARD_TEAM_ID=team),
                       inherit=False, timeout=180)
    payload = extract_last_json(out) or {}
    reason = payload.get("reason") or ("ready" if rc == 0 else "unknown")
    say("login", f"heartbeat rc={rc} reason={reason}")

    if rc == 0:
        return True, reason
    if reason != "login" and rc != 2:
        return False, f"submit page unhealthy: {reason}"

    say("login", "=" * 62)
    say("login", "MANUAL STEP: finish the 统一身份认证 login in the Chrome window.")
    say("login", f"I am watching the page and will continue automatically (up to {int(timeout)}s).")
    say("login", "=" * 62)
    rc2, _ = run_node(["wait-login", str(int(timeout * 1000))], env=child_env(), inherit=True)
    if rc2 != 0:
        return False, "login wait timed out or aborted"
    rc3, out3 = run_node(["heartbeat"], env=child_env(AIC_LEADERBOARD_TEAM_ID=team),
                         inherit=False, timeout=180)
    say("login", f"post-login heartbeat rc={rc3}")
    return rc3 == 0, "logged-in" if rc3 == 0 else "still unhealthy after login"


def step_capture(*, team: str, previous: str | None, timeout: float) -> dict[str, Any] | None:
    """Poll the leaderboard until a row newer than ``previous`` shows a score."""
    start = time.monotonic()
    attempt = 0
    while time.monotonic() - start < timeout:
        attempt += 1
        elapsed = int(time.monotonic() - start)
        say("capture", f"attempt {attempt} (elapsed {elapsed}s / {int(timeout)}s)")
        try:
            _, out = run_node(["leaderboard"], env=child_env(AIC_LEADERBOARD_TEAM_ID=team),
                              inherit=False, timeout=360)
        except subprocess.TimeoutExpired:
            say("capture", "leaderboard call timed out; retrying")
            continue
        payload = extract_last_json(out) or {}
        text = payload.get("text") or out
        row = newest_row(text, team)
        if row:
            say("capture", f"row: {row.get('submitted')} score={row.get('score')}")
            if previous is None or row["submitted"] > previous:
                return row
            say("capture", f"row is not newer than the last known one ({previous}); waiting for evaluation")
        else:
            say("capture", "no row for our team yet")
        time.sleep(20)
    return None


def result_row(payload: dict[str, Any], *, team: str, stage: str,
               expected_sha256: str, since: str | None) -> dict[str, Any] | None:
    """Attribute an account result only after the server attachment hash matches."""
    record = payload.get("record") or {}
    if (not payload.get("ok") or record.get("team") != team or record.get("stage") != stage
            or record.get("status") != "DONE" or record.get("attachmentMatches") is not True
            or record.get("attachmentSha256") != expected_sha256):
        return None
    evaluated = record.get("evaluated")
    score = record.get("score")
    if not evaluated or not isinstance(score, (int, float)) or isinstance(score, bool):
        return None
    if since:
        try:
            actual = datetime.fromisoformat(evaluated.replace("Z", "+00:00"))
            threshold = datetime.fromisoformat(since.replace("Z", "+00:00"))
            if actual.tzinfo is None:
                actual = actual.replace(tzinfo=ledger.CN)
            if threshold.tzinfo is None:
                threshold = threshold.replace(tzinfo=ledger.CN)
            if actual <= threshold:
                return None
        except ValueError:
            return None
    return {"team": team, "submitted": None, "score": float(score),
            "evaluated": evaluated, "name": record.get("title") or "",
            "status": record["status"], "failure_reason": record.get("failureReason") or "",
            "attachment_sha256": record["attachmentSha256"], "raw": record}


def step_capture_result(*, team: str, stage: str, expected_sha256: str,
                        since: str | None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    rc, out = run_node(["result-records"],
                       env=child_env(AIC_LEADERBOARD_TEAM_ID=team,
                                     AIC_LEADERBOARD_STAGE=stage,
                                     AIC_LEADERBOARD_EXPECTED_SHA256=expected_sha256),
                       inherit=False, timeout=120)
    payload = extract_last_json(out) or {"ok": False, "reason": "no_result_payload", "returncode": rc}
    return result_row(payload, team=team, stage=stage,
                      expected_sha256=expected_sha256, since=since), payload


def resolve_candidate(args: argparse.Namespace) -> Path:
    if args.candidate:
        return Path(args.candidate).expanduser().resolve()
    if args.pick_best:
        ranked = rank_candidates(args.pick_best)
        if not ranked:
            raise SystemExit(f"--pick-best found no candidate under {args.pick_best}")
        for entry in ranked:
            say("best", f"{entry['score'] if entry['score'] is not None else '-'}  {entry['zip']}")
        say("best", f"-> {ranked[0]['zip']}")
        return ranked[0]["zip"]
    raise SystemExit("give a candidate zip or --pick-best <dir|zip>")


def rank_candidates(paths: list[str]) -> list[dict[str, Any]]:
    """Rank local estimates, excluding packages officially marked infeasible."""
    entries: list[dict[str, Any]] = []
    for raw in paths:
        p = Path(raw).expanduser().resolve()
        if p.is_dir():
            zips = sorted(p.glob("复赛结果_*.zip")) or sorted(p.glob("*.zip"))
            score = None
            for name in ("score_official.json", "validation_report.json", "local_score.json"):
                score_file = p / name
                if score_file.is_file():
                    try:
                        blob = json.loads(score_file.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    for key in ("score_capped_after_penalty", "score_capped_display_after_penalty",
                                "score", "score_capped"):
                        if isinstance(blob.get(key), (int, float)):
                            score = float(blob[key])
                            break
                    if score is None and isinstance(blob.get("calibrated_prediction"), dict):
                        predicted = blob["calibrated_prediction"].get("score_capped")
                        if isinstance(predicted, (int, float)):
                            score = float(predicted)
                    if score is not None:
                        break
            for z in zips:
                if not officially_infeasible(z):
                    entries.append({"zip": z, "score": score, "dir": str(p), "mtime": z.stat().st_mtime})
        elif p.suffix.lower() in {".zip", ".rar"}:
            if not officially_infeasible(p):
                entries.append({"zip": p, "score": None, "dir": str(p.parent), "mtime": p.stat().st_mtime})
    entries.sort(key=lambda e: (e["score"] if e["score"] is not None else float("-inf"), e["mtime"]),
                 reverse=True)
    return entries


def officially_infeasible(candidate: Path) -> bool:
    feedback = candidate.parent / "official_feedback.json"
    if not feedback.is_file():
        return False
    try:
        record = json.loads(feedback.read_text(encoding="utf-8"))
        return (record.get("infeasible") is True and record.get("sha256") == file_sha256(candidate))
    except (OSError, json.JSONDecodeError):
        return False


def local_score_beside(zip_path: Path) -> float | None:
    for entry in rank_candidates([str(zip_path.parent)]):
        if entry["zip"] == zip_path:
            return entry["score"]
    return None


# ------------------------------------------------------------------------- main


def cmd_status(args: argparse.Namespace) -> int:
    print(json.dumps({"guards": ledger.guards(ROOT, stage=args.stage),
                      "ledger": ledger.summary(ROOT, args.stage),
                      "browser": {"backend": BROWSER_BACKEND, "probe":
                                  {"detail": "run submit --dry-run to test the pipe"} if BROWSER_BACKEND == "pipe"
                                  else cdp_state()},
                      "node": node_exe()}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_submit(args: argparse.Namespace) -> int:
    if not args.team:
        say("guard", "set --team or AIC_LEADERBOARD_TEAM_ID before submitting")
        return EXIT_GUARD_REFUSED
    report: dict[str, Any] = {"startedAt": ledger.now_cn().isoformat(timespec="seconds"),
                              "stage": args.stage, "team": args.team, "dryRun": args.dry_run}
    candidate = resolve_candidate(args)
    report["candidate"] = str(candidate)
    say("cand", str(candidate))

    # ---- 0. guards -------------------------------------------------------
    meta = validate_candidate(candidate)
    report["sha256"] = meta["sha256"]
    report["bytes"] = meta["bytes"]
    state = ledger.guards(ROOT, sha256=meta["sha256"], stage=args.stage)
    report["guards"] = state
    say("guard", f"sha256 {meta['sha256'][:16]}  {meta['bytes']} bytes  entries={meta.get('entries')}")
    say("guard", f"spent today {state['spent_today']}/{state['daily_limit']}, "
                 f"{state['hours_left']}h to deadline, best={state['best_score']}")
    if state["blocked"]:
        say("guard", "REFUSED: " + "; ".join(state["reasons"]))
        if not args.force:
            report["outcome"] = "guard_refused"
            write_report(report)
            return EXIT_GUARD_REFUSED
        say("guard", "--force given; overriding the guards")
    if args.retry_unverified and not args.force:
        say("guard", "--retry-unverified requires --force and an externally checked mismatch")
        report["outcome"] = "guard_refused"
        write_report(report)
        return EXIT_GUARD_REFUSED

    # ---- 1/2. browser + login -------------------------------------------
    if args.no_browser:
        say("cdp", "skipped (--no-browser)")
    else:
        ok, why = step_cdp(launch=not args.no_launch_chrome, timeout=args.launch_timeout,
                           url=args.cdp_url)
        report["cdp"] = why
        say("cdp", why)
        if not ok:
            report["outcome"] = "no_browser"
            write_report(report)
            return EXIT_NO_BROWSER
        if not args.dry_run:
            ok, why = step_login(team=args.team, timeout=args.login_timeout)
            report["login"] = why
            if not ok:
                say("login", f"FAILED: {why}")
                report["outcome"] = "login_failed"
                write_report(report)
                return EXIT_LOGIN_TIMEOUT

    # ---- 3/4. enqueue ----------------------------------------------------
    queue = Queue(ROOT)
    try:
        item = queue.enqueue(candidate, stage=args.stage, team=args.team)
    except ValueError as exc:
        if "already exists" not in str(exc):
            raise
        item = next((x for x in queue.read()["queue"]
                     if x.get("sha256") == meta["sha256"] and x.get("stage") == args.stage), None)
        if item is None:
            raise
        say("queue", f"already queued as {item['id']} (reusing it)")
    report["candidateId"] = item["id"]
    say("queue", f"id={item['id']} status={item.get('status')}")

    previous = ledger.newest_submission_time(ROOT) or item.get("submitted_at")

    # ---- 5. the only step that clicks ------------------------------------
    cli = [sys.executable, "-X", "utf8", "-m", "aic_leaderboard.cli", "--root", str(ROOT),
           "submit", "--id", item["id"]]
    if not args.dry_run:
        cli.append("--confirm-real-submit")
        if args.retry_unverified:
            cli.append("--retry-unverified")
    say("submit", "clicking the submit button" if not args.dry_run else "DRY RUN: not clicking")
    proc = subprocess.run(cli, cwd=ROOT, env=child_env(AIC_LEADERBOARD_TEAM_ID=args.team),
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=args.submit_timeout)
    if proc.stdout:
        print(proc.stdout, flush=True)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, flush=True)
    result = extract_last_json(proc.stdout or "") or {}
    report["submit"] = result

    if args.dry_run:
        status = "dry_run"
    else:
        rc = result.get("returncode")
        if rc is None:
            current = next((x for x in queue.read()["queue"] if x.get("id") == item["id"]), {})
            status = "no_click" if current.get("status") in {"queued", "no_click"} else "outcome_unknown"
            why = "submit process failed before a click" if status == "no_click" else "submit outcome uncertain"
        else:
            status, why = SUBMIT_RC.get(rc, (f"unknown_rc_{rc}", "unrecognised exit code"))
            status = result.get("item", {}).get("status", status)
        say("submit", f"rc={rc} -> {status} ({why})")

    report["status"] = status

    # ---- 6. capture ------------------------------------------------------
    row = None
    clicked_match = re.search(r"SUBMIT_CLICKED_AT=(\S+)", result.get("browser_stdout") or "")
    clicked_at = clicked_match.group(1) if clicked_match else None
    if status == "accepted" and not args.no_browser and args.score_timeout > 0:
        if BROWSER_BACKEND == "pipe":
            say("capture", "reading the account result page and checking the saved ZIP hash")
            row, snapshot = step_capture_result(team=args.team, stage=args.stage,
                                                expected_sha256=meta["sha256"],
                                                since=clicked_at or previous)
            report["resultRecord"] = snapshot
        else:
            say("capture", f"waiting for a new leaderboard row (prev={previous})")
            row = step_capture(team=args.team, previous=previous, timeout=args.score_timeout)
        report["leaderboardRow"] = row
    report["localScore"] = local_score_beside(candidate)

    # ---- 7. ledger -------------------------------------------------------
    entry = ledger.append(ROOT, {
        "stage": args.stage, "team": args.team, "path": str(candidate),
        "sha256": meta["sha256"], "bytes": meta["bytes"], "candidateId": item["id"],
        "dry_run": args.dry_run, "status": status,
        "clicked_at": clicked_at,
        "submit_rc": report.get("submit", {}).get("returncode"),
        "submitted_at": (row or {}).get("submitted"),
        "score": (row or {}).get("score"),
        "rank": None, "evaluated_at": (row or {}).get("evaluated"),
        "local_score": report["localScore"], "raw_row": (row or {}).get("raw"),
        "failure_reason": (row or {}).get("failure_reason"),
    })
    report["ledger"] = entry
    say("ledger", f"recorded status={status} score={(row or {}).get('score')}")

    # Close the queue item.  Nothing else did, so it sat at `accepted` for ever --
    # and `accepted` is in core.BLOCKING, which means ONE scored submission blocks
    # every later one.  The 2026-09-26 15:45 submission did exactly that: the
    # queue read `blocked` afterwards and the next submission would have been
    # refused, while the ledger and the platform both already had the result.
    # `scored` once a score is attributed, `awaiting_score` while it is not --
    # the latter stays blocking on purpose, the former must not.
    if not args.dry_run and status == "accepted":
        state = queue.read()
        for entry in state["queue"]:
            if entry.get("id") == item["id"]:
                entry["status"] = "scored" if row is not None else "awaiting_score"
                entry["score"] = (row or {}).get("score")
                entry["evaluated_at"] = (row or {}).get("evaluated")
                entry["closed_at"] = datetime.now(timezone.utc).isoformat(
                    timespec="seconds").replace("+00:00", "Z")
                break
        queue.write(state)
        say("queue", f"closed id={item['id']} as {entry.get('status')}")

    if args.dry_run:
        report["outcome"] = "dry_run"
        write_report(report)
        return EXIT_OK
    if status != "accepted":
        report["outcome"] = status
        write_report(report)
        return EXIT_SUBMIT_REJECTED
    if row is None:
        report["outcome"] = "submitted_score_pending"
        write_report(report)
        say("done", "submission accepted but no scored row appeared yet; rerun `auto capture` later")
        return EXIT_SCORE_TIMEOUT
    report["outcome"] = "submitted_and_scored"
    write_report(report)
    say("done", f"score {row['score']} at {row['submitted']}")
    return EXIT_OK


def cmd_capture(args: argparse.Namespace) -> int:
    if not args.team:
        print(json.dumps({"error": "set --team or AIC_LEADERBOARD_TEAM_ID"}, ensure_ascii=False))
        return EXIT_GUARD_REFUSED
    history = ledger.read(ROOT)
    pending = next((r for r in reversed(history) if r.get("stage") == args.stage and
                    r.get("team") == args.team and r.get("status") == "accepted" and
                    r.get("sha256")), None)
    if BROWSER_BACKEND == "pipe":
        if pending is None:
            print(json.dumps({"error": "no accepted candidate to attribute"}, ensure_ascii=False))
            return EXIT_SCORE_TIMEOUT
        scored = next((r for r in reversed(history) if r.get("sha256") == pending["sha256"]
                       and r.get("score") is not None and r.get("evaluated_at")), None)
        if scored:
            print(json.dumps({"already_captured": scored}, ensure_ascii=False, indent=2))
            return EXIT_OK
        previous = args.since or pending.get("clicked_at") or pending.get("at")
        say("capture", f"reading account results after {previous}")
        row, snapshot = step_capture_result(team=args.team, stage=args.stage,
                                            expected_sha256=pending["sha256"], since=previous)
        if row is None:
            print(json.dumps({"error": "no hash-matched DONE result yet", "resultRecord": snapshot},
                             ensure_ascii=False, indent=2))
            return EXIT_SCORE_TIMEOUT
    else:
        previous = args.since or ledger.newest_submission_time(ROOT)
        say("capture", f"waiting for a row newer than {previous}")
        row = step_capture(team=args.team, previous=previous, timeout=args.score_timeout)
    if row:
        best_before = ledger.best(ROOT, args.stage)
        ledger.append(ROOT, {"stage": args.stage, "team": args.team, "status": "score_captured",
                             "submitted_at": row.get("submitted"), "score": row.get("score"),
                             "evaluated_at": row.get("evaluated"), "raw_row": row.get("raw"),
                             "sha256": pending.get("sha256") if pending else None,
                             "failure_reason": row.get("failure_reason"),
                             "note": "captured by `auto capture`"})
        print(json.dumps({"row": row, "best_before": (best_before or {}).get("score"),
                          "delta": (row["score"] - best_before["score"]) if best_before and
                          best_before.get("score") is not None else None}, ensure_ascii=False, indent=2))
        return EXIT_OK
    print(json.dumps({"error": "no scored row appeared before the timeout"}, ensure_ascii=False, indent=2))
    return EXIT_SCORE_TIMEOUT


def write_report(report: dict[str, Any]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = REPORT_DIR / f"auto_submit_{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(path), "outcome": report.get("outcome"),
                      "status": report.get("status"), "score": (report.get("leaderboardRow") or {}).get("score")},
                     ensure_ascii=False, indent=2), flush=True)
    return path


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="aic_leaderboard.auto", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--stage", default=STAGE_DEFAULT)
        p.add_argument("--team", default=TEAM_DEFAULT)

    s = sub.add_parser("submit", help="run the whole guarded pipeline")
    s.add_argument("candidate", nargs="?")
    s.add_argument("--pick-best", nargs="+", metavar="DIR|ZIP",
                   help="choose the highest locally-scored package under these paths")
    common(s)
    s.add_argument("--dry-run", action="store_true", help="everything except the click")
    s.add_argument("--force", action="store_true", help="override the ledger guards")
    s.add_argument("--retry-unverified", action="store_true",
                   help="retry a queue item marked outcome_unknown after verifying the first file was not saved")
    s.add_argument("--no-browser", action="store_true", help="skip CDP, login and score capture")
    s.add_argument("--no-launch-chrome", action="store_true")
    s.add_argument("--cdp-url", help=f"DevTools endpoint (default {CDP_URL})")
    s.add_argument("--launch-timeout", type=float, default=90.0)
    s.add_argument("--login-timeout", type=float, default=600.0)
    s.add_argument("--submit-timeout", type=float, default=1800.0)
    s.add_argument("--score-timeout", type=float, default=1800.0)
    s.add_argument("--confirm-real-submit", action="store_true",
                   help="explicitly acknowledge that this clicks the real submit button")
    s.set_defaults(func=cmd_submit)

    c = sub.add_parser("capture", help="read account result and verify the submitted ZIP hash")
    common(c)
    c.add_argument("--since", help="only accept rows submitted after this stamp")
    c.add_argument("--score-timeout", type=float, default=1800.0)
    c.set_defaults(func=cmd_capture)

    st = sub.add_parser("status", help="guards + ledger + environment, no side effects")
    st.add_argument("--stage", default=STAGE_DEFAULT)
    st.set_defaults(func=cmd_status)
    return ap


def main(argv: list[str] | None = None) -> int:
    _force_utf8()
    args = build_parser().parse_args(argv)
    if getattr(args, "cmd", None) == "submit" and not args.dry_run and not args.confirm_real_submit:
        say("guard", "refusing to click without --confirm-real-submit (use --dry-run to rehearse)")
        return EXIT_GUARD_REFUSED
    try:
        return args.func(args)
    except KeyboardInterrupt:
        say("abort", "interrupted")
        return EXIT_ERROR
    except Exception as exc:  # noqa: BLE001 - top level guard, the report matters more than the trace
        say("error", f"{type(exc).__name__}: {exc}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
