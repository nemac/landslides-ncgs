"""
refresh_simple.py - build the DFENS Simple data files.

Runs whenever ndfd_check.py found new NDFD data. Steps:

  1. Re-read the NDFD state (same function as the check, so the
     published key/window always match the data used).
  2. Fetch ALL precip categories for the single 24 h period, clip to the
     WNC bbox and write forecast_24h.geojson (the "NDFD forecast
     precipitation" map layer).
  3. If any polygons are >= 5" (cat 11): load debris flows from the local
     cache (cache/debris_flows.gpkg; fetched + tagged with county and
     watershed on a cold start via scripts/data.py),
     pre-filter them to those polygons' bounding box, and run the main
     pipeline's find_alerts() on that subset only.
  4. Simplify + round like the main pipeline; write
     flagged_ndfd_24h_min11.geojson and status.json (status last).

Run from the repo root:  python simple/pipeline/refresh_simple.py --out out
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent  # .../simple/pipeline
REPO = HERE.parent.parent  # .../landslides-ncgs
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "scripts"))  # shared main-pipeline modules

import fire_districts  # noqa: E402
import geopandas as gpd  # noqa: E402
import ndfd_check  # noqa: E402
import requests  # noqa: E402
import settings as S  # noqa: E402
from fire_district_join import assign_fire_districts, empty_fire_columns  # noqa: E402
from shapely.geometry import box  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

import analysis as shared_analysis  # noqa: E402  (scripts/analysis.py)
import data as shared_data  # noqa: E402  (scripts/data.py)
from config import (  # noqa: E402
    DEBRIS_VERSION_FIELD,
    DISPLAY_CRS,
    INTERSECTION_CRS,
    PATHWAY_KEY_FIELD,
)


def log(msg: str) -> None:
    print(f"[refresh-simple] {msg}", flush=True)


def fetch_precip(cycle_start, min_category: int) -> gpd.GeoDataFrame:
    params = {
        "where": S.period_where(cycle_start, S.WINDOW_HOURS, min_category),
        "outFields": "category,label",
        "outSR": 4326,
        "f": "geojson",
        "returnGeometry": "true",
        "geometry": ",".join(str(c) for c in S.WNC_BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
    }

    def query() -> dict:
        r = requests.get(S.NDFD_LAYER_URL + "/query", params=params, timeout=90)
        r.raise_for_status()
        page = r.json()
        if "error" in page:
            raise RuntimeError(f"NDFD query error: {page['error']}")
        return page

    # Same retry as the check step: this runs a minute or two later and
    # can land in the NDFD service's hourly reload just as easily.
    page = ndfd_check.retry(query, label="NDFD precip query")
    feats = page.get("features") or []
    if not feats:
        return gpd.GeoDataFrame({"category": [], "label": []}, geometry=[], crs=DISPLAY_CRS)
    gdf = gpd.GeoDataFrame.from_features(feats, crs=DISPLAY_CRS)
    return repair_polygons(gdf)


def _polygonal(geom):
    """Keep only the polygon parts of a geometry (make_valid can return a
    GeometryCollection that also holds stray lines/points)."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        return unary_union(polys) if polys else None
    return None


