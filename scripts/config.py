"""
Configuration for the alerts pipeline (scripts/) and the parts of it that
DFENS Simple (simple/pipeline/) imports.

Every constant here is read by code; the unused ones were removed on
2026-10-27. simple/pipeline/settings.py repeats the values the Simple page
also needs, and simple/pipeline/test_config_sync.py asserts the two files
and simple/js/config.js agree.
"""

# -----------------------------------------------------------------------------
# Data services
# -----------------------------------------------------------------------------

# NC Geological Survey channelized debris flow susceptibility model (WNC).
# This is your debris flow polygon source. Coverage = Western NC only.
DEBRIS_FLOW_SERVICE_URL = (
    "https://services1.arcgis.com/PwLrOgCfU0cYShcG/arcgis/rest/services/"
    "CDF_Landslides_Model/FeatureServer/0"
)

# NWS NDFD Precipitation forecast, "Accumulation by Time" layer.
# Each feature is a polygon binned by accumulated rainfall, time-enabled.
# fromdate = forecast issuance, todate = end of accumulation window.
NDFD_PRECIP_SERVICE_URL = (
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/"
    "NDFD_Precipitation_v1/FeatureServer/1"
)


# -----------------------------------------------------------------------------
# Geographic scope
# -----------------------------------------------------------------------------
# The one WNC bounding box (west, south, east, north, WGS84) used for every
# service query, raster clip and spatial filter. Slightly larger than the
# debris-flow extent so polygons at the edges are kept. The same values are
# in simple/pipeline/settings.py; the sync test keeps them equal. (Until
# 2026-10-27 a second box with a -80.8 east edge existed but was unused.)
WNC_BBOX = (-84.5, 34.8, -81.0, 36.7)


# -----------------------------------------------------------------------------
# CRS
# -----------------------------------------------------------------------------
# Display CRS for the web map (WGS84).
DISPLAY_CRS = "EPSG:4326"

# CRS used for the spatial intersection. NAD83 / Conus Albers Equal Area is
# a good choice across the CONUS for area-preserving overlay math.
INTERSECTION_CRS = "EPSG:5070"


# -----------------------------------------------------------------------------
# Caching
# -----------------------------------------------------------------------------
# The NCGS debris flow layer has ~228k polygons and changes infrequently
# (it's a regional susceptibility model, not a live feed). Fetching it on
# every run is wasteful, so we cache it locally as a GeoPackage.
#
# Since 2026-10-27 the cache is rebuilt by refresh-reference.yml when the
# NCGS layer's edit date moves, or after 90 days regardless, and shared
# through S3 (see scripts/reference_check.py). The TTL here is only a
# backstop for a stale local copy and is kept longer than that floor so it
# never pre-empts the change detection. Set CACHE_TTL_DAYS = 0 to disable
# caching, or pass force_refresh=True to fetch_debris_flows().
CACHE_DIR = "cache"
DEBRIS_CACHE_FILENAME = "debris_flows.gpkg"
CACHE_TTL_DAYS = 120


