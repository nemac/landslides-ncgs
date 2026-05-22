# DEFNS Alerts data pipeline

Python scripts that produce the live data files served by the
`/alerts/` dashboard.

## Files

```
scripts/
  refresh.py          Driver: fetches NDFD + MRMS, writes JSON to alerts/data/
  data.py             Data fetchers (copied from wnc_alert project)
  config.py           Constants (URLs, bbox, product fallback order)
  requirements.txt    Python package dependencies
  README.md           This file
```

## Phase 3a: manual refresh (current)

You run this on your own machine when you want to update the live data
files for the dashboard. The frontend reads
`alerts/data/forecast.geojson` and `alerts/data/observed.geojson` on page
load.

### Setup (one time)

Reuse the existing EWS conda environment from the wnc_alert project. All
the dependencies are already installed there — `geopandas`, `rasterio`,
`libgdal-grib`, `requests`.

If for some reason you want a fresh environment dedicated to this script:

```bash
conda create -n defns-refresh -c conda-forge \
    python=3.11 geopandas rasterio libgdal-grib requests
conda activate defns-refresh
```

### Run it

From the repository root (`landslidesncgs.com/`):

```bash
conda activate EWS
python scripts/refresh.py
```

Expected output:

```
[defns-refresh] Output directory: .../landslidesncgs.com/alerts/data
[defns-refresh] Started at:       2026-05-22T14:30:00+00:00

[defns-refresh] === NDFD forecast ===
  Fetched 247 NDFD polygons across all categories.
  Clipped to WNC bbox: 14 polygons remain.
  Wrote forecast.geojson: 42.3 KB

[defns-refresh] === MRMS observed ===
  Fetched 8 MRMS polygons from MultiSensor Pass1.
  Valid time:  2026-05-22T14:00:00+00:00
  Max inches:  0.342
  Minutes ago: 32.4
  Wrote observed.geojson: 6.1 KB

[defns-refresh] DONE - both files written.
```

After running, refresh the dashboard in your browser and you'll see live
data instead of the mock fallback.

### What if it fails?

- **NDFD fetch fails but MRMS succeeds (or vice versa):** the script
  writes the file that worked and reports a partial success. The
  frontend gracefully falls back to mock data for the missing source.
- **Both fail:** no files are written. Frontend uses mock data for both.
- **`gdal_GRIB.dll is not available`:** MRMS specific, install the GDAL
  GRIB plugin: `conda install -c conda-forge libgdal-grib`.

## Phase 3b: automated cron (next)

Once the team confirms the GitHub→AWS S3 deploy story, this same
`refresh.py` becomes the body of a GitHub Actions workflow that runs
every 15 minutes and commits any data changes back to the repo. No code
changes to `refresh.py` will be needed.
