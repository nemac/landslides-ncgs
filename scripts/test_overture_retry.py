"""Tests for the Overture extraction retry in data.py.

Run from the repo root in an environment with geopandas, requests and duckdb:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import duckdb  # noqa: E402

import data  # noqa: E402


class FakeQuery:
    """Stands in for overturemaps.geodataframe: raises the queued exceptions
    in order, then returns a sentinel."""

    def __init__(self, failures):
        self.failures = list(failures)
        self.calls = 0

    def __call__(self, kind, bbox):
        self.calls += 1
        assert kind == "building"
        if self.failures:
            raise self.failures.pop(0)
        return "TABLE"


class OvertureRetryTest(unittest.TestCase):
    BBOX = (-84.5, 34.8, -81.0, 36.7)

    def _run(self, failures, attempts=data.OVERTURE_RETRY_ATTEMPTS):
        query = FakeQuery(failures)
        sleeps = []
        result = data.overture_query_with_retry(
            query, self.BBOX, attempts=attempts, sleep=sleeps.append
        )
        return result, query.calls, sleeps

    def test_duckdb_io_errors_are_not_os_errors(self):
        # The bug this guards against: the old loop caught OSError only.
        self.assertFalse(issubclass(duckdb.IOException, OSError))
        self.assertIn(duckdb.IOException, data.overture_transient_errors())
        self.assertIn(OSError, data.overture_transient_errors())

    def test_network_error_is_retried_then_succeeds(self):
        failures = [
            duckdb.HTTPException("AWS Error NETWORK_CONNECTION: body length mismatch"),
            duckdb.IOException("read failed"),
        ]
        result, calls, sleeps = self._run(failures)
        self.assertEqual(result, "TABLE")
        self.assertEqual(calls, 3)
        self.assertEqual(sleeps, [2, 4])

    def test_os_error_is_still_retried(self):
        result, calls, sleeps = self._run([OSError("connection reset")])
        self.assertEqual(result, "TABLE")
        self.assertEqual(calls, 2)
        self.assertEqual(sleeps, [2])

    def test_programming_error_is_not_retried(self):
        with self.assertRaises(duckdb.BinderException):
            self._run([duckdb.BinderException("no such column")])

    def test_gives_up_after_the_last_attempt(self):
        failures = [duckdb.IOException(f"fail {i}") for i in range(3)]
        with self.assertRaises(duckdb.IOException) as ctx:
            self._run(failures, attempts=3)
        self.assertEqual(str(ctx.exception), "fail 2")


if __name__ == "__main__":
    unittest.main()
