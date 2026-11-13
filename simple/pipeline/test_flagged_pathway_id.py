"""Tests that the flagged file written by refresh_simple.py gives every
pathway a unique `pathway_id`, even when two pathways share an OBJECTID.
They need geopandas, so they are skipped on the CI job that runs this
folder with plain Python.

Run from the repo root:
    .venv/bin/python -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

import settings as S

HAS_GEOPANDAS = importlib.util.find_spec("geopandas") is not None

if HAS_GEOPANDAS:
    import geopandas as gpd
    from shapely.geometry import box

WINDOW_START = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)
NDFD_STATE = {
    "issued": datetime(2026, 11, 13, 11, 40, tzinfo=UTC),
    "window_start": WINDOW_START,
    "window_end": datetime(2026, 11, 14, 12, 0, tzinfo=UTC),
    "n_precip_polygons": 1,
    "ndfd_key": "test",
}


def small_square(lon, lat, half_size=0.001):
    return box(lon - half_size, lat - half_size, lon + half_size, lat + half_size)


def heavy_rain_over_both_pathways():
    return gpd.GeoDataFrame(
        {"category": [S.THRESHOLD_CATEGORY], "label": ["5.00 - 6.00 in"]},
        geometry=[box(-82.70, 35.50, -82.30, 35.70)],
        crs="EPSG:4326",
    )


def two_pathways_sharing_an_objectid():
    """About 20 km apart, from two source tiles of the NCGS layer, so they
    share OBJECTID 7 but have their own OBJECTID_1."""
    return gpd.GeoDataFrame(
        {
            "OBJECTID_1": [101, 202],
            "OBJECTID": [7, 7],
            "county": ["Buncombe", "McDowell"],
            "watershed": ["Hominy Creek", "Mill Creek"],
        },
        geometry=[small_square(-82.60, 35.60), small_square(-82.38, 35.60)],
        crs="EPSG:4326",
    )


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class FlaggedPathwayIdTest(unittest.TestCase):
    def build_flagged_file(self, pathways):
        """Run build() with the outside services replaced. Returns the
        flagged file as a dict."""
        import refresh_simple

        fire_lookup_down = RuntimeError("fire district service is down")
        with (
            tempfile.TemporaryDirectory() as folder,
            mock.patch.object(refresh_simple.ndfd_check, "ndfd_state", return_value=NDFD_STATE),
            mock.patch.object(
                refresh_simple, "fetch_precip", return_value=heavy_rain_over_both_pathways()
            ),
            mock.patch.object(
                refresh_simple.shared_data, "fetch_debris_flows", return_value=pathways
            ),
            mock.patch.object(refresh_simple, "load_fire_districts", side_effect=fire_lookup_down),
            redirect_stdout(io.StringIO()),
        ):
            refresh_simple.build(Path(folder))
            text = (Path(folder) / S.FLAGGED_FILENAME).read_text(encoding="utf-8")
        return json.loads(text)

    def test_both_pathways_of_a_shared_objectid_are_published(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        ids = sorted(f["properties"]["pathway_id"] for f in flagged["features"])
        self.assertEqual(ids, [101, 202])
        self.assertEqual(flagged["meta"]["n_flagged"], 2)

    def test_pathway_id_is_a_whole_number(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        for feature in flagged["features"]:
            self.assertIs(type(feature["properties"]["pathway_id"]), int)

    def test_the_source_objectid_is_still_published(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        objectids = [f["properties"]["OBJECTID"] for f in flagged["features"]]
        self.assertEqual(objectids, [7, 7])

    def test_the_layer_field_name_is_not_published(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        for feature in flagged["features"]:
            self.assertNotIn("OBJECTID_1", feature["properties"])

    def test_pathways_without_the_unique_key_are_not_published(self):
        old_cache = two_pathways_sharing_an_objectid().drop(columns=["OBJECTID_1"])

        with self.assertRaisesRegex(ValueError, "OBJECTID_1"):
            self.build_flagged_file(old_cache)


if __name__ == "__main__":
    unittest.main()
