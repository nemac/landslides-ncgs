#!/usr/bin/env python3
"""
refresh.py - DEFNS Alerts data pipeline

Three modes:

  python scripts/refresh.py
      Default: fetch live NDFD forecast, MRMS observed, run debris flow
      intersections, write four files to alerts/data/.

  python scripts/refresh.py --hindcast
      Generate historical (hindcast) data for every event in events.py.
      Writes to alerts/data/historical/ - one precip + one flagged file
      per event, plus events.json (the manifest the frontend reads).

  python scripts/refresh.py --hindcast helene_2024
      Only generate hindcast data for a specific event id. Useful when
      adding or re-processing one event without touching the others.

Live mode writes:
    alerts/data/forecast.geojson         NDFD precipitation polygons
    alerts/data/observed.geojson         MRMS precipitation polygons
    alerts/data/flagged_ndfd.geojson     Debris flow polygons + max NDFD cat
    alerts/data/flagged_mrms.geojson     Debris flow polygons + max MRMS cat

Hindcast mode writes (per event):
    alerts/data/historical/{event_id}_precip.geojson
    alerts/data/historical/{event_id}_flagged.geojson
    alerts/data/historical/events.json   Manifest (regenerated each run)

Each GeoJSON has a `meta` property at the top level carrying timestamps
and source info. Non-strict GeoJSON but every parser tolerates it.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

# Make scripts/ importable so we can pull in our data.py and config.py
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DATA_DIR = REPO_ROOT / "alerts" / "data"
HISTORICAL_DIR = DATA_DIR / "historical"

sys.path.insert(0, str(HERE))

import data as defns_data            # noqa: E402  (intentional: see sys.path above)
import analysis as defns_analysis    # noqa: E402
from config import WNC_BBOX, DISPLAY_CRS  # noqa: E402


# Module-level cache so debris flows are fetched once per refresh run and
# reused for both NDFD and MRMS intersections.
_debris_cache: dict = {}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="DEFNS data pipeline: live precip + alerts, or hindcast."
    )
    parser.add_argument(
        "--hindcast",
        nargs="?",
        const="ALL",
        default=None,
        metavar="EVENT_ID",
        help=(
            "Generate hindcast files. Pass an event id to generate just "
            "that event, or no argument to generate all events in "
            "events.HISTORICAL_EVENTS."
        ),
    )
    args = parser.parse_args()

    if args.hindcast is None:
        return _main_live()
    return _main_hindcast(args.hindcast)


def _main_live() -> int:
    """Original live-mode entry point. Fetches NDFD + MRMS at each
    supported window, plus flagged debris flow intersections per window.

    Generates per-window file pairs:
      forecast_{N}h.geojson + flagged_ndfd_{N}h.geojson  for N in NDFD_WINDOWS_HOURS
      observed_{N}h.geojson + flagged_mrms_{N}h.geojson  for N in MRMS_WINDOWS_HOURS

    Each window's fetch and intersection is independent - one failure
    doesn't block the others.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[defns-refresh] Output directory: {DATA_DIR}")
    print(f"[defns-refresh] Started at:       {datetime.now(timezone.utc).isoformat()}")
    print(f"[defns-refresh] NDFD windows: {NDFD_WINDOWS_HOURS}")
    print(f"[defns-refresh] MRMS windows: {MRMS_WINDOWS_HOURS}")

    # ---- Phase 1: fetch precipitation per window -----------------------
    ndfd_window_ok: dict[int, bool] = {}
    mrms_window_ok: dict[int, bool] = {}

    for hrs in NDFD_WINDOWS_HOURS:
        ndfd_window_ok[hrs] = _safely(
            lambda h=hrs: _refresh_ndfd(window_hours=h),
            f"NDFD forecast ({hrs}h)",
        )

    for hrs in MRMS_WINDOWS_HOURS:
        mrms_window_ok[hrs] = _safely(
            lambda h=hrs: _refresh_mrms(window_hours=h),
            f"MRMS observed ({hrs}h)",
        )

    # ---- Phase 1.5: Overture buildings (independent reference layer) ---
    # Runs regardless of precip success because buildings are a reference
    # layer, not part of the alert pipeline. The cache check inside
    # fetch_overture_buildings means this is a near-instant no-op on
    # most runs - the slow extraction only fires when the file is
    # missing or older than ~30 days.
    buildings_ok = _safely(_refresh_overture_buildings, "Buildings (Overture)")

    # ---- Phase 2: load debris flows once for all intersections ---------
    any_precip_ok = any(ndfd_window_ok.values()) or any(mrms_window_ok.values())
    if not any_precip_ok:
        print("\n[defns-refresh] ALL precipitation fetches failed; "
              "skipping debris flow intersections.")
        return 1

    debris_ok = _safely(_load_debris_flows, "Debris flow polygons")
    if not debris_ok:
        print("\n[defns-refresh] Debris flow load failed; "
              "wrote precip files but cannot produce flagged files.")
        return 2

    # ---- Phase 3: intersect each successful precip with debris flows ---
    flagged_ok: dict[str, bool] = {}
    for hrs in NDFD_WINDOWS_HOURS:
        if ndfd_window_ok[hrs]:
            flagged_ok[f"ndfd_{hrs}h"] = _safely(
                lambda h=hrs: _refresh_flagged_ndfd(window_hours=h),
                f"NDFD intersections ({hrs}h)",
            )
    for hrs in MRMS_WINDOWS_HOURS:
        if mrms_window_ok[hrs]:
            flagged_ok[f"mrms_{hrs}h"] = _safely(
                lambda h=hrs: _refresh_flagged_mrms(window_hours=h),
                f"MRMS intersections ({hrs}h)",
            )

    # ---- Summary --------------------------------------------------------
    total_precip = len(NDFD_WINDOWS_HOURS) + len(MRMS_WINDOWS_HOURS)
    total_flagged = sum(ndfd_window_ok.values()) + sum(mrms_window_ok.values())
    precip_successes = sum(ndfd_window_ok.values()) + sum(mrms_window_ok.values())
    flagged_successes = sum(flagged_ok.values())

    print(f"\n[defns-refresh] DONE - "
          f"{precip_successes}/{total_precip} precip files written, "
          f"{flagged_successes}/{total_flagged} flagged files written.")

    # Return 0 if everything succeeded, 2 if partial, 1 if nothing worked
    if precip_successes == total_precip and flagged_successes == total_flagged:
        return 0
    elif precip_successes == 0 and flagged_successes == 0:
        return 1
    else:
        return 2


