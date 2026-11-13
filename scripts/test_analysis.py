"""Tests for find_alerts in analysis.py: which debris-flow pathways are
flagged, and that each pathway is counted once by its unique key.

Run from the repo root:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import sys
import unittest
from pathlib import Path

import geopandas as gpd
from shapely.geometry import box

# analysis.py imports config.py as a sibling, so scripts/ must be importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from analysis import find_alerts  # noqa: E402
from config import PATHWAY_KEY_FIELD  # noqa: E402

WGS84 = "EPSG:4326"


def small_square(lon, lat, half_size=0.001):
    return box(lon - half_size, lat - half_size, lon + half_size, lat + half_size)


def make_pathways(rows):
    """rows: (unique key, OBJECTID, geometry)."""
    return gpd.GeoDataFrame(
        {
            PATHWAY_KEY_FIELD: [key for key, _, _ in rows],
            "OBJECTID": [objectid for _, objectid, _ in rows],
        },
        geometry=[geometry for _, _, geometry in rows],
        crs=WGS84,
    )


def make_rain(rows):
    """rows: (category, geometry)."""
    return gpd.GeoDataFrame(
        {
            "category": [category for category, _ in rows],
            "label": [f"cat {category}" for category, _ in rows],
        },
        geometry=[geometry for _, geometry in rows],
        crs=WGS84,
    )


# Two pathways about 20 km apart. They share OBJECTID 7, as pathways from
# two different source tiles of the NCGS layer do.
WEST_PATHWAY = (101, 7, small_square(-82.60, 35.60))
EAST_PATHWAY = (202, 7, small_square(-82.38, 35.60))
RAIN_OVER_BOTH = box(-82.70, 35.50, -82.30, 35.70)


class FindAlertsTest(unittest.TestCase):
    def test_two_pathways_that_share_an_objectid_are_both_flagged(self):
        pathways = make_pathways([WEST_PATHWAY, EAST_PATHWAY])
        rain = make_rain([(11, RAIN_OVER_BOTH)])

        flagged = find_alerts(pathways, rain)

        self.assertEqual(sorted(flagged[PATHWAY_KEY_FIELD]), [101, 202])
        self.assertEqual(list(flagged["OBJECTID"]), [7, 7])

    def test_a_pathway_under_two_rain_bins_is_flagged_once_with_the_worst(self):
        pathways = make_pathways([WEST_PATHWAY])
        rain = make_rain([(11, RAIN_OVER_BOTH), (13, small_square(-82.60, 35.60, 0.01))])

        flagged = find_alerts(pathways, rain)

        self.assertEqual(list(flagged[PATHWAY_KEY_FIELD]), [101])
        self.assertEqual(list(flagged["category"]), [13])
        self.assertEqual(list(flagged["label"]), ["cat 13"])

    def test_each_pathway_keeps_its_own_worst_bin(self):
        pathways = make_pathways([WEST_PATHWAY, EAST_PATHWAY])
        rain = make_rain([(11, RAIN_OVER_BOTH), (13, small_square(-82.38, 35.60, 0.01))])

        flagged = find_alerts(pathways, rain).set_index(PATHWAY_KEY_FIELD)

        self.assertEqual(flagged.loc[101, "category"], 11)
        self.assertEqual(flagged.loc[202, "category"], 13)

    def test_a_pathway_outside_the_rain_is_not_flagged(self):
        dry_pathway = (303, 9, small_square(-83.50, 35.20))
        pathways = make_pathways([WEST_PATHWAY, dry_pathway])
        rain = make_rain([(11, RAIN_OVER_BOTH)])

        flagged = find_alerts(pathways, rain)

        self.assertEqual(list(flagged[PATHWAY_KEY_FIELD]), [101])

    def test_pathways_without_the_unique_key_are_refused(self):
        # A debris-flow cache built before the key was kept has only
        # OBJECTID. Using it would drop pathways again, so stop instead.
        pathways = make_pathways([WEST_PATHWAY, EAST_PATHWAY]).drop(columns=[PATHWAY_KEY_FIELD])
        rain = make_rain([(11, RAIN_OVER_BOTH)])

        with self.assertRaisesRegex(ValueError, PATHWAY_KEY_FIELD):
            find_alerts(pathways, rain)

    def test_no_rain_gives_an_empty_result_with_the_key_column(self):
        pathways = make_pathways([WEST_PATHWAY])
        no_rain = make_rain([])

        flagged = find_alerts(pathways, no_rain)

        self.assertTrue(flagged.empty)
        self.assertIn(PATHWAY_KEY_FIELD, flagged.columns)


if __name__ == "__main__":
    unittest.main()
