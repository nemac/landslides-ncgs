"""Tests for fire_district_join.py and the fire district steps in
refresh_simple.py. They need geopandas, so they are skipped on the CI job
that runs this folder with plain Python.

Run from the repo root:
    .venv/bin/python -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import fire_districts as fd
import settings as S

HAS_GEOPANDAS = importlib.util.find_spec("geopandas") is not None

if HAS_GEOPANDAS:
    import fire_district_join as join
    import geopandas as gpd
    from shapely.geometry import Polygon, box

# A metric projection (UTM zone 17N) that covers western North Carolina.
METRIC_CRS = "EPSG:32617"
MARCH_5_2024_MS = 1709640000000


def make_districts(rows):
    """rows: (name, fdid, geometry). Builds a frame with the service's fields."""
    return gpd.GeoDataFrame(
        {
            "FDID": [fdid for _, fdid, _ in rows],
            "firedepartment": [name for name, _, _ in rows],
            "fdcounty": ["Buncombe" for _ in rows],
            "fdaddress": ["1 Main St" for _ in rows],
            "dateupdated": [MARCH_5_2024_MS for _ in rows],
        },
        geometry=[geometry for _, _, geometry in rows],
        crs="EPSG:4326",
    )


def make_pathways(geometries, index=None):
    return gpd.GeoDataFrame(
        {"OBJECTID": list(range(len(geometries)))},
        geometry=geometries,
        crs="EPSG:4326",
        index=index,
    )


def small_square(lon, lat, half_size=0.001):
    return box(lon - half_size, lat - half_size, lon + half_size, lat + half_size)


def notched_square():
    """A district with a small hole in the middle. The hole is its own
    district, so a pathway centered on the hole has its point in the
    small district but overlaps the notched one far more."""
    shell = [(-82.36, 35.59), (-82.34, 35.59), (-82.34, 35.61), (-82.36, 35.61)]
    hole = [(-82.3505, 35.5995), (-82.3495, 35.5995), (-82.3495, 35.6005), (-82.3505, 35.6005)]
    return Polygon(shell, [hole])


def all_districts():
    return make_districts(
        [
            # One district on its own.
            ("Alpha", "100", box(-82.61, 35.59, -82.59, 35.61)),
            # Two overlapping districts.
            ("Big", "200", box(-82.57, 35.58, -82.53, 35.62)),
            ("Small", "201", box(-82.555, 35.595, -82.545, 35.605)),
            # Land with no fire district.
            (fd.NO_DISTRICT_NAME, None, box(-82.51, 35.59, -82.49, 35.61)),
            # A real district over a smaller "No District" patch.
            ("Real", None, box(-82.47, 35.58, -82.43, 35.62)),
            (fd.NO_DISTRICT_NAME, None, box(-82.455, 35.595, -82.445, 35.605)),
            # Two districts with a thin gap between them at lon -82.40.
            ("Left", "300", box(-82.42, 35.600, -82.4005, 35.6005)),
            ("Right", "301", box(-82.3995, 35.59, -82.38, 35.61)),
            # A district with a hole, and the hole's own district.
            ("Notched", "400", notched_square()),
            ("Hole", "401", box(-82.3505, 35.5995, -82.3495, 35.6005)),
            # Two districts with a thin "No District" strip between them.
            # The state layer fills the gaps between districts this way.
            ("West", "500", box(-82.22, 35.59, -82.2003, 35.61)),
            (fd.NO_DISTRICT_NAME, None, box(-82.2003, 35.59, -82.1997, 35.61)),
            ("East", "501", box(-82.1997, 35.59, -82.18, 35.61)),
        ]
    )


