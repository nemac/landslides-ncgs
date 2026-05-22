"""
Configuration for the WNC Debris Flow Early Warning Dashboard.

All knobs the operator needs to touch live here. Application logic should
not need editing for routine changes (threshold, window, output path, etc.).
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
# Alert threshold  (the main testing knob)
# -----------------------------------------------------------------------------
#
# The NDFD service bins rainfall into integer categories. Each category
# corresponds to a range of accumulated inches:
#
#     cat   range          cat   range
#     ---   ----------     ---   ----------
#      0    .01 - .10"      10    4 - 5"
#      1    .10 - .25"      11    5 - 6"     <-- PRODUCTION (>= 5 in)
#      2    .25 - .50"      12    6 - 8"
#      3    .50 - .75"      13    8 - 10"
#      4    .75 - 1"        14    10 - 12"
#      5    1 - 1.50"       15    12 - 14"
#      6    1.50 - 2"       16    14 - 16"
#      7    2 - 2.50"       17    16 - 18"
#      8    2.50 - 3"       18    18 - 20"
#      9    3 - 4"          19    > 20"
#
# Setting this to N means "alert on any forecast polygon with category >= N",
# i.e. any cell forecast to receive at least the lower bound of cat N.
#
# For TESTING during a dry period, use a low value so the pipeline produces
# results to inspect. Once you've verified everything looks right, raise to 11.
#
PRECIP_THRESHOLD_CATEGORY = 1   # >>> CHANGE TO 11 FOR PRODUCTION <<<


# -----------------------------------------------------------------------------
# Forecast window
# -----------------------------------------------------------------------------
# How many hours past the forecast issuance to look at the accumulation.
# NDFD has native 6-hour intervals, so this must be a positive multiple of 6.
# Your operational spec was 12 hours.
FORECAST_WINDOW_HOURS = 12


# -----------------------------------------------------------------------------
# Geographic scope
# -----------------------------------------------------------------------------
# Bounding box (WGS84) used for the spatial intersection only. The NDFD
# forecast layer is now fetched CONUS-wide for display purposes (so you can
# see what's happening in, e.g., Florida) - debris flow polygons are still
# WNC-only, so alerts naturally stay scoped to Western NC.
WNC_BBOX_WGS84 = {
    "xmin": -84.5,
    "ymin": 34.8,
    "xmax": -80.8,
    "ymax": 36.7,
}

# Map center / initial zoom for the Folium output. Asheville, NC.
MAP_CENTER = (35.6, -82.55)
MAP_ZOOM = 8


# -----------------------------------------------------------------------------
# Optional external debris flow tile service (reference layer)
# -----------------------------------------------------------------------------
# When set, the dashboard adds a server-rendered tile layer showing the FULL
# NCGS debris flow model as a reference overlay - separate from the
# FeatureServer used for the alert intersection. Use this once you have
# published a vector tile or rasterized tile service of the debris flows.
#
# Two patterns supported:
#   - Raster XYZ tiles (e.g. ArcGIS hosted tile cache, MapServer cache,
#     PostGIS/MapServer/MVT pipeline rendered to PNG)
#   - Vector tiles via Mapbox Vector Tile (MVT) protocol
#
# Leave at None to fall back to the random-sampled subset rendered from
# the FeatureServer (the "All debris flow zones (sampled)" sidebar toggle).
DEBRIS_CONTEXT_TILE_URL = None  # e.g. "https://yourtileservice.com/{z}/{x}/{y}.png"
DEBRIS_CONTEXT_TILE_ATTRIBUTION = "NC Geological Survey debris flow model"
DEBRIS_CONTEXT_TILE_OPACITY = 0.55       # 0.0 = invisible, 1.0 = fully opaque
DEBRIS_CONTEXT_TILE_MIN_ZOOM = 6
DEBRIS_CONTEXT_TILE_MAX_ZOOM = 18


# -----------------------------------------------------------------------------
# Live radar layer (NEXRAD reflectivity)
# -----------------------------------------------------------------------------
# Iowa Environmental Mesonet redistributes NOAA NEXRAD as XYZ map tiles,
# updated every ~5 minutes. This is a *current observed* radar product,
# distinct from the NDFD precipitation *forecast*. The dashboard offers
# both as toggleable layers in the layer control.
# NEXRAD current reflectivity from Iowa Environmental Mesonet's tile service.
# Per IEM docs (https://mesonet.agron.iastate.edu/ogc/), the NEXRAD mosaics
# are ONLY at the /cache/ endpoint (NOT /c/), and the current layer name is
# "nexrad-n0q" - the older "nexrad-n0q-900913" name was deprecated and now
# returns "Layer nexrad-n0q not found".
NEXRAD_TILES_URL = (
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/"
    "nexrad-n0q/{z}/{x}/{y}.png"
)
NEXRAD_ATTRIBUTION = "NOAA NEXRAD via Iowa Environmental Mesonet"


# -----------------------------------------------------------------------------
# Debris flow reference tile layer (optional)
# -----------------------------------------------------------------------------
# A separate, lightweight reference layer for "all debris flow zones in WNC".
# The full NCGS FeatureServer has ~228k features and can't be rendered as
# vector geometry in a browser; a tile service is the right way to provide
# regional context without that cost.
#
# Fill in the URL once you've published the tile service. Until then,
# leave as None - the sidebar will surface this as a disabled checkbox
# with a note explaining it's not configured yet.
#
# Expected format: XYZ tile URL pattern with {z}/{x}/{y} placeholders.
# Examples:
#   ArcGIS Online cached tile service:
#     https://tiles.arcgis.com/tiles/<orgid>/arcgis/rest/services/<name>/MapServer/tile/{z}/{y}/{x}
#   (note: ArcGIS uses /{z}/{y}/{x}, while OSM/Folium expect /{z}/{x}/{y};
#    folium handles either order via its tms parameter if needed)
#
# NCGS FeatureServer continues to be the authoritative source for alert
# computation. This reference layer is for visual context only.
DEBRIS_CONTEXT_TILE_URL: str | None = None
DEBRIS_CONTEXT_TILE_ATTRIBUTION = "NC Geological Survey debris flow model"
DEBRIS_CONTEXT_TILE_OPACITY = 0.55
DEBRIS_CONTEXT_TILE_MIN_ZOOM = 6
DEBRIS_CONTEXT_TILE_MAX_ZOOM = 16


# -----------------------------------------------------------------------------
# NCGS FeatureServer as a *dynamic* reference layer (via esri-leaflet)
# -----------------------------------------------------------------------------
# The same NCGS FeatureServer we use for alert computation can also be added
# to the map as a reference overlay, rendered dynamically via esri-leaflet.
# Unlike embedding 228k polygons as static GeoJSON (which crashes browsers),
# esri-leaflet fetches only features in the current map view as you pan/zoom,
# so the dataset stays light on the wire even though it's huge in total.
#
# Because this points at the same authoritative NCGS source, any update they
# publish flows through automatically - no separate tile service to maintain.
# NCGS FeatureServer URL: DEBRIS_FLOW_SERVICE_URL already ends in /0
# (the layer index within the service), so the reference layer points at
# the same URL.
NCGS_REFERENCE_LAYER_URL = DEBRIS_FLOW_SERVICE_URL
NCGS_REFERENCE_LAYER_ATTRIBUTION = "NC Geological Survey debris flow model"


# -----------------------------------------------------------------------------
# CRS
# -----------------------------------------------------------------------------
# Display CRS for the web map. Folium expects WGS84.
DISPLAY_CRS = "EPSG:4326"

# CRS used for the spatial intersection. NAD83 / Conus Albers Equal Area is
# a good choice across the CONUS for area-preserving overlay math.
INTERSECTION_CRS = "EPSG:5070"


# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
OUTPUT_DIR = "output"
MAP_FILENAME = "debris_flow_alert_map.html"


# -----------------------------------------------------------------------------
# Caching
# -----------------------------------------------------------------------------
# The NCGS debris flow layer has ~228k polygons and changes infrequently
# (it's a regional susceptibility model, not a live feed). Fetching it on
# every run is wasteful, so we cache it locally as a GeoPackage.
#
# Set CACHE_TTL_DAYS = 0 to disable caching (every run re-fetches), or pass
# force_refresh=True to fetch_debris_flows() when you want to bust the cache
# manually (e.g., after NCGS publishes a new model release).
CACHE_DIR = "cache"
DEBRIS_CACHE_FILENAME = "debris_flows.gpkg"
CACHE_TTL_DAYS = 30


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

MRMS_URL_TEMPLATES = {
    # MultiSensor Pass1: radar + rain gauge bias correction. Published
    # ~5-10 minutes after the hour. Good balance of recency and accuracy.
    # This is the primary product for real-time alert detection.
    "MultiSensor_QPE_01H_Pass1": (
        "https://mtarchive.geol.iastate.edu/"
        "{Y:04d}/{M:02d}/{D:02d}/mrms/ncep/MultiSensor_QPE_01H_Pass1/"
        "MultiSensor_QPE_01H_Pass1_00.00_{Y:04d}{M:02d}{D:02d}-{H:02d}0000.grib2.gz"
    ),
    # RadarOnly: pure radar QPE, no gauge correction. Published ~2-3 min
    # after the hour. Fast fallback if Pass1 isn't yet available.
    "RadarOnly_QPE_01H": (
        "https://mtarchive.geol.iastate.edu/"
        "{Y:04d}/{M:02d}/{D:02d}/mrms/ncep/RadarOnly_QPE_01H/"
        "RadarOnly_QPE_01H_00.00_{Y:04d}{M:02d}{D:02d}-{H:02d}0000.grib2.gz"
    ),
    # MultiSensor Pass2: radar + comprehensive gauge correction. Published
    # ~60-75 minutes after the hour. Most accurate but most delayed - use
    # only for retrospective analysis. Last fallback in real-time mode.
    "MultiSensor_QPE_01H_Pass2": (
        "https://mtarchive.geol.iastate.edu/"
        "{Y:04d}/{M:02d}/{D:02d}/mrms/ncep/MultiSensor_QPE_01H_Pass2/"
        "MultiSensor_QPE_01H_Pass2_00.00_{Y:04d}{M:02d}{D:02d}-{H:02d}0000.grib2.gz"
    ),
}

# Order of products to try. We start with the fastest (Pass1), fall back to
# RadarOnly if Pass1 isn't yet available, then Pass2 as a last resort. The
# "lookback_minutes" tells the fetcher how many minutes after the hour we
# can expect this product's file to be available - we use that to compute
# the most recent valid-time target.
MRMS_PRODUCT_FALLBACK = [
    {"name": "MultiSensor_QPE_01H_Pass1", "lookback_minutes": 15,
     "display": "MultiSensor Pass1"},
    {"name": "RadarOnly_QPE_01H", "lookback_minutes": 10,
     "display": "RadarOnly"},
    {"name": "MultiSensor_QPE_01H_Pass2", "lookback_minutes": 75,
     "display": "MultiSensor Pass2"},
]

# Kept for backward compatibility (old URL template constant). Points to Pass1.
MRMS_URL_TEMPLATE = MRMS_URL_TEMPLATES["MultiSensor_QPE_01H_Pass1"]
MRMS_ATTRIBUTION = "NOAA MRMS via Iowa Environmental Mesonet"

# MRMS uses continuous mm values per pixel. We bin them into NDFD-compatible
# category indices so the existing color ramp, legend, and threshold UI all
# work without parallel infrastructure. These are the upper-bound inches for
# each category (matches NDFD bins).
MRMS_CATEGORY_CUTOFFS_INCHES = [
    0.10, 0.25, 0.50, 0.75, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00,
    5.00, 6.00, 8.00, 10.00, 12.00, 14.00, 16.00, 18.00, 20.00,
]

# Default MRMS threshold (NDFD category index). 5 corresponds to >= 1.5",
# matching NWS flash flood guidance for steep WNC terrain at 1-hour accums.
MRMS_DEFAULT_THRESHOLD_CATEGORY = 5

# Cache TTL: MRMS releases hourly, but we re-check more often in case a
# delayed file becomes available. 10 minutes is a reasonable balance.
MRMS_CACHE_TTL_SECONDS = 600

# WNC bounding box (lonmin, latmin, lonmax, latmax) for clipping MRMS rasters.
# Slightly larger than the debris flow extent so we catch polygons at edges.
WNC_BBOX = (-84.5, 34.8, -81.0, 36.7)
