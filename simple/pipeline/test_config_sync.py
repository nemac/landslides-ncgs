"""The values DFENS Simple shares across three files must agree:
simple/pipeline/settings.py (Python), simple/js/config.js (browser) and
scripts/config.py (the alerts pipeline the Simple pipeline imports).
Standard library only; the JavaScript is read with regular expressions.

Run: python3 -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "scripts"))

import settings as S  # noqa: E402

import config as alerts_config  # noqa: E402

JS = (REPO / "simple" / "js" / "config.js").read_text(encoding="utf-8")


def js_number(name: str) -> float:
    m = re.search(rf"const {name}\s*=\s*([0-9.]+)\s*;", JS)
    assert m, f"{name} not found in simple/js/config.js"
    return float(m.group(1))


def js_string(name: str) -> str:
    m = re.search(rf"const {name}\s*=\s*'([^']*)'\s*;", JS)
    assert m, f"{name} not found in simple/js/config.js"
    return m.group(1)


def js_object_keys(name: str) -> list[int]:
    m = re.search(rf"const {name}\s*=\s*\{{(.*?)\}};", JS, re.S)
    assert m, f"{name} not found in simple/js/config.js"
    return [int(k) for k in re.findall(r"^\s*(\d+):", m.group(1), re.M)]


class SettingsMatchFrontend(unittest.TestCase):
    def test_window_and_threshold(self):
        self.assertEqual(js_number("WINDOW_HOURS"), S.WINDOW_HOURS)
        self.assertEqual(js_number("THRESHOLD_CATEGORY"), S.THRESHOLD_CATEGORY)

    def test_threshold_inches_is_the_category_lower_bound(self):
        # cutoff[n] is the top of category n, so the bottom of category n+1.
        lower_bound = alerts_config.MRMS_CATEGORY_CUTOFFS_INCHES[S.THRESHOLD_CATEGORY - 1]
        self.assertEqual(js_number("THRESHOLD_INCHES"), lower_bound)

    def test_data_file_names(self):
        self.assertEqual(js_string("FLAGGED_FILE"), S.FLAGGED_FILENAME)
        self.assertEqual(js_string("FORECAST_FILE"), S.FORECAST_FILENAME)
        self.assertIn(f"{S.WINDOW_HOURS}h", S.FLAGGED_FILENAME)
        self.assertIn(f"min{S.THRESHOLD_CATEGORY}", S.FLAGGED_FILENAME)

    def test_check_interval_default(self):
        self.assertEqual(js_number("CHECK_INTERVAL_MINUTES"), S.check_interval_minutes())

    def test_ndfd_service_url(self):
        # Written in the JS as adjacent string literals joined with +.
        m = re.search(r"const NDFD_SOURCE_URL\s*=\s*((?:'[^']*'\s*\+?\s*)+);", JS)
        self.assertIsNotNone(m)
        url = "".join(re.findall(r"'([^']*)'", m.group(1)))
        self.assertEqual(url, S.NDFD_LAYER_URL)

    def test_precip_label_table_covers_every_category(self):
        keys = js_object_keys("PRECIP_LABELS")
        self.assertEqual(keys, list(range(len(alerts_config.MRMS_CATEGORY_CUTOFFS_INCHES) + 1)))


class SettingsMatchAlertsPipeline(unittest.TestCase):
    def test_one_bounding_box(self):
        self.assertEqual(tuple(S.WNC_BBOX), tuple(alerts_config.WNC_BBOX))
        self.assertFalse(hasattr(alerts_config, "WNC_BBOX_WGS84"))

    def test_same_ndfd_service(self):
        self.assertEqual(S.NDFD_LAYER_URL, alerts_config.NDFD_PRECIP_SERVICE_URL)

    def test_same_output_geometry_tuning(self):
        self.assertEqual(S.SIMPLIFY_METERS, alerts_config.FLAGGED_SIMPLIFY_METERS)
        self.assertEqual(S.COORD_PRECISION, alerts_config.FLAGGED_COORD_PRECISION)


if __name__ == "__main__":
    unittest.main()