# (pathway geometry, expected department, expected status), one per case.
# Built only when shapely is installed, since the shapes need it.
CASES = []
if HAS_GEOPANDAS:
    CASES = [
        (small_square(-82.60, 35.60), "Alpha", fd.STATUS_DISTRICT),
        (small_square(-82.55, 35.60), "Small", fd.STATUS_DISTRICT),
        (small_square(-82.50, 35.60), None, fd.STATUS_NO_DISTRICT),
        (small_square(-82.45, 35.60), "Real", fd.STATUS_DISTRICT),
        (small_square(-82.30, 35.60), None, fd.STATUS_OUTSIDE_NC),
        (box(-82.402, 35.599, -82.398, 35.601), "Right", fd.STATUS_DISTRICT),
        (box(-82.352, 35.599, -82.348, 35.601), "Hole", fd.STATUS_DISTRICT),
        # Point in the strip, but most of the pathway is in East.
        (box(-82.2012, 35.599, -82.1984, 35.601), "East", fd.STATUS_DISTRICT),
        # Point in the strip, and most of the pathway is in the strip.
        (box(-82.2004, 35.599, -82.1996, 35.601), None, fd.STATUS_NO_DISTRICT),
    ]


def department_names(matches):
    names = []
    for match in matches:
        if match is None:
            names.append(None)
        else:
            names.append(match["firedepartment"])
    return names


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class MatchFireDistrictsTest(unittest.TestCase):
    def match_one(self, geometry):
        pathways = make_pathways([geometry])
        return join.match_fire_districts(pathways, all_districts(), METRIC_CRS)[0]

    def test_inside_one_district(self):
        self.assertEqual(self.match_one(CASES[0][0])["firedepartment"], "Alpha")

    def test_smaller_overlapping_district_wins(self):
        self.assertEqual(self.match_one(CASES[1][0])["firedepartment"], "Small")

    def test_inside_no_district_land(self):
        match = self.match_one(CASES[2][0])
        self.assertTrue(fd.is_no_district(match))

    def test_real_district_beats_no_district(self):
        self.assertEqual(self.match_one(CASES[3][0])["firedepartment"], "Real")

    def test_outside_every_district(self):
        self.assertIsNone(self.match_one(CASES[4][0]))

    def test_point_in_a_gap_uses_the_largest_overlap(self):
        self.assertEqual(self.match_one(CASES[5][0])["firedepartment"], "Right")

    def test_overlap_is_not_used_when_the_point_is_in_a_real_district(self):
        self.assertEqual(self.match_one(CASES[6][0])["firedepartment"], "Hole")

    def test_point_in_a_no_district_strip_uses_the_largest_overlap(self):
        self.assertEqual(self.match_one(CASES[7][0])["firedepartment"], "East")

    def test_pathway_mostly_in_a_no_district_strip_stays_no_district(self):
        match = self.match_one(CASES[8][0])
        self.assertTrue(fd.is_no_district(match))

    def test_results_follow_input_order(self):
        geometries = [geometry for geometry, _, _ in CASES]
        expected = []
        for _, name, status in CASES:
            if status == fd.STATUS_NO_DISTRICT:
                expected.append(fd.NO_DISTRICT_NAME)
            else:
                expected.append(name)

        forward = join.match_fire_districts(make_pathways(geometries), all_districts(), METRIC_CRS)
        self.assertEqual(department_names(forward), expected)

        backward = join.match_fire_districts(
            make_pathways(geometries[::-1]), all_districts(), METRIC_CRS
        )
        self.assertEqual(department_names(backward), expected[::-1])


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class AssignFireDistrictsTest(unittest.TestCase):
    def test_fills_the_pathway_columns(self):
        geometries = [geometry for geometry, _, _ in CASES]
        pathways = make_pathways(geometries, index=[10 + i for i in range(len(CASES))])
        tagged = join.assign_fire_districts(pathways, all_districts(), METRIC_CRS)

        self.assertEqual(list(tagged.index), list(pathways.index))
        self.assertEqual(list(tagged["fire_department"]), [name for _, name, _ in CASES])
        self.assertEqual(list(tagged["fire_district_status"]), [s for _, _, s in CASES])
        self.assertEqual(tagged.loc[10, "fdid"], "100")
        self.assertEqual(tagged.loc[10, "district_updated"], "2024-03-05")
        self.assertIsNone(tagged.loc[13, "fdid"])
        self.assertNotIn("fire_department", pathways.columns)

    def test_empty_fire_columns(self):
        pathways = make_pathways([small_square(-82.60, 35.60), small_square(-82.30, 35.60)])
        empty = join.empty_fire_columns(pathways)
        for column in fd.PATHWAY_COLUMNS:
            self.assertEqual(list(empty[column]), [None, None])
        self.assertNotIn("fdid", pathways.columns)


