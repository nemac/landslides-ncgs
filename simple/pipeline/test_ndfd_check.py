"""Tests for ndfd_check.py: the retry around the ArcGIS requests, and the
choice between skipping and building.

Run from the repo root:
    python3 -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import fire_districts
import ndfd_check
import settings as S

ARCGIS_ERROR = {
    "error": {"code": 400, "message": "Cannot perform query. Invalid query parameters."},
}
GOOD = {"features": [{"attributes": {"fromdate": 1}}]}


def _response(payload: dict) -> io.BytesIO:
    # BytesIO is a context manager, so it stands in for the urlopen response.
    return io.BytesIO(json.dumps(payload).encode("utf-8"))


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x", code, "err", {}, None)


def _requests_error(name: str, status: int | None = None) -> Exception:
    """A stand-in for a requests exception. ndfd_check only looks at the
    class's module and name, so requests itself is never imported here."""
    cls = type(name, (Exception,), {"__module__": "requests.exceptions"})
    exc = cls(f"fake {name}")
    exc.response = None if status is None else mock.Mock(status_code=status)
    return exc


class GetJsonRetryTest(unittest.TestCase):
    def setUp(self):
        self.sleep = mock.patch.object(ndfd_check.time, "sleep").start()
        self.urlopen = mock.patch.object(ndfd_check.urllib.request, "urlopen").start()
        self.addCleanup(mock.patch.stopall)

    def test_arcgis_error_payload_is_retried_then_succeeds(self):
        self.urlopen.side_effect = [_response(ARCGIS_ERROR), _response(GOOD)]
        self.assertEqual(ndfd_check.get_json("https://x"), GOOD)
        self.assertEqual(self.urlopen.call_count, 2)
        self.sleep.assert_called_once_with(ndfd_check.RETRY_DELAYS[0])

    def test_timeout_is_retried(self):
        self.urlopen.side_effect = [TimeoutError("timed out"), _response(GOOD)]
        self.assertEqual(ndfd_check.get_json("https://x"), GOOD)
        self.assertEqual(self.urlopen.call_count, 2)

    def test_server_error_is_retried(self):
        self.urlopen.side_effect = [_http_error(503), _response(GOOD)]
        self.assertEqual(ndfd_check.get_json("https://x"), GOOD)

    def test_gives_up_after_the_last_attempt(self):
        attempts = ndfd_check.RETRY_ATTEMPTS
        self.urlopen.side_effect = [_response(ARCGIS_ERROR) for _ in range(attempts)]
        with self.assertRaises(RuntimeError):
            ndfd_check.get_json("https://x")
        self.assertEqual(self.urlopen.call_count, ndfd_check.RETRY_ATTEMPTS)
        self.assertEqual(self.sleep.call_count, ndfd_check.RETRY_ATTEMPTS - 1)

    def test_not_found_is_not_retried(self):
        self.urlopen.side_effect = [_http_error(404), _response(GOOD)]
        with self.assertRaises(urllib.error.HTTPError):
            ndfd_check.get_json("https://x")
        self.assertEqual(self.urlopen.call_count, 1)
        self.sleep.assert_not_called()