def repair_polygons(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Service polygons (NDFD contours, fire districts) are occasionally
    self-intersecting, which makes GEOS overlay operations (clip,
    intersection) throw a TopologyException ("side location conflict").
    Repair invalid ones with make_valid and drop anything that isn't
    polygonal afterwards."""
    bad = ~gdf.geometry.is_valid
    if bad.any():
        log(f"repairing {int(bad.sum())} invalid polygon(s)")
        fixed = gdf.geometry.make_valid().apply(_polygonal)
        gdf = gdf.set_geometry(fixed)
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    return gdf


# ---------------------------------------------------------------------------
# Fire districts (NC OSFM) - primary district per flagged pathway
# ---------------------------------------------------------------------------
def load_fire_districts() -> gpd.GeoDataFrame:
    """The WNC fire districts from cache/. In production a workflow step
    has already placed the file there; on a developer machine, or before
    the data bucket has a copy, it is downloaded here first."""
    path = REPO / S.FIRE_DISTRICTS_CACHE
    if not path.exists():
        log("no local fire district file; downloading the WNC districts")
        collection = fire_districts.fetch_wnc_districts()
        fire_districts.write_districts(path, collection)
    districts = repair_polygons(gpd.read_file(path))
    # Counted after the repair, which drops polygons it cannot fix.
    fire_districts.require_enough_districts(len(districts))
    return districts


def warn_about_unmatched_pathways(tagged: gpd.GeoDataFrame) -> None:
    """Flag a run where a pathway matched no district polygon. The state
    layer covers all of NC, so "Outside North Carolina" should be rare.
    It is also what a district file with polygons missing would produce,
    and the count checks cannot catch every such file."""
    statuses = tagged["fire_district_status"]
    unmatched = int((statuses == fire_districts.STATUS_OUTSIDE_NC).sum())
    if unmatched == 0:
        return
    # A line that starts with ::warning:: shows as a warning on the
    # GitHub Actions run page, so it is printed without the log prefix.
    print(
        f"::warning::{unmatched} flagged pathway(s) matched no fire district polygon "
        "and are marked Outside North Carolina. Check that the pathways really are "
        "outside the state and that cache/fire_districts_wnc.geojson is complete.",
        flush=True,
    )


def tag_fire_districts(flagged: gpd.GeoDataFrame) -> tuple[gpd.GeoDataFrame, str]:
    """Add the fire district columns. Returns the tagged pathways and the
    lookup result for meta.fire_districts."""
    try:
        districts = load_fire_districts()
        tagged = assign_fire_districts(flagged, districts, INTERSECTION_CRS)
    # Deliberately broad: a fire district failure must never stop the
    # flagged pathways from being published.
    except Exception as e:
        log(f"WARNING: fire district lookup failed ({type(e).__name__}: {e})")
        return empty_fire_columns(flagged), fire_districts.LOOKUP_UNAVAILABLE
    warn_about_unmatched_pathways(tagged)
    in_district = int((tagged["fire_district_status"] == fire_districts.STATUS_DISTRICT).sum())
    log(f"fire districts: {in_district} of {len(tagged)} flagged pathways in a fire district")
    return tagged, fire_districts.LOOKUP_OK


def debris_layer_version(debris: gpd.GeoDataFrame) -> str | None:
    """Which NCGS layer version the pathway IDs belong to. None for a
    cache file that does not name one (built before 2026-11-13)."""
    if DEBRIS_VERSION_FIELD not in debris.columns or debris.empty:
        return None
    return str(debris[DEBRIS_VERSION_FIELD].iloc[0])


def round_coords(geom_json: dict, nd: int) -> None:
    def rnd(c):
        if c and isinstance(c[0], (int, float)):
            return [round(v, nd) for v in c]
        return [rnd(x) for x in c]

    if geom_json and "coordinates" in geom_json:
        geom_json["coordinates"] = rnd(geom_json["coordinates"])


def build(out: Path) -> int:
    """Write forecast_24h, the flagged file and status.json into `out`.
    Returns the number of flagged pathways. Used by main() and run_local.py."""
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    state = ndfd_check.ndfd_state()
    log(
        f"window {state['window_start']:%Y-%m-%d %H:%M} -> "
        f"{state['window_end']:%Y-%m-%d %H:%M} UTC, NDFD updated {state['issued']}"
    )

    # ---- Forecast layer: every category, clipped to WNC -----------------
    allcat = fetch_precip(state["window_start"], 0)
    log(f"{len(allcat)} precip polygons (all categories) touch the WNC bbox")
    forecast_fc = {"type": "FeatureCollection", "features": []}
    if not allcat.empty:
        try:
            clipped = gpd.clip(allcat, box(*S.WNC_BBOX))
        except Exception as e:  # last resort: never let the map layer kill the run
            log(f"clip failed ({type(e).__name__}: {e}); writing unclipped polygons")
            clipped = allcat
        clipped = clipped[~clipped.geometry.is_empty][["category", "label", "geometry"]]
        forecast_fc = json.loads(clipped.to_json())
        for f in forecast_fc["features"]:
            round_coords(f.get("geometry"), S.COORD_PRECISION)
            f.pop("id", None)
            f["properties"]["category"] = int(f["properties"]["category"])
    forecast_fc["meta"] = {
        **ndfd_check.build_meta(state, 0, datetime.now(UTC)),
        "n_polygons": len(forecast_fc["features"]),
        "min_category_shipped": 0,
    }
    forecast_fc["meta"].pop("n_flagged", None)
    ndfd_check.write_json(out / S.FORECAST_FILENAME, forecast_fc)
    log(f"wrote {S.FORECAST_FILENAME} ({len(forecast_fc['features'])} polygons)")

    # ---- Flagged pathways: only the >= threshold polygons matter --------
    precip = (
        allcat[allcat["category"].astype(int) >= S.THRESHOLD_CATEGORY]
        if not allcat.empty
        else allcat
    )
    log(f"{len(precip)} precip polygons >= cat {S.THRESHOLD_CATEGORY}")

    flagged = None
    ncgs_layer_version = None
    if not precip.empty:
        debris = shared_data.fetch_debris_flows()  # cached gpkg, WGS84
        ncgs_layer_version = debris_layer_version(debris)
        log(f"debris flows loaded: {len(debris):,} ({time.time() - t0:.0f}s)")
        minx, miny, maxx, maxy = precip.total_bounds
        cand = debris.cx[minx:maxx, miny:maxy]
        log(f"candidates in precip bbox: {len(cand):,}")
        flagged = shared_analysis.find_alerts(cand, precip)
        log(f"flagged: {len(flagged):,} ({time.time() - t0:.0f}s)")

    features = []
    fire_district_lookup = fire_districts.LOOKUP_NOT_RUN
    if flagged is not None and not flagged.empty:
        # Published as `pathway_id`: the name the page and the CSV use for
        # the one value that is different for every pathway.
        flagged = flagged.rename(
            columns={"category": "max_category", PATHWAY_KEY_FIELD: "pathway_id"}
        )
        flagged, fire_district_lookup = tag_fire_districts(flagged)
        proj = flagged.to_crs(INTERSECTION_CRS)
        proj["geometry"] = proj.geometry.simplify(S.SIMPLIFY_METERS, preserve_topology=True)
        flagged = proj.to_crs(DISPLAY_CRS)
        fc = json.loads(flagged.to_json())
        for f in fc["features"]:
            round_coords(f.get("geometry"), S.COORD_PRECISION)
            f.pop("id", None)
            p = f["properties"]
            p["max_category"] = int(p["max_category"])
            p["pathway_id"] = int(p["pathway_id"])
            p["OBJECTID"] = int(p["OBJECTID"])
        features = fc["features"]

    now = datetime.now(UTC)
    meta = ndfd_check.build_meta(state, len(features), now)
    meta["fire_districts"] = fire_district_lookup
    # A pathway_id is a row number in one version of the NCGS layer. This
    # says which one. It is None when no pathways were looked up.
    meta["ncgs_layer_version"] = ncgs_layer_version
    ndfd_check.write_json(
        out / S.FLAGGED_FILENAME, {"type": "FeatureCollection", "features": features, "meta": meta}
    )
    ndfd_check.write_json(out / "status.json", ndfd_check.build_status(meta, now, "updated"))
    log(f"wrote {S.FLAGGED_FILENAME} ({len(features)} features) in {time.time() - t0:.0f}s total")
    return len(features)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    args = ap.parse_args()
    build(Path(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
