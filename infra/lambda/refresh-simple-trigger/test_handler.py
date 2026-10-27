"""Unit tests for handler.py.

Run: python -m unittest infra/lambda/refresh-simple-trigger/test_handler.py
"""

import io
import json
import os
import sys
import types
import unittest
from unittest import mock

sys.modules.setdefault("boto3", types.ModuleType("boto3"))  # not needed for these tests
sys.path.insert(0, os.path.dirname(__file__))
import handler  # noqa: E402


class FakeResponse(io.BytesIO):
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class DispatchTests(unittest.TestCase):
    def test_posts_workflow_dispatch_with_ref_and_token(self):
        seen = {}

        def fake_urlopen(req, timeout):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            seen["body"] = json.loads(req.data)
            seen["auth"] = req.get_header("Authorization")
            return FakeResponse()

        with mock.patch.object(handler.urllib.request, "urlopen", fake_urlopen):
            status = handler.dispatch_workflow(
                "tok123", "nemac/landslides-ncgs", "refresh-simple.yml", "master"
            )
        self.assertEqual(status, 204)
        self.assertEqual(
            seen["url"],
            "https://api.github.com/repos/nemac/landslides-ncgs/actions/workflows/refresh-simple.yml/dispatches",
        )
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["body"], {"ref": "master"})
        self.assertEqual(seen["auth"], "Bearer tok123")

    def test_handler_reads_env_and_returns_status(self):
        env = {
            "GITHUB_REPO": "nemac/landslides-ncgs",
            "WORKFLOW_FILE": "refresh-simple.yml",
            "GIT_REF": "master",
            "TOKEN_SECRET_ID": "x",
        }
        with (
            mock.patch.dict(os.environ, env),
            mock.patch.object(handler, "github_token", return_value="tok"),
            mock.patch.object(handler, "dispatch_workflow", return_value=204) as d,
        ):
            out = handler.handler({}, None)
        d.assert_called_once_with("tok", "nemac/landslides-ncgs", "refresh-simple.yml", "master")
        self.assertEqual(out, {"status": 204, "workflow": "refresh-simple.yml", "ref": "master"})

    def test_event_can_override_workflow_file(self):
        """A one-time schedule (e.g. the token-expiry reminder) passes
        {"workflow_file": ...} in the event to dispatch a different workflow."""
        env = {
            "GITHUB_REPO": "nemac/landslides-ncgs",
            "WORKFLOW_FILE": "refresh-simple.yml",
            "GIT_REF": "master",
            "TOKEN_SECRET_ID": "x",
        }
        with (
            mock.patch.dict(os.environ, env),
            mock.patch.object(handler, "github_token", return_value="tok"),
            mock.patch.object(handler, "dispatch_workflow", return_value=204) as d,
        ):
            out = handler.handler({"workflow_file": "token-expiry-reminder.yml"}, None)
        d.assert_called_once_with(
            "tok", "nemac/landslides-ncgs", "token-expiry-reminder.yml", "master"
        )
        self.assertEqual(out["workflow"], "token-expiry-reminder.yml")


if __name__ == "__main__":
    unittest.main()
