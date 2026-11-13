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
import os
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


class BuildRunner:
    """Runs refresh_simple.build() for the test classes below."""

    def run_build(self, pathways, rain=None, commit=None):
        """Run build() with the outside services replaced. Returns every
        file it wrote, as {file name: text}."""
        import refresh_simple

        if rain is None:
            rain = heavy_rain_over_both_pathways()
        environment = {"GITHUB_SHA": commit} if commit else {}
        fire_lookup_down = RuntimeError("fire district service is down")
        with (
            tempfile.TemporaryDirectory() as folder,
            mock.patch.object(refresh_simple.ndfd_check, "ndfd_state", return_value=NDFD_STATE),
            mock.patch.object(refresh_simple, "fetch_precip", return_value=rain),
            mock.patch.object(
                refresh_simple.shared_data, "fetch_debris_flows", return_value=pathways
            ),
            mock.patch.object(refresh_simple, "load_fire_districts", side_effect=fire_lookup_down),
            mock.patch.dict(os.environ, environment, clear=True),
            redirect_stdout(io.StringIO()),
        ):
            refresh_simple.build(Path(folder))
            return {path.name: path.read_text(encoding="utf-8") for path in Path(folder).iterdir()}

    def build_flagged_file(self, pathways, **options):
        """The flagged file from one build, as a dict."""
        return json.loads(self.run_build(pathways, **options)[S.FLAGGED_FILENAME])


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class FlaggedPathwayIdTest(BuildRunner, unittest.TestCase):
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

    def test_the_file_names_the_ncgs_layer_version_the_ids_came_from(self):
        pathways = two_pathways_sharing_an_objectid()
        pathways["ncgs_layer_version"] = "2026-03-03T171307Z"

        flagged = self.build_flagged_file(pathways)

        self.assertEqual(flagged["meta"]["ncgs_layer_version"], "2026-03-03T171307Z")

    def test_the_layer_version_is_empty_for_a_cache_that_does_not_name_one(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        self.assertIsNone(flagged["meta"]["ncgs_layer_version"])

    def test_pathways_without_the_unique_key_are_not_published(self):
        old_cache = two_pathways_sharing_an_objectid().drop(columns=["OBJECTID_1"])

        with self.assertRaisesRegex(ValueError, "OBJECTID_1"):
            self.build_flagged_file(old_cache)


def rain_with_fine_coordinates():
    """Heavy rain over the west pathway only. Its corner has more decimal
    places than the public files keep (COORD_PRECISION)."""
    return gpd.GeoDataFrame(
        {"category": [12], "label": ["6.00 - 8.00 in"]},
        geometry=[box(-82.700000123, 35.500000456, -82.50, 35.70)],
        crs="EPSG:4326",
    )


def rain_far_from_the_pathways():
    return gpd.GeoDataFrame(
        {"category": [S.THRESHOLD_CATEGORY], "label": ["5.00 - 6.00 in"]},
        geometry=[box(-84.40, 34.90, -84.30, 35.00)],
        crs="EPSG:4326",
    )


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class RunRecordTest(BuildRunner, unittest.TestCase):
    """What a run that flags pathways keeps, so the same pathways can be
    worked out again after the forecast has moved on."""

    def test_a_flagged_run_saves_the_rain_polygons_it_used(self):
        files = self.run_build(two_pathways_sharing_an_objectid())

        rain = json.loads(files[S.RAIN_INPUT_FILENAME])
        categories = [f["properties"]["category"] for f in rain["features"]]
        self.assertEqual(categories, [S.THRESHOLD_CATEGORY])
        self.assertEqual(rain["meta"]["window_start"], "2026-11-13T12:00:00+00:00")

    def test_the_saved_rain_keeps_its_exact_coordinates(self):
        files = self.run_build(
            two_pathways_sharing_an_objectid(), rain=rain_with_fine_coordinates()
        )

        self.assertIn("-82.700000123", files[S.RAIN_INPUT_FILENAME])
        self.assertIn("35.500000456", files[S.RAIN_INPUT_FILENAME])

    def test_the_saved_rain_gives_the_same_flagged_pathways_again(self):
        import refresh_simple

        pathways = two_pathways_sharing_an_objectid()
        files = self.run_build(pathways, rain=rain_with_fine_coordinates())
        published = json.loads(files[S.FLAGGED_FILENAME])

        saved_rain = gpd.read_file(io.StringIO(files[S.RAIN_INPUT_FILENAME]))
        again = refresh_simple.shared_analysis.find_alerts(pathways, saved_rain)

        self.assertEqual(
            sorted(again["OBJECTID_1"]),
            sorted(f["properties"]["pathway_id"] for f in published["features"]),
        )
        self.assertEqual(list(again["category"]), [12])

    def test_a_run_that_flags_nothing_saves_no_rain_file(self):
        files = self.run_build(
            two_pathways_sharing_an_objectid(), rain=rain_far_from_the_pathways()
        )

        self.assertNotIn(S.RAIN_INPUT_FILENAME, files)

    def test_the_file_names_the_code_commit_that_built_it(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid(), commit="abc123")

        self.assertEqual(flagged["meta"]["code_commit"], "abc123")

    def test_the_code_commit_is_empty_outside_github_actions(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        self.assertIsNone(flagged["meta"]["code_commit"])

    def test_the_district_layer_version_is_empty_when_the_lookup_failed(self):
        flagged = self.build_flagged_file(two_pathways_sharing_an_objectid())

        self.assertIsNone(flagged["meta"]["fire_district_layer_version"])


if __name__ == "__main__":
    unittest.main()
