"""
fire_district_join.py - match each flagged pathway to one NC fire district.

The caller passes a metric CRS (refresh_simple uses INTERSECTION_CRS), so
areas are in square meters. The rules for picking one district, and the
fields written for it, live in fire_districts.py.
"""

from __future__ import annotations

import fire_districts
import geopandas as gpd
import pandas as pd

# geopandas names the matched district's row number with this column.
MATCHED_ROW = "index_right"


def _district_records(districts: gpd.GeoDataFrame) -> list[dict]:
    """One dict of service fields per district, in row order."""
    records = []
    for _, row in districts.iterrows():
        record = {}
        for field in fire_districts.SERVICE_FIELDS:
            record[field] = row.get(field)
        records.append(record)
    return records


def _candidate(record: dict, rank: float) -> dict:
    candidate = dict(record)
    candidate["rank"] = rank
    return candidate


def _point_candidates(pathways, districts, records) -> dict[int, list[dict]]:
    """Stage 1: districts that hold a point inside each pathway. The
    district's area is its rank, so the smaller, more specific one wins."""
    points = gpd.GeoDataFrame(
        {"pathway": range(len(pathways))},
        geometry=pathways.geometry.representative_point().values,
        crs=pathways.crs,
    )
    pairs = gpd.sjoin(points, districts[[districts.geometry.name]], how="inner", predicate="within")
    district_areas = districts.geometry.area

    candidates = {}
    for pathway, district in zip(pairs["pathway"], pairs[MATCHED_ROW], strict=True):
        rank = district_areas.iloc[district]
        candidates.setdefault(pathway, []).append(_candidate(records[district], rank))
    return candidates


def _overlap_candidates(pathways, districts, records, unmatched) -> dict[int, list[dict]]:
    """Stage 2: districts that overlap the pathway's polygon. The rank is
    minus the overlap area, so the largest overlap wins. A district that
    only touches the pathway's edge has no overlap and is left out."""
    polygons = gpd.GeoDataFrame(
        {"pathway": unmatched},
        geometry=pathways.geometry.iloc[unmatched].values,
        crs=pathways.crs,
    )
    pairs = gpd.sjoin(
        polygons, districts[[districts.geometry.name]], how="inner", predicate="intersects"
    )

    candidates = {}
    for pathway, district in zip(pairs["pathway"], pairs[MATCHED_ROW], strict=True):
        pathway_shape = pathways.geometry.iloc[pathway]
        district_shape = districts.geometry.iloc[district]
        overlap = pathway_shape.intersection(district_shape).area
        if overlap > 0:
            candidates.setdefault(pathway, []).append(_candidate(records[district], -overlap))
    return candidates


def match_fire_districts(flagged, districts, crs) -> list[dict | None]:
    """One district record (or None outside NC) per pathway, in order."""
    # Plain 0..n-1 row numbers, so sjoin results point straight at rows.
    pathways = flagged.to_crs(crs).reset_index(drop=True)
    districts = districts.to_crs(crs).reset_index(drop=True)
    records = _district_records(districts)

    candidates = _point_candidates(pathways, districts, records)

    # A pathway's point can land in a thin gap between two NC districts.
    # Its polygon still overlaps them, so it is not really outside NC.
    unmatched = []
    for pathway in range(len(pathways)):
        if pathway not in candidates:
            unmatched.append(pathway)
    if unmatched:
        overlaps = _overlap_candidates(pathways, districts, records, unmatched)
        candidates.update(overlaps)

    matches = []
    for pathway in range(len(pathways)):
        matches.append(fire_districts.choose_district(candidates.get(pathway, [])))
    return matches


def assign_fire_districts(flagged, districts, crs) -> gpd.GeoDataFrame:
    """A copy of `flagged` with the six fire district columns filled in."""
    matches = match_fire_districts(flagged, districts, crs)
    rows = []
    for match in matches:
        rows.append(fire_districts.pathway_fields(match))

    tagged = flagged.copy()
    for column in fire_districts.PATHWAY_COLUMNS:
        values = []
        for row in rows:
            values.append(row[column])
        # object dtype keeps None as None. pandas 3 would otherwise make a
        # text column and turn each None into NaN.
        tagged[column] = pd.Series(values, index=tagged.index, dtype=object)
    return tagged


def empty_fire_columns(flagged) -> gpd.GeoDataFrame:
    """A copy of `flagged` with the six columns empty, for when the lookup
    could not run."""
    tagged = flagged.copy()
    for column in fire_districts.PATHWAY_COLUMNS:
        tagged[column] = None
    return tagged
