"""Regression tests for the stdio MCP server.

`aic_leaderboard/mcp.py` had no coverage at all before this file, and all three
bugs found on 2026-09-26 lived in it:

  * a malformed *first* line left `req` unbound, so the handler's own NameError
    killed the server before any tool could be called;
  * a malformed line *after* a good one was reported under the previous
    request's id, i.e. the client got a failure it never asked about;
  * `aic_submit_candidate` started its child without `-X utf8`, so on Windows the
    child wrote cp936, the parent's `text=True` decoded it as UTF-8, and the
    caller got an exception instead of a message.

The first two are exercised end to end against a real server process; the third
patches `subprocess.run` because the alternative is clicking a real submit.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def run_server(lines: list[str]) -> tuple[int, list[dict]]:
    """Feed raw stdin lines to a real server process; return (rc, replies)."""
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "aic_leaderboard.mcp"],
        input="".join(lines), capture_output=True, text=True, cwd=str(ROOT),
        env={**os.environ, "AIC_LEADERBOARD_ROOT": str(ROOT)}, timeout=60,
    )
    replies = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, replies


INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
TOOLS_LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'


class StdioRobustnessTests(unittest.TestCase):
    def test_blank_first_line_does_not_kill_the_server(self):
        rc, replies = run_server(["\n", INITIALIZE])
        self.assertEqual(rc, 0, "the server must survive a blank first line")
        self.assertEqual(len(replies), 2)
        # The malformed line cannot name a request, so its id must be null.
        self.assertIsNone(replies[0]["id"])
        self.assertIn("error", replies[0])
        # ...and the real request must still be served.
        self.assertEqual(replies[1]["id"], 1)
        self.assertIn("result", replies[1])

    def test_garbage_first_line_does_not_kill_the_server(self):
        rc, replies = run_server(["not json at all\n", INITIALIZE])
        self.assertEqual(rc, 0)
        self.assertIsNone(replies[0]["id"])
        self.assertEqual(replies[1]["id"], 1)

    def test_malformed_line_is_not_attributed_to_the_previous_request(self):
        rc, replies = run_server([INITIALIZE, "\n", TOOLS_LIST])
        self.assertEqual(rc, 0)
        ids_with_errors = [r["id"] for r in replies if "error" in r]
        self.assertEqual(ids_with_errors, [None],
                         "a malformed line must not be blamed on an earlier request")
        # Both real requests still get their own successful answers.
        answered = {r["id"]: "result" in r for r in replies}
        self.assertEqual(answered.get(1), True)
        self.assertEqual(answered.get(2), True)

    def test_tools_list_still_returns_every_tool(self):
        _, replies = run_server([INITIALIZE, TOOLS_LIST])
        tools = [t["name"] for t in replies[1]["result"]["tools"]]
        self.assertEqual(len(tools), 7)
        self.assertIn("aic_auto_submit", tools)
        self.assertIn("aic_submit_candidate", tools)


class SubmitCandidateEncodingTests(unittest.TestCase):
    """`text=True` decodes the child with this process's encoding, so the child
    has to be started in UTF-8 mode too or Chinese package paths break it."""

    def test_submit_candidate_starts_its_child_with_x_utf8(self):
        import aic_leaderboard.mcp as mcp

        request = json.dumps({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "aic_submit_candidate",
                       "arguments": {"id": "any-id", "confirm_real_submit": True}},
        }) + "\n"

        captured: list[list[str]] = []

        def fake_run(cmd, *a, **kw):
            captured.append(list(cmd))
            return subprocess.CompletedProcess(cmd, 0, stdout='{"ok": true}', stderr="")

        with mock.patch.object(mcp.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(mcp.sys, "stdin", io.StringIO(request)):
            mcp.main()

        self.assertEqual(len(captured), 1, "the tool should have spawned one child")
        argv = captured[0]
        self.assertIn("-X", argv)
        self.assertEqual(argv[argv.index("-X") + 1], "utf8")

    def test_auto_submit_starts_its_child_with_x_utf8(self):
        import aic_leaderboard.mcp as mcp

        request = json.dumps({
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": {"name": "aic_auto_submit",
                       "arguments": {"path": "candidate.zip", "confirm_real_submit": False}},
        }) + "\n"

        captured: list[list[str]] = []

        def fake_run(cmd, *a, **kw):
            captured.append(list(cmd))
            return subprocess.CompletedProcess(cmd, 0, stdout='{"ok": true}', stderr="")

        with mock.patch.object(mcp.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(mcp.sys, "stdin", io.StringIO(request)):
            mcp.main()

        argv = captured[0]
        self.assertIn("-X", argv)
        self.assertEqual(argv[argv.index("-X") + 1], "utf8")


if __name__ == "__main__":
    unittest.main()
