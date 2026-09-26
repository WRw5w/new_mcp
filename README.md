# AIC Leaderboard Control

Portable submission control for AIC competition tracks. Clone this repository
on any Windows, macOS or Linux computer with Python 3.10+, Node.js and Chrome.

The project separates four concerns: candidate validation, durable queue state,
browser submission, and score attribution. Login state stays in a user-owned
Chrome profile. No cookie, token or password is stored by this project.

The default browser transport uses Playwright and Chrome's debugging pipe.
Install its Node dependency with `npm ci`. It does not require port 9222.
Playwright uses the installed Chrome channel on each OS; set
`AIC_LEADERBOARD_CHROME_PATH` only if Chrome is in a custom location.
The browser profile defaults to a separate directory under the system temp
directory; set `AIC_LEADERBOARD_PIPE_PROFILE` to keep it in a chosen location.
Only one process can use that profile at a time.

## Install and connect

```powershell
git clone https://github.com/WRw5w/new_mcp.git
cd new_mcp
python -m pip install -e .
npm ci
$env:AIC_LEADERBOARD_ROOT = (Get-Location).Path
$env:AIC_LEADERBOARD_SUBMIT_URL = 'https://your-aic-submit-page'
$env:AIC_LEADERBOARD_LEADERBOARD_URL = 'https://your-aic-leaderboard-page'
node tools/leaderboard_pipe.mjs probe
node tools/pipe_smoke.mjs
python -m aic_leaderboard.cli validate .\candidate.zip
python -m aic_leaderboard.cli enqueue .\candidate.zip --stage semi --team YOUR_TEAM
python -m aic_leaderboard.cli status
python -m aic_leaderboard.auto capture --team YOUR_TEAM
node tools/leaderboard_pipe.mjs result-records
```

On macOS or Linux, use `export AIC_LEADERBOARD_ROOT="$(pwd)"` and the same
`export` form for the URL variables. The repository's `.mcp.json` starts the
`aic-leaderboard` stdio MCP server with `python -m aic_leaderboard.mcp`.
Install the package first, then configure your MCP client to launch that command
with `AIC_LEADERBOARD_ROOT` set to this checkout's absolute path. Set the two
page URLs to the full routes for your AIC track, and set
`AIC_LEADERBOARD_TEAM_ID` for account-specific score capture. The checked-in
Codex plugin manifest also exposes the MCP server and companion skill.

The deadline and daily quota are defaults for the current AIC round. For
another AIC track or round, set `AIC_LEADERBOARD_DEADLINE` (ISO 8601 with
timezone) and `AIC_DAILY_SUBMIT_LIMIT` before submitting. Review the current
rules before a real submission; `--dry-run` is available for a rehearsal.

The `auto` CLI requires `--dry-run` for a rehearsal and
`--confirm-real-submit` for a real click. The MCP exposes the same operations;
its submit tool requires `confirm_real_submit=true` and uses the local browser
pipe. Install the Python package and Node dependencies on each computer before
enabling the plugin's MCP server. Set the root and actual AIC page URLs in the
MCP process environment; logging in happens in the dedicated visible Chrome.

`tools/leaderboard_cdp.mjs` is adapted from the state-machine design in
`WRw5w/aic_new`: CDP preflight, one candidate per process, exact file binding,
login detection, upload readiness checks, and explicit unknown-outcome handling.

For the standard browser backend, `result-records` reads the signed-in account's
`打榜状态查询` page. This includes zero-score and infeasible submissions that do not
appear on the public leaderboard. The route defaults to the AIC account results
page and can be overridden with `AIC_LEADERBOARD_RECORDS_URL` for another AIC
track. The auto CLI attributes a `DONE` score only when the result's timestamp is
after the submit click and downloading its saved attachment yields the queued
ZIP's SHA-256. If the download or hash check is unavailable, it reports the
visible result but leaves score attribution pending for manual verification.
The legacy CDP backend still captures public leaderboard snapshots under
`leaderboard_evidence/`.

## Task migration archive

Read [migration/README.md](migration/README.md) for recovery and the solver's current-state entry.
The public, redacted WorkBuddy `00001` transcript is losslessly compressed and indexed for on-demand lookup;
do not load it as current instructions. The original raw session and full project backup remain encrypted,
with the key outside the repository. Recovery does not establish that any competition package is valid.

## Workspace layout

`aic_leaderboard/` contains service and CLI code; `tests/` contains all Python tests;
`tools/` contains browser/launch helpers; `migration/archives/` holds compressed or encrypted history.
Plugin manifests stay at their required root locations. Run the full offline Python suite with:

```powershell
python -X utf8 -m unittest discover -s tests
```

The solver workspace uses `aic.py`, `src/`, `tests/`, `artifacts/`, `evidence/` and `archives/`;
see its [workspace guide](https://github.com/WRw5w/jinyinsai1/blob/codex/semifinal-knowledge-cleanup/docs/WORKSPACE.md).
