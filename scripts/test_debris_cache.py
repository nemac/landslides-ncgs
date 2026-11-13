"""Tests for the debris-flow cache in data.py: the unique pathway key is
fetched and kept, and a cache file built without it is never used.

Run from the repo root:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import geopandas as gpd
from shapely.geometry import box, mapping

# data.py imports config.py as a sibling, so scripts/ must be importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import data  # noqa: E402
from config import PATHWAY_KEY_FIELD  # noqa: E402

SQUARE = box(-82.601, 35.599, -82.599, 35.601)


def service_feature(key, objectid):
    """One feature the way the NCGS service returns it as GeoJSON."""
    return {
        "type": "Feature",
        "id": key,
        "geometry": mapping(SQUARE),
        "properties": {PATHWAY_KEY_FIELD: key, "OBJECTID": objectid},
    }


def add_county_and_watershed(pathways):
    """A stand-in for _augment_with_admin_boundaries, which calls two
    outside services."""
    pathways["county"] = "Buncombe"
    pathways["watershed"] = "Swannanoa River"
    return pathways


def write_cache_without_key(path):
    """A cache file as it was built before the unique key was kept."""
    old_cache = gpd.GeoDataFrame(
        {"OBJECTID": [7], "county": ["Buncombe"], "watershed": ["Swannanoa River"]},
        geometry=[SQUARE],
        crs="EPSG:4326",
    )
    old_cache.to_file(path, driver="GPKG")


class DebrisCacheTest(unittest.TestCase):
    def setUp(self):
        # fetch_debris_flows prints its progress; keep the test output clean.
        self.enterContext(redirect_stdout(io.StringIO()))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.cache_path = Path(folder.name) / "debris_flows.gpkg"
        self.patch(data, "_cache_path", return_value=self.cache_path)
        self.patch(data, "_augment_with_admin_boundaries", side_effect=add_county_and_watershed)
        self.fetch = self.patch(
            data,
            "_fetch_features_paginated",
            return_value=[service_feature(101, 7), service_feature(202, 7)],
        )

    def patch(self, target, name, **kwargs):
        patcher = mock.patch.object(target, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def test_the_fetch_asks_the_service_for_the_unique_key(self):
        data.fetch_debris_flows()

        params = self.fetch.call_args.args[1]
        self.assertIn(PATHWAY_KEY_FIELD, params["outFields"].split(","))

    def test_a_new_cache_keeps_the_unique_key(self):
        data.fetch_debris_flows()

        cached = gpd.read_file(self.cache_path)
        self.assertEqual(sorted(cached[PATHWAY_KEY_FIELD]), [101, 202])
        self.assertEqual(list(cached["OBJECTID"]), [7, 7])

    def test_a_cache_with_the_key_is_loaded_without_a_fetch(self):
        data.fetch_debris_flows()
        self.fetch.reset_mock()

        pathways = data.fetch_debris_flows()

        self.fetch.assert_not_called()
        self.assertEqual(sorted(pathways[PATHWAY_KEY_FIELD]), [101, 202])

    def test_an_old_cache_without_the_key_is_rebuilt_from_the_service(self):
        write_cache_without_key(self.cache_path)

        pathways = data.fetch_debris_flows()

        self.fetch.assert_called_once()
        self.assertEqual(sorted(pathways[PATHWAY_KEY_FIELD]), [101, 202])
        rebuilt = gpd.read_file(self.cache_path)
        self.assertIn(PATHWAY_KEY_FIELD, rebuilt.columns)

    def test_a_download_with_a_repeated_key_is_refused(self):
        self.fetch.return_value = [service_feature(101, 7), service_feature(101, 8)]

        with self.assertRaisesRegex(RuntimeError, "not unique"):
            data.fetch_debris_flows()

        self.assertFalse(self.cache_path.exists())

    def test_a_download_without_the_key_is_refused(self):
        feature = service_feature(101, 7)
        del feature["properties"][PATHWAY_KEY_FIELD]
        self.fetch.return_value = [feature]

        with self.assertRaisesRegex(RuntimeError, PATHWAY_KEY_FIELD):
            data.fetch_debris_flows()

        self.assertFalse(self.cache_path.exists())


if __name__ == "__main__":
    unittest.main()
