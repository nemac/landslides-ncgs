#!/usr/bin/env python3
"""
refresh.py - DEFNS Alerts data pipeline

Fetches live NWS NDFD precipitation forecast and NOAA MRMS 1-hour observed
QPE, clips both to the WNC bounding box, and writes two GeoJSON files that
the static frontend reads on page load:

    landslidesncgs.com/alerts/data/forecast.geojson
    landslidesncgs.com/alerts/data/observed.geojson

Each file is a standard GeoJSON FeatureCollection with an additional `meta`
property at the top level containing timestamps, source info, and freshness
markers. (Non-strict GeoJSON, but every parser tolerates extra top-level
keys.)

Phase 3a: Run manually whenever fresh data is wanted.

    python scripts/refresh.py

Phase 3b: Wrap in a GitHub Actions cron once the deploy story is settled.

Exit codes:
    0 = both files written successfully
    1 = both fetches failed
    2 = one fetch failed (the other file is still written)

This means the script is safe to run on a schedule; the frontend gracefully
falls back to mock data if a file is missing or stale.
"""

from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

# Make scripts/ importable so we can pull in our data.py and config.py
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DATA_DIR = REPO_ROOT / "alerts" / "data"

sys.path.insert(0, str(HERE))

import data as defns_data            # noqa: E402  (intentional: see sys.path above)
import analysis as defns_analysis    # noqa: E402
from config import WNC_BBOX, DISPLAY_CRS  # noqa: E402


# Module-level cache so debris flows are fetched once per refresh run and
# reused for both NDFD and MRMS intersections.
_debris_cache: dict = {}


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[defns-refresh] Output directory: {DATA_DIR}")
    print(f"[defns-refresh] Started at:       {datetime.now(timezone.utc).isoformat()}")

    # Fetch precipitation first. If both fail, no point loading debris flows.
    ndfd_ok = _safely(_refresh_ndfd, "NDFD forecast")
    mrms_ok = _safely(_refresh_mrms, "MRMS observed")

    # Load debris flows once (used for both intersections below)
    debris_ok = ndfd_ok or mrms_ok
    if debris_ok:
        debris_ok = _safely(_load_debris_flows, "Debris flow polygons")

    # Intersect against each precip source that succeeded
    flagged_ndfd_ok = False
    flagged_mrms_ok = False
    if debris_ok and ndfd_ok:
        flagged_ndfd_ok = _safely(_refresh_flagged_ndfd, "NDFD intersections")
    if debris_ok and mrms_ok:
        flagged_mrms_ok = _safely(_refresh_flagged_mrms, "MRMS intersections")

    # Summary
    successes = sum([ndfd_ok, mrms_ok, flagged_ndfd_ok, flagged_mrms_ok])
    if successes == 4:
        print("\n[defns-refresh] DONE - all four files written.")
        return 0
    elif successes == 0:
        print("\n[defns-refresh] ALL FAILED - no files written.")
        return 1
    else:
        print(f"\n[defns-refresh] PARTIAL - {successes}/4 files written.")
        return 2


def _safely(fn, label: str) -> bool:
    """Run one of the refresh functions, capturing exceptions so a single
    failure doesn't crash the whole script. Returns True on success."""
    try:
        print(f"\n[defns-refresh] === {label} ===")
        fn()
        return True
    except Exception as e:
        print(f"[defns-refresh] {label} FAILED: {type(e).__name__}: {e}")
        traceback.print_exc()
        return False


# ============================================================================
# NDFD forecast
# ============================================================================

def _refresh_ndfd() -> None:
    # min_category=0 returns ALL categories so the client can re-threshold
    # without re-fetching. Window matches the default UI value (12 hr).
    gdf, fromdate, todate = defns_data.fetch_precip_forecast(
        window_hours=12, min_category=0
    )
    print(f"  Fetched {len(gdf)} NDFD polygons across all categories.")

    gdf_clipped = _clip_to_wnc(gdf)
    print(f"  Clipped to WNC bbox: {len(gdf_clipped)} polygons remain.")

    # Slim payload: keep only the fields the frontend reads. Smaller JSON.
    keep_cols = [c for c in ["category", "label", "geometry"] if c in gdf_clipped.columns]
    gdf_slim = gdf_clipped[keep_cols].copy()

    # Convert to GeoJSON and attach meta
    fc = json.loads(gdf_slim.to_json())
    fc["meta"] = {
        "source":        "NWS NDFD precipitation forecast",
        "issued":        _to_iso(fromdate),
        "window_end":    _to_iso(todate),
        "window_hours":  12,
        "generated_at":  _to_iso(datetime.now(timezone.utc)),
        "n_polygons":    len(gdf_slim),
    }

    out_path = DATA_DIR / "forecast.geojson"
    _write_json(out_path, fc)
    print(f"  Wrote {out_path.name}: {out_path.stat().st_size / 1024:.1f} KB")


