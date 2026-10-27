"""
settings.py - the fixed DFENS Simple configuration, shared by
ndfd_check.py (stdlib only) and refresh_simple.py (geopandas).
Keep in sync with js/config.js (WINDOW_HOURS, THRESHOLD_CATEGORY).
"""

from datetime import datetime, timedelta

WINDOW_HOURS = 24
THRESHOLD_CATEGORY = 11  # NDFD cat 11 = 5.00-6.00 in; ">= 5 inches"

NDFD_LAYER_URL = (
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/"
    "NDFD_Precipitation_v1/FeatureServer/1"
)
WNC_BBOX = (-84.5, 34.8, -81.0, 36.7)  # west, south, east, north

FLAGGED_FILENAME = "flagged_ndfd_24h_min11.geojson"
FORECAST_FILENAME = "forecast_24h.geojson"  # all categories, for the map layer

# Bump when the set or format of output files changes. A published
# status.json with a different version forces a rebuild even if NDFD
# itself hasn't changed (v2 added forecast_24h.geojson).
PIPELINE_VERSION = 2

# Where the page (and the change check) read the last published status.
PUBLIC_STATUS_URL = "https://landslidesncgs.org/simple/data/status.json"


def check_interval_minutes() -> float:
    """How often checks run, written into status.json so the page can show
    "next check in N min". Set by refresh-simple.yml / run_local.py."""
    import os

    try:
        return float(os.environ.get("CHECK_INTERVAL_MINUTES", "10"))
    except ValueError:
        return 10.0


# Output geometry tuning (same values as the main pipeline).
SIMPLIFY_METERS = 10
COORD_PRECISION = 6


def period_where(cycle_start: datetime, window_hours: int, min_category: int) -> str:
    """WHERE clause selecting the single 6-h period ending at
    cycle_start + window_hours. The "Accumulation by Time" layer is
    cumulative from the cycle start, so that period IS the N-hour total.
    The service stores fromdates 1 s past the boundary, so match +/- 1 min.
    """
    period_start = cycle_start + timedelta(hours=window_hours - 6)
    lo = period_start - timedelta(minutes=1)
    hi = period_start + timedelta(minutes=1)
    return (
        f"fromdate >= timestamp '{lo:%Y-%m-%d %H:%M:%S}' "
        f"AND fromdate <= timestamp '{hi:%Y-%m-%d %H:%M:%S}' "
        f"AND category >= {min_category}"
    )
