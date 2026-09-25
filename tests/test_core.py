import json
import zipfile
from pathlib import Path

import unittest

from aic_leaderboard.core import Queue, validate_candidate


def candidate(tmp_path):
    p = tmp_path / "candidate.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("result.json", json.dumps({"ok": True}))
    return p


class CoreTests(unittest.TestCase):
  def test_validate_and_hash(self):
    import tempfile
    with tempfile.TemporaryDirectory() as d:
      info = validate_candidate(candidate(Path(d)))
      self.assertEqual(len(info["sha256"]), 64)
      self.assertEqual(info["entries"], ["result.json"])

  def test_queue_deduplicates_by_stage(self):
    import tempfile
    with tempfile.TemporaryDirectory() as d:
      root = Path(d); p = candidate(root); q = Queue(root)
      q.enqueue(p, stage="semi", team="T")
      with self.assertRaisesRegex(ValueError, "already exists"):
        q.enqueue(p, stage="semi", team="T")
      q.enqueue(p, stage="final", team="T")

  def test_zip_rejects_multiple_entries(self):
    import tempfile
    with tempfile.TemporaryDirectory() as d:
      p = Path(d) / "bad.zip"
      with zipfile.ZipFile(p, "w") as z:
        z.writestr("a.json", "{}")
        z.writestr("b.json", "{}")
      with self.assertRaises(ValueError): validate_candidate(p)

if __name__ == "__main__": unittest.main()
