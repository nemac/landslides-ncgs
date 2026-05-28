"""
Spatial analysis for the WNC Debris Flow Early Warning Dashboard.

Identifies debris flow polygons that intersect the precipitation forecast
polygons (which have already been filtered to >= threshold upstream), and
computes summary statistics used to populate the dashboard widgets.
"""

from __future__ import annotations

import geopandas as gpd

from config import INTERSECTION_CRS, DISPLAY_CRS


def find_alerts(
    debris_gdf: gpd.GeoDataFrame,
    precip_gdf: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Return debris flow polygons that fall inside any precipitation polygon.

    A debris flow can sit beneath multiple precip bins (a polygon overlapping
    two contour rings). When that happens we keep the worst-case bin (the
    highest `category`) so the alert reflects the most severe forecast.

    Parameters
    ----------
    debris_gdf : GeoDataFrame
        Debris flow susceptibility polygons (WGS84).
    precip_gdf : GeoDataFrame
        Precipitation polygons already filtered to >= threshold (WGS84).

    Returns
    -------
    GeoDataFrame in WGS84 with columns:
        OBJECTID, category, label, area_acres, geometry
    """
    empty = gpd.GeoDataFrame(
        {"OBJECTID": [], "category": [], "label": [], "area_acres": []},
        geometry=[],
        crs=DISPLAY_CRS,
    )
    if debris_gdf.empty or precip_gdf.empty:
        return empty

    # Project both to an equal-area CRS for valid overlay + area math.
    # Conus Albers (EPSG:5070) is in meters.
    debris_proj = debris_gdf.to_crs(INTERSECTION_CRS)
    precip_proj = precip_gdf.to_crs(INTERSECTION_CRS)

    # Spatial join: for each debris flow polygon, find every intersecting
    # precip polygon. A single debris flow may match multiple precip cats.
    joined = gpd.sjoin(
        debris_proj,
        precip_proj[["category", "label", "geometry"]],
        how="inner",
        predicate="intersects",
    )

    if joined.empty:
        return empty

    # Keep the highest (worst) category per debris flow polygon.
    joined = joined.sort_values("category", ascending=False)
    deduped = joined.drop_duplicates(subset="OBJECTID", keep="first").copy()

    # Area in acres (1 sq meter = 0.000247105 acres).
    deduped["area_acres"] = deduped.geometry.area * 0.000247105

    # Drop sjoin's bookkeeping columns and project back to WGS84 for display.
    deduped = deduped.drop(
        columns=[c for c in deduped.columns if c.startswith("index_right")]
    )
    deduped = deduped.to_crs(DISPLAY_CRS)

    return deduped[[
        "OBJECTID", "category", "label", "area_acres",
        # Optional admin columns: include if present on the debris flow GDF.
        # _augment_with_admin_boundaries adds these in data.py; preserving
        # them here lets the frontend display county + watershed per row.
        *[c for c in ("county", "watershed") if c in deduped.columns],
        "geometry"
    ]]


def summarize_alerts(alerts_gdf: gpd.GeoDataFrame) -> dict:
    """Build a small dict of stats for the dashboard info panel.

    Keys:
        alert_count          : int, number of impacted debris flow polygons
        total_area_acres     : float, sum of their areas
        max_category         : int or None, worst forecast category
        max_label            : str or None, label of worst category
        category_breakdown   : list of {category, label, count} dicts,
                               sorted from worst to least severe
    """
    if alerts_gdf.empty:
        return {
            "alert_count": 0,
            "total_area_acres": 0.0,
            "max_category": None,
            "max_label": None,
            "category_breakdown": [],
        }

    breakdown_df = (
        alerts_gdf.groupby(["category", "label"])
        .size()
        .reset_index(name="n")
        .sort_values("category", ascending=False)
    )

    sorted_by_cat = alerts_gdf.sort_values("category", ascending=False)
    return {
        "alert_count": int(len(alerts_gdf)),
        "total_area_acres": float(alerts_gdf["area_acres"].sum()),
        "max_category": int(alerts_gdf["category"].max()),
        "max_label": str(sorted_by_cat["label"].iloc[0]),
        "category_breakdown": [
            {
                "category": int(row.category),
                "label": str(row.label),
                "count": int(row.n),
            }
            for _, row in breakdown_df.iterrows()
        ],
    }
