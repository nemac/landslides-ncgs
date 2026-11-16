"""Tests for archive_decision.py (stdlib only).

Run from the repo root:
    python3 -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import archive_decision
import fire_districts

FIRST_BUILD = {"fire_district_retry": False}
RETRY = {"fire_district_retry": True}


def status(n_flagged, lookup):
    return {"n_flagged": n_flagged, "fire_districts": lookup}


class ShouldArchiveTest(unittest.TestCase):
    def test_flagged_run_is_archived(self):
        run = status(3, fire_districts.LOOKUP_OK)
        self.assertTrue(archive_decision.should_archive(run, FIRST_BUILD))

    def test_run_with_nothing_flagged_is_not_archived(self):
        run = status(0, fire_districts.LOOKUP_NOT_RUN)
        self.assertFalse(archive_decision.should_archive(run, FIRST_BUILD))
        self.assertFalse(archive_decision.should_archive({}, FIRST_BUILD))

    def test_first_run_with_a_failed_lookup_is_archived(self):
        # It is the only record of what this forecast flagged.
        run = status(3, fire_districts.LOOKUP_UNAVAILABLE)
        self.assertTrue(archive_decision.should_archive(run, FIRST_BUILD))

    def test_retry_that_fails_again_is_not_archived(self):
        run = status(3, fire_districts.LOOKUP_UNAVAILABLE)
        self.assertFalse(archive_decision.should_archive(run, RETRY))

    def test_retry_that_works_is_archived(self):
        run = status(3, fire_districts.LOOKUP_OK)
        self.assertTrue(archive_decision.should_archive(run, RETRY))

    def test_check_file_from_before_the_retry_flag(self):
        run = status(3, fire_districts.LOOKUP_UNAVAILABLE)
        self.assertTrue(archive_decision.should_archive(run, {}))


class MainTest(unittest.TestCase):
    def printed(self, run, check) -> str:
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "status.json").write_text(json.dumps(run), encoding="utf-8")
            (Path(folder) / "check.json").write_text(json.dumps(check), encoding="utf-8")
            output = io.StringIO()
            argv = ["archive_decision.py", "--out", folder]
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
                archive_decision.main()
        return output.getvalue()

    def test_prints_true_or_false_for_the_workflow(self):
        ok = status(2, fire_districts.LOOKUP_OK)
        failed = status(2, fire_districts.LOOKUP_UNAVAILABLE)
        self.assertEqual(self.printed(ok, FIRST_BUILD), "true\n")
        self.assertEqual(self.printed(failed, RETRY), "false\n")


if __name__ == "__main__":
    unittest.main()