# ============================================================================
# MRMS observed
# ============================================================================

def _refresh_mrms() -> None:
    gdf, fromdate, todate, meta = defns_data.fetch_mrms_qpe_1h()
    print(f"  Fetched {len(gdf)} MRMS polygons from {meta['product']}.")
    print(f"  Valid time:  {meta['valid_time'].isoformat()}")
    print(f"  Max inches:  {meta['max_inches']:.3f}")
    print(f"  Minutes ago: {meta['minutes_ago']:.1f}")

    # MRMS already clips internally; this is a no-op safety net for
    # the unlikely case that the WNC bbox in config differs from
    # what the fetcher uses.
    gdf_clipped = _clip_to_wnc(gdf)

    keep_cols = [c for c in ["category", "label", "geometry"] if c in gdf_clipped.columns]
    gdf_slim = gdf_clipped[keep_cols].copy()

    fc = json.loads(gdf_slim.to_json())
    fc["meta"] = {
        "source":        f"NOAA MRMS {meta['product']}",
        "observed_at":   _to_iso(meta["valid_time"]),
        "window_hours":  1,
        "max_inches":    float(meta["max_inches"]),
        "minutes_ago":   float(meta["minutes_ago"]),
        "generated_at":  _to_iso(datetime.now(timezone.utc)),
        "n_polygons":    len(gdf_slim),
    }

    out_path = DATA_DIR / "observed.geojson"
    _write_json(out_path, fc)
    print(f"  Wrote {out_path.name}: {out_path.stat().st_size / 1024:.1f} KB")


# ============================================================================
# Debris flow load + intersections (Phase B)
# ============================================================================

def _load_debris_flows() -> None:
    """Fetch the full NCGS debris flow GDF once and cache it for the rest
    of this run. Cached by module-level dict so subsequent calls are free.
    """
    if "gdf" in _debris_cache:
        print("  (already cached this run)")
        return

    print("  Fetching NCGS debris flow polygons from AGOL FeatureServer...")
    gdf = defns_data.fetch_debris_flows()
    print(f"  Loaded {len(gdf)} debris flow polygons.")
    _debris_cache["gdf"] = gdf


def _refresh_flagged_ndfd() -> None:
    """Run debris-flow x NDFD precipitation intersection. Writes
    flagged_ndfd.geojson with one feature per debris flow polygon that
    touches any NDFD precip polygon. Each feature carries a `max_category`
    property = the highest NDFD category it intersects (used client-side
    for instant threshold filtering)."""
    _write_flagged(
        precip_path=DATA_DIR / "forecast.geojson",
        out_path=DATA_DIR / "flagged_ndfd.geojson",
        source_label="NDFD",
    )


def _refresh_flagged_mrms() -> None:
    """Same as _refresh_flagged_ndfd but against MRMS observed precipitation."""
    _write_flagged(
        precip_path=DATA_DIR / "observed.geojson",
        out_path=DATA_DIR / "flagged_mrms.geojson",
        source_label="MRMS",
    )


