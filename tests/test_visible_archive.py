"""Regression: a self-consistent CRLF archive must fail Git provenance checks."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    "visible_archive", Path(__file__).resolve().parents[1] / "migration/tools/visible_archive.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VisibleArchiveTests(unittest.TestCase):
    def prepare(self, root, autocrlf):
        def git(*args):
            return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)
        git("init", "-q")
        git("config", "core.autocrlf", autocrlf)
        for path in module.MEMBERS:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"line one\nline two\n")
        git("add", ".")
        git("-c", "user.name=Archive Test", "-c", "user.email=test@example.invalid",
            "commit", "-qm", "fixture")
        source = git("rev-parse", "HEAD").decode().strip()
        # A checkout may contain different line endings even when Git is clean.
        for path in module.MEMBERS:
            (root / path).write_bytes(b"line one\r\nline two\r\n")
        return source

    def test_build_uses_git_bytes_with_either_autocrlf_setting(self):
        for setting in ("true", "false"):
            with self.subTest(setting=setting), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.prepare(root, setting)
                archive, index = root / "archive.zip", root / "manifest.json"
                module.build(root, archive, index, source)
                with zipfile.ZipFile(archive) as packed:
                    for path in module.MEMBERS:
                        self.assertEqual(packed.read(path), b"line one\nline two\n")

    def test_self_consistent_wrong_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.prepare(root, "true")
            archive, index = root / "archive.zip", root / "manifest.json"
            module.build(root, archive, index, source)
            with zipfile.ZipFile(archive) as packed:
                contents = {name: packed.read(name) for name in packed.namelist()}
            path = module.MEMBERS[0]
            contents[path] = contents[path].replace(b"\n", b"\r\n")
            manifest = json.loads(contents["MANIFEST.json"])
            manifest["files"][0] = module.record(path, contents[path])
            encoded = json.dumps(manifest).encode()
            contents["MANIFEST.json"] = encoded
            index.write_bytes(encoded)
            with zipfile.ZipFile(archive, "w") as packed:
                for name, raw in contents.items():
                    packed.writestr(name, raw)
            with self.assertRaisesRegex(ValueError, "Git blob mismatch"):
                module.verify(root, archive, index, source)
