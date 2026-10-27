"""Unit tests for the precipitation category label table in data.py.

Run from the repo root:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import sys
import unittest
from pathlib import Path

# data.py imports config.py as a sibling, so scripts/ must be importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from data import PRECIP_CATEGORY_LABELS, _category_label  # noqa: E402


class CategoryLabelTests(unittest.TestCase):
    def test_every_known_category_yields_its_label(self):
        for category, expected_label in PRECIP_CATEGORY_LABELS.items():
            with self.subTest(category=category):
                self.assertEqual(_category_label(category), expected_label)

    def test_unknown_category_yields_generic_label(self):
        self.assertEqual(_category_label(99), "cat 99")
        self.assertEqual(_category_label(-1), "cat -1")

    def test_table_has_no_gaps(self):
        # Rasters are binned into consecutive category indices, so a missing
        # key would silently turn a real bin into a generic "cat N" label.
        keys = sorted(PRECIP_CATEGORY_LABELS)
        self.assertEqual(keys, list(range(keys[0], keys[-1] + 1)))

    def test_table_covers_categories_zero_through_nineteen(self):
        self.assertEqual(min(PRECIP_CATEGORY_LABELS), 0)
        self.assertEqual(max(PRECIP_CATEGORY_LABELS), 19)


if __name__ == "__main__":
    unittest.main()