class RetryTest(unittest.TestCase):
    def setUp(self):
        self.sleep = mock.patch.object(ndfd_check.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    def test_runtime_error_is_retried_then_succeeds(self):
        fn = mock.Mock(side_effect=[RuntimeError("ArcGIS error"), "ok"])
        self.assertEqual(ndfd_check.retry(fn), "ok")
        self.assertEqual(fn.call_count, 2)
        self.sleep.assert_called_once_with(ndfd_check.RETRY_DELAYS[0])

    def test_requests_server_error_is_retried(self):
        fn = mock.Mock(side_effect=[_requests_error("HTTPError", 503), "ok"])
        self.assertEqual(ndfd_check.retry(fn), "ok")
        self.assertEqual(fn.call_count, 2)

    def test_requests_client_error_is_not_retried(self):
        exc = _requests_error("HTTPError", 400)
        fn = mock.Mock(side_effect=[exc, "ok"])
        with self.assertRaises(type(exc)):
            ndfd_check.retry(fn)
        self.assertEqual(fn.call_count, 1)
        self.sleep.assert_not_called()

    def test_requests_connection_error_is_retried(self):
        fn = mock.Mock(side_effect=[_requests_error("ConnectionError"), "ok"])
        self.assertEqual(ndfd_check.retry(fn), "ok")
        self.assertEqual(fn.call_count, 2)

    def test_gives_up_after_the_last_attempt(self):
        attempts = ndfd_check.RETRY_ATTEMPTS
        fn = mock.Mock(side_effect=[RuntimeError("still down") for _ in range(attempts)])
        with self.assertRaises(RuntimeError):
            ndfd_check.retry(fn)
        self.assertEqual(fn.call_count, attempts)
        self.assertEqual(self.sleep.call_count, attempts - 1)


STATE = {"ndfd_key": "2026-10-28T12:00:00+00:00|2026-10-28T18:00:00+00:00"}


def published(**changes) -> dict:
    """A status.json from a run that covered STATE."""
    status = {
        "ndfd_key": STATE["ndfd_key"],
        "pipeline_version": S.PIPELINE_VERSION,
        "fire_districts": fire_districts.LOOKUP_OK,
    }
    status.update(changes)
    return status


class IsUpToDateTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("builtins.print")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_same_ndfd_update_is_up_to_date(self):
        self.assertTrue(ndfd_check.is_up_to_date(published(), STATE))

    def test_no_previous_status(self):
        self.assertFalse(ndfd_check.is_up_to_date(None, STATE))
        self.assertFalse(ndfd_check.is_up_to_date({}, STATE))

    def test_new_ndfd_update(self):
        self.assertFalse(ndfd_check.is_up_to_date(published(ndfd_key="older"), STATE))

    def test_new_pipeline_version(self):
        self.assertFalse(ndfd_check.is_up_to_date(published(pipeline_version="0"), STATE))

    def test_failed_fire_district_lookup_is_built_again(self):
        previous = published(fire_districts=fire_districts.LOOKUP_UNAVAILABLE)
        self.assertFalse(ndfd_check.is_up_to_date(previous, STATE))

    def test_no_flagged_pathways_is_not_built_again(self):
        previous = published(fire_districts=fire_districts.LOOKUP_NOT_RUN)
        self.assertTrue(ndfd_check.is_up_to_date(previous, STATE))

    def test_status_from_before_fire_districts_is_up_to_date(self):
        previous = published()
        del previous["fire_districts"]
        self.assertTrue(ndfd_check.is_up_to_date(previous, STATE))

    def test_unavailable_matches_the_fire_district_module(self):
        self.assertEqual(ndfd_check.FIRE_DISTRICTS_UNAVAILABLE, fire_districts.LOOKUP_UNAVAILABLE)


class IsFireDistrictRetryTest(unittest.TestCase):
    def test_same_update_with_a_failed_lookup_is_a_retry(self):
        previous = published(fire_districts=fire_districts.LOOKUP_UNAVAILABLE)
        self.assertTrue(ndfd_check.is_fire_district_retry(previous, STATE))

    def test_a_good_lookup_is_not_a_retry(self):
        self.assertFalse(ndfd_check.is_fire_district_retry(published(), STATE))

    def test_a_new_ndfd_update_is_not_a_retry(self):
        # A new forecast is a new run, whatever the last lookup did.
        previous = published(ndfd_key="older", fire_districts=fire_districts.LOOKUP_UNAVAILABLE)
        self.assertFalse(ndfd_check.is_fire_district_retry(previous, STATE))

    def test_no_previous_status_is_not_a_retry(self):
        self.assertFalse(ndfd_check.is_fire_district_retry(None, STATE))


class RunWritesTheRetryFlagTest(unittest.TestCase):
    """check.json tells the workflow whether this build is a retry."""

    def check_json(self, previous) -> dict:
        ndfd_state = dict(STATE, n_precip_polygons=1, issued=None, window_start=None)
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(ndfd_check, "ndfd_state", return_value=ndfd_state):
                with mock.patch.object(ndfd_check, "_iso", return_value="x"):
                    with mock.patch("builtins.print"):
                        result = ndfd_check.run(Path(folder), prev=previous)
            check = json.loads((Path(folder) / "check.json").read_text())
        return {"action": result["action"], "retry": check["fire_district_retry"]}

    def test_failed_lookup_builds_again_and_is_marked_a_retry(self):
        previous = published(fire_districts=fire_districts.LOOKUP_UNAVAILABLE)
        self.assertEqual(self.check_json(previous), {"action": "build", "retry": True})

    def test_new_update_builds_and_is_not_a_retry(self):
        previous = published(ndfd_key="older")
        self.assertEqual(self.check_json(previous), {"action": "build", "retry": False})

    def test_unchanged_update_skips(self):
        self.assertEqual(self.check_json(published()), {"action": "skip", "retry": False})


class BuildStatusTest(unittest.TestCase):
    def test_carries_the_fire_district_result(self):
        meta = {"ndfd_key": "k", "fire_districts": fire_districts.LOOKUP_UNAVAILABLE}
        status = ndfd_check.build_status(meta, ndfd_check.datetime.now(ndfd_check.UTC), "updated")
        self.assertEqual(status["fire_districts"], fire_districts.LOOKUP_UNAVAILABLE)


if __name__ == "__main__":
    unittest.main()
