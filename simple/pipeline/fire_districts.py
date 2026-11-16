"""
fire_districts.py - NC fire districts for the DFENS Simple pipeline.

Standard library only. It downloads the fire districts that touch western
North Carolina from the NC Office of State Fire Marshal layer, and turns
one district record into the fields each flagged pathway carries.
The spatial match itself lives in fire_district_join.py (geopandas).

Run from the repo root to refresh the local copy:
    python simple/pipeline/fire_districts.py --out cache/fire_districts_wnc.geojson

The file names the version of the state layer it came from. To print it:
    python simple/pipeline/fire_districts.py --version-of cache/fire_districts_wnc.geojson
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


def _wnc_filter_params() -> dict:
    """The part of a query that picks the districts touching WNC."""
    return {
        "where": "1=1",
        "geometry": ",".join(str(c) for c in S.WNC_BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
    }


def _query_params(offset: int) -> dict:
    return {
        **_wnc_filter_params(),
        "outFields": ",".join(SERVICE_FIELDS),
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


def fetch_wnc_district_count(get_json=ndfd_check.get_json) -> int:
    """How many districts the service says touch the WNC box."""
    params = {**_wnc_filter_params(), "returnCountOnly": "true", "f": "json"}
    answer = get_json(S.FIRE_DISTRICTS_URL + "/query", params, timeout=REQUEST_TIMEOUT_SECONDS)
    count = answer.get("count")
    # bool counts as a number in Python, but it is never a real count.
    if not isinstance(count, int) or isinstance(count, bool):
        raise RuntimeError("fire district service did not report a count")
    return count


def require_complete_download(downloaded: int, get_json) -> None:
    """Raise RuntimeError unless the download holds every district the
    service has for WNC. The fixed minimum alone would let a download
    that is a few dozen districts short through."""
    require_enough_districts(downloaded)
    expected = fetch_wnc_district_count(get_json)
    if downloaded != expected:
        raise RuntimeError(
            f"downloaded {downloaded} WNC fire districts but the service has {expected}"
        )


def fetch_wnc_districts(get_json=ndfd_check.get_json) -> dict:
    """Every district that touches the WNC box, as a GeoJSON
    FeatureCollection. Raises RuntimeError if the answer is short or does
    not match the service's own count."""
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
    require_complete_download(len(features), get_json)
    return {"type": "FeatureCollection", "features": features}


def fetch_layer_version(get_json=ndfd_check.get_json) -> str:
    """Which version of the state's fire district layer is being served:
    its data-last-edit time in UTC, safe in a file path, like
    "2026-03-03T171307Z". The same format scripts/data.py uses for the
    debris-flow layer."""
    info = get_json(S.FIRE_DISTRICTS_URL, {"f": "json"}, timeout=REQUEST_TIMEOUT_SECONDS)
    last_edit_ms = (info.get("editingInfo") or {}).get("dataLastEditDate")
    if not last_edit_ms:
        raise RuntimeError("fire district layer reports no data edit date")
    last_edit = datetime.fromtimestamp(int(last_edit_ms) / 1000, tz=UTC)
    return last_edit.strftime("%Y-%m-%dT%H%M%SZ")


def download_wnc_districts(get_json=ndfd_check.get_json) -> dict:
    """The WNC districts, with the layer version they came from in a
    top-level "layer_version" field."""
    # Read first, so the districts are never newer than their name.
    layer_version = fetch_layer_version(get_json)
    collection = fetch_wnc_districts(get_json)
    collection["layer_version"] = layer_version
    return collection


def read_layer_version(path: Path) -> str | None:
    """The layer version a district file was downloaded from. None for a
    file written before 2026-11-13, which does not say."""
    collection = json.loads(Path(path).read_text(encoding="utf-8"))
    return collection.get("layer_version")


def write_districts(path: Path, feature_collection: dict) -> None:
    """Write through a temp file so a reader never sees half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(json.dumps(feature_collection, separators=(",", ":")), encoding="utf-8")
    temp_path.replace(path)


def print_version_of(path: Path) -> int:
    """For refresh-reference.yml, which names the copy it keeps of each
    layer version from the file itself. Fails for a file with no version."""
    layer_version = read_layer_version(path)
    if not layer_version:
        print(f"[fire-districts] {path} names no layer version; rebuild it", file=sys.stderr)
        return 1
    print(layer_version)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the WNC fire districts.")
    parser.add_argument("--out", default=str(REPO / S.FIRE_DISTRICTS_CACHE))
    parser.add_argument(
        "--version-of",
        metavar="FILE",
        help="print the layer version a district file holds, and download nothing",
    )
    args = parser.parse_args()

    if args.version_of:
        return print_version_of(Path(args.version_of))

    collection = download_wnc_districts()
    write_districts(Path(args.out), collection)
    print(f"[fire-districts] wrote {len(collection['features'])} districts to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
