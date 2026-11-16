"""Tests for reference_record.py (stdlib only).

Run: python3 -m unittest scripts/test_reference_record.py
"""

import json
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reference_record  # noqa: E402

NOW = datetime(2026, 10, 27, 5, 20, tzinfo=UTC)
OLD_DEBRIS = {"value": "2026-03-03", "built_at": "2026-09-01T05:00:00+00:00"}
OLD_FIRE = {"value": "2025-07-25", "built_at": "2026-09-01T05:00:00+00:00"}


def write_run_files(folder: Path, upstream: dict) -> None:
    """The two files reference_check.py leaves behind."""
    state = {"checked_at": "x", "buildings": {}, "debris": OLD_DEBRIS, "fire_districts": OLD_FIRE}
    (folder / "reference_state.json").write_text(json.dumps(state), encoding="utf-8")
    (folder / "check.json").write_text(json.dumps({"upstream": upstream}), encoding="utf-8")


class RecordTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name)

    def saved_state(self) -> dict:
        return json.loads((self.out / "reference_state.json").read_text(encoding="utf-8"))

    def test_records_one_dataset_and_keeps_the_others(self):
        write_run_files(self.out, {"debris": "2026-11-01", "fire_districts": "2026-11-02"})
        reference_record.record(self.out, "debris", NOW)
        state = self.saved_state()
        self.assertEqual(state["debris"], {"value": "2026-11-01", "built_at": NOW.isoformat()})
        self.assertEqual(state["fire_districts"], OLD_FIRE)

    def test_two_datasets_recorded_one_after_the_other(self):
        write_run_files(self.out, {"debris": "2026-11-01", "fire_districts": "2026-11-02"})
        reference_record.record(self.out, "debris", NOW)
        reference_record.record(self.out, "fire_districts", NOW)
        state = self.saved_state()
        self.assertEqual(state["debris"]["value"], "2026-11-01")
        self.assertEqual(state["fire_districts"]["value"], "2026-11-02")

    def test_dataset_with_no_marker_is_an_error_and_changes_nothing(self):
        write_run_files(self.out, {"debris": None})
        with self.assertRaises(ValueError):
            reference_record.record(self.out, "debris", NOW)
        self.assertEqual(self.saved_state()["debris"], OLD_DEBRIS)


if __name__ == "__main__":
    unittest.main()
