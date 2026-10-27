"""Tests for the retry around the ArcGIS requests in ndfd_check.py.

Run from the repo root:
    python3 -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import io
import json
import unittest
import urllib.error
from unittest import mock

import ndfd_check

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
        self.assertEqual(ndfd_check._get_json("https://x"), GOOD)
        self.assertEqual(self.urlopen.call_count, 2)
        self.sleep.assert_called_once_with(ndfd_check.RETRY_DELAYS[0])

    def test_timeout_is_retried(self):
        self.urlopen.side_effect = [TimeoutError("timed out"), _response(GOOD)]
        self.assertEqual(ndfd_check._get_json("https://x"), GOOD)
        self.assertEqual(self.urlopen.call_count, 2)

    def test_server_error_is_retried(self):
        self.urlopen.side_effect = [_http_error(503), _response(GOOD)]
        self.assertEqual(ndfd_check._get_json("https://x"), GOOD)

    def test_gives_up_after_the_last_attempt(self):
        attempts = ndfd_check.RETRY_ATTEMPTS
        self.urlopen.side_effect = [_response(ARCGIS_ERROR) for _ in range(attempts)]
        with self.assertRaises(RuntimeError):
            ndfd_check._get_json("https://x")
        self.assertEqual(self.urlopen.call_count, ndfd_check.RETRY_ATTEMPTS)
        self.assertEqual(self.sleep.call_count, ndfd_check.RETRY_ATTEMPTS - 1)

    def test_not_found_is_not_retried(self):
        self.urlopen.side_effect = [_http_error(404), _response(GOOD)]
        with self.assertRaises(urllib.error.HTTPError):
            ndfd_check._get_json("https://x")
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


if __name__ == "__main__":
    unittest.main()