# Per-mode window lists. Kept here (not in config.py) so refresh-script
# loop control is local to refresh.py - changing here doesn't affect
# data.py or any other module.
NDFD_WINDOWS_HOURS = [12, 24, 48, 72]
MRMS_WINDOWS_HOURS = [1, 24, 72]


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

def _refresh_ndfd(window_hours: int = 12) -> None:
    """Fetch NDFD forecast for a specific window. Writes per-window file
    forecast_{N}h.geojson. min_category=0 returns ALL categories so the
    client can re-threshold without re-fetching."""
    gdf, fromdate, todate = defns_data.fetch_precip_forecast(
        window_hours=window_hours, min_category=0
    )
    print(f"  Fetched {len(gdf)} NDFD polygons across all categories.")

    gdf_clipped = _clip_to_wnc(gdf)
    print(f"  Clipped to WNC bbox: {len(gdf_clipped)} polygons remain.")

    # Slim payload: keep only the fields the frontend reads. Smaller JSON.
    keep_cols = [c for c in ["category", "label", "geometry"] if c in gdf_clipped.columns]
    gdf_slim = gdf_clipped[keep_cols].copy()

    # Convert to GeoJSON and attach meta
    fc = json.loads(gdf_slim.to_json()) if not gdf_slim.empty else {
        "type": "FeatureCollection", "features": [],
    }
    fc["meta"] = {
        "source":        "NWS NDFD precipitation forecast",
        "issued":        _to_iso(fromdate),
        "window_end":    _to_iso(todate),
        "window_hours":  window_hours,
        "generated_at":  _to_iso(datetime.now(timezone.utc)),
        "n_polygons":    len(gdf_slim),
    }

    out_path = DATA_DIR / f"forecast_{window_hours}h.geojson"
    _write_json(out_path, fc)
    print(f"  Wrote {out_path.name}: {out_path.stat().st_size / 1024:.1f} KB")


