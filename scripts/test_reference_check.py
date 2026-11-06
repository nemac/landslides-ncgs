"""Tests for reference_check.py (stdlib only).

Run: python3 -m unittest scripts/test_reference_check.py
"""

import io
import json
import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

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


def _raising(exc: Exception):
    def fetch(url):
        raise exc

    return fetch


class PreviousStateTest(unittest.TestCase):
    """Only a 404 on the state file is a first run. A 403 used to count too,
    because CloudFront answers 403 for a missing object, but the file has
    existed since 2026-10-28, so a 403 now means the bucket policy or origin
    access broke: the check must fail so the job is retried tomorrow instead
    of rebuilding both datasets. A forced run rebuilds everything anyway, so
    it accepts a 403 and starts from an empty state: that is the way back if
    the file really is gone."""

    URL = "http://x/state.json"

    def _http_error(self, code: int) -> Exception:
        error = rc.urllib.error.HTTPError(self.URL, code, "err", {}, io.BytesIO(b""))
        self.addCleanup(error.close)
        return error

    def test_missing_state_404_is_first_run(self):
        self.assertEqual(rc.previous_state(_raising(self._http_error(404)), url=self.URL), {})

    def test_forbidden_state_403_fails_the_run(self):
        with self.assertRaises(rc.urllib.error.HTTPError):
            rc.previous_state(_raising(self._http_error(403)), url=self.URL)

    def test_forced_run_accepts_403_as_first_run(self):
        state = rc.previous_state(_raising(self._http_error(403)), url=self.URL, force=True)
        self.assertEqual(state, {})

    def test_server_error_propagates(self):
        with self.assertRaises(rc.urllib.error.HTTPError):
            rc.previous_state(_raising(self._http_error(503)), url=self.URL)

    def test_connection_failure_propagates(self):
        with self.assertRaises(rc.urllib.error.URLError):
            rc.previous_state(_raising(rc.urllib.error.URLError("refused")), url=self.URL)

    def test_unparseable_state_propagates(self):
        with self.assertRaises(ValueError):
            rc.previous_state(_raising(ValueError("not json")), url=self.URL)


GOOD = {"latest": "2026-10-21.0"}


def _response(payload: dict) -> io.BytesIO:
    # BytesIO is a context manager, so it stands in for the urlopen response.
    return io.BytesIO(json.dumps(payload).encode("utf-8"))


class GetJsonRetryTest(unittest.TestCase):
    """_get_json tries again after errors that may pass (timeouts, dropped
    connections, 429, 5xx) and fails at once on the rest. These tests set
    the random jitter to zero so the waits are exact."""

    def setUp(self):
        self.urlopen = mock.patch.object(rc.urllib.request, "urlopen").start()
        mock.patch.object(rc.random, "uniform", return_value=0).start()
        self.addCleanup(mock.patch.stopall)
        self.waits = []

    def _get(self):
        return rc._get_json("https://x", sleep=self.waits.append)

    def _http_error(self, code: int, headers: dict | None = None) -> Exception:
        error = rc.urllib.error.HTTPError("https://x", code, "err", headers or {}, io.BytesIO(b""))
        self.addCleanup(error.close)
        return error

    def test_timeout_is_retried_then_succeeds(self):
        # The failure in run 42165821205.
        self.urlopen.side_effect = [TimeoutError("The read operation timed out"), _response(GOOD)]
        self.assertEqual(self._get(), GOOD)
        self.assertEqual(self.waits, [rc.FIRST_RETRY_DELAY])

    def test_connection_errors_and_server_errors_are_retried(self):
        self.urlopen.side_effect = [
            rc.urllib.error.URLError("connection refused"),
            ConnectionResetError("reset by peer"),
            self._http_error(503),
            _response(GOOD),
        ]
        self.assertEqual(self._get(), GOOD)
        self.assertEqual(self.urlopen.call_count, 4)

    def test_wait_doubles_after_each_failure(self):
        self.urlopen.side_effect = [TimeoutError()] * 3 + [_response(GOOD)]
        self._get()
        first = rc.FIRST_RETRY_DELAY
        self.assertEqual(self.waits, [first, first * 2, first * 4])

    def test_gives_up_after_the_last_attempt(self):
        self.urlopen.side_effect = [TimeoutError()] * rc.RETRY_ATTEMPTS
        with self.assertRaises(TimeoutError):
            self._get()
        self.assertEqual(self.urlopen.call_count, rc.RETRY_ATTEMPTS)
        self.assertEqual(len(self.waits), rc.RETRY_ATTEMPTS - 1)

    def test_client_errors_are_not_retried(self):
        # previous_state depends on this: a 404 or 403 must reach it at once.
        for code in (403, 404):
            with self.subTest(code=code):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = [self._http_error(code), _response(GOOD)]
                with self.assertRaises(rc.urllib.error.HTTPError):
                    self._get()
                self.assertEqual(self.urlopen.call_count, 1)
        self.assertEqual(self.waits, [])

    def test_bad_json_is_not_retried(self):
        self.urlopen.side_effect = [io.BytesIO(b"<html>"), _response(GOOD)]
        with self.assertRaises(ValueError):
            self._get()
        self.assertEqual(self.waits, [])

    def test_server_retry_after_is_honoured(self):
        self.urlopen.side_effect = [self._http_error(429, {"Retry-After": "12"}), _response(GOOD)]
        self.assertEqual(self._get(), GOOD)
        self.assertEqual(self.waits, [12])

    def test_server_retry_after_is_capped(self):
        self.urlopen.side_effect = [self._http_error(503, {"Retry-After": "3600"}), _response(GOOD)]
        self._get()
        self.assertEqual(self.waits, [rc.MAX_RETRY_DELAY])

    def test_retry_after_date_falls_back_to_backoff(self):
        headers = {"Retry-After": "Fri, 06 Nov 2026 05:02:00 GMT"}
        self.urlopen.side_effect = [self._http_error(503, headers), _response(GOOD)]
        self._get()
        self.assertEqual(self.waits, [rc.FIRST_RETRY_DELAY])

    def test_jitter_adds_up_to_a_fifth_of_the_wait(self):
        mock.patch.object(rc.random, "uniform", side_effect=lambda low, high: high).start()
        self.urlopen.side_effect = [TimeoutError(), _response(GOOD)]
        self._get()
        self.assertEqual(self.waits, [rc.FIRST_RETRY_DELAY * 1.2])


if __name__ == "__main__":
    unittest.main()
