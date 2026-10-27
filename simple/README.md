# DFENS Simple

A simplified variant of the DFENS dashboard for emergency responders. It
began as an A/B usability test against the full dashboard under `alerts/`;
since 2026-10-22 it is the only dashboard users see. It lives in this repo
under `simple/` and is served at <https://dashboard.landslidesncgs.org/>
(the CloudFront function maps that host onto `/simple/`) and at
<https://landslidesncgs.org/simple/>.

Originally developed in github.com/ijohnson37/dfens-simple.

## One fixed view

| Setting   | Value                                            |
|-----------|--------------------------------------------------|
| Source    | NWS NDFD precipitation forecast                  |
| Window    | 24-hour rain total                               |
| Threshold | 5.00 inches or more (NDFD category 11)           |

The page has no mode, window or threshold controls. These values are set in
`simple/js/config.js` and `simple/pipeline/settings.py`; keep the two files
in sync.

The page keeps the map (basemap selector and address search), the flagged
pathways table (click a row to zoom, CSV download), and seven layer toggles:

- NDFD forecast precipitation (the 24-hour window, live from the service)
- MRMS observed precipitation, past 24 hours (Iowa Mesonet tiles, reference only)
- NEXRAD radar, current (reference only)
- Flagged debris flow pathways (from this pipeline)
- Potential channelized debris flow pathways (NCGS AGOL, live)
- NC Parcels (NC OneMap, live, zoom 14+, clickable)
- Building footprints (produced by the nightly pipeline, read from
  `../alerts/data/` on the same origin)

## Data pipeline: its own, every 10 minutes

The main dashboard's pipeline (`scripts/refresh.py`, `refresh-data.yml`)
runs nightly. It produces 7 flagged files plus MRMS and buildings, and
uploads them to the data bucket. It is too heavy to keep up with NDFD, which updates
about hourly. The simple page therefore has its own lean pipeline that
produces only the files this page needs and uploads them straight to S3.
Nothing under `simple/data/` is committed to git.

```
.github/workflows/refresh-simple.yml   (cron: every 10 min)
  simple/pipeline/ndfd_check.py        stdlib only, ~5 s
      NDFD unchanged since last status.json?  -> skip (re-upload status only)
      otherwise                                -> build
  simple/pipeline/refresh_simple.py    geopandas, only on "build"
      fetch all categories for the 24 h period, clip to WNC -> forecast_24h.geojson
      any >= 5" polygons? load debris flows (cache/debris_flows.gpkg,
      actions/cache monthly), bbox prefilter, find_alerts() on candidates
  -> s3://landslidesncgs-data/simple/data/
        forecast_24h.geojson             (map layer, Cache-Control max-age=60)
        flagged_ndfd_24h_min11.geojson   (max-age=60)
        status.json                      (max-age=30, rewritten every run)
```

The pipeline imports `scripts/data.py`, `scripts/analysis.py` and
`scripts/config.py` directly (the debris-flow fetch with county and
watershed tagging, and the intersection), so results match the full
dashboard. The debris-flow cache (`cache/debris_flows.gpkg`) and its
monthly `actions/cache` key are shared with `refresh-data.yml`.

### Expected freshness

| Step | Typical time |
|------|--------------|
| NWS updates NDFD; Esri reloads the layer | about hourly |
| Next scheduled check (EventBridge Scheduler, every 10 min) | 0–10 min |
| Run: skip | ~30 s |
| Run: build | ~1–2 min; ~3–5 min with heavy rain (~20 min on the monthly cold cache) |
| CloudFront / browser cache | ≤ 1 min; the page re-polls every 5 min |

The page displays a warning banner if `status.checked_at` is more than 45
minutes old, which means the pipeline has stopped checking.

GitHub's own cron turned out to be hours late for this repo, so the
workflow is triggered by **EventBridge Scheduler + a small Lambda** that
calls GitHub's `workflow_dispatch` API every 10 minutes; see
`infra/lambda/refresh-simple-trigger/README.md`. The cron in the workflow
file is only a backup. Running the two scripts themselves on AWS (Lambda
or Fargate) is a later step, tracked in `BACKLOG.md`.

## How the time window is labeled

The NDFD "Accumulation by Time" layer is cumulative from the start of the
current forecast cycle (00, 06, 12 or 18 UTC). The 24-hour total runs from
the cycle start, which can be up to about 6 hours in the past, to 24 hours
after it. The page shows those exact bounds, for example:

> Wed, Oct 7, 8:00 AM ET – Thu, Oct 8, 8:00 AM ET
> Started 6 h ago; 18 h remain. Totals include rain forecast for the hours already past.

It also shows when NWS/Esri last updated the data (`issued`) and when the
pipeline last checked for updates (`checked_at`).

## Deploy

- `deploy-prod.yml` (on push to `master`) syncs the repo to the site
  bucket, so `simple/` ships with the main site. `simple/pipeline/*` is
  excluded. `simple/data/` is served from the separate data bucket through
  the same CloudFront distribution.
- `refresh-simple.yml` (dispatched every 10 minutes) writes `simple/data/`
  to the data bucket.

After the first deploy, seed `simple/data/` by running `refresh-simple.yml`
once by hand (Actions, Run workflow, `force` checked). Until then the page
shows its stale-data banner.

The dev site at <https://dev.landslidesncgs.org/simple/> (from the
`development` branch, basic auth) reads the production data bucket, so it
shows live data.

## Run it locally

`simple/pipeline/run_local.py` does what the workflow does in production,
on your own computer. It checks NDFD every 10 minutes, writes the results
into `simple/data/`, and serves the repo root so the page is at
<http://localhost:8000/simple/> and building footprints load from
`alerts/data/`.

```bash
conda activate defns-refresh    # from environment.yml; any env with geopandas + requests works
python simple/pipeline/run_local.py
```

Options: `--warm` (load the debris cache before starting), `--force` (rebuild
even if NDFD hasn't changed), `--once` (one refresh, then just serve),
`--interval 5`, `--port 8080`, `--host 0.0.0.0` (let others on your network
open it), `--no-serve` (refresh only).

`?data=<folder>` and `?buildings=<folder>` on the page URL override the
data locations for testing.