# ============================================================================
# MRMS observed
# ============================================================================

def _refresh_mrms(window_hours: int = 1) -> None:
    """Fetch MRMS observed precipitation for a specific window. Writes
    per-window file observed_{N}h.geojson."""
    gdf, fromdate, todate, meta = defns_data.fetch_mrms_qpe(window_hours=window_hours)
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

    fc = json.loads(gdf_slim.to_json()) if not gdf_slim.empty else {
        "type": "FeatureCollection", "features": [],
    }
    fc["meta"] = {
        "source":        f"NOAA MRMS {meta['product']}",
        "observed_at":   _to_iso(meta["valid_time"]),
        "window_hours":  window_hours,
        "max_inches":    float(meta["max_inches"]),
        "minutes_ago":   float(meta["minutes_ago"]),
        "generated_at":  _to_iso(datetime.now(timezone.utc)),
        "n_polygons":    len(gdf_slim),
    }

    out_path = DATA_DIR / f"observed_{window_hours}h.geojson"
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


def _refresh_flagged_ndfd(window_hours: int = 12) -> None:
    """Run debris-flow x NDFD precipitation intersection for a window.
    Writes flagged_ndfd_{N}h.geojson with one feature per debris flow
    polygon that touches any NDFD precip polygon at this window."""
    _write_flagged(
        precip_path=DATA_DIR / f"forecast_{window_hours}h.geojson",
        out_path=DATA_DIR / f"flagged_ndfd_{window_hours}h.geojson",
        source_label="NDFD",
    )


def _refresh_flagged_mrms(window_hours: int = 1) -> None:
    """Same as _refresh_flagged_ndfd but against MRMS observed precipitation."""
    _write_flagged(
        precip_path=DATA_DIR / f"observed_{window_hours}h.geojson",
        out_path=DATA_DIR / f"flagged_mrms_{window_hours}h.geojson",
        source_label="MRMS",
    )


def _refresh_overture_buildings() -> None:
    """Extract WNC building footprints from Overture Maps Foundation.

    Delegates to defns_data.fetch_overture_buildings, which handles the
    cache TTL check internally. On most runs (cache fresh), this returns
    in milliseconds with a "skipping extraction" log message. When the
    cache is stale or missing, this is the slow phase: 5-15 minutes of
    DuckDB-against-Overture-S3 work.

    Writes alerts/data/buildings_wnc.geojson which the frontend loads
    lazily when the user toggles the "Building footprints" layer on.

    Failures here are non-fatal - _safely() in the orchestrator will log
    the exception and continue. A missing buildings file just means the
    layer toggle does nothing client-side; it doesn't affect alerts.
    """
    defns_data.fetch_overture_buildings(output_dir=DATA_DIR)


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
# Hindcast mode (Stage IV historical events)
# ============================================================================

