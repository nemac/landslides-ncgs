"""The building footprints have one owner: refresh-reference.yml, through
`refresh.py --buildings`. The live alerts pipeline no longer extracts them on
a manifest-age TTL, so nothing here should still implement that TTL.

Run from the repo root in an environment with geopandas:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import inspect
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
import data  # noqa: E402
import refresh  # noqa: E402


class BuildingsOwnerTest(unittest.TestCase):
    def test_extraction_has_no_ttl_switch(self):
        params = inspect.signature(data.fetch_overture_buildings).parameters
        self.assertNotIn("force_refresh", params)
        self.assertIn("release", params)

    def test_no_manifest_age_check_remains(self):
        self.assertFalse(hasattr(data, "_overture_cache_is_fresh"))
        self.assertFalse(hasattr(config, "OVERTURE_BUILDINGS_CACHE_TTL_DAYS"))

    def test_live_pipeline_has_no_buildings_phase(self):
        self.assertFalse(hasattr(refresh, "_refresh_overture_buildings"))


if __name__ == "__main__":
    unittest.main()
