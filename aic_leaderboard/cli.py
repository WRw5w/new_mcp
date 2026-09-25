from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from .core import Queue, validate_candidate


def submission_status(returncode: int, click_attempted: bool) -> str:
    if returncode == 0:
        return "accepted"
    return "outcome_unknown" if click_attempted else "no_click"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Portable AIC submission queue")
    ap.add_argument("--root", default=os.environ.get("AIC_LEADERBOARD_ROOT", "."))
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("candidate")
    e = sub.add_parser("enqueue"); e.add_argument("candidate"); e.add_argument("--stage", required=True); e.add_argument("--team", required=True)
    sub.add_parser("status")
    s = sub.add_parser("submit"); s.add_argument("--id", required=True); s.add_argument("--confirm-real-submit", action="store_true")
    s.add_argument("--retry-unverified", action="store_true",
                   help="retry an outcome_unknown queue item after external verification")
    c = sub.add_parser("capture"); c.add_argument("--id", required=True)
    args = ap.parse_args(argv)
    q = Queue(args.root)
    if args.cmd == "validate": out = validate_candidate(args.candidate)
    elif args.cmd == "enqueue": out = q.enqueue(args.candidate, stage=args.stage, team=args.team)
    elif args.cmd == "status": out = q.status()
    elif args.cmd == "capture":
        state = q.read(); item = next((x for x in state["queue"] if x["id"] == args.id), None)
        if item is None: raise SystemExit("unknown candidate id")
        if item.get("status") not in {"accepted", "awaiting_score", "outcome_unknown"}:
            raise SystemExit("candidate is not ready for score capture")
        env = {**os.environ, "AIC_LEADERBOARD_ROOT": str(q.root),
               "AIC_LEADERBOARD_TEAM_ID": item.get("team", "")}
        browser = "leaderboard_pipe.mjs" if os.environ.get("AIC_LEADERBOARD_BROWSER", "pipe") == "pipe" else "leaderboard_cdp.mjs"
        proc = subprocess.run(["node", str(q.root / "tools" / browser), "leaderboard"],
                              env=env, capture_output=True, text=True)
        evidence = q.root / "leaderboard_evidence" / f"{item['id']}.json"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps({"candidateId": item["id"], "candidateSha256": item["sha256"],
                                        "returncode": proc.returncode, "stdout": proc.stdout,
                                        "stderr": proc.stderr}, ensure_ascii=False, indent=2), encoding="utf-8")
        out = {"captured": proc.returncode == 0, "evidence": str(evidence), "candidate": item["id"]}
    else:
        state = q.read(); item = next((x for x in state["queue"] if x["id"] == args.id), None)
        if item is None: raise SystemExit("unknown candidate id")
        if not args.confirm_real_submit:
            out = {"dry_run": True, "would_submit": item, "message": "pass --confirm-real-submit to click the browser"}
        else:
            retry = args.retry_unverified and item.get("status") == "outcome_unknown"
            if item.get("status") not in {"queued", "no_click"} and not retry:
                raise SystemExit(f"candidate status {item.get('status')} cannot be submitted again")
            if q.status()["active"] and q.status()["active"]["id"] != item["id"]:
                raise SystemExit("another submission is active; refusing duplicate submit")
            if not os.environ.get("AIC_LEADERBOARD_SUBMIT_URL", "").startswith("https://reg.aicomp.cn/"):
                raise SystemExit("set AIC_LEADERBOARD_SUBMIT_URL to the full AIC submit page")
            if shutil.which("node") is None:
                raise SystemExit("Node.js is required for browser control")
            if validate_candidate(item["path"])["sha256"] != item["sha256"]:
                raise SystemExit("candidate bytes changed since enqueue")
            browser = "leaderboard_pipe.mjs" if os.environ.get("AIC_LEADERBOARD_BROWSER", "pipe") == "pipe" else "leaderboard_cdp.mjs"
            attempt_id = uuid.uuid4().hex
            env = {**os.environ, "AIC_LEADERBOARD_ROOT": str(q.root),
                   "AIC_LEADERBOARD_TEAM_ID": item["team"],
                   "AIC_LEADERBOARD_CONFIRM": "true",
                   "AIC_LEADERBOARD_ATTEMPT_ID": attempt_id,
                   "AIC_LEADERBOARD_FENCE_MODE": "local",
                   "AIC_LEADERBOARD_EXPECTED_SHA256": item["sha256"],
                   "AIC_LEADERBOARD_QUEUE_ID": item["id"],
                   "AIC_LEADERBOARD_SUBMIT_URL": os.environ.get("AIC_LEADERBOARD_SUBMIT_URL", ""),
                   "AIC_LEADERBOARD_LEADERBOARD_URL": os.environ.get("AIC_LEADERBOARD_LEADERBOARD_URL", "")}
            if browser == "leaderboard_pipe.mjs":
                probe = subprocess.run(["node", str(q.root / "tools" / browser), "probe"],
                                       env=env, capture_output=True, text=True, timeout=30)
                if probe.returncode:
                    raise SystemExit("Chrome debugging pipe is unavailable; queue state was not changed")
            item["status"] = "submitting"; q.write(state)
            proc = subprocess.run(["node", str(q.root / "tools" / browser), "submit-one", item["path"]],
                                  env=env, capture_output=True, text=True, errors="replace")
            attempted = (q.root / "submissions" / f"{item['id']}.{attempt_id}.attempt.json").exists() or \
                "SUBMIT_CLICK_ATTEMPTED_AT=" in proc.stdout or "SUBMIT_CLICKED_AT=" in proc.stdout
            item["status"] = submission_status(proc.returncode, attempted)
            q.write(state)
            out = {"returncode": proc.returncode, "item": item, "click_attempted": attempted,
                   "browser_stdout": proc.stdout[-4000:], "browser_stderr": proc.stderr[-4000:]}
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__": main()
