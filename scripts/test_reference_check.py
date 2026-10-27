"""Tests for reference_check.py (stdlib only).

Run: python3 -m unittest scripts/test_reference_check.py
"""

import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reference_check as rc  # noqa: E402

NOW = datetime(2026, 10, 27, 5, 0, tzinfo=UTC)


def recorded(value, days_ago):
    return {"value": value, "built_at": (NOW - timedelta(days=days_ago)).isoformat()}


class DecideTest(unittest.TestCase):
    def test_first_run_rebuilds(self):
        self.assertEqual(rc.decide("2026-10-21.0", None, NOW), (True, "no previous build recorded"))
        self.assertTrue(rc.decide("2026-10-21.0", {}, NOW)[0])

    def test_unchanged_and_recent_skips(self):
        rebuild, reason = rc.decide("2026-10-21.0", recorded("2026-10-21.0", 10), NOW)
        self.assertFalse(rebuild)
        self.assertIn("unchanged", reason)

    def test_changed_upstream_rebuilds(self):
        rebuild, reason = rc.decide("2026-10-21.0", recorded("2026-09-23.1", 10), NOW)
        self.assertTrue(rebuild)
        self.assertEqual(reason, "upstream changed: 2026-09-23.1 -> 2026-10-21.0")

    def test_ninety_day_floor_rebuilds(self):
        rebuild, reason = rc.decide("2026-10-21.0", recorded("2026-10-21.0", 91), NOW)
        self.assertTrue(rebuild)
        self.assertIn("91 days old", reason)
        self.assertFalse(rc.decide("2026-10-21.0", recorded("2026-10-21.0", 89), NOW)[0])

    def test_force_rebuilds_regardless(self):
        self.assertEqual(rc.decide("x", recorded("x", 1), NOW, force=True), (True, "forced"))


class NextStateTest(unittest.TestCase):
    def test_rebuilt_takes_new_marker_and_others_carry_over(self):
        previous = {"buildings": recorded("2026-09-23.1", 40), "debris": recorded("2026-03-03", 40)}
        upstream = {"buildings": "2026-10-21.0", "debris": "2026-03-03"}
        state = rc.next_state(previous, upstream, {"buildings": True, "debris": False}, NOW)
        self.assertEqual(state["buildings"], {"value": "2026-10-21.0", "built_at": NOW.isoformat()})
        self.assertEqual(state["debris"], previous["debris"])
        self.assertEqual(state["checked_at"], NOW.isoformat())


class UpstreamParsingTest(unittest.TestCase):
    def test_overture_latest_from_catalog(self):
        fetch = lambda url: {"latest": "2026-10-21.0", "links": []}  # noqa: E731
        self.assertEqual(rc.latest_overture_release(fetch), "2026-10-21.0")
        with self.assertRaises(RuntimeError):
            rc.latest_overture_release(lambda url: {"links": []})

    def test_debris_edit_date_from_editing_info(self):
        ms = int(datetime(2026, 3, 3, 17, 13, 7, tzinfo=UTC).timestamp() * 1000)
        fetch = lambda url: {"editingInfo": {"dataLastEditDate": ms}}  # noqa: E731
        self.assertEqual(rc.debris_last_edit(fetch), "2026-03-03T17:13:07+00:00")
        with self.assertRaises(RuntimeError):
            rc.debris_last_edit(lambda url: {"editingInfo": {}})

    def test_missing_previous_state_is_first_run(self):
        def fetch(url):
            raise rc.urllib.error.URLError("404")

        self.assertEqual(rc.previous_state(fetch, url="http://x/state.json"), {})


if __name__ == "__main__":
    unittest.main()
