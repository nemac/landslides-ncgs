"""Tests for fire_districts.py: cleaning the district fields, choosing one
district per pathway, and downloading the WNC districts page by page.

Run from the repo root:
    python3 -m unittest discover -s simple/pipeline -p "test_*.py"
"""

import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

import fire_districts as fd
import settings as S

# 2024-03-05 12:00 UTC in epoch milliseconds.
MARCH_5_2024_MS = 1709640000000


def district(name, fdid="1234", county="Buncombe", rank=0, **extra):
    record = {
        "FDID": fdid,
        "firedepartment": name,
        "fdcounty": county,
        "fdaddress": "1 Main St",
        "dateupdated": MARCH_5_2024_MS,
        "rank": rank,
    }
    record.update(extra)
    return record


def no_district(rank=0, county="Swain"):
    return district(fd.NO_DISTRICT_NAME, fdid=None, county=county, rank=rank)


class CleanTextTest(unittest.TestCase):
    def test_blank_values_become_none(self):
        self.assertIsNone(fd.clean_text(None))
        self.assertIsNone(fd.clean_text(float("nan")))
        self.assertIsNone(fd.clean_text("   "))

    def test_inner_whitespace_collapses(self):
        self.assertEqual(fd.clean_text("  Asheville   Fire\tDept "), "Asheville Fire Dept")

    def test_numbers_become_text(self):
        self.assertEqual(fd.clean_text(42), "42")


class FormatDistrictDateTest(unittest.TestCase):
    def test_epoch_milliseconds(self):
        self.assertEqual(fd.format_district_date(MARCH_5_2024_MS), "2024-03-05")
        self.assertEqual(fd.format_district_date(float(MARCH_5_2024_MS)), "2024-03-05")

    def test_date_is_in_utc(self):
        # 2024-03-06 01:00 UTC is still March 5 in North Carolina.
        self.assertEqual(fd.format_district_date(1709686800000), "2024-03-06")

    def test_object_with_strftime(self):
        self.assertEqual(fd.format_district_date(datetime(2023, 7, 1, tzinfo=UTC)), "2023-07-01")

    def test_missing_or_garbage_gives_none(self):
        self.assertIsNone(fd.format_district_date(None))
        self.assertIsNone(fd.format_district_date(float("nan")))
        self.assertIsNone(fd.format_district_date("not a date"))
        self.assertIsNone(fd.format_district_date(True))


class IsNoDistrictTest(unittest.TestCase):
    def test_matches_ignoring_case_and_spaces(self):
        self.assertTrue(fd.is_no_district({"firedepartment": "No District"}))
        self.assertTrue(fd.is_no_district({"firedepartment": " no   DISTRICT "}))

    def test_real_department_and_blank(self):
        self.assertFalse(fd.is_no_district({"firedepartment": "Asheville Fire Department"}))
        self.assertFalse(fd.is_no_district({"firedepartment": None}))
        self.assertFalse(fd.is_no_district({}))


class ChooseDistrictTest(unittest.TestCase):
    def test_empty_list_gives_none(self):
        self.assertIsNone(fd.choose_district([]))

    def test_real_department_beats_no_district(self):
        real = district("Bryson City", rank=500)
        empty_land = no_district(rank=1)
        self.assertIs(fd.choose_district([empty_land, real]), real)

    def test_lowest_rank_wins(self):
        big = district("Big", rank=10)
        small = district("Small", rank=2)
        self.assertIs(fd.choose_district([big, small]), small)

    def test_ties_do_not_depend_on_input_order(self):
        first = district("Alpha", fdid="2", rank=5)
        second = district("Alpha", fdid="1", rank=5)
        third = district("Beta", fdid=None, rank=5)
        self.assertIs(fd.choose_district([first, second, third]), second)
        self.assertIs(fd.choose_district([third, first, second]), second)