# -----------------------------------------------------------------------------
# Overture Maps - building footprints
# -----------------------------------------------------------------------------
# Reference layer on the dashboard: when the user toggles "Building footprints"
# on, the browser fetches a static GeoJSON of all buildings in the WNC bbox.
# Source data comes from Overture Maps Foundation via their official Python
# client, which queries Overture's hosted GeoParquet files on AWS using DuckDB
# under the hood. We extract once and cache the resulting GeoJSON locally.
#
# Multi-state coverage is automatic: Overture is global, so a bbox extract
# captures NC + TN + GA + SC + VA wherever they fall inside the WNC bbox.
# Same bbox semantics as our county / watershed pipelines.
#
# Update cadence: monthly. Overture publishes releases monthly, and building
# stock turnover is glacial compared to weather data. The freshness check
# below means the slow extraction (5-15 min) only runs ~once per month even
# though refresh.py itself runs every ~15 min for weather data.
#
# Output schema per county file: id, geometry. ID is Overture's GERS UUID
# (stable across releases, useful for future spatial joins with flagged
# debris flows). We drop the other Overture attributes (class, height,
# sources, etc.) for size - none are used by the frontend and each adds
# tens of bytes per feature.
#
# ARCHITECTURE NOTE (2026-07-14): switched from single-file output to
# per-county chunked output. A single WNC-wide GeoJSON was ~800 MB
# (2.88M buildings) which browsers couldn't load reliably. Chunked
# per-county means the frontend loads only counties in the current
# viewport, at higher zoom levels. Each county file is ~1-15 MB;
# frontend caches up to 20 counties at a time (LRU eviction).
OVERTURE_BUILDINGS_SUBDIR = "buildings"  # subdirectory under alerts/data
OVERTURE_BUILDINGS_MANIFEST_NAME = "manifest.json"  # inside that subdir
# Geometry simplification tolerance in degrees. Set to 0 (2026-07-22) to
# preserve full source-fidelity building shapes. Coordinate precision below
# still snaps vertices to a ~1.1m grid on write, which acts as a mild
# implicit simplification without dropping vertices the way Douglas-Peucker
# would. Rural WNC buildings look unchanged (Microsoft's ML pipeline
# already regularizes them upstream); urban/OSM-mapped buildings gain back
# the bay windows, angled porches, and courtyard detail our old 3m
# simplification was smoothing away.
OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG = 0.0
# Coordinate decimal precision. 5 decimals ~= 1.1 m at the equator - still
# well within visual accuracy for building footprints (buildings are
# multiple meters across; sub-meter geometry precision is invisible on
# any real-world map).
OVERTURE_BUILDINGS_COORD_PRECISION = 5
# Minimum building footprint area in square meters. Overture's "buildings"
# dataset includes every structure - sheds, gazebos, garages, small
# outbuildings, etc. For a reference layer, filtering out anything below
# ~20 sq meters (roughly a garden shed) drops noise without losing any
# building we'd care about (residential minimum is ~90 sq m / 1000 sq ft).
# Set to 0 to disable this filter.
OVERTURE_BUILDINGS_MIN_AREA_SQM = 20.0


# -----------------------------------------------------------------------------
# MRMS (Multi-Radar Multi-Sensor) - alternative real-time alert source
# -----------------------------------------------------------------------------
# When the user picks "Current radar (MRMS)" detection mode, we fetch the most
# recent 1-hour QPE (Quantitative Precipitation Estimate) from MRMS - this is
# radar+gauge calibrated rainfall accumulation, not just instantaneous
# reflectivity. Polygonize it and intersect with debris flows the same way
# we do with the NDFD forecast.
#
# Source: Iowa Environmental Mesonet archive of NCEP MRMS products.
# Files release every hour on the hour with ~30 min lag.
#
# Product: MultiSensor_QPE_01H_Pass2 (the most accurate 1-hour product).

# MRMS supports pre-summed accumulation windows of 1, 3, 6, 12, 24, 48, 72
# hours per the NSSL spec. We use [1, 24, 72] - the subset that IEM
# actually archives. Empirically verified 2026-05-28: IEM returns 404s
# for 12H and 48H products at any hour (their archive keeps a "limited
# assortment" per their schema docs). If we ever need 12H or 48H, we
# can compute them by summing N consecutive 01H files, like Stage IV
# does for the multi-day hindcast accumulations.
MRMS_HOUR_WINDOWS = [1, 24, 72]


def _mrms_url_template(product_name: str) -> str:
    """Construct the IEM archive URL template for an MRMS product. The
    template still has {Y}/{M}/{D}/{H} placeholders for the caller to fill."""
    return (
        "https://mtarchive.geol.iastate.edu/"
        "{Y:04d}/{M:02d}/{D:02d}/mrms/ncep/"
        + product_name
        + "/"
        + product_name
        + "_00.00_{Y:04d}{M:02d}{D:02d}-{H:02d}0000.grib2.gz"
    )


# Auto-generated MRMS URL templates for every supported (window x variant)
# combination. Variants: MultiSensor Pass1 (~5-10 min lag, primary),
# RadarOnly (~2-3 min lag, fast fallback), MultiSensor Pass2 (~60-75 min
# lag, most accurate but stale).
#
# Resulting keys look like "MultiSensor_QPE_24H_Pass1", "RadarOnly_QPE_72H",
# etc - exactly matching the NSSL product naming used by IEM's directory
# structure.
MRMS_URL_TEMPLATES = {}
for _hours in MRMS_HOUR_WINDOWS:
    for _variant_fmt in (
        "MultiSensor_QPE_{H:02d}H_Pass1",
        "RadarOnly_QPE_{H:02d}H",
        "MultiSensor_QPE_{H:02d}H_Pass2",
    ):
        _product_name = _variant_fmt.format(H=_hours)
        MRMS_URL_TEMPLATES[_product_name] = _mrms_url_template(_product_name)


