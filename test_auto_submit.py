"""Tests for the automated leaderboard submission path (ledger + auto).

Nothing here touches the network or a browser: the CDP leg is guarded by
``--no-browser`` / ``--no-launch-chrome`` in the CLI, and the pieces tested are
the ones that decide *whether* a submission is allowed and *what* the
leaderboard row means.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aic_leaderboard import auto, ledger  # noqa: E402
from aic_leaderboard.cli import submission_status  # noqa: E402
from aic_leaderboard.core import sha256  # noqa: E402

REAL_ROW = (
    "19 | AIC-2026-93096493 | 鱼不吃猫 | 2026-09-16 10:38:45 | 98.6500 | 2026-09-16 10:38:54\n"
    "18 | AIC-2026-13208788 | 别人 | 2026-09-16 10:00:00 | 99.0000 | 2026-09-16 10:00:10\n"
    "21 | AIC-2026-93096493 | 鱼不吃猫 | 2026-09-23 09:30:00 | 94.7115 | 2026-09-23 09:31:02\n"
)


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_read_roundtrip(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "accepted", "sha256": "aa", "score": 94.0})
        records = ledger.read(self.root)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["stage"], "semi")
        self.assertIn("at", records[0])

    def test_a_torn_tail_line_is_skipped_not_fatal(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "accepted"})
        with ledger.ledger_path(self.root).open("a", encoding="utf-8") as f:
            f.write('{"stage": "semi", "status": "acc')  # crash mid-write
        self.assertEqual(len(ledger.read(self.root)), 1)

    def test_a_dry_run_does_not_spend_a_slot(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "dry_run", "dry_run": True})
        self.assertEqual(ledger.spent_today(self.root, stage="semi"), [])
        self.assertFalse(ledger.guards(self.root, stage="semi")["blocked"])

    def test_quota_blocks_after_the_daily_limit(self) -> None:
        for i in range(ledger.daily_limit()):
            ledger.append(self.root, {"stage": "semi", "status": "accepted", "sha256": f"s{i}"})
        state = ledger.guards(self.root, stage="semi")
        self.assertTrue(state["blocked"])
        self.assertEqual(state["remaining_today"], 0)
        self.assertTrue(any(r.startswith("DAILY_LIMIT_REACHED") for r in state["reasons"]))

    def test_an_unconfirmed_submission_still_spends_a_slot(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "outcome_unknown"})
        self.assertEqual(len(ledger.spent_today(self.root, stage="semi")), 1)

    def test_score_capture_and_correction_do_not_spend_another_slot(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "accepted", "sha256": "aa"})
        ledger.append(self.root, {"stage": "semi", "status": "score_captured", "score": 0})
        ledger.append(self.root, {"stage": "semi", "status": "platform_result", "score": 0})
        ledger.append(self.root, {"stage": "semi", "status": "verification_mismatch"})
        self.assertEqual(len(ledger.spent_today(self.root, stage="semi")), 1)
        self.assertEqual(ledger.summary(self.root, stage="semi")["real_submissions"], 1)

    def test_duplicate_bytes_are_blocked(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "accepted", "sha256": "deadbeef"})
        state = ledger.guards(self.root, sha256="deadbeef", stage="semi")
        self.assertTrue(state["blocked"])
        self.assertTrue(any(r.startswith("ALREADY_SUBMITTED") for r in state["reasons"]))

    def test_another_stage_is_not_a_duplicate(self) -> None:
        ledger.append(self.root, {"stage": "prelim", "status": "accepted", "sha256": "deadbeef"})
        self.assertFalse(ledger.guards(self.root, sha256="deadbeef", stage="semi")["blocked"])

    def test_deadline_closes_the_round(self) -> None:
        old = os.environ.get("AIC_LEADERBOARD_DEADLINE")
        os.environ["AIC_LEADERBOARD_DEADLINE"] = "2001-01-01T00:00:00+08:00"
        try:
            state = ledger.guards(self.root, stage="semi")
        finally:
            if old is None:
                os.environ.pop("AIC_LEADERBOARD_DEADLINE", None)
            else:
                os.environ["AIC_LEADERBOARD_DEADLINE"] = old
        self.assertTrue(state["blocked"])
        self.assertTrue(any(r.startswith("ROUND_CLOSED") for r in state["reasons"]))

    def test_best_and_newest_track_the_score_not_the_order(self) -> None:
        ledger.append(self.root, {"stage": "semi", "status": "accepted", "score": 94.0,
                                  "submitted_at": "2026-09-22 10:00:00"})
        ledger.append(self.root, {"stage": "semi", "status": "accepted", "score": 93.0,
                                  "submitted_at": "2026-09-23 10:00:00"})
        self.assertEqual(ledger.best(self.root, "semi")["score"], 94.0)
        self.assertEqual(ledger.newest_submission_time(self.root), "2026-09-23 10:00:00")


class RowParsingTests(unittest.TestCase):
    def test_account_result_accepts_zero_only_with_matching_attachment_and_new_time(self) -> None:
        sha = "a" * 64
        payload = {"ok": True, "record": {"team": "AIC-2026-93096493", "stage": "semi",
                   "score": 0, "status": "DONE", "evaluated": "2026-09-23 11:12:56",
                   "attachmentSha256": sha, "attachmentMatches": True,
                   "failureReason": "跨轮接续不连续(7030条)"}}
        row = auto.result_row(payload, team="AIC-2026-93096493", stage="semi",
                              expected_sha256=sha, since="2026-09-23T11:12:16+08:00")
        self.assertIsNotNone(row)
        self.assertEqual(row["score"], 0.0)
        self.assertIn("7030", row["failure_reason"])
        payload["record"]["attachmentMatches"] = False
        self.assertIsNone(auto.result_row(payload, team="AIC-2026-93096493", stage="semi",
                                           expected_sha256=sha, since=None))
        payload["record"]["attachmentMatches"] = True
        self.assertIsNone(auto.result_row(payload, team="AIC-2026-93096493", stage="semi",
                                           expected_sha256=sha, since="2026-09-23T11:13:00+08:00"))

    def test_parses_the_real_leaderboard_row(self) -> None:
        rows = auto.parse_rows(REAL_ROW, "AIC-2026-93096493")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["score"], 98.65)
        self.assertEqual(rows[0]["name"], "鱼不吃猫")

    def test_filters_other_teams_out(self) -> None:
        self.assertNotIn("AIC-2026-13208788", [r["team"] for r in auto.parse_rows(REAL_ROW, "AIC-2026-93096493")])

    def test_newest_row_is_the_latest_submission(self) -> None:
        row = auto.newest_row(REAL_ROW, "AIC-2026-93096493")
        self.assertEqual(row["submitted"], "2026-09-23 09:30:00")
        self.assertEqual(row["score"], 94.7115)

    def test_no_team_id_means_no_row(self) -> None:
        self.assertIsNone(auto.newest_row(REAL_ROW, "AIC-2026-00000000"))

    def test_falls_back_to_a_loose_line_when_the_table_layout_changes(self) -> None:
        loose = "排名 21  AIC-2026-93096493  鱼不吃猫  2026-09-23 09:30:00  94.7115"
        row = auto.newest_row(loose, "AIC-2026-93096493")
        self.assertEqual(row["score"], 94.7115)

    def test_extract_last_json_ignores_progress_lines(self) -> None:
        text = 'leaderboard not ready; retry 1\n{"time":"x","text":"hi"}\n'
        self.assertEqual(auto.extract_last_json(text)["text"], "hi")

    def test_extract_last_json_prefers_the_final_object(self) -> None:
        text = '{"a": 1}\nsome noise\n{"b": 2}\n'
        self.assertEqual(auto.extract_last_json(text), {"b": 2})


class CandidatePickingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _pack(self, name: str, score: float) -> Path:
        d = self.root / name
        d.mkdir()
        (d / "复赛结果_鱼不吃猫.zip").write_bytes(b"PK\x03\x04")
        (d / "score_official.json").write_text(
            json.dumps({"score_capped_after_penalty": score}), encoding="utf-8")
        return d

    def test_pick_best_prefers_the_higher_local_score(self) -> None:
        low, high = self._pack("low", 94.03), self._pack("high", 94.71)
        ranked = auto.rank_candidates([str(low), str(high)])
        self.assertEqual(ranked[0]["dir"], str(high))
        self.assertEqual(ranked[0]["score"], 94.71)

    def test_local_score_beside_reads_the_sibling_report(self) -> None:
        d = self._pack("only", 93.5)
        self.assertEqual(auto.local_score_beside(d / "复赛结果_鱼不吃猫.zip"), 93.5)

    def test_local_score_reads_builder_prediction(self) -> None:
        d = self.root / "builder"
        d.mkdir()
        z = d / "复赛结果_鱼不吃猫.zip"
        z.write_bytes(b"PK\x03\x04")
        (d / "validation_report.json").write_text(json.dumps({"calibrated_prediction":
            {"score_capped": 94.71154834617565}}), encoding="utf-8")
        self.assertAlmostEqual(auto.local_score_beside(z), 94.71154834617565)

    def test_pick_best_skips_a_package_with_official_infeasible_feedback(self) -> None:
        bad, good = self._pack("bad", 94.71), self._pack("good", 93.5)
        (bad / "official_feedback.json").write_text(
            json.dumps({"official_score": 0, "infeasible": True,
                        "sha256": sha256(bad / "复赛结果_鱼不吃猫.zip")}), encoding="utf-8")
        ranked = auto.rank_candidates([str(bad), str(good)])
        self.assertEqual([entry["dir"] for entry in ranked], [str(good)])
        self.assertEqual(auto.rank_candidates([str(bad / "复赛结果_鱼不吃猫.zip")]), [])


class ConfirmationGateTests(unittest.TestCase):
    def test_a_real_submit_is_refused_without_the_explicit_flag(self) -> None:
        code = auto.main(["submit", "does-not-matter.zip"])
        self.assertEqual(code, auto.EXIT_GUARD_REFUSED)

    def test_dry_run_is_allowed_through_the_gate(self) -> None:
        # It must get past the gate and fail later on the missing file, not on
        # the confirmation check.
        code = auto.main(["submit", "does-not-matter.zip", "--team", "TEST",
                          "--dry-run", "--no-browser"])
        self.assertNotEqual(code, auto.EXIT_GUARD_REFUSED)

    def test_failure_before_click_does_not_spend_a_submission(self) -> None:
        self.assertEqual(submission_status(3, False), "no_click")
        self.assertEqual(submission_status(5, False), "no_click")

    def test_uncertain_result_after_click_stays_blocked(self) -> None:
        self.assertEqual(submission_status(3, True), "outcome_unknown")
        self.assertEqual(submission_status(7, True), "outcome_unknown")
        self.assertEqual(submission_status(0, True), "accepted")


if __name__ == "__main__":
    unittest.main(verbosity=2)
