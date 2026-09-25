"""Build the local, unencrypted input for the public encrypted migration payload.

Run only on the source machine. The output ZIP must never be committed directly.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(*args: str) -> str:
    proc = subprocess.run(args, check=True, text=True, capture_output=True)
    return proc.stdout.strip()


def add_file(z: zipfile.ZipFile, source: Path, name: str, manifest: list[dict]) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    z.write(source, name)
    manifest.append({"path": name, "bytes": source.stat().st_size, "sha256": digest(source)})


def main() -> None:
    here = Path(__file__).resolve().parents[1]
    main_root = Path(r"D:\02_Projects\ML\jinyinsai1")
    semi_root = Path(r"D:\02_Projects\ML\jinyinsai1_nolimit")
    auto_root = main_root / "auto_review"
    raw = Path(r"C:\Users\19811\.workbuddy\projects\d-02_Projects-ML-jinyinsai1"
               r"\21624865-44ed-450b-a9b2-c650dec10933.jsonl")
    build = here / "private_build"
    build.mkdir(parents=True, exist_ok=True)
    specs = (
        (main_root, "jinyinsai1-main"),
        (semi_root, "jinyinsai1-semi-final"),
        (auto_root, "auto_review"),
    )
    commits = {}
    bundles = []
    trees = []
    for root, label in specs:
        commits[label] = run("git", "-C", str(root), "rev-parse", "HEAD")
        bundle = build / f"{label}.bundle"
        run("git", "-C", str(root), "bundle", "create", str(bundle), "--all")
        bundles.append((bundle, f"repos/{label}.bundle"))
        tree = build / f"{label}-HEAD.zip"
        run("git", "-C", str(root), "archive", "--format=zip", "-o", str(tree), "HEAD")
        trees.append((tree, f"worktrees/{label}-HEAD.zip"))

    local_main = [
        main_root / ".workbuddy/memory/2026-09-23.md",
        main_root / "diagnostics/optimization_review_probe.py",
        main_root / "repair_semi.py",
        main_root / "watch_semi.py",
        main_root / "复赛结果_棒材优化_待提交.zip",
    ]
    local_main += sorted((main_root / "diagnostics/optimization_review_20260922").rglob("*"))
    local_main += sorted((main_root / "tools").rglob("*"))
    local_main += sorted((main_root / "runs/semi_full").rglob("*"))
    local_main = [p for p in local_main if p.is_file()]
    semi_runs = [p for p in sorted((semi_root / "runs").rglob("*")) if p.is_file()]

    output = build / "full-migration.zip"
    manifest = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=6, allowZip64=True) as archive:
        for source, name in bundles + trees:
            add_file(archive, source, name, manifest)
        add_file(archive, raw, f"conversation/{raw.name}", manifest)
        meta = raw.with_suffix(".meta.json")
        add_file(archive, meta, f"conversation/{meta.name}", manifest)
        add_file(archive, here / "conversation/00001_visible.md",
                 "conversation/00001_visible.md", manifest)
        for source in local_main:
            add_file(archive, source, "local_changes/jinyinsai1/" +
                     source.relative_to(main_root).as_posix(), manifest)
        for source in semi_runs:
            add_file(archive, source, "run_state/jinyinsai1_nolimit/" +
                     source.relative_to(semi_root).as_posix(), manifest)
        metadata = {"created_utc": datetime.now(timezone.utc).isoformat(),
                    "commits": commits, "excluded": [
                        "jinyinsai1/runs except semi_full (859 MiB of reproducible output)",
                        "machine-specific executables, caches, browser profiles, login state",
                        "unrelated nested aic_new_review and output/pdf projects",
                    ], "files": manifest}
        archive.writestr("MANIFEST.json", json.dumps(metadata, ensure_ascii=False, indent=2))
    print(json.dumps({"archive": str(output), "bytes": output.stat().st_size,
                      "files": len(manifest), "commits": commits}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
