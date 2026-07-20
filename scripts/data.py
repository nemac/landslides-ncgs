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
    WNC_BBOX,
    OVERTURE_BUILDINGS_SUBDIR,
    OVERTURE_BUILDINGS_MANIFEST_NAME,
    OVERTURE_BUILDINGS_CACHE_TTL_DAYS,
    OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG,
    OVERTURE_BUILDINGS_COORD_PRECISION,
    OVERTURE_BUILDINGS_MIN_AREA_SQM,
)


# =============================================================================
# AGOL request helper with retry-with-backoff
# =============================================================================

def _agol_request_with_retry(url: str, params: dict, label: str,
                              max_attempts: int = 5,
                              accept_encoding: str = "gzip, deflate") -> dict:
    """GET an ArcGIS REST endpoint, retrying transient errors (5xx, timeouts).

    AGOL has periodic blips (503, 504, brief socket timeouts) that resolve
    in seconds. We retry up to `max_attempts` times with exponential
    backoff (1s, 2s, 4s, 8s) before giving up.

    ALSO detects AGOL's HTTP-200-but-JSON-error pattern: AGOL returns
    {"error": {...}} with status 200 for both real problems (bad field name)
    and TRANSIENT ones - notably error 400 "Unable to perform query" when the
    service is overwhelmed by concurrent requests. We route these through the
    same retry/backoff loop; a genuine error simply exhausts the retries and
    surfaces its message, while a transient overload recovers on a later try.

    Parameters
    ----------
    url : str         the /query endpoint
    params : dict     query parameters
    label : str       short description used in log lines (e.g. "page @offset=20000")
    max_attempts : int  total attempts including the first; default 5
    accept_encoding : str  value of the Accept-Encoding request header.
        Defaults to "gzip, deflate" (excludes brotli, which the requests
        library can't decode without the optional `brotli` package - a
        known headache with some AGOL services). Pass "identity" for
        services that claim to send valid gzip but send malformed bytes
        (see _fetch_wnc_huc12 for the one known case in our pipeline).

    Returns
    -------
    dict   the parsed JSON response

    Raises
    ------
    requests.HTTPError on the final attempt if errors persist - including a
    persistent AGOL HTTP-200 error envelope, which is retried like any other
    transient failure.
    """
    import time
    headers = {"Accept-Encoding": accept_encoding}

    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            r = requests.get(url, params=params, timeout=120, headers=headers)
            if 500 <= r.status_code < 600:
                raise requests.HTTPError(
                    f"{r.status_code} Server Error", response=r
                )
            r.raise_for_status()
            try:
                payload = r.json()
            except ValueError as je:
                # JSON parse failed - server probably gave us an HTML error
                # page or an empty body despite the 200 status. Show what we
                # actually got, then raise for retry.
                snippet = r.text[:200].strip() if r.text else "(empty body)"
                raise requests.HTTPError(
                    f"Non-JSON response (probably transient server issue): "
                    f"{snippet}", response=r
                ) from je
            # AGOL error-envelope check (HTTP 200 with an {"error": ...} body).
            # Raise a requests error (not RuntimeError) so it goes through the
            # retry/backoff loop below - these are frequently transient under
            # concurrent load (error 400 "Unable to perform query"). A genuine
            # bad-parameter error just exhausts the retries and surfaces here.
            if isinstance(payload, dict) and "error" in payload:
                err = payload["error"]
                msg = err.get("message", "(no message)")
                details = err.get("details") or []
                code = err.get("code", "?")
                raise requests.HTTPError(
                    f"AGOL returned error {code}: {msg}"
                    + (f" details={details!r}" if details else "")
                )
            return payload
        # Retry any requests-level transport error. Besides HTTPError /
        # Timeout / ConnectionError this covers ChunkedEncodingError (server
        # drops the connection mid-response) and ContentDecodingError (malformed
        # gzip) - both observed against these AGOL services during large
        # paginated pulls - as well as the AGOL error-envelope raised above.
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt < max_attempts:
                backoff_s = 2 ** (attempt - 1)
                print(f"  [retry {attempt}/{max_attempts - 1}] {label}: "
                      f"{type(e).__name__}, waiting {backoff_s}s...")
                time.sleep(backoff_s)
            else:
                print(f"  [give up] {label}: exhausted {max_attempts} attempts")
    raise last_exc  # type: ignore[misc]