def _write_flagged(precip_path: Path, out_path: Path, source_label: str) -> None:
    """Shared core: read a precip GeoJSON from disk, intersect with the
    cached debris flow GDF, write the flagged subset as GeoJSON with
    `max_category` on each feature.

    Phase B optimizations (configurable in config.py):
      - FLAGGED_MIN_CATEGORY: drop polygons below this category at build
      - FLAGGED_SIMPLIFY_METERS: Douglas-Peucker geometry simplification
      - FLAGGED_COORD_PRECISION: decimal places for output coordinates
    """
    import geopandas as gpd
    from config import (
        FLAGGED_MIN_CATEGORY,
        FLAGGED_SIMPLIFY_METERS,
        FLAGGED_COORD_PRECISION,
        INTERSECTION_CRS,
    )

    # Load the precip file we just wrote (round-trip through disk is wasteful
    # but keeps each step idempotent and isolated for testing/debugging).
    if not precip_path.exists():
        raise FileNotFoundError(f"Precip file missing: {precip_path}")
    precip_gdf = gpd.read_file(precip_path)
    print(f"  Precip polygons:  {len(precip_gdf)}")

    if precip_gdf.empty:
        print(f"  No precipitation -> empty flagged file.")
        _write_empty_flagged(out_path, source_label)
        return

    # IMPORTANT: find_alerts requires precip to already be filtered to
    # >= threshold. We pass it unfiltered so we get the WORST CASE max
    # category per debris flow polygon. Client filters by max_category
    # against the slider value.
    debris_gdf = _debris_cache["gdf"]
    flagged = defns_analysis.find_alerts(debris_gdf, precip_gdf)
    print(f"  Debris flows flagged (raw): {len(flagged)}")

    if flagged.empty:
        _write_empty_flagged(out_path, source_label)
        return

    # find_alerts returns columns: OBJECTID, category, label, area_acres, geometry.
    # We need `max_category` as the client-side filter key. Same value,
    # cleaner name for the frontend.
    flagged = flagged.rename(columns={"category": "max_category"})

    # ---- Optimization 1: drop low-category polygons -------------------------
    n_before = len(flagged)
    flagged = flagged[flagged["max_category"] >= FLAGGED_MIN_CATEGORY].copy()
    dropped = n_before - len(flagged)
    if dropped > 0:
        print(f"  Dropped {dropped} polygons below cat {FLAGGED_MIN_CATEGORY} "
              f"({len(flagged)} remain)")

    if flagged.empty:
        _write_empty_flagged(out_path, source_label)
        return

    # ---- Optimization 2: geometry simplification ----------------------------
    # Use the equal-area projection (meters) so the tolerance is meaningful,
    # then project back to display CRS for output.
    if FLAGGED_SIMPLIFY_METERS:
        flagged_proj = flagged.to_crs(INTERSECTION_CRS)
        flagged_proj["geometry"] = flagged_proj.geometry.simplify(
            FLAGGED_SIMPLIFY_METERS, preserve_topology=True
        )
        flagged = flagged_proj.to_crs(DISPLAY_CRS)
        print(f"  Simplified geometries at {FLAGGED_SIMPLIFY_METERS} m tolerance")

    # ---- Build the output FeatureCollection ---------------------------------
    fc = json.loads(flagged.to_json())

    # ---- Optimization 3: coordinate precision -------------------------------
    if FLAGGED_COORD_PRECISION is not None:
        _round_coords(fc, FLAGGED_COORD_PRECISION)
        print(f"  Rounded coords to {FLAGGED_COORD_PRECISION} decimal places")

    fc["meta"] = {
        "source":       source_label,
        "generated_at": _to_iso(datetime.now(timezone.utc)),
        "n_flagged":    len(flagged),
        "n_debris":     len(debris_gdf),
        "min_category_shipped": FLAGGED_MIN_CATEGORY,
    }
    _write_json(out_path, fc)
    print(f"  Wrote {out_path.name}: {out_path.stat().st_size / 1024:.1f} KB")


def _round_coords(obj, precision: int) -> None:
    """Recursively round all coordinate floats in a GeoJSON object in place.

    Walks the standard GeoJSON coordinates nesting (Polygons: [[[x,y],...],
    [[x,y],...]]; MultiPolygons: nested one level deeper). Modifies the dict
    in place; doesn't return anything.
    """
    if isinstance(obj, dict):
        if "coordinates" in obj:
            obj["coordinates"] = _round_recursive(obj["coordinates"], precision)
        if "features" in obj:
            for feat in obj["features"]:
                if "geometry" in feat and feat["geometry"]:
                    _round_coords(feat["geometry"], precision)


def _round_recursive(coords, precision):
    """Round all numeric leaves in a nested coordinate list to `precision`
    decimal places. Returns a new structure."""
    if isinstance(coords, list):
        if coords and isinstance(coords[0], (int, float)):
            # Leaf: a [x, y] or [x, y, z] coordinate pair
            return [round(c, precision) for c in coords]
        return [_round_recursive(c, precision) for c in coords]
    return coords


def _write_empty_flagged(out_path: Path, source_label: str) -> None:
    """Write a valid empty FeatureCollection so the frontend has a file
    to fetch even when there are no flagged polygons."""
    fc = {
        "type": "FeatureCollection",
        "features": [],
        "meta": {
            "source":       source_label,
            "generated_at": _to_iso(datetime.now(timezone.utc)),
            "n_flagged":    0,
            "n_debris":     len(_debris_cache.get("gdf", []))
        }
    }
    _write_json(out_path, fc)
    print(f"  Wrote {out_path.name}: (empty)")


# ============================================================================
# Helpers
# ============================================================================

def _clip_to_wnc(gdf):
    """Spatially filter a GeoDataFrame to features intersecting the WNC
    bounding box. Returns features whose geometry intersects; geometries
    are NOT clipped to the bbox edge (faster, and the frontend re-renders
    them client-side anyway)."""
    import geopandas as gpd
    from shapely.geometry import box

    if gdf is None or len(gdf) == 0:
        return gdf

    if gdf.crs is None or str(gdf.crs).upper() != "EPSG:4326":
        gdf = gdf.to_crs("EPSG:4326")

    bbox_geom = box(*WNC_BBOX)
    return gdf[gdf.intersects(bbox_geom)].copy()


def _to_iso(dt) -> str | None:
    """Convert a datetime/Timestamp to ISO 8601 UTC string. Returns None
    on falsy input (since meta fields might legitimately be missing)."""
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    # Fall through: pandas Timestamp, numpy datetime64, etc.
    import pandas as pd
    return pd.Timestamp(dt).isoformat()


def _write_json(path: Path, obj) -> None:
    """Write JSON compactly (no extra whitespace). Bytes saved here
    accumulate fast across forecast.geojson commits over time."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())