def _main_hindcast(which: str) -> int:
    """Generate hindcast files. If `which == 'ALL'`, do every event in
    events.HISTORICAL_EVENTS. Otherwise just the specified event id."""
    import events as defns_events

    HISTORICAL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[defns-refresh] Hindcast mode")
    print(f"[defns-refresh] Output directory: {HISTORICAL_DIR}")
    print(f"[defns-refresh] Started at:       {datetime.now(timezone.utc).isoformat()}")

    if which == "ALL":
        events_to_run = defns_events.HISTORICAL_EVENTS
    else:
        events_to_run = [defns_events.get_event(which)]

    # We need debris flows once for all intersections
    if not _safely(_load_debris_flows, "Debris flow polygons"):
        print("[defns-refresh] FAIL - debris flows could not be loaded.")
        return 1

    n_ok = 0
    n_fail = 0
    for event in events_to_run:
        label = f"Event: {event['id']} ({event['name']})"
        if _safely(lambda e=event: _refresh_hindcast_event(e), label):
            n_ok += 1
        else:
            n_fail += 1

    # Always write the manifest covering ALL events (not just this run),
    # so removing a single event from the run doesn't make the frontend
    # forget about the others that exist on disk.
    _write_events_manifest(defns_events.HISTORICAL_EVENTS)

    if n_fail == 0:
        print(f"\n[defns-refresh] DONE - {n_ok} event(s) processed.")
        return 0
    elif n_ok > 0:
        print(f"\n[defns-refresh] PARTIAL - {n_ok} ok, {n_fail} failed.")
        return 2
    else:
        print(f"\n[defns-refresh] ALL FAILED - {n_fail} events failed.")
        return 1


def _refresh_hindcast_event(event: dict) -> None:
    """Generate one event's pair of files: precip + flagged."""
    event_id = event["id"]

    # ---- Fetch Stage IV precip ------------------------------------------
    print(f"  Event: {event['name']}")
    print(f"  Date label: {event['date_label']}")
    print(f"  End date: {event['end_date']}")
    print(f"  Accumulation: {event['accumulation_days']} day(s)")

    precip_gdf, fetch_meta = defns_data.fetch_stage_iv_qpe(
        end_date=event["end_date"],
        accumulation_days=event["accumulation_days"],
    )
    print(f"  Stage IV polygons (clipped to WNC): {len(precip_gdf)}")

    # ---- Write precip GeoJSON -------------------------------------------
    keep_cols = [c for c in ["category", "label", "geometry"]
                 if c in precip_gdf.columns]
    precip_slim = precip_gdf[keep_cols].copy() if keep_cols else precip_gdf

    precip_fc = json.loads(precip_slim.to_json()) if not precip_slim.empty else {
        "type": "FeatureCollection",
        "features": [],
    }
    precip_fc["meta"] = {
        "source":             fetch_meta["product"],
        "event_id":           event_id,
        "event_name":         event["name"],
        "date_label":         event["date_label"],
        "end_date":           event["end_date"],
        "accumulation_days":  event["accumulation_days"],
        "max_inches":         float(fetch_meta["max_inches"]),
        "generated_at":       _to_iso(datetime.now(timezone.utc)),
        "n_polygons":         len(precip_slim),
        "description":        event["description"],
    }
    precip_path = HISTORICAL_DIR / f"{event_id}_precip.geojson"
    _write_json(precip_path, precip_fc)
    print(f"  Wrote {precip_path.name}: "
          f"{precip_path.stat().st_size / 1024:.1f} KB")

    # ---- Compute + write flagged debris flows ---------------------------
    if precip_gdf.empty:
        print(f"  No precip -> empty flagged file.")
        _write_hindcast_empty_flagged(event_id, event)
        return

    debris_gdf = _debris_cache["gdf"]
    flagged = defns_analysis.find_alerts(debris_gdf, precip_gdf)
    print(f"  Debris flows flagged (raw): {len(flagged)}")

    if flagged.empty:
        _write_hindcast_empty_flagged(event_id, event)
        return

    flagged = flagged.rename(columns={"category": "max_category"})

    # Apply same Phase B optimizations as live mode for size parity
    from config import (
        FLAGGED_MIN_CATEGORY,
        FLAGGED_SIMPLIFY_METERS,
        FLAGGED_COORD_PRECISION,
        INTERSECTION_CRS,
    )

    n_before = len(flagged)
    flagged = flagged[flagged["max_category"] >= FLAGGED_MIN_CATEGORY].copy()
    if n_before - len(flagged) > 0:
        print(f"  Dropped {n_before - len(flagged)} polygons below "
              f"cat {FLAGGED_MIN_CATEGORY}")

    if FLAGGED_SIMPLIFY_METERS:
        flagged_proj = flagged.to_crs(INTERSECTION_CRS)
        flagged_proj["geometry"] = flagged_proj.geometry.simplify(
            FLAGGED_SIMPLIFY_METERS, preserve_topology=True
        )
        flagged = flagged_proj.to_crs(DISPLAY_CRS)

    flagged_fc = json.loads(flagged.to_json())
    if FLAGGED_COORD_PRECISION is not None:
        _round_coords(flagged_fc, FLAGGED_COORD_PRECISION)

    flagged_fc["meta"] = {
        "source":            fetch_meta["product"],
        "event_id":          event_id,
        "event_name":        event["name"],
        "date_label":        event["date_label"],
        "end_date":          event["end_date"],
        "accumulation_days": event["accumulation_days"],
        "max_inches":        float(fetch_meta["max_inches"]),
        "generated_at":      _to_iso(datetime.now(timezone.utc)),
        "n_flagged":         len(flagged),
        "n_debris":          len(debris_gdf),
        "min_category_shipped": FLAGGED_MIN_CATEGORY,
    }
    flagged_path = HISTORICAL_DIR / f"{event_id}_flagged.geojson"
    _write_json(flagged_path, flagged_fc)
    print(f"  Wrote {flagged_path.name}: "
          f"{flagged_path.stat().st_size / 1024:.1f} KB")


