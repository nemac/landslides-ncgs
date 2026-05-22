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
from config import WNC_BBOX           # noqa: E402


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[defns-refresh] Output directory: {DATA_DIR}")
    print(f"[defns-refresh] Started at:       {datetime.now(timezone.utc).isoformat()}")

    ndfd_ok = _safely(_refresh_ndfd, "NDFD forecast")
    mrms_ok = _safely(_refresh_mrms, "MRMS observed")

    if ndfd_ok and mrms_ok:
        print("[defns-refresh] DONE - both files written.")
        return 0
    elif not ndfd_ok and not mrms_ok:
        print("[defns-refresh] BOTH FAILED - no files written.")
        return 1
    else:
        which = "NDFD" if not ndfd_ok else "MRMS"
        print(f"[defns-refresh] PARTIAL - {which} failed, other file is fresh.")
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
