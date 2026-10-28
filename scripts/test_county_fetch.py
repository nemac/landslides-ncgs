"""Tests for the county fetch that chunks the building footprints.

Run from the repo root in an environment with geopandas:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The buildings rebuild imports duckdb, whose native module cannot be loaded
# twice in one process. Import it here so the sys.modules snapshot that
# patch.dict restores below still contains it between rebuild tests.
import duckdb  # noqa: E402, F401
import geopandas as gpd  # noqa: E402
from shapely.geometry import box  # noqa: E402

import data  # noqa: E402


def _county_feature(fips: str, name: str) -> dict:
    return {
        "type": "Feature",
        "properties": {"NAME": name, "GEOID": f"{fips}001", "STATE": fips},
        "geometry": box(-83, 35, -82, 36).__geo_interface__,
    }


def _census_failing_for(failing_fips: str):
    """A stand-in for _agol_request_with_retry: one state's query fails,
    every other state returns one county."""

    def request(url, params, label, **kwargs):
        fips = params["where"].split("'")[1]
        if fips == failing_fips:
            raise ConnectionError(f"{label}: timed out")
        return {"features": [_county_feature(fips, f"County {fips}")]}

    return request


def _census_empty_for(empty_fips: str):
    """A stand-in for _agol_request_with_retry: one state's query succeeds
    but returns no counties, every other state returns one county."""

    def request(url, params, label, **kwargs):
        fips = params["where"].split("'")[1]
        if fips == empty_fips:
            return {"features": []}
        return {"features": [_county_feature(fips, f"County {fips}")]}

    return request


class CountyFetchTest(unittest.TestCase):
    def test_lenient_fetch_keeps_the_states_that_answered(self):
        with mock.patch.object(data, "_agol_request_with_retry", _census_failing_for("47")):
            counties = data._fetch_nc_counties()
        self.assertEqual(len(counties), 4)
        self.assertNotIn("47", set(counties["STATE"]))

    def test_strict_fetch_fails_when_one_state_fails(self):
        with mock.patch.object(data, "_agol_request_with_retry", _census_failing_for("47")):
            with self.assertRaises(ConnectionError):
                data._fetch_nc_counties(strict=True)

    def test_strict_fetch_fails_when_one_state_returns_no_counties(self):
        with mock.patch.object(data, "_agol_request_with_retry", _census_empty_for("51")):
            with self.assertRaises(RuntimeError):
                data._fetch_nc_counties(strict=True)


class BuildingsRebuildTest(unittest.TestCase):
    """A rebuild that cannot fetch every state's counties must fail rather
    than write a partial set of county files: the workflow mirrors the
    output folder to the bucket with --delete, so a partial set would
    delete the missing state's files until the next rebuild."""

    def _fake_overture(self):
        footprints = gpd.GeoDataFrame(
            {"id": ["a", "b"]},
            geometry=[box(-82.6, 35.5, -82.59, 35.51), box(-82.5, 35.6, -82.49, 35.61)],
            crs="EPSG:4326",
        )
        module = types.ModuleType("overturemaps")
        module.geodataframe = lambda kind, bbox, release=None: footprints
        return module

    def test_rebuild_fails_when_a_state_county_fetch_fails(self):
        with (
            tempfile.TemporaryDirectory() as out,
            mock.patch.dict(sys.modules, {"overturemaps": self._fake_overture()}),
            mock.patch.object(data, "_agol_request_with_retry", _census_failing_for("47")),
        ):
            with self.assertRaises(ConnectionError):
                data.fetch_overture_buildings(output_dir=Path(out), release="2026-10-21.0")
            self.assertEqual(list(Path(out).rglob("*.geojson")), [])

    def test_rebuild_fails_when_a_state_returns_no_counties(self):
        with (
            tempfile.TemporaryDirectory() as out,
            mock.patch.dict(sys.modules, {"overturemaps": self._fake_overture()}),
            mock.patch.object(data, "_agol_request_with_retry", _census_empty_for("51")),
        ):
            with self.assertRaises(RuntimeError):
                data.fetch_overture_buildings(output_dir=Path(out), release="2026-10-21.0")
            self.assertEqual(list(Path(out).rglob("*.geojson")), [])


if __name__ == "__main__":
    unittest.main()