def mrms_product_fallback_for_hours(hours: int) -> list[dict]:
    """Pass1 -> RadarOnly -> Pass2 fallback chain for a given accumulation
    window. The lookback minutes describe when each variant typically
    becomes available after the hour mark; the fetcher uses these to
    compute the most recent valid timestamp likely to have a file."""
    return [
        {
            "name": f"MultiSensor_QPE_{hours:02d}H_Pass1",
            "lookback_minutes": 15,
            "display": f"MultiSensor Pass1 ({hours}H)",
        },
        {
            "name": f"RadarOnly_QPE_{hours:02d}H",
            "lookback_minutes": 10,
            "display": f"RadarOnly ({hours}H)",
        },
        {
            "name": f"MultiSensor_QPE_{hours:02d}H_Pass2",
            "lookback_minutes": 75,
            "display": f"MultiSensor Pass2 ({hours}H)",
        },
    ]


# NDFD bins rainfall into integer categories, each a range of accumulated
# inches:
#
#     cat   range          cat   range
#     ---   ----------     ---   ----------
#      0    .01 - .10"      10    4 - 5"
#      1    .10 - .25"      11    5 - 6"     <-- DFENS Simple threshold (>= 5 in)
#      2    .25 - .50"      12    6 - 8"
#      3    .50 - .75"      13    8 - 10"
#      4    .75 - 1"        14    10 - 12"
#      5    1 - 1.50"       15    12 - 14"
#      6    1.50 - 2"       16    14 - 16"
#      7    2 - 2.50"       17    16 - 18"
#      8    2.50 - 3"       18    18 - 20"
#      9    3 - 4"          19    > 20"
#
# MRMS gives continuous mm per pixel; it is binned into the same categories
# so one colour ramp and label table serve both. These are the upper-bound
# inches of each category: cutoff[n] is the top of category n and the
# bottom of category n + 1.
MRMS_CATEGORY_CUTOFFS_INCHES = [
    0.10,
    0.25,
    0.50,
    0.75,
    1.00,
    1.50,
    2.00,
    2.50,
    3.00,
    4.00,
    5.00,
    6.00,
    8.00,
    10.00,
    12.00,
    14.00,
    16.00,
    18.00,
    20.00,
]


# -----------------------------------------------------------------------------
# Static dashboard output tuning  (Phase B)
# -----------------------------------------------------------------------------
# These knobs control the size of the flagged_*.geojson files that ship to
# the browser. They trade fidelity for file size; all are safe to adjust.

# Minimum precipitation category to ship in flagged_*.geojson. Debris flow
# polygons whose max intersecting precipitation category is BELOW this value
# are dropped at build time.
#
#   0  = include trace precipitation (.01-.10"), biggest files
#  11  = only 5"+ rainfall, smallest files
#
# Decision 2026-10-27: left at 0. These files feed only the SIREN alerts
# dashboard, offline since 2026-10-22, and the pipeline no longer runs on a
# schedule, so file size no longer matters. DFENS Simple has its own
# threshold (simple/pipeline/settings.py THRESHOLD_CATEGORY) and is not
# affected by this value.
FLAGGED_MIN_CATEGORY = 0

# Simplification tolerance in meters for debris flow geometries.
# Uses Douglas-Peucker simplification in the EPSG:5070 (meters) projection,
# then reprojects to EPSG:4326 for output. Set to None to disable.
#
#   None  = no simplification (raw NCGS geometries; biggest files)
#    5    = 5m tolerance, near-invisible at all reasonable zooms
#   10    = 10m tolerance, invisible at WNC overview (zoom 8-11)
#   25    = 25m tolerance, slightly chunky at street-level zoom
FLAGGED_SIMPLIFY_METERS = 10

# Number of decimal places for coordinates in output GeoJSON. Six decimal
# places = ~11 cm precision at this latitude, more than enough for our
# polygon visualization. Each decimal place dropped saves ~7% file size.
#
#   15  = Python default; sub-nanometer precision (wasteful)
#    6  = ~11 cm precision  <-- good default
#    5  = ~1.1 m precision  (only if you need every byte)
FLAGGED_COORD_PRECISION = 6
