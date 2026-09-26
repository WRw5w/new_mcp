"""Minimal stdio MCP server exposing safe queue operations.

Mutating submission is intentionally unavailable through MCP until the caller
passes the exact candidate id and an explicit confirmation argument.

Three layers live here, cheapest first:

* ``aic_validate_candidate`` / ``aic_queue_status`` -- read only;
* ``aic_submission_plan`` / ``aic_submission_ledger`` -- read only, and they are
  what the competition rules say about a submission right now (deadline, daily
  quota, duplicate bytes);
* ``aic_auto_submit`` -- the whole guarded pipeline, including launching the
  battle Chrome, waiting out a manual login, and capturing the score;
  ``aic_submit_candidate`` stays as the low-level one-click escape hatch and
  does NOT consult the ledger.
"""
from __future__ import annotations
import json, os, sys, subprocess
from . import ledger
from .core import Queue, validate_candidate

ROOT = os.environ.get("AIC_LEADERBOARD_ROOT", ".")

def reply(i, result=None, error=None):
    msg = {"jsonrpc":"2.0", "id":i}
    if error:
        msg["error"] = {"code": -32602, "message": error}
    else:
        msg["result"] = result
    print(json.dumps(msg, ensure_ascii=False), flush=True)

def _last_json_object(text):
    """auto.py logs progress lines and then one pretty JSON object."""
    for i in range(len(text) - 1, -1, -1):
        if text[i] != "{": continue
        try: value = json.loads(text[i:])
        except json.JSONDecodeError: continue
        if isinstance(value, dict): return value
    return None

def main():
    q = Queue(ROOT)
    for line in sys.stdin:
        # Rebind before parsing.  `req` only comes into existence once json.loads
        # succeeds, and a loop variable survives into the next iteration, so
        # without this a malformed line does one of two bad things: on the first
        # message `req` is unbound and the handler's own NameError kills the
        # server, and afterwards the error is reported under the *previous*
        # request's id, which is a response the client never asked for.
        req = None
        try:
            req = json.loads(line); method = req.get("method"); args = req.get("params", {}) or {}; i = req.get("id")
            if method == "initialize": reply(i, {"protocolVersion":"2024-11-05", "capabilities":{"tools":{}}, "serverInfo":{"name":"aic-leaderboard","version":"0.1.0"}})
            elif method == "notifications/initialized": continue
            elif method == "tools/list": reply(i, {"tools":[
                {"name":"aic_validate_candidate","description":"Validate a local AIC result archive without uploading it.","inputSchema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
                {"name":"aic_queue_status","description":"Read local queue state.","inputSchema":{"type":"object","properties":{}}},
                {"name":"aic_enqueue_candidate","description":"Add a validated candidate to the local queue.","inputSchema":{"type":"object","required":["path","stage","team"],"properties":{"path":{"type":"string"},"stage":{"type":"string"},"team":{"type":"string"}}}},
                {"name":"aic_submit_candidate","description":"Submit exactly one queued candidate; requires explicit confirmation. Low-level: does not consult the submission ledger. Prefer aic_auto_submit.","inputSchema":{"type":"object","required":["id","confirm_real_submit"],"properties":{"id":{"type":"string"},"confirm_real_submit":{"type":"boolean"}}}},
                {"name":"aic_submission_plan","description":"Read-only pre-flight for a candidate: deadline, daily quota left, duplicate check, best score so far. Use this before spending a daily submission slot.","inputSchema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"},"stage":{"type":"string"}}}},
                {"name":"aic_submission_ledger","description":"Read-only submission ledger summary: how many slots are spent today, the best official score so far, and the last few records.","inputSchema":{"type":"object","properties":{"stage":{"type":"string"}}}},
                {"name":"aic_auto_submit","description":"Run the whole guarded submission pipeline on one archive: ledger guards -> launch the battle Chrome -> wait for a manual login -> validate -> enqueue -> click submit -> poll the leaderboard -> record the score. Requires confirm_real_submit=true to actually click; otherwsise it rehearses.","inputSchema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"},"stage":{"type":"string"},"team":{"type":"string"},"confirm_real_submit":{"type":"boolean"},"force":{"type":"boolean"},"no_browser":{"type":"boolean"},"login_timeout":{"type":"number"},"score_timeout":{"type":"number"}}}}
            ]})
            elif method == "tools/call":
                name = args.get("name"); a = args.get("arguments", {})
                if name == "aic_validate_candidate": result = validate_candidate(a["path"])
                elif name == "aic_queue_status": result = q.status()
                elif name == "aic_enqueue_candidate": result = q.enqueue(a["path"], stage=a["stage"], team=a["team"])
                elif name == "aic_submission_plan":
                    meta = validate_candidate(a["path"])
                    result = {"candidate": meta,
                              "guards": ledger.guards(q.root, sha256=meta["sha256"], stage=a.get("stage", "semi")),
                              "best": ledger.best(q.root, a.get("stage", "semi"))}
                elif name == "aic_submission_ledger":
                    stage = a.get("stage", "semi")
                    result = {"summary": ledger.summary(q.root, stage),
                              "guards": ledger.guards(q.root, stage=stage)}
                elif name == "aic_auto_submit":
                    cmd = [sys.executable, "-X", "utf8", "-m", "aic_leaderboard.auto", "submit", a["path"],
                           "--stage", a.get("stage", "semi"),
                           "--team", a.get("team") or os.environ.get("AIC_LEADERBOARD_TEAM_ID", "")]
                    cmd.append("--confirm-real-submit" if a.get("confirm_real_submit") is True else "--dry-run")
                    if a.get("force"): cmd.append("--force")
                    if a.get("no_browser"): cmd.append("--no-browser")
                    if a.get("login_timeout") is not None: cmd += ["--login-timeout", str(a["login_timeout"])]
                    if a.get("score_timeout") is not None: cmd += ["--score-timeout", str(a["score_timeout"])]
                    proc = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
                    tail = _last_json_object(proc.stdout or "")
                    if tail is None:
                        raise RuntimeError((proc.stderr or "").strip() or (proc.stdout or "").strip()
                                           or f"auto submit exited {proc.returncode}")
                    result = {"returncode": proc.returncode, **tail, "log": (proc.stdout or "")[-4000:]}
                    if proc.returncode not in (0, 6):
                        raise RuntimeError(json.dumps(result, ensure_ascii=False)[:2000])
                elif name == "aic_submit_candidate":
                    if a.get("confirm_real_submit") is not True: raise ValueError("explicit confirm_real_submit=true is required")
                    candidate_id = str(a.get("id", ""))
                    if not candidate_id: raise ValueError("candidate id is required")
                    # `text=True` decodes the child with THIS process's encoding, and the
                    # CLI prints Chinese package paths, so both ends have to agree on
                    # UTF-8.  Starting the child without -X utf8 makes it emit cp936 on
                    # Windows, which then fails to decode here and leaves proc.stdout
                    # None -- an exception, not a message the caller can read.
                    proc = subprocess.run([sys.executable, "-X", "utf8", "-m", "aic_leaderboard.cli", "--root", ROOT,
                                           "submit", "--id", candidate_id, "--confirm-real-submit"],
                                          capture_output=True, text=True, env=os.environ.copy())
                    if proc.returncode: raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "submission failed")
                    result = json.loads(proc.stdout)
                else: raise ValueError("unknown tool")
                reply(i, {"content":[{"type":"text","text":json.dumps(result,ensure_ascii=False,indent=2)}]})
            else: reply(i, error="unknown method")
        except Exception as exc: reply(req.get("id") if isinstance(req,dict) else None, error=str(exc))

if __name__ == "__main__": main()
