"""
fire_districts.py - NC fire districts for the DFENS Simple pipeline.

Standard library only. It downloads the fire districts that touch western
North Carolina from the NC Office of State Fire Marshal layer, and turns
one district record into the fields each flagged pathway carries.
The spatial match itself lives in fire_district_join.py (geopandas).

Run from the repo root to refresh the local copy:
    python simple/pipeline/fire_districts.py --out cache/fire_districts_wnc.geojson
"""

from __future__ import annotations

import argparse
import json
import numbers
import sys
from datetime import UTC, datetime
from pathlib import Path

import ndfd_check
import settings as S

REPO = Path(__file__).resolve().parent.parent.parent

# The layer covers all of NC. Land outside any fire district is covered by
# polygons with this department name, so a point in NC always matches.
NO_DISTRICT_NAME = "No District"

# What the lookup found for one pathway.
STATUS_DISTRICT = "district"
STATUS_NO_DISTRICT = "no_district"
STATUS_OUTSIDE_NC = "outside_nc"

# Whether the lookup ran for the whole file (meta.fire_districts).
LOOKUP_OK = "ok"
LOOKUP_UNAVAILABLE = "unavailable"
LOOKUP_NOT_RUN = "not_run"

PATHWAY_COLUMNS = (
    "fdid",
    "fire_department",
    "fd_county",
    "fd_address",
    "district_updated",
    "fire_district_status",
)

SERVICE_FIELDS = ("FDID", "firedepartment", "fdcounty", "fdaddress", "dateupdated")
PAGE_SIZE = 2000  # the most the service returns in one answer
REQUEST_TIMEOUT_SECONDS = 120


def is_missing(value) -> bool:
    # NaN and pandas' NaT are the only values that are not equal to themselves.
    return value is None or value != value


def clean_text(value) -> str | None:
    if is_missing(value):
        return None
    text = " ".join(str(value).split())
    if text == "":
        return None
    return text


def format_district_date(value) -> str | None:
    """YYYY-MM-DD from epoch milliseconds or a date-like object."""
    if is_missing(value):
        return None
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    # bool counts as a number in Python, but it is never a real date.
    # numbers.Real also covers the numpy integers geopandas reads.
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        moment = datetime.fromtimestamp(float(value) / 1000, tz=UTC)
        return moment.strftime("%Y-%m-%d")
    return None


def is_no_district(record: dict) -> bool:
    name = clean_text(record.get("firedepartment"))
    if name is None:
        return False
    return name.lower() == NO_DISTRICT_NAME.lower()


def _choice_order(candidate: dict) -> tuple:
    """Sort key: real departments first, then lowest rank, then names.
    The names only break ties, so the answer never depends on input order."""
    department = clean_text(candidate.get("firedepartment")) or ""
    fdid = clean_text(candidate.get("FDID")) or ""
    return (is_no_district(candidate), candidate["rank"], department, fdid)


def choose_district(candidates: list[dict]) -> dict | None:
    if not candidates:
        return None
    return min(candidates, key=_choice_order)


def _overlap_order(candidate: dict) -> tuple:
    """Sort key: lowest rank first, so the largest overlap wins. A real
    department and then the names only break exact ties."""
    department = clean_text(candidate.get("firedepartment")) or ""
    fdid = clean_text(candidate.get("FDID")) or ""
    return (candidate["rank"], is_no_district(candidate), department, fdid)


def choose_largest_overlap(candidates: list[dict]) -> dict | None:
    """Like choose_district, but "No District" land competes on overlap.
    A pathway that is mostly "No District" land stays "No District"."""
    if not candidates:
        return None
    return min(candidates, key=_overlap_order)


def _outside_nc_fields() -> dict:
    fields = {}
    for column in PATHWAY_COLUMNS:
        fields[column] = None
    fields["fire_district_status"] = STATUS_OUTSIDE_NC
    return fields


def _no_district_fields(record: dict) -> dict:
    return {
        "fdid": None,
        "fire_department": None,
        "fd_county": clean_text(record.get("fdcounty")),
        "fd_address": None,
        "district_updated": format_district_date(record.get("dateupdated")),
        "fire_district_status": STATUS_NO_DISTRICT,
    }


def _department_fields(record: dict) -> dict:
    return {
        "fdid": clean_text(record.get("FDID")),
        "fire_department": clean_text(record.get("firedepartment")),
        "fd_county": clean_text(record.get("fdcounty")),
        "fd_address": clean_text(record.get("fdaddress")),
        "district_updated": format_district_date(record.get("dateupdated")),
        "fire_district_status": STATUS_DISTRICT,
    }


def pathway_fields(record: dict | None) -> dict:
    """The six fire district fields for one pathway. None means no
    polygon matched, which can only happen outside NC."""
    if record is None:
        return _outside_nc_fields()
    if is_no_district(record):
        return _no_district_fields(record)
    return _department_fields(record)


def require_enough_districts(count: int) -> None:
    """Raise RuntimeError when a set of districts is too small to be all
    of WNC. Used on the download and again on the file the lookup reads."""
    if count < S.FIRE_DISTRICTS_MIN_COUNT:
        raise RuntimeError(
            f"only {count} WNC fire districts; expected at least {S.FIRE_DISTRICTS_MIN_COUNT}"
        )


def _query_params(offset: int) -> dict:
    return {
        "where": "1=1",
        "outFields": ",".join(SERVICE_FIELDS),
        "geometry": ",".join(str(c) for c in S.WNC_BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": 4326,
        "f": "geojson",
        "returnGeometry": "true",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
    }


def _has_more_pages(page: dict) -> bool:
    # The service puts this flag at the top level or under "properties".
    if page.get("exceededTransferLimit"):
        return True
    properties = page.get("properties") or {}
    return bool(properties.get("exceededTransferLimit"))


def fetch_wnc_districts(get_json=ndfd_check.get_json) -> dict:
    """Every district that touches the WNC box, as a GeoJSON
    FeatureCollection. Raises RuntimeError if the answer is too short."""
    features = []
    offset = 0
    while True:
        page = get_json(
            S.FIRE_DISTRICTS_URL + "/query",
            _query_params(offset),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        batch = page.get("features") or []
        features.extend(batch)
        if not batch or not _has_more_pages(page):
            break
        offset += len(batch)

    # An empty or partial answer must never replace a good copy of the file.
    require_enough_districts(len(features))
    return {"type": "FeatureCollection", "features": features}


def write_districts(path: Path, feature_collection: dict) -> None:
    """Write through a temp file so a reader never sees half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(json.dumps(feature_collection, separators=(",", ":")), encoding="utf-8")
    temp_path.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the WNC fire districts.")
    parser.add_argument("--out", default=str(REPO / S.FIRE_DISTRICTS_CACHE))
    args = parser.parse_args()

    collection = fetch_wnc_districts()
    write_districts(Path(args.out), collection)
    print(f"[fire-districts] wrote {len(collection['features'])} districts to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