class PathwayFieldsTest(unittest.TestCase):
    def test_keys_are_the_pathway_columns(self):
        for record in (None, no_district(), district("X")):
            self.assertEqual(tuple(fd.pathway_fields(record)), fd.PATHWAY_COLUMNS)

    def test_no_match_is_outside_nc(self):
        fields = fd.pathway_fields(None)
        self.assertEqual(fields["fire_district_status"], fd.STATUS_OUTSIDE_NC)
        for column in fd.PATHWAY_COLUMNS[:-1]:
            self.assertIsNone(fields[column])

    def test_no_district_keeps_only_county_and_date(self):
        fields = fd.pathway_fields(no_district(county="  Swain "))
        self.assertEqual(
            fields,
            {
                "fdid": None,
                "fire_department": None,
                "fd_county": "Swain",
                "fd_address": None,
                "district_updated": "2024-03-05",
                "fire_district_status": fd.STATUS_NO_DISTRICT,
            },
        )

    def test_real_department(self):
        record = district("Asheville  Fire Department", fdid=" 11201 ")
        self.assertEqual(
            fd.pathway_fields(record),
            {
                "fdid": "11201",
                "fire_department": "Asheville Fire Department",
                "fd_county": "Buncombe",
                "fd_address": "1 Main St",
                "district_updated": "2024-03-05",
                "fire_district_status": fd.STATUS_DISTRICT,
            },
        )

    def test_real_department_with_null_fdid(self):
        fields = fd.pathway_fields(district("Cherokee Tribal Fire", fdid=None))
        self.assertIsNone(fields["fdid"])
        self.assertEqual(fields["fire_department"], "Cherokee Tribal Fire")
        self.assertEqual(fields["fire_district_status"], fd.STATUS_DISTRICT)


def feature(name):
    return {"type": "Feature", "properties": {"firedepartment": name}, "geometry": None}


class FakeGetter:
    """Stands in for ndfd_check.get_json. Returns the given pages in order
    and remembers the parameters of every call."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def __call__(self, url, params=None, timeout=60):
        self.calls.append({"url": url, "params": dict(params or {})})
        return self.pages.pop(0)


class FetchWncDistrictsTest(unittest.TestCase):
    def test_pages_until_the_limit_flag_goes_away(self):
        getter = FakeGetter(
            [
                {"features": [feature("A"), feature("B")], "exceededTransferLimit": True},
                {"features": [feature("C")]},
            ]
        )
        result = fd.fetch_wnc_districts(get_json=getter)
        self.assertEqual(result["type"], "FeatureCollection")
        names = [f["properties"]["firedepartment"] for f in result["features"]]
        self.assertEqual(names, ["A", "B", "C"])
        self.assertEqual([c["params"]["resultOffset"] for c in getter.calls], [0, 2])

    def test_limit_flag_under_properties(self):
        getter = FakeGetter(
            [
                {"features": [feature("A")], "properties": {"exceededTransferLimit": True}},
                {"features": [feature("B")], "properties": {}},
            ]
        )
        result = fd.fetch_wnc_districts(get_json=getter)
        self.assertEqual(len(result["features"]), 2)
        self.assertEqual(len(getter.calls), 2)

    def test_query_parameters(self):
        getter = FakeGetter([{"features": [feature("A")]}])
        fd.fetch_wnc_districts(get_json=getter)
        call = getter.calls[0]
        self.assertEqual(call["url"], S.FIRE_DISTRICTS_URL + "/query")
        params = call["params"]
        self.assertEqual(params["where"], "1=1")
        self.assertEqual(params["outFields"], "FDID,firedepartment,fdcounty,fdaddress,dateupdated")
        self.assertEqual(params["geometry"], ",".join(str(c) for c in S.WNC_BBOX))
        self.assertEqual(params["geometryType"], "esriGeometryEnvelope")
        self.assertEqual(params["inSR"], "4326")
        self.assertEqual(params["spatialRel"], "esriSpatialRelIntersects")
        self.assertEqual(params["outSR"], 4326)
        self.assertEqual(params["f"], "geojson")
        self.assertEqual(params["returnGeometry"], "true")
        self.assertEqual(params["resultRecordCount"], 2000)

    def test_no_features_is_an_error(self):
        getter = FakeGetter([{"features": []}])
        with self.assertRaises(RuntimeError):
            fd.fetch_wnc_districts(get_json=getter)

    def test_missing_features_key_is_an_error(self):
        getter = FakeGetter([{"type": "FeatureCollection"}])
        with self.assertRaises(RuntimeError):
            fd.fetch_wnc_districts(get_json=getter)


class WriteDistrictsTest(unittest.TestCase):
    def test_creates_the_folder_and_leaves_no_temp_file(self):
        collection = {"type": "FeatureCollection", "features": [feature("A")]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cache" / "fire_districts_wnc.geojson"
            fd.write_districts(path, collection)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), collection)
            self.assertEqual([p.name for p in path.parent.iterdir()], [path.name])

    def test_replaces_an_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "districts.geojson"
            path.write_text("old", encoding="utf-8")
            collection = {"type": "FeatureCollection", "features": [feature("B")]}
            fd.write_districts(path, collection)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), collection)


if __name__ == "__main__":
    unittest.main()