def _write_hindcast_empty_flagged(event_id: str, event: dict) -> None:
    """Write a valid empty flagged FeatureCollection for an event whose
    precip didn't intersect any debris flows. Lets the frontend distinguish
    "no event selected" (no file) from "event selected, no flags" (file
    exists, empty features array)."""
    fc = {
        "type": "FeatureCollection",
        "features": [],
        "meta": {
            "event_id":      event_id,
            "event_name":    event["name"],
            "date_label":    event["date_label"],
            "end_date":      event["end_date"],
            "generated_at":  _to_iso(datetime.now(timezone.utc)),
            "n_flagged":     0,
            "n_debris":      len(_debris_cache.get("gdf", [])),
        }
    }
    _write_json(HISTORICAL_DIR / f"{event_id}_flagged.geojson", fc)
    print(f"  Wrote {event_id}_flagged.geojson (empty)")


def _write_events_manifest(events: list[dict]) -> None:
    """Write events.json - the frontend reads this to populate the dropdown.

    Only includes events whose precip file actually exists on disk; that way
    if a user adds an event to events.py but hasn't run the refresh yet, it
    doesn't appear in the UI as a broken option.
    """
    available = []
    for event in events:
        precip_path = HISTORICAL_DIR / f"{event['id']}_precip.geojson"
        flagged_path = HISTORICAL_DIR / f"{event['id']}_flagged.geojson"
        if precip_path.exists() and flagged_path.exists():
            available.append({
                "id":                event["id"],
                "name":               event["name"],
                "date_label":         event["date_label"],
                "end_date":           event["end_date"],
                "accumulation_days":  event["accumulation_days"],
                "description":        event["description"],
                "precip_file":        f"historical/{event['id']}_precip.geojson",
                "flagged_file":       f"historical/{event['id']}_flagged.geojson",
            })

    manifest = {
        "events":       available,
        "generated_at": _to_iso(datetime.now(timezone.utc)),
    }
    path = HISTORICAL_DIR / "events.json"
    _write_json(path, manifest)
    print(f"\n[defns-refresh] Wrote manifest: {path.name} "
          f"({len(available)} event(s) available)")


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