def _fetch_features_paginated(query_url: str, base_params: dict,
                              page_size: int = 2000, max_workers: int = 8,
                              label: str = "features") -> list[dict]:
    """Fetch ALL features from an ArcGIS /query endpoint, paginating pages
    in parallel.

    ArcGIS caps every response at the service's maxRecordCount (2000 for the
    NCGS debris service - requesting more per page is silently clamped), so a
    large layer must be paged. The pages are independent, though: we first
    probe the total via returnCountOnly, compute every offset, and fetch them
    concurrently instead of one-at-a-time. For the ~225k-feature WNC debris
    layer that turns ~113 serial round-trips into a handful of parallel batches.

    Falls back to plain sequential pagination if the count probe fails, so a
    flaky count query can't break the fetch. Every page still goes through
    _agol_request_with_retry for 5xx/timeout backoff and the HTTP-200 error
    envelope check.

    base_params must carry everything except paging (where, outFields, f,
    spatial filter, outSR, ...). Do NOT put resultOffset/resultRecordCount in
    it; this function sets those per page.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def fetch_page(offset: int) -> tuple[int, list[dict]]:
        params = dict(base_params)
        params["resultOffset"] = offset
        params["resultRecordCount"] = page_size
        page = _agol_request_with_retry(
            query_url, params, label=f"{label} @offset={offset:,}")
        return offset, page.get("features", [])

    # Probe the total up front so we can compute all offsets.
    count_params = dict(base_params)
    count_params.update({"returnCountOnly": "true", "f": "json"})
    for k in ("outFields", "resultOffset", "resultRecordCount"):
        count_params.pop(k, None)
    try:
        cp = _agol_request_with_retry(query_url, count_params,
                                      label=f"{label} count")
        total = int(cp.get("count"))
    except Exception as e:
        print(f"  count probe failed ({type(e).__name__}: {e}); "
              f"falling back to sequential pagination")
        total = None

    # Sequential fallback: page until a short/empty page (the original loop).
    if total is None:
        all_features: list[dict] = []
        offset = 0
        while True:
            _, feats = fetch_page(offset)
            if not feats:
                break
            all_features.extend(feats)
            if len(feats) < page_size:
                break
            offset += page_size
        return all_features

    if total == 0:
        return []

    offsets = list(range(0, total, page_size))
    print(f"  {total:,} features across {len(offsets)} pages "
          f"(fetching up to {max_workers} concurrently)...")
    pages: dict[int, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(fetch_page, off) for off in offsets]
        done = 0
        for fut in as_completed(futures):
            offset, feats = fut.result()
            pages[offset] = feats
            done += 1
            if done % 10 == 0 or done == len(offsets):
                got = sum(len(v) for v in pages.values())
                print(f"  {done}/{len(offsets)} pages done ({got:,} features)")

    # Concatenate in offset order so output is deterministic regardless of the
    # order futures completed in.
    all_features: list[dict] = []
    for off in offsets:
        all_features.extend(pages.get(off, []))

    # Completeness guard. With a stable unique sort every page is a disjoint,
    # full slice, so the concatenation must total exactly `total`. If it's
    # short, a page came back with fewer rows than expected (e.g. a throttled
    # response that slipped through) - fail loudly rather than silently
    # shipping an incomplete layer downstream.
    if len(all_features) != total:
        raise RuntimeError(
            f"{label}: fetched {len(all_features):,} features but the service "
            f"reported {total:,}. Pagination is incomplete (likely dropped "
            f"pages under load); aborting instead of shipping partial data."
        )
    return all_features


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
    """Pull WNC-area debris flow polygons from the NCGS feature service.

    Filtered server-side to the WNC bounding box (see config.WNC_BBOX). This
    is a Western NC model, so the bbox contains ~225k of its ~228k polygons -
    the filter trims almost nothing; it just keeps the fetch aligned with the
    WNC-only precipitation scope. Pages are fetched in parallel (see
    _fetch_features_paginated) since that's ~113 pages at the 2000-record cap.

    Results are cached locally as a GeoPackage. Subsequent calls within
    the cache TTL load from disk instead of paginating against AGOL.

    Includes retry-with-backoff for transient AGOL 5xx errors.

    Each polygon is also augmented with `county` and `watershed` (HUC12 name)
    columns via spatial join against US Census TIGER counties (NC only) and
    USGS WBD HUC12 subwatersheds. These joins happen once when the cache
    is first built; existing caches missing these columns are
    transparently upgraded in place.

    Parameters
    ----------
    force_refresh : bool
        If True, ignore the cache and re-fetch from NCGS.

    Returns
    -------
    GeoDataFrame in EPSG:4326 with columns OBJECTID, county, watershed,
    geometry.
    """
    cache_p = _cache_path()

    if not force_refresh and _cache_is_fresh():
        age_h = (datetime.now().timestamp() - cache_p.stat().st_mtime) / 3600
        print(f"Loading debris flow polygons from cache "
              f"({cache_p}, {age_h:.1f}h old)...")
        gdf = gpd.read_file(cache_p)
        print(f"  -> {len(gdf):,} polygons loaded from cache")

        # Upgrade cached GDFs that don't yet have county/watershed columns,
        # OR have them present but fully empty (which happens if a prior
        # run hit a service outage and saved a cache with empty strings).
        needs_augment = (
            "county" not in gdf.columns
            or "watershed" not in gdf.columns
            or (gdf["county"].fillna("").astype(str) == "").all()
            or (gdf["watershed"].fillna("").astype(str) == "").all()
        )
        if needs_augment:
            reasons = []
            if "county" not in gdf.columns:
                reasons.append("county column missing")
            elif (gdf["county"].fillna("").astype(str) == "").all():
                reasons.append("county column all empty")
            if "watershed" not in gdf.columns:
                reasons.append("watershed column missing")
            elif (gdf["watershed"].fillna("").astype(str) == "").all():
                reasons.append("watershed column all empty")
            print(f"  Cache needs augmentation: {', '.join(reasons)}")
            gdf = _augment_with_admin_boundaries(gdf)
            print(f"  Saving augmented cache...")
            gdf.to_file(cache_p, driver="GPKG")
            print(f"  cache updated ({cache_p.stat().st_size / 1e6:.1f} MB)")

        return gdf

    bbox_str = ",".join(str(c) for c in WNC_BBOX)
    print(f"Fetching debris flow polygons from NCGS (WNC bbox = {bbox_str})...")

    # The debris model is a Western NC dataset, so ~225k of its ~228k polygons
    # fall inside the WNC bbox - the spatial filter trims almost nothing, it
    # just aligns the fetch with the WNC-only precipitation scope. That's a lot
    # of pages at the service's 2000-record cap, so fetch them in parallel.
    base_params = {
        "where": "1=1",
        "outFields": "OBJECTID",
        "outSR": 4326,
        "f": "geojson",
        # REQUIRED for correct pagination. ArcGIS resultOffset/resultRecordCount
        # paging is only deterministic with a stable sort on a UNIQUE key;
        # without it the server returns pages in arbitrary per-request order, so
        # pages overlap and some features are never returned (verified 2026-07-20:
        # an unordered pull of all 113 pages surfaced only part of the layer).
        # Sort by OBJECTID_1 - the layer's real system OID field. NOTE: the
        # plain "OBJECTID" column on this WNC_Mosaic layer is NOT unique (many
        # rows share a value), so it must NOT be used for paging or as a key.
        "orderByFields": "OBJECTID_1",
        # Server-side spatial filter to WNC bbox
        "geometry":     bbox_str,
        "geometryType": "esriGeometryEnvelope",
        "inSR":         "4326",
        "spatialRel":   "esriSpatialRelIntersects",
    }
    # page_size 1000 (below the 2000 server cap): smaller responses are lighter
    # per request and less likely to trip AGOL's overload 400s. max_workers 4:
    # 8-wide provably got throttled (dropped pages / overload 400s) - 4 keeps us
    # under the service's rate limit while still ~4x faster than serial.
    all_features = _fetch_features_paginated(
        f"{DEBRIS_FLOW_SERVICE_URL}/query",
        base_params,
        page_size=1000,
        max_workers=4,
        label="debris flow",
    )

    if not all_features:
        return gpd.GeoDataFrame({"OBJECTID": []}, geometry=[], crs=DISPLAY_CRS)

    gdf = gpd.GeoDataFrame.from_features(all_features, crs=DISPLAY_CRS)
    print(f"  -> {len(gdf):,} debris flow polygons within WNC bbox")

    # Augment with administrative boundaries (county + HUC12 watershed)
    gdf = _augment_with_admin_boundaries(gdf)

    # Write to cache
    cache_p.parent.mkdir(parents=True, exist_ok=True)
    print(f"  caching to {cache_p}...")
    gdf.to_file(cache_p, driver="GPKG")
    print(f"  cache written ({cache_p.stat().st_size / 1e6:.1f} MB)")

    return gdf


# =============================================================================
# Administrative boundaries (counties + watersheds) for debris flow context
# =============================================================================

# US Census Bureau TIGERweb counties layer
_CENSUS_COUNTIES_URL = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/"
    "TIGERweb/State_County/MapServer/13/query"
)

# UNC Asheville-hosted HUC12 watershed boundary dataset.
#
# Why UNC Asheville and not Esri's central Living Atlas:
# We tested four sources on 2026-05-28 and only UNC's worked:
#   1. USGS National Map (hydrowfs.nationalmap.gov/.../wbd/MapServer/6):
#      500 Server Errors on every retry.
#   2. Esri's "new authoritative" Living Atlas HUC12 item
#      (917b0818267847aca910d465b5a3e8ec): proxies through to USGS National
#      Map, inheriting the 500/400 errors.
#   3. Esri's "retiring" Living Atlas HUC12 service
#      (services.arcgis.com/P3ePLMYs2RVChkJx/.../USA_Watershed_Boundary_Dataset_HUC_12s):
#      400 Bad Request errors - the service appears to have been
#      decommissioned despite its item page still showing on AGOL.
#   4. UNC Asheville's hosted copy (THIS ONE): worked perfectly, 827
#      watersheds returned with 99.94% match rate against debris flow
#      polygons.
#
# UNC's service is hosted on Esri's services5.arcgis.com infrastructure
# (same ArcGIS Online platform that hosts Esri's central services). UNC
# downloaded USGS WBD data and republished it as their own FeatureServer.
# So technically this IS an "Esri-hosted" source - it's just curated and
# published by UNC Asheville rather than Esri's central team. The
# underlying data is the same USGS WBD that Esri's broken services were
# supposed to be serving.
_HUC12_QUERY_URL = (
    "https://services5.arcgis.com/7weheFjxuNkGGiZi/arcgis/rest/services/"
    "Watershed_Boundary_HUC12/FeatureServer/0/query"
)



def _fetch_nc_counties() -> gpd.GeoDataFrame:
    """Fetch counties from NC and neighboring states (TN, GA, SC, VA).

    Queries each state SEPARATELY rather than using a multi-value WHERE
    clause. TIGERweb has been observed to return empty response bodies
    for IN(...) clauses and even simple OR-chains - the single-value
    STATE='X' form is the only one consistently accepted. The per-state
    loop also makes failures granular: if VA's query fails, we still get
    counties from the other 4 states.

    Returns a GDF in EPSG:4326 with columns NAME and geometry.
    """
    print("  Fetching NC + neighboring-state county boundaries from "
          "US Census TIGERweb...")
    # State FIPS: 37=NC, 47=TN, 13=GA, 45=SC, 51=VA
    states = [
        ("37", "NC"),
        ("47", "TN"),
        ("13", "GA"),
        ("45", "SC"),
        ("51", "VA"),
    ]

    all_features: list[dict] = []
    for fips, abbrev in states:
        params = {
            "where":          f"STATE='{fips}'",
            "outFields":      "NAME,GEOID,STATE",
            "outSR":          "4326",
            "f":              "geojson",
            "returnGeometry": "true",
        }
        try:
            page = _agol_request_with_retry(
                _CENSUS_COUNTIES_URL, params,
                label=f"{abbrev} counties",
            )
            feats = page.get("features", [])
            print(f"    {abbrev}: {len(feats)} counties")
            all_features.extend(feats)
        except Exception as e:
            print(f"    ! {abbrev} county fetch failed: {e}; continuing")

    if not all_features:
        print("  ! No county features returned from any state")
        return gpd.GeoDataFrame(columns=["NAME", "geometry"],
                                 geometry="geometry", crs=DISPLAY_CRS)
    gdf = gpd.GeoDataFrame.from_features(all_features, crs=DISPLAY_CRS)
    print(f"  -> {len(gdf)} counties loaded total")
    return gdf


def _fetch_wnc_huc12() -> gpd.GeoDataFrame:
    """Fetch HUC12 subwatersheds intersecting the WNC bbox.

    Source: Esri Living Atlas "USA Watershed Boundary Dataset HUC 12s"
    feature service (see _HUC12_QUERY_URL comment for why we use this
    rather than Esri's newer "authoritative" item, which actually proxies
    to USGS's unreliable National Map service).

    Returns a GDF in EPSG:4326 with columns:
      NAME      subwatershed name (e.g. "South Toe River-Carolina Hemlocks")
      HUC12     12-digit USGS HUC identifier (if present in source schema)
      geometry
    """
    print("  Fetching WNC HUC12 watersheds from Esri Living Atlas...")
    bbox_str = ",".join(str(c) for c in WNC_BBOX)
    params = {
        "where":          "1=1",
        # Request all fields rather than guessing case (Living Atlas
        # schemas can differ from USGS native - sometimes NAME, sometimes
        # name, sometimes huc12 vs HUC12). We normalize after fetch.
        "outFields":      "*",
        "geometry":       bbox_str,
        "geometryType":   "esriGeometryEnvelope",
        "inSR":           "4326",
        "spatialRel":     "esriSpatialRelIntersects",
        "outSR":          "4326",
        "f":              "geojson",
        "returnGeometry": "true",
    }
    # UNC Asheville's services5 host claims Content-Encoding: gzip on its
    # HUC12 responses but sends malformed gzip bytes ("invalid stored block
    # lengths" / "invalid code lengths set"). Requesting identity encoding
    # tells the server to skip compression entirely. HUC12 payloads for
    # the WNC bbox are ~5-10 MB uncompressed - noticeable but not painful.
    page = _agol_request_with_retry(_HUC12_QUERY_URL, params,
                                     label="WNC HUC12 watersheds",
                                     accept_encoding="identity")
    feats = page.get("features", [])
    if not feats:
        print("  ! No HUC12 features returned from AGOL")
        return gpd.GeoDataFrame(columns=["NAME", "HUC12", "geometry"],
                                 geometry="geometry", crs=DISPLAY_CRS)
    gdf = gpd.GeoDataFrame.from_features(feats, crs=DISPLAY_CRS)

    # Normalize field names. Try multiple variants since Living Atlas
    # and USGS native services have slightly different schemas.
    name_col = next((c for c in ("name", "NAME", "Name")
                     if c in gdf.columns), None)
    huc_col  = next((c for c in ("huc12", "HUC12", "Huc12")
                     if c in gdf.columns), None)
    if name_col and name_col != "NAME":
        gdf = gdf.rename(columns={name_col: "NAME"})
    if huc_col and huc_col != "HUC12":
        gdf = gdf.rename(columns={huc_col: "HUC12"})

    if "NAME" not in gdf.columns:
        # Last resort: pick the first string column as the name
        text_cols = [c for c in gdf.columns
                     if c != "geometry" and gdf[c].dtype == object]
        if text_cols:
            print(f"  ! 'NAME' field not found; using '{text_cols[0]}' as watershed name")
            gdf = gdf.rename(columns={text_cols[0]: "NAME"})
        else:
            print("  ! No usable name field found on Living Atlas response")
            gdf["NAME"] = ""

    print(f"  -> {len(gdf)} HUC12 watersheds loaded for WNC")
    return gdf


def _augment_with_admin_boundaries(debris_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Spatially join debris flow polygons against counties + HUC12s.

    Uses representative_point() rather than the polygon itself to ensure
    each debris flow gets exactly ONE county and ONE watershed (a polygon
    that crosses boundaries would otherwise produce multiple sjoin rows).

    Mutates and returns the input GDF with two new columns: county, watershed.
    Failures (e.g. Census service unavailable) are non-fatal: missing
    values become empty strings and the rest of the pipeline continues.
    """
    print(f"\n  Augmenting {len(debris_gdf):,} debris flow polygons "
          f"with county + watershed info...")

    # Cache the auxiliary datasets module-level so multiple calls within
    # one run don't re-fetch.
    if "counties" not in _admin_cache:
        try:
            _admin_cache["counties"] = _fetch_nc_counties()
        except Exception as e:
            print(f"  ! County fetch failed: {e}; will fill with ''")
            _admin_cache["counties"] = None

    if "watersheds" not in _admin_cache:
        try:
            _admin_cache["watersheds"] = _fetch_wnc_huc12()
        except Exception as e:
            print(f"  ! Watershed fetch failed: {e}; will fill with ''")
            _admin_cache["watersheds"] = None

    counties_gdf  = _admin_cache.get("counties")
    watersheds_gdf = _admin_cache.get("watersheds")

    # Build a one-time points layer (representative_point) for fast sjoins.
    # Carry only OBJECTID through so we can re-join the result columns
    # back to debris_gdf by index.
    rep_points = gpd.GeoDataFrame(
        {"_join_idx": range(len(debris_gdf))},
        geometry=debris_gdf.geometry.representative_point(),
        crs=debris_gdf.crs,
    )

    # County join
    if counties_gdf is not None and len(counties_gdf) > 0:
        cj = gpd.sjoin(
            rep_points,
            counties_gdf[["NAME", "geometry"]].rename(columns={"NAME": "county"}),
            how="left", predicate="within",
        )
        # Sort back to original order in case sjoin reordered rows.
        cj = cj.sort_values("_join_idx").drop_duplicates("_join_idx", keep="first")
        debris_gdf["county"] = cj["county"].fillna("").values
        n_with = (debris_gdf["county"] != "").sum()
        print(f"  -> {n_with}/{len(debris_gdf):,} polygons matched to a county")
    else:
        debris_gdf["county"] = ""

    # Watershed join
    if watersheds_gdf is not None and len(watersheds_gdf) > 0:
        wj = gpd.sjoin(
            rep_points,
            watersheds_gdf[["NAME", "geometry"]].rename(columns={"NAME": "watershed"}),
            how="left", predicate="within",
        )
        wj = wj.sort_values("_join_idx").drop_duplicates("_join_idx", keep="first")
        debris_gdf["watershed"] = wj["watershed"].fillna("").values
        n_with = (debris_gdf["watershed"] != "").sum()
        print(f"  -> {n_with}/{len(debris_gdf):,} polygons matched to a watershed")
    else:
        debris_gdf["watershed"] = ""

    return debris_gdf


# Module-level cache so counties+watersheds are fetched once per process
_admin_cache: dict = {}


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

    NDFD's "Accumulation by Time" service stores 6-hour accumulation
    periods (per the NWS NDFD spec, periods are 6 hours long beginning
    and ending at 0000, 0600, 1200, 1800 UTC). To cover a longer
    window_hours, we return ALL 6-hour periods whose accumulation window
    overlaps [now, now + window_hours]. The client-side intersection logic
    takes the MAX category across overlapping polygons, so duplicates
    don't break alerts.

    Parameters
    ----------
    window_hours : int
        Hours past now to take the accumulation snapshot. Multiple of 6.
    min_category : int
        Lowest NDFD precipitation category to include (0-19).

    Returns
    -------
    gdf : GeoDataFrame (EPSG:4326)
        Features above the threshold across CONUS.
        Columns: category, label, fromdate, todate, geometry.
    fromdate : datetime (UTC)
        Now - the start of our query window.
    todate : datetime (UTC)
        End of the accumulation window we requested (now + window_hours).
    """
    if window_hours <= 0 or window_hours % 6 != 0:
        raise ValueError(
            f"window_hours must be a positive multiple of 6 (got {window_hours})"
        )

    now_dt = datetime.now(timezone.utc)
    end_dt = now_dt + timedelta(hours=window_hours)

    print(f"Fetching NDFD precipitation forecast "
          f"(window={window_hours}h, min category={min_category})...")
    print(f"  query window from: {now_dt:%Y-%m-%d %H:%M UTC}")
    print(f"  query window to:   {end_dt:%Y-%m-%d %H:%M UTC}")

    # Build the WHERE clause. Overlap test: a polygon's accumulation
    # period [fromdate, todate] overlaps [now, end] iff
    #     fromdate < end  AND  todate > now
    # ArcGIS REST API supports `timestamp 'YYYY-MM-DD HH:MM:SS'` literals
    # for date/time field comparisons.
    where = (
        f"fromdate < timestamp '{end_dt:%Y-%m-%d %H:%M:%S}' "
        f"AND todate > timestamp '{now_dt:%Y-%m-%d %H:%M:%S}' "
        f"AND category >= {min_category}"
    )

    # Server-side spatial filter to the WNC bbox. Without this, busy CONUS
    # forecasts can return >2000 features and hit the ArcGIS maxRecordCount
    # cap, truncating WNC features arbitrarily. Filtering at the service
    # cuts the response to just our area and keeps us well below the cap.
    from config import WNC_BBOX
    bbox_str = ",".join(str(c) for c in WNC_BBOX)

    params = {
        "where": where,
        "outFields": "category,label,fromdate,todate",
        "outSR": 4326,
        "f": "geojson",
        "returnGeometry": "true",
        "geometry":      bbox_str,
        "geometryType":  "esriGeometryEnvelope",
        "inSR":          "4326",
        "spatialRel":    "esriSpatialRelIntersects",
    }
    r = requests.get(f"{NDFD_PRECIP_SERVICE_URL}/query",
                     params=params, timeout=90)
    r.raise_for_status()
    page = r.json()

    feats = page.get("features", [])
    print(f"  -> {len(feats)} precipitation polygons above threshold (WNC bbox)")

    if not feats:
        gdf = gpd.GeoDataFrame(
            {"category": [], "label": [], "fromdate": [], "todate": []},
            geometry=[],
            crs=DISPLAY_CRS,
        )
    else:
        gdf = gpd.GeoDataFrame.from_features(feats, crs=DISPLAY_CRS)

    return gdf, now_dt, end_dt


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


def fetch_mrms_qpe(
    window_hours: int = 1,
    bbox: tuple[float, float, float, float] | None = None,
) -> tuple[gpd.GeoDataFrame, datetime, datetime, dict]:
    """Fetch the most recent MRMS N-hour QPE accumulation.

    MRMS publishes pre-summed accumulation products for 1, 3, 6, 12, 24,
    48, and 72 hours (per the NSSL spec). This function works against any
    of those windows uniformly - the only difference between a 1-hour
    fetch and a 72-hour fetch is the product directory in the URL.

    The fetcher tries the same Pass1 -> RadarOnly -> Pass2 fallback chain
    we use for the 1-hour product. Pass1 is primary (published ~5-10 min
    after the hour, includes gauge correction); RadarOnly is fast fallback
    (~2-3 min after the hour); Pass2 is last resort (~60-75 min, most
    accurate but stalest).

    Parameters
    ----------
    window_hours : int
        Accumulation window. Must be in config.MRMS_HOUR_WINDOWS.
    bbox : tuple, optional
        Geographic bbox to clip the polygons to. Defaults to WNC_BBOX.

    Returns
    -------
    (precip_gdf, fromdate, todate, meta)
        precip_gdf : GeoDataFrame in NDFD-compatible category bins
        fromdate, todate : datetime UTC; todate is the valid-time of the
            product file, fromdate is todate - window_hours
        meta : dict with keys: product, product_id, file_url, valid_time,
            minutes_ago, max_inches, n_polygons, window_hours

    Raises
    ------
    ValueError if window_hours isn't a supported MRMS window.
    RuntimeError if no MRMS file succeeded across all product fallbacks.
    """
    if not HAS_RASTERIO:
        raise RuntimeError(
            "MRMS mode requires the rasterio package. Install with:\n"
            "    conda install -c conda-forge rasterio libgdal-grib"
        )

    from config import (
        MRMS_URL_TEMPLATES, MRMS_HOUR_WINDOWS, WNC_BBOX,
        mrms_product_fallback_for_hours,
    )
    if window_hours not in MRMS_HOUR_WINDOWS:
        raise ValueError(
            f"window_hours={window_hours} not in MRMS_HOUR_WINDOWS "
            f"({MRMS_HOUR_WINDOWS}). Edit config.py to add a new window."
        )
    if bbox is None:
        bbox = WNC_BBOX

    now = datetime.now(timezone.utc)
    errors: list[str] = []
    fallback_chain = mrms_product_fallback_for_hours(window_hours)

    # Try each product variant in order. Each has its own expected lag.
    for product_cfg in fallback_chain:
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
                gdf, max_inches = _read_mrms_grib_to_polygons(
                    url, bbox, valid_time
                )
                fromdate = valid_time - timedelta(hours=window_hours)
                todate = valid_time
                minutes_ago = (now - valid_time).total_seconds() / 60.0
                meta = {
                    "product":      display_name,
                    "product_id":   product_name,
                    "file_url":     url,
                    "valid_time":   valid_time,
                    "minutes_ago":  minutes_ago,
                    "max_inches":   max_inches,
                    "n_polygons":   len(gdf),
                    "window_hours": window_hours,
                }
                return gdf, fromdate, todate, meta
            except Exception as e:
                errors.append(
                    f"{display_name} @ {valid_time:%Y-%m-%d %H:%MZ}: "
                    f"{type(e).__name__}: {e}"
                )
                continue

    raise RuntimeError(
        f"Could not fetch any MRMS {window_hours}-hour file across all "
        f"product fallbacks. Recent errors:\n  " + "\n  ".join(errors[-5:])
    )


def fetch_mrms_qpe_1h(
    bbox: tuple[float, float, float, float] | None = None,
) -> tuple[gpd.GeoDataFrame, datetime, datetime, dict]:
    """Backward-compat alias for fetch_mrms_qpe(window_hours=1).
    Existing callers that don't know about windows keep working."""
    return fetch_mrms_qpe(window_hours=1, bbox=bbox)


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


# =============================================================================
# NWPS Stage IV historical precipitation (hindcast)
# =============================================================================

STAGE_IV_URL_TEMPLATE = (
    "https://water.noaa.gov/resources/downloads/precip/stageIV/"
    "{YYYY:04d}/{MM:02d}/{DD:02d}/"
    "nws_precip_1day_{YYYY:04d}{MM:02d}{DD:02d}_conus.tif"
)


def fetch_stage_iv_qpe(
    end_date: str,
    accumulation_days: int,
) -> tuple[gpd.GeoDataFrame, dict]:
    """Fetch NWPS Stage IV multi-day precipitation accumulation.

    Stage IV publishes 1-day GeoTIFFs (12Z-12Z windows) for each calendar
    day, archived 2016-present. To produce an N-day accumulation, we
    download N consecutive 1-day files and sum them. NWPS removes the
    pre-computed multi-day files after ~365 days, so we don't rely on
    those - the 1-day-and-sum approach works for any historical date.

    Each 1-day file represents the 24-hour period ending at 12Z on the
    day in its filename. So for an N-day total ending at 12Z on end_date,
    we sum the files for end_date, end_date-1, ..., end_date-(N-1).

    Parameters
    ----------
    end_date : str
        Last day of the accumulation window, "YYYY-MM-DD". The window
        covers the N days ending at 12Z on end_date.
    accumulation_days : int
        Width of the accumulation window in days. Must be positive.

    Returns
    -------
    gdf : GeoDataFrame
        Precipitation polygons in EPSG:4326, clipped to the WNC bbox,
        binned to NDFD categories 0-19. Columns: category, label, geometry.
    meta : dict
        {'product', 'end_date', 'accumulation_days', 'max_inches',
         'urls_used', 'days_missing'}

    Raises
    ------
    ValueError      if accumulation_days is non-positive
    RuntimeError    if more than half the daily files are unavailable
    """
    from datetime import datetime as _datetime, timedelta as _timedelta

    if accumulation_days < 1:
        raise ValueError(f"accumulation_days must be >= 1, got {accumulation_days}")

    end_dt = _datetime.strptime(end_date, "%Y-%m-%d")
    days = [end_dt - _timedelta(days=i) for i in range(accumulation_days)]
    days_oldest_first = sorted(days)

    print(f"  Fetching Stage IV {accumulation_days}-day accumulation "
          f"ending {end_date}")
    print(f"  Range: {days_oldest_first[0]:%Y-%m-%d} "
          f"through {days_oldest_first[-1]:%Y-%m-%d}")

    accumulator = None
    accumulator_transform = None
    accumulator_crs = None
    accumulator_nodata = None
    urls_used = []
    days_missing = []

    for day in days_oldest_first:
        url = STAGE_IV_URL_TEMPLATE.format(
            YYYY=day.year, MM=day.month, DD=day.day
        )
        try:
            arr, transform, crs, nodata = _download_stage_iv_one_day(url)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                print(f"  ! {day:%Y-%m-%d}: file not found (404), skipping")
                days_missing.append(day.strftime("%Y-%m-%d"))
                continue
            raise

        urls_used.append(url)

        if accumulator is None:
            # First successful day - initialize the accumulator with its
            # grid as the reference. All subsequent days must align with
            # this grid (Stage IV files share the same HRAP grid, so this
            # is a safety check, not active reprojection).
            import numpy as np
            accumulator = np.where(
                (arr != nodata) & np.isfinite(arr) & (arr > 0),
                arr, 0
            ).astype("float64")
            accumulator_transform = transform
            accumulator_crs = crs
            accumulator_nodata = nodata
        else:
            import numpy as np
            if arr.shape != accumulator.shape:
                print(f"  ! {day:%Y-%m-%d}: grid mismatch "
                      f"({arr.shape} vs {accumulator.shape}), skipping")
                days_missing.append(day.strftime("%Y-%m-%d"))
                continue
            valid = (arr != nodata) & np.isfinite(arr) & (arr > 0)
            accumulator = accumulator + np.where(valid, arr, 0)

    # Bail if too many days were missing
    if accumulator is None:
        raise RuntimeError(
            f"All {accumulation_days} daily files failed; nothing to sum"
        )
    if len(days_missing) > accumulation_days / 2:
        raise RuntimeError(
            f"{len(days_missing)}/{accumulation_days} daily files missing "
            f"({days_missing}); accumulation would be misleading"
        )

    print(f"  Summed {accumulation_days - len(days_missing)} day(s) "
          f"({len(days_missing)} missing)")

    # Polygonize the accumulator. _polygonize_inches_array reuses our
    # MRMS-style logic; the only difference is we already have inches
    # (no mm->in conversion needed) and a pre-summed accumulator.
    gdf, max_inches = _polygonize_stage_iv_inches(
        accumulator, accumulator_transform, accumulator_crs, accumulator_nodata
    )

    meta = {
        "product":           f"NWPS Stage IV ({accumulation_days}-day sum)",
        "end_date":          end_date,
        "accumulation_days": accumulation_days,
        "max_inches":        max_inches,
        "urls_used":         urls_used,
        "days_missing":      days_missing,
    }
    return gdf, meta


def _download_stage_iv_one_day(url: str):
    """Download a single 1-day Stage IV file and return
    (data_array, transform, crs, nodata). Tries .tif first, falls back to
    .nc (NetCDF) - both are published by NWPS and rasterio reads them
    identically. Some dates have only one format available, especially
    around the Hurricane Helene period (Sept 27-29, 2024) when NCEI's
    archive ingest in Asheville, NC was disrupted by the storm itself.
    """
    print(f"    fetching {url.rsplit('/', 1)[-1]}...")
    r = requests.get(url, timeout=120)

    if r.status_code == 404 and url.endswith('.tif'):
        # Try NetCDF fallback
        nc_url = url[:-4] + '.nc'
        print(f"    .tif missing, trying {nc_url.rsplit('/', 1)[-1]}...")
        r = requests.get(nc_url, timeout=120)
        url = nc_url

    if r.status_code == 404:
        raise requests.HTTPError(f"404 at {url}", response=r)
    r.raise_for_status()

    from rasterio.io import MemoryFile
    with MemoryFile(r.content) as memfile:
        with memfile.open() as src:
            data = src.read(1).astype("float32")
            transform = src.transform
            crs = src.crs
            nodata = src.nodata if src.nodata is not None else -9999
    return data, transform, crs, nodata


def _polygonize_stage_iv_inches(
    data_inches,
    transform,
    src_crs,
    nodata,
) -> tuple[gpd.GeoDataFrame, float]:
    """Reproject the accumulator to WGS84, clip to WNC, polygonize at NDFD
    category cutoffs. Stage IV's native CRS is polar stereographic (HRAP
    grid); we reproject to a regular lat/lon grid before binning so we get
    rectangular pixel polygons in the output."""
    import numpy as np
    from rasterio.warp import reproject, Resampling, calculate_default_transform

    # Reproject to WGS84 at ~native (4km) resolution
    is_geographic = (src_crs is not None
                     and (src_crs.to_epsg() == 4326 or src_crs.is_geographic))

    if is_geographic:
        data_wgs84 = data_inches
        transform_wgs84 = transform
    else:
        dst_crs = "EPSG:4326"
        src_height, src_width = data_inches.shape
        # Get the source bounds for calculate_default_transform
        from rasterio.transform import array_bounds
        src_bounds = array_bounds(src_height, src_width, transform)
        dst_transform, dst_width, dst_height = calculate_default_transform(
            src_crs, dst_crs, src_width, src_height,
            *src_bounds,
            resolution=0.04,   # ~4km at WNC latitude
        )
        data_wgs84 = np.full(
            (dst_height, dst_width),
            fill_value=0.0,
            dtype="float64",
        )
        reproject(
            source=data_inches.astype("float64"),
            destination=data_wgs84,
            src_transform=transform,
            src_crs=src_crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            src_nodata=0,   # we already replaced nodata with 0 in accumulator
            dst_nodata=0,
            resampling=Resampling.bilinear,
        )
        transform_wgs84 = dst_transform

    valid_mask = np.isfinite(data_wgs84) & (data_wgs84 > 0)
    max_inches = float(data_wgs84[valid_mask].max()) if valid_mask.any() else 0.0
    print(f"  Max accumulation across CONUS: {max_inches:.2f}\u2033")

    # NDFD category bins (same approach as MRMS)
    from config import MRMS_CATEGORY_CUTOFFS_INCHES
    cat_bounds: list[tuple[float, float]] = []
    prev = 0.01
    for upper in MRMS_CATEGORY_CUTOFFS_INCHES:
        cat_bounds.append((prev, upper))
        prev = upper
    cat_bounds.append((prev, float("inf")))

    # Use the masked array to keep no-data out of any bin
    data_for_binning = np.where(valid_mask, data_wgs84, -1.0)

    records = []
    for cat, (lo, hi) in enumerate(cat_bounds):
        bin_mask = (data_for_binning >= lo) & (data_for_binning < hi)
        if not bin_mask.any():
            continue
        for geom_json, _ in _raster_shapes(
            bin_mask.astype("uint8"),
            mask=bin_mask,
            transform=transform_wgs84,
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
        empty = gpd.GeoDataFrame(
            columns=["category", "label", "geometry"],
            geometry="geometry",
            crs="EPSG:4326",
        )
        return empty, max_inches

    gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")

    # Clip to WNC bbox
    from shapely.geometry import box as _shapely_box
    bbox_geom = _shapely_box(*WNC_BBOX)
    gdf = gdf[gdf.intersects(bbox_geom)].copy()
    print(f"  {len(gdf)} polygons within WNC bbox")

    return gdf, max_inches



# =============================================================================
# Overture Maps - building footprints (visual reference layer)
# =============================================================================
#
# Static GeoJSON of building footprints for the WNC bbox, extracted from
# Overture Maps Foundation's monthly GeoParquet releases via their official
# Python client. Output schema: id, class, height, geometry. Coverage is
# automatically multi-state (NC + TN + GA + SC + VA wherever they fall inside
# the WNC bbox) because Overture is a global dataset sliced by bbox.
#
# The extraction is SLOW (DuckDB query against Overture's hosted Parquet,
# typically 5-15 min for a WNC-sized bbox), so we cache aggressively. The
# OVERTURE_BUILDINGS_CACHE_TTL_DAYS check below means refresh.py only
# triggers a fresh extract about once a month, while the file feeds the
# frontend on every page load in between.

def _overture_output_dir(output_dir: Path) -> Path:
    """Where the per-county building GeoJSONs and their manifest live.
    A subdirectory under alerts/data/ so buildings-related files stay
    together and don't clutter the top level."""
    return Path(output_dir) / OVERTURE_BUILDINGS_SUBDIR


def _overture_manifest_path(output_dir: Path) -> Path:
    """The manifest file describes all per-county files produced by the
    most recent extraction. The frontend fetches this once to know which
    counties exist and what their bboxes are."""
    return _overture_output_dir(output_dir) / OVERTURE_BUILDINGS_MANIFEST_NAME


def _overture_cache_is_fresh(output_dir: Path) -> bool:
    """Return True if the buildings manifest exists AND is younger than
    OVERTURE_BUILDINGS_CACHE_TTL_DAYS. Skip the extraction in that case.

    The manifest is the authoritative freshness signal - if it exists,
    a full extraction ran to completion (we write the manifest LAST).
    A partial extraction that failed mid-way leaves some county files
    but no manifest, so the next refresh will retry the extraction.
    """
    p = _overture_manifest_path(output_dir)
    if not p.exists():
        return False
    age_days = (datetime.now().timestamp() - p.stat().st_mtime) / 86400
    return age_days < OVERTURE_BUILDINGS_CACHE_TTL_DAYS


def fetch_overture_buildings(
    output_dir: Path,
    force_refresh: bool = False,
) -> gpd.GeoDataFrame | None:
    """Extract Overture building footprints for the WNC bbox, chunk by
    county, and write per-county GeoJSON files + a manifest describing
    them.

    Output structure:
        alerts/data/buildings/
            manifest.json          - lists all counties + their bboxes
            37021.geojson          - Buncombe (NC)
            37199.geojson          - Yancey (NC)
            47155.geojson          - Sevier (TN)
            ...

    The frontend loads manifest.json once, then loads individual county
    files on demand as the user pans/zooms. See alerts/js/map.js
    setBuildingsVisible for the viewport-triggered loading logic.

    Returns the combined GeoDataFrame on success. Returns None if the
    cache was fresh (no extraction needed). Callers can check existence
    of the manifest file on disk instead.

    Args:
        output_dir: parent directory (typically alerts/data). The
            "buildings" subdirectory is created inside it.
        force_refresh: if True, ignore the TTL and re-extract anyway.

    Raises:
        RuntimeError if the `overturemaps` Python client isn't installed.
        Any exception the client raises (network failures, DuckDB errors,
        etc.) propagates up - refresh.py will log it and continue, since
        a missing buildings layer shouldn't break alert generation.
    """
    output_dir = Path(output_dir)
    buildings_dir = _overture_output_dir(output_dir)
    manifest_path = _overture_manifest_path(output_dir)

    if not force_refresh and _overture_cache_is_fresh(output_dir):
        age_days = (datetime.now().timestamp() - manifest_path.stat().st_mtime) / 86400
        print(f"  Buildings cache is fresh ({age_days:.1f} days old, "
              f"TTL {OVERTURE_BUILDINGS_CACHE_TTL_DAYS}d). Skipping extraction.")
        return None

    print(f"  Extracting Overture buildings for bbox {WNC_BBOX}...")
    print(f"  This typically takes 5-15 minutes (DuckDB query against "
          f"Overture's hosted GeoParquet on AWS).")

    # Lazy import: overturemaps + duckdb are heavy dependencies and we
    # only need them when actually extracting. Importing at module load
    # would slow every refresh.py invocation, including the 99% that
    # hit the cache and skip this work.
    try:
        # The top-level `geodataframe` function is the canonical API per
        # Overture's docs and README examples. Internally it uses DuckDB
        # to query Overture's hosted GeoParquet on AWS S3 (bbox-filtered
        # streaming), then returns a GeoPandas GeoDataFrame directly.
        from overturemaps import geodataframe as _overture_geodataframe
    except ImportError as exc:
        raise RuntimeError(
            "The overturemaps Python client is required for the buildings "
            "phase. Install it with: pip install overturemaps"
        ) from exc

    # WNC_BBOX is (minx, miny, maxx, maxy) in WGS84 - same format the
    # overturemaps client expects for its bbox parameter.
    minx, miny, maxx, maxy = WNC_BBOX

    # The 'building' type within the 'buildings' theme is the primary
    # footprints dataset. We do NOT pull 'building_part' here - those
    # are sub-parts (architectural details like wings on a building),
    # not full footprints, and would inflate the file without adding
    # value for a reference layer.
    #
    # The overturemaps client streams Parquet parts from Overture's S3
    # bucket via DuckDB. It has NO built-in retry logic - a transient
    # network hiccup on any single Parquet part ("AWS Error
    # NETWORK_CONNECTION: Response body length doesn't match the
    # content-length header") kills the whole extraction. We wrap the
    # call in a retry-with-backoff loop to survive these.
    print(f"  Querying Overture (theme=buildings, type=building)...")
    import time
    max_attempts = 4
    table = None
    for attempt in range(1, max_attempts + 1):
        try:
            table = _overture_geodataframe(
                "building",
                bbox=(minx, miny, maxx, maxy),
            )
            break
        except (OSError, IOError) as exc:
            # AWS network errors, Parquet read errors - all typically
            # transient. Log, wait, retry.
            if attempt < max_attempts:
                wait_s = 2 ** (attempt - 1)  # 1, 2, 4 seconds
                print(f"  [retry {attempt}/{max_attempts - 1}] Overture "
                      f"extract failed transiently ({type(exc).__name__}). "
                      f"Waiting {wait_s}s before retry...")
                time.sleep(wait_s)
            else:
                print(f"  [failed] Overture extract exhausted "
                      f"{max_attempts} attempts. Last error was:")
                print(f"    {type(exc).__name__}: {str(exc)[:200]}")
                raise
    if table is None:
        raise RuntimeError("Overture extract returned no data after retries")
    n_raw = len(table)
    print(f"  Raw extract: {n_raw:,} buildings.")

    if n_raw == 0:
        print(f"  WARNING: 0 buildings returned. Check Overture release "
              f"availability for this bbox.")
        return table

    # Subset to minimal columns: id + geometry only. Every extra field
    # adds tens of bytes per feature; across ~2M features that's real
    # money in file size for a visual reference layer.
    keep_cols = [c for c in ["id", "geometry"] if c in table.columns]
    if "geometry" not in keep_cols:
        raise RuntimeError("Overture extract has no 'geometry' column; "
                           "cannot produce a spatial output.")
    if "id" not in keep_cols:
        print(f"  Note: 'id' column not in Overture extract - future "
              f"spatial joins will need a different join key.")
    gdf = table[keep_cols].copy()

    # Ensure WGS84 - Overture publishes in 4326 but be defensive
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif str(gdf.crs).upper() not in ("EPSG:4326", "WGS 84"):
        gdf = gdf.to_crs("EPSG:4326")

    # Filter by minimum building area (drops sheds, gazebos, small
    # outbuildings). Uses EPSG:5070 for square-meter area math.
    if OVERTURE_BUILDINGS_MIN_AREA_SQM > 0:
        print(f"  Filtering to buildings >= "
              f"{OVERTURE_BUILDINGS_MIN_AREA_SQM} sq meters...")
        areas_sqm = gdf.geometry.to_crs("EPSG:5070").area
        keep_mask = areas_sqm >= OVERTURE_BUILDINGS_MIN_AREA_SQM
        n_before = len(gdf)
        gdf = gdf[keep_mask].copy()
        n_after = len(gdf)
        pct_dropped = (n_before - n_after) / n_before * 100 if n_before else 0
        print(f"  Filtered: {n_before:,} -> {n_after:,} buildings "
              f"({pct_dropped:.1f}% dropped as too-small).")

    # Simplify geometries for file-size savings.
    print(f"  Simplifying geometries at {OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG} deg "
          f"(~3m) tolerance...")
    gdf["geometry"] = gdf.geometry.simplify(
        tolerance=OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG,
        preserve_topology=True,
    )
    # Drop any rows where simplification produced empty geometries
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()].copy()

    # ---- Spatial-join with counties for chunking -----------------------
    # Fetch counties (same function used by the debris flow augmentation).
    # Returns a GDF with columns NAME, GEOID, STATE across NC + TN + GA +
    # SC + VA. GEOID is the 5-digit state+county FIPS code, unique across
    # states. We use GEOID as the county file basename.
    print(f"  Fetching county boundaries for building spatial join...")
    counties = _fetch_nc_counties()
    if len(counties) == 0:
        raise RuntimeError("County fetch returned 0 records; cannot "
                           "chunk buildings by county.")

    # Reproject counties to 4326 if needed (matches our building CRS)
    if str(counties.crs).upper() not in ("EPSG:4326", "WGS 84"):
        counties = counties.to_crs("EPSG:4326")

    # Spatial join: point-in-polygon test between building centroids
    # and county boundaries. Using centroid rather than intersects
    # because a building might cross a county line at the boundary
    # (rare but happens near rivers etc); centroid gives a definite
    # assignment to exactly one county.
    #
    # We compute centroids in EPSG:5070 (Albers Equal Area CONUS) rather
    # than raw WGS84 because GeoPandas rightly warns that geographic-CRS
    # centroids can be inaccurate. For building-sized polygons the error
    # is negligible in practice, but a correct computation costs almost
    # nothing here and silences the warning.
    print(f"  Spatial-joining {len(gdf):,} buildings to "
          f"{len(counties):,} counties (centroid-in-county)...")
    centroids_projected = gdf.geometry.to_crs("EPSG:5070").centroid
    centroids_gdf = gdf.copy()
    centroids_gdf["geometry"] = centroids_projected.to_crs("EPSG:4326")
    joined = gpd.sjoin(
        centroids_gdf,
        counties[["GEOID", "NAME", "STATE", "geometry"]],
        how="left",
        predicate="within",
    )
    # Attach original polygon geometries back (sjoin used centroids; we
    # want the actual footprints in the output).
    joined["geometry"] = gdf.geometry.values
    # Drop the sjoin's index_right column
    if "index_right" in joined.columns:
        joined = joined.drop(columns=["index_right"])

    # Count buildings that didn't match any county (edge cases: buildings
    # inside WNC bbox but outside all 5 states' county coverage)
    n_orphans = joined["GEOID"].isna().sum()
    n_matched = len(joined) - n_orphans
    if n_orphans > 0:
        print(f"  Note: {n_orphans:,} buildings ({100*n_orphans/len(joined):.1f}%) "
              f"did not match any county - dropping.")
    joined = joined[joined["GEOID"].notna()].copy()

    # ---- Write per-county GeoJSON files --------------------------------
    # Clean out the buildings subdirectory before writing new files -
    # otherwise an old county file from a previous release (e.g. a
    # county boundary that shifted, dropping some buildings) would
    # persist as stale data. Fresh directory = fresh state.
    buildings_dir.mkdir(parents=True, exist_ok=True)
    for old_file in buildings_dir.glob("*.geojson"):
        old_file.unlink()
    if manifest_path.exists():
        manifest_path.unlink()

    print(f"  Writing per-county GeoJSON files to {buildings_dir}...")
    manifest_counties: list[dict] = []
    total_size_mb = 0.0

    for geoid, county_group in joined.groupby("GEOID"):
        # Keep only id + geometry in the output; GEOID/NAME/STATE go
        # into the manifest entry, not the individual features
        county_out = county_group[["id", "geometry"]].copy() \
            if "id" in county_group.columns \
            else county_group[["geometry"]].copy()

        # Compute the bbox in a stable order for manifest storage
        b = county_out.total_bounds  # [minx, miny, maxx, maxy]
        bbox = [round(float(b[0]), 5), round(float(b[1]), 5),
                round(float(b[2]), 5), round(float(b[3]), 5)]

        county_file = buildings_dir / f"{geoid}.geojson"
        county_out.to_file(
            county_file,
            driver="GeoJSON",
            COORDINATE_PRECISION=OVERTURE_BUILDINGS_COORD_PRECISION,
        )
        size_mb = county_file.stat().st_size / (1024 * 1024)
        total_size_mb += size_mb

        # Get county name + state from any row (all rows in group share these)
        first_row = county_group.iloc[0]
        manifest_counties.append({
            "geoid": str(geoid),
            "name":  str(first_row.get("NAME", "")),
            "state": str(first_row.get("STATE", "")),
            "bbox":  bbox,
            "count": int(len(county_out)),
            "file":  f"{OVERTURE_BUILDINGS_SUBDIR}/{geoid}.geojson",
            "size_mb": round(size_mb, 2),
        })

    # Sort manifest for stable ordering (helps diffs and manual inspection)
    manifest_counties.sort(key=lambda c: c["geoid"])

    # ---- Write manifest ------------------------------------------------
    # Manifest is the frontend's index into the per-county files. It's
    # what tells the browser "these are the counties with buildings and
    # here are their bboxes." Small file (~30 counties x ~200 bytes each
    # = ~6 KB total).
    import json
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source":       "Overture Maps Foundation",
        "bbox":         list(WNC_BBOX),
        "simplify_tolerance_deg": OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG,
        "min_area_sqm":          OVERTURE_BUILDINGS_MIN_AREA_SQM,
        "county_count":          len(manifest_counties),
        "total_features":        int(sum(c["count"] for c in manifest_counties)),
        "total_size_mb":         round(total_size_mb, 2),
        "counties":              manifest_counties,
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"  Wrote {len(manifest_counties)} per-county files, "
          f"total {total_size_mb:.1f} MB "
          f"({n_matched:,} buildings). Avg "
          f"{total_size_mb / max(len(manifest_counties), 1):.1f} MB per county.")
    print(f"  Manifest: {manifest_path.name} "
          f"(loaded first by the frontend to know which counties exist).")

    return joined