@unittest.skipUnless(HAS_GEOPANDAS, "geopandas is not installed")
class RefreshSimpleFireDistrictTest(unittest.TestCase):
    """The fire district steps in refresh_simple.py. Imported here, not at
    the top, because refresh_simple needs geopandas and the scripts/ folder."""

    def setUp(self):
        import refresh_simple

        self.refresh = refresh_simple
        self.pathways = make_pathways([small_square(-82.60, 35.60)])
        # The test districts are a handful of boxes, far fewer than WNC has.
        patcher = mock.patch.object(S, "FIRE_DISTRICTS_MIN_COUNT", 1)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_tag_reports_ok(self):
        with mock.patch.object(self.refresh, "load_fire_districts", return_value=all_districts()):
            with redirect_stdout(io.StringIO()):
                tagged, lookup = self.refresh.tag_fire_districts(self.pathways)
        self.assertEqual(lookup, fd.LOOKUP_OK)
        self.assertEqual(list(tagged["fire_department"]), ["Alpha"])

    def test_tag_failure_leaves_columns_empty_and_warns(self):
        failure = RuntimeError("service down")
        output = io.StringIO()
        with mock.patch.object(self.refresh, "load_fire_districts", side_effect=failure):
            with redirect_stdout(output):
                tagged, lookup = self.refresh.tag_fire_districts(self.pathways)
        self.assertEqual(lookup, fd.LOOKUP_UNAVAILABLE)
        self.assertEqual(list(tagged["fire_district_status"]), [None])
        self.assertIn("WARNING", output.getvalue())
        self.assertIn("RuntimeError: service down", output.getvalue())

    def test_load_downloads_when_the_file_is_missing(self):
        collection = all_districts().to_geo_dict()
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(self.refresh, "REPO", Path(folder)):
                with mock.patch.object(fd, "fetch_wnc_districts", return_value=collection) as fetch:
                    with redirect_stdout(io.StringIO()):
                        districts = self.refresh.load_fire_districts()
                        self.refresh.load_fire_districts()
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(len(districts), len(all_districts()))

    def write_district_file(self, folder, districts):
        path = Path(folder) / S.FIRE_DISTRICTS_CACHE
        fd.write_districts(path, districts.to_geo_dict())

    def test_load_rejects_a_file_with_too_few_districts(self):
        with tempfile.TemporaryDirectory() as folder:
            self.write_district_file(folder, all_districts())
            too_many = len(all_districts()) + 1
            with mock.patch.object(self.refresh, "REPO", Path(folder)):
                with mock.patch.object(S, "FIRE_DISTRICTS_MIN_COUNT", too_many):
                    with self.assertRaises(RuntimeError):
                        self.refresh.load_fire_districts()

    def test_tag_is_unavailable_when_the_file_is_short(self):
        # Without the count check every pathway here would be published
        # as "outside_nc" under an "ok" marker.
        with tempfile.TemporaryDirectory() as folder:
            self.write_district_file(folder, all_districts().iloc[0:0])
            with mock.patch.object(self.refresh, "REPO", Path(folder)):
                with redirect_stdout(io.StringIO()):
                    tagged, lookup = self.refresh.tag_fire_districts(self.pathways)
        self.assertEqual(lookup, fd.LOOKUP_UNAVAILABLE)
        self.assertEqual(list(tagged["fire_district_status"]), [None])


if __name__ == "__main__":
    unittest.main()
