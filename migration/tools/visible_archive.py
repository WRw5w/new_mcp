"""Build/verify the public redacted archive against pinned Git blobs.

No checkout bytes, raw session files, keys or browser state are read.
Run from any directory: python migration/tools/visible_archive.py verify
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = "40fae38e1d90bb038ddb0d054a0af04cb100ad24"
MEMBERS = ("migration/conversation/00001_visible.md",
           "migration/conversation/00001_visible.jsonl", "migration/README.md", "README.md")
ARCHIVE = ROOT / "migration/archives/00001-visible-20260926.zip"
INDEX = ROOT / "migration/archives/00001-visible-manifest.json"


def git_blob(repo: Path, source: str, path: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), "show", f"{source}:{path}"])


def record(path: str, raw: bytes) -> dict:
    return {"path": path, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def build(repo: Path, archive: Path, index: Path, source: str = SOURCE) -> None:
    contents = {path: git_blob(repo, source, path) for path in MEMBERS}
    manifest = {"format": 2, "date": "2026-09-26", "source_commit": source,
                "byte_source": "git_blob",
                "description": "Previously public redacted transcript and guides; exact Git blob bytes.",
                "files": [record(path, raw) for path, raw in contents.items()]}
    encoded = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf8")
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w") as packed:
        for path, raw in [*contents.items(), ("MANIFEST.json", encoded)]:
            info = zipfile.ZipInfo(path, date_time=(2026, 9, 26, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            packed.writestr(info, raw)
    index.write_bytes(encoded)
    verify(repo, archive, index, source)


def verify(repo: Path, archive: Path, index: Path, source: str = SOURCE) -> None:
    with zipfile.ZipFile(archive) as packed:
        names = packed.namelist()
        if sorted(names) != sorted([*MEMBERS, "MANIFEST.json"]):
            raise ValueError("Unexpected, missing or duplicate archive members")
        if packed.testzip() is not None:
            raise ValueError("Archive CRC mismatch")
        if packed.read("MANIFEST.json") != index.read_bytes():
            raise ValueError("Internal/external manifests differ")
        manifest = json.loads(index.read_bytes())
        if manifest["source_commit"] != source or manifest.get("byte_source") != "git_blob":
            raise ValueError("Unexpected provenance")
        if [item["path"] for item in manifest["files"]] != list(MEMBERS):
            raise ValueError("Unexpected manifest members")
        for item in manifest["files"]:
            raw = packed.read(item["path"])
            if record(item["path"], raw) != item:
                raise ValueError("Manifest hash/size mismatch")
            if raw != git_blob(repo, source, item["path"]):
                raise ValueError(f"Git blob mismatch: {item['path']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify", "rebuild"))
    args = parser.parse_args()
    if args.action == "rebuild":
        build(ROOT, ARCHIVE, INDEX)
    else:
        verify(ROOT, ARCHIVE, INDEX)
    print(f"Verified {len(MEMBERS)} exact Git blobs at {SOURCE}; "
          f"archive sha256={hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
