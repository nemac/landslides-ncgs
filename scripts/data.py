"""
Data fetching for the WNC Debris Flow Early Warning Dashboard.

Two public functions:
    fetch_debris_flows()      -> GeoDataFrame of NCGS debris flow polygons
    fetch_precip_forecast()   -> (GeoDataFrame, fromdate, todate) for NDFD

Both return geometries in WGS84 (EPSG:4326) so they can be displayed
directly in Folium. Reproject to an equal-area CRS for area math.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import geopandas as gpd

from config import (
    DEBRIS_FLOW_SERVICE_URL,
    NDFD_PRECIP_SERVICE_URL,
    DISPLAY_CRS,
    CACHE_DIR,
    DEBRIS_CACHE_FILENAME,
    CACHE_TTL_DAYS,
)


# =============================================================================
# Debris flow polygons (NCGS CDF_Landslides_Model / WNC_Mosaic)
# =============================================================================

def _cache_path() -> Path:
    return Path(CACHE_DIR) / DEBRIS_CACHE_FILENAME


def _cache_is_fresh() -> bool:
    p = _cache_path()
    if not p.exists() or CACHE_TTL_DAYS <= 0:
        return False
    age_days = (datetime.now().timestamp() - p.stat().st_mtime) / 86400
    return age_days < CACHE_TTL_DAYS


def fetch_debris_flows(force_refresh: bool = False) -> gpd.GeoDataFrame:
    """Pull all debris flow polygons from the NCGS feature service.

    Results are cached as a local GeoPackage. Subsequent calls within the
    cache TTL (see config.CACHE_TTL_DAYS) load from disk in ~1 second
    instead of paginating 100+ requests against the live service.

    Parameters
    ----------
    force_refresh : bool
        If True, ignore the cache and re-fetch from NCGS.

    Returns
    -------
    GeoDataFrame in EPSG:4326 with columns OBJECTID, geometry.
    """
    cache_p = _cache_path()

    if not force_refresh and _cache_is_fresh():
        age_h = (datetime.now().timestamp() - cache_p.stat().st_mtime) / 3600
        print(f"Loading debris flow polygons from cache "
              f"({cache_p}, {age_h:.1f}h old)...")
        gdf = gpd.read_file(cache_p)
        print(f"  -> {len(gdf):,} polygons loaded from cache")
        return gdf

    print("Fetching debris flow polygons from NCGS "
          "(228k+ features expected, this may take several minutes)...")

    all_features: list[dict] = []
    offset = 0
    page_size = 2000

    while True:
        params = {
            "where": "1=1",
            "outFields": "OBJECTID",
            "outSR": 4326,
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "f": "geojson",
        }
        r = requests.get(f"{DEBRIS_FLOW_SERVICE_URL}/query",
                         params=params, timeout=120)
        r.raise_for_status()
        page = r.json()

        feats = page.get("features", [])
        if not feats:
            break

        all_features.extend(feats)
        # Print progress every 10 pages
        if (offset // page_size) % 10 == 0:
            print(f"  page @offset={offset:,}: running total {len(all_features):,}")

        if len(feats) < page_size:
            break
        offset += page_size

    if not all_features:
        return gpd.GeoDataFrame({"OBJECTID": []}, geometry=[], crs=DISPLAY_CRS)

    gdf = gpd.GeoDataFrame.from_features(all_features, crs=DISPLAY_CRS)
    print(f"  -> {len(gdf):,} debris flow polygons total")

    # Write to cache
    cache_p.parent.mkdir(parents=True, exist_ok=True)
    print(f"  caching to {cache_p}...")
    gdf.to_file(cache_p, driver="GPKG")
    print(f"  cache written ({cache_p.stat().st_size / 1e6:.1f} MB)")

    return gdf


# =============================================================================
# NDFD "Accumulation by Time" precipitation forecast
# =============================================================================

def _query_latest_forecast_issuance() -> int:
    """Return the most recent `fromdate` (epoch ms) published by NDFD.

    The service stores the current forecast cycle. `fromdate` is the
    forecast issuance time and is shared by every accumulation timestep
    in that cycle. Sorting DESC and pulling one record is the cheapest
    way to discover when the current cycle started.
    """
    params = {
        "where": "1=1",
        "outFields": "fromdate",
        "orderByFields": "fromdate DESC",
        "resultRecordCount": 1,
        "returnGeometry": "false",
        "f": "json",
    }
    r = requests.get(f"{NDFD_PRECIP_SERVICE_URL}/query",
                     params=params, timeout=60)
    r.raise_for_status()
    payload = r.json()

    feats = payload.get("features", [])
    if not feats:
        raise RuntimeError(
            "NDFD service returned no features when probing for the latest "
            "forecast issuance. The service may be unavailable."
        )
    return int(feats[0]["attributes"]["fromdate"])


def fetch_precip_forecast(
    window_hours: int,
    min_category: int,
) -> tuple[gpd.GeoDataFrame, datetime, datetime]:
    """Fetch precipitation polygons for the requested forecast window.

    Fetches CONUS-wide. The intersection with WNC-only debris flow polygons
    naturally constrains alerts to Western NC; the broader fetch is so the
    display layer can show forecast conditions across the country.

    Parameters
    ----------
    window_hours : int
        Hours past the forecast issuance to take the accumulation snapshot
        from. Must be a positive multiple of 6.
    min_category : int
        Lowest NDFD precipitation category to include. See config.py for
        the category -> rainfall range mapping.

    Returns
    -------
    gdf : GeoDataFrame (EPSG:4326)
        Features above the threshold across CONUS.
        Columns: category, label, fromdate, todate, geometry.
    fromdate : datetime (UTC)
        When the forecast cycle was issued.
    todate : datetime (UTC)
        End of the accumulation window we requested.
    """
    if window_hours <= 0 or window_hours % 6 != 0:
        raise ValueError(
            f"window_hours must be a positive multiple of 6 (got {window_hours})"
        )

    print(f"Fetching NDFD precipitation forecast "
          f"(window={window_hours}h, min category={min_category}, CONUS)...")

    # 1. discover the current forecast cycle
    fromdate_ms = _query_latest_forecast_issuance()
    todate_ms = fromdate_ms + window_hours * 3600 * 1000

    fromdate_dt = datetime.fromtimestamp(fromdate_ms / 1000, tz=timezone.utc)
    todate_dt = datetime.fromtimestamp(todate_ms / 1000, tz=timezone.utc)
    print(f"  forecast issued  : {fromdate_dt:%Y-%m-%d %H:%M UTC}")
    print(f"  accumulation thru: {todate_dt:%Y-%m-%d %H:%M UTC}")

    # 2. build the WHERE clause. We restrict to region='conus' so we don't
    #    pull Alaska / Hawaii / PR polygons (they're outside our area of
    #    interest and they balloon the response). NDFD `region` values are
    #    lowercase.
    fromdate_lit = fromdate_dt.strftime("%Y-%m-%d %H:%M:%S")
    todate_lit = todate_dt.strftime("%Y-%m-%d %H:%M:%S")
    where = (
        f"fromdate = date '{fromdate_lit}' "
        f"AND todate = date '{todate_lit}' "
        f"AND category >= {min_category} "
        f"AND region = 'conus'"
    )

    # 3. no spatial filter - return all CONUS polygons above threshold
    params = {
        "where": where,
        "outFields": "category,label,fromdate,todate",
        "outSR": 4326,
        "f": "geojson",
    }
    r = requests.get(f"{NDFD_PRECIP_SERVICE_URL}/query",
                     params=params, timeout=90)
    r.raise_for_status()
    page = r.json()

    feats = page.get("features", [])
    print(f"  -> {len(feats)} precipitation polygons above threshold (CONUS)")

    if not feats:
        gdf = gpd.GeoDataFrame(
            {"category": [], "label": [], "fromdate": [], "todate": []},
            geometry=[],
            crs=DISPLAY_CRS,
        )
    else:
        gdf = gpd.GeoDataFrame.from_features(feats, crs=DISPLAY_CRS)

    return gdf, fromdate_dt, todate_dt


# =============================================================================
# Synthetic test polygon (testing-only)
# =============================================================================

def make_test_precip_polygon(
    category: int,
    fromdate: datetime,
    todate: datetime,
) -> gpd.GeoDataFrame:
    """Build a synthetic precipitation polygon over Asheville for testing.

    Used by the Streamlit dashboard's "Test mode" to verify the alert
    pipeline end-to-end on dry days. The polygon is a ~30-mile square
    centered roughly on Asheville, NC, large enough to intersect a
    meaningful number of NCGS debris flow zones.

    The `label` is prefixed with '[TEST]' so it cannot be confused with
    real NDFD features in tooltips, the impacted-zones table, or the
    summary stats.

    Parameters
    ----------
    category : int
        The synthetic NDFD precipitation category (0-19). Determines the
        rainfall amount the test polygon claims to be forecasting.
    fromdate, todate : datetime
        Times to stamp on the synthetic polygon so it matches the schema
        of real NDFD features.
    """
    # NDFD's exact label strings for each category - mirror them so the
    # test polygon looks like a real one in the table (except for [TEST]).
    label_lookup = {
        0:  ".01 - .10\"",   1: ".10 - .25\"",   2: ".25 - .50\"",
        3:  ".50 - .75\"",   4: ".75 - 1\"",     5: "1 - 1.50\"",
        6:  "1.50 - 2\"",    7: "2 - 2.50\"",    8: "2.50 - 3\"",
        9:  "3 - 4\"",      10: "4 - 5\"",      11: "5 - 6\"",
        12: "6 - 8\"",      13: "8 - 10\"",     14: "10 - 12\"",
        15: "12 - 14\"",    16: "14 - 16\"",    17: "16 - 18\"",
        18: "18 - 20\"",    19: "> 20\"",
    }
    from shapely.geometry import Polygon
    cx, cy = -82.55, 35.60     # Asheville
    half = 0.22                # ~15 mi half-width
    poly = Polygon([
        (cx - half, cy - half),
        (cx + half, cy - half),
        (cx + half, cy + half),
        (cx - half, cy + half),
    ])
    return gpd.GeoDataFrame(
        {
            "category": [int(category)],
            "label": [f"[TEST] {label_lookup.get(int(category), 'test')}"],
            "fromdate": [int(fromdate.timestamp() * 1000)],
            "todate":   [int(todate.timestamp() * 1000)],
            "is_test":  [True],
        },
        geometry=[poly],
        crs=DISPLAY_CRS,
    )


# =============================================================================
# MRMS Quantitative Precipitation Estimate (1-hour observed accumulation)
# =============================================================================
# Real-time observed precipitation from radar mosaics calibrated against
# rain gauges. Used as an alternative alert source to the NDFD forecast -
# when the user picks "Current radar (MRMS)" detection mode, we threshold
# this raster and polygonize the qualifying cells, then intersect with
# debris flows the same way as the NDFD pipeline.

from shapely.geometry import shape as _shapely_shape  # local alias

# rasterio is brought in via conda-forge (it pulls GDAL). If it's not
# installed, MRMS mode degrades gracefully - the UI shows a one-line note
# explaining how to install it, and falls back to NDFD mode.
try:
    import rasterio                       # type: ignore
    from rasterio.features import shapes as _raster_shapes  # type: ignore
    from rasterio.windows import from_bounds as _window_from_bounds  # type: ignore
    HAS_RASTERIO = True
except Exception:
    HAS_RASTERIO = False


def _classify_mrms_inches_to_category(rainfall_inches: float) -> int:
    """Map an MRMS rainfall value (inches) to an NDFD-compatible category
    index 0-19. Uses the same cutoffs as PRECIP_LABELS so the existing
    color ramp and legend work unchanged."""
    from config import MRMS_CATEGORY_CUTOFFS_INCHES
    for i, upper in enumerate(MRMS_CATEGORY_CUTOFFS_INCHES):
        if rainfall_inches < upper:
            return i
    return 19  # >= 20"


def fetch_mrms_qpe_1h(
    bbox: tuple[float, float, float, float] | None = None,
) -> tuple[gpd.GeoDataFrame, datetime, datetime, dict]:
    """Fetch the most recent MRMS 1-hour QPE, clip to ``bbox``, polygonize
    qualifying cells by NDFD category, and return.

    The fetcher tries multiple MRMS products in order (Pass1 first, then
    RadarOnly, then Pass2) - whichever produces a successful fetch wins.
    Pass1 is the primary because it's published ~5-10 min after the hour
    AND includes gauge correction, vs Pass2 which is more accurate but
    published 60-75 min after the hour (too stale for real-time alerts).

    Returns
    -------
    (precip_gdf, fromdate, todate, meta)
        precip_gdf : GeoDataFrame in NDFD-compatible shape
        fromdate, todate : datetime UTC. fromdate = todate - 1 hour
        meta : dict with keys
            product : str (e.g. "MultiSensor Pass1")
            file_url : str
            valid_time : datetime UTC (the file's valid-hour ending)
            minutes_ago : float
            max_inches : float (maximum value in WNC bbox)
            n_polygons : int

    Raises
    ------
    RuntimeError if rasterio is not installed, or if no MRMS file
    succeeded across all product fallbacks.
    """
    if not HAS_RASTERIO:
        raise RuntimeError(
            "MRMS mode requires the rasterio package. Install with:\n"
            "    conda install -c conda-forge rasterio libgdal-grib\n"
            "Then restart Streamlit."
        )

    from config import MRMS_URL_TEMPLATES, MRMS_PRODUCT_FALLBACK, WNC_BBOX
    if bbox is None:
        bbox = WNC_BBOX

    now = datetime.now(timezone.utc)
    errors: list[str] = []

    # Try each product in order. Each product has its own expected lag.
    for product_cfg in MRMS_PRODUCT_FALLBACK:
        product_name = product_cfg["name"]
        lookback = product_cfg["lookback_minutes"]
        display_name = product_cfg["display"]
        url_template = MRMS_URL_TEMPLATES[product_name]

        # Target the most recent file likely to be available for this
        # product, then back off hour by hour if we miss.
        target = (now - timedelta(minutes=lookback)).replace(
            minute=0, second=0, microsecond=0
        )

        for hours_back in range(0, 3):
            valid_time = target - timedelta(hours=hours_back)
            url = url_template.format(
                Y=valid_time.year, M=valid_time.month,
                D=valid_time.day, H=valid_time.hour,
            )
            try:
                gdf, max_inches = _read_mrms_grib_to_polygons(url, bbox, valid_time)
                fromdate = valid_time - timedelta(hours=1)
                todate = valid_time
                minutes_ago = (now - valid_time).total_seconds() / 60.0
                meta = {
                    "product": display_name,
                    "product_id": product_name,
                    "file_url": url,
                    "valid_time": valid_time,
                    "minutes_ago": minutes_ago,
                    "max_inches": max_inches,
                    "n_polygons": len(gdf),
                }
                return gdf, fromdate, todate, meta
            except Exception as e:
                errors.append(
                    f"{display_name} @ {valid_time:%Y-%m-%d %H:%MZ}: "
                    f"{type(e).__name__}: {e}"
                )
                continue

    raise RuntimeError(
        "Could not fetch any MRMS file across all product fallbacks. "
        "Recent errors:\n  " + "\n  ".join(errors[-5:])
    )


def _read_mrms_grib_to_polygons(
    url: str,
    bbox: tuple[float, float, float, float],
    valid_time: datetime,
) -> tuple[gpd.GeoDataFrame, float]:
    """Download a single MRMS GRIB2.gz, read it via rasterio's /vsigzip/
    + /vsicurl/ chain, clip to the bbox, threshold every NDFD category
    cutoff, and polygonize.

    Returns (gdf, max_inches_in_bbox).
    """
    import numpy as np

    vsi_path = f"/vsigzip//vsicurl/{url}"

    with rasterio.open(vsi_path) as src:
        nodata = src.nodata if src.nodata is not None else -3.0
        try:
            window = _window_from_bounds(*bbox, transform=src.transform)
        except Exception:
            window = None

        data = src.read(1, window=window).astype("float32")
        transform = src.window_transform(window) if window else src.transform

    # MRMS values are mm. Convert to inches and mask out no-data.
    valid_mask = (data != nodata) & (data > 0)
    data_inches = data / 25.4
    data_inches[~valid_mask] = -1.0  # sentinel keeps these out of any bin

    max_inches = float(data_inches[valid_mask].max()) if valid_mask.any() else 0.0

    # Build the bin ranges for NDFD categories 0..19.
    # NDFD bins are: cat 0 = [0.01, 0.10), cat 1 = [0.10, 0.25), ..., cat 19 = [20, inf).
    # MRMS_CATEGORY_CUTOFFS_INCHES holds the UPPER bound of each category (length 19).
    # So cat N's lower bound is the previous cat's upper bound (or 0.01 for cat 0),
    # and cat N's upper bound is MRMS_CATEGORY_CUTOFFS_INCHES[N] (or inf for cat 19).
    from config import MRMS_CATEGORY_CUTOFFS_INCHES

    cat_bounds: list[tuple[float, float]] = []
    prev = 0.01  # smallest measurable precip
    for upper in MRMS_CATEGORY_CUTOFFS_INCHES:
        cat_bounds.append((prev, upper))
        prev = upper
    cat_bounds.append((prev, float("inf")))  # cat 19: [20.0, inf)
    assert len(cat_bounds) == 20

    records = []
    for cat, (lo, hi) in enumerate(cat_bounds):
        bin_mask = (data_inches >= lo) & (data_inches < hi)
        if not bin_mask.any():
            continue
        for geom_json, _ in _raster_shapes(
            bin_mask.astype("uint8"),
            mask=bin_mask,
            transform=transform,
        ):
            geom = _shapely_shape(geom_json)
            if not geom.is_valid or geom.is_empty:
                continue
            records.append({
                "category": cat,
                "label": _category_label(cat),
                "geometry": geom,
            })

    if not records:
        # No precip in the bbox at any category. Return empty GDF in the
        # right shape so downstream code doesn't choke.
        empty = gpd.GeoDataFrame(
            columns=["category", "label", "geometry"],
            geometry="geometry",
            crs="EPSG:4326",
        )
        return empty, max_inches

    gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")
    return gdf, max_inches


def _category_label(cat: int) -> str:
    """Human-friendly label for category index. Lazy import of the labels
    dict from map_folium to avoid a circular import."""
    try:
        from map_folium import PRECIP_LABELS
        return PRECIP_LABELS.get(cat, f"cat {cat}")
    except Exception:
        return f"cat {cat}"
