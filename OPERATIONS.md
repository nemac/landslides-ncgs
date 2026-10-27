# Operations guide

How the site and its data pipelines run, and how to run them on your own
computer. Current as of 2026-10-27. Architecture is in `README.md`; the
AWS setup is in `infra/README.md`.

## What runs where

| Piece | Runs | Writes | Served at |
|---|---|---|---|
| Main site and both dashboards (static files) | `deploy-prod.yml` on push to `master`; `deploy-dev.yml` on push to `development` | site bucket, dev-site bucket | `https://landslidesncgs.org`, `https://dev.landslidesncgs.org` (basic auth) |
| DFENS Simple pipeline (`simple/pipeline/`) | `refresh-simple.yml`, dispatched every 10 minutes by EventBridge Scheduler | `s3://landslidesncgs-data/simple/data/` | `/simple/data/` on both hosts |
| Nightly alerts pipeline (`scripts/refresh.py`) | `refresh-data.yml`, dispatched daily at 04:00 UTC by EventBridge Scheduler | `s3://landslidesncgs-data/alerts/data/` | `/alerts/data/` on both hosts |
| AWS resources (`infra/cdk/`) | by hand from a developer machine | CloudFormation stacks | |

Nothing under `alerts/data/` or `simple/data/` is in git. The dev site reads
the production data bucket, so it always shows live data.

The SIREN alerts dashboard under `alerts/` has been offline since
2026-10-22; its pages redirect to `/simple/`. Its nightly pipeline still
runs because DFENS Simple reads the building footprints it produces, and
because the two pipelines share `scripts/data.py`, `scripts/analysis.py`
and `scripts/config.py`.

## Local preview of the site

From the repo root:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` for the main site or
`http://localhost:8000/simple/` for the dashboard. Page links are
root-absolute (`/about/`, `/assets/...`), so the server must run from the
repo root. A plain file open (`file://`) will not resolve them.

Hard-refresh after changing files, or turn on "Disable cache" in the
browser's DevTools Network tab while developing.

## Getting data onto your computer

A fresh checkout has empty `alerts/data/` and `simple/data/` folders. The
dashboard shows its stale-data banner until `simple/data/` exists.

With AWS access (profile `jbliss-landslidesncgs`):

```bash
aws s3 sync s3://landslidesncgs-data/simple/data simple/data --profile jbliss-landslidesncgs
aws s3 sync s3://landslidesncgs-data/alerts/data alerts/data --profile jbliss-landslidesncgs   # ~870 MB, mostly building footprints
```

Without AWS access, run the pipelines below; they write the same files.

## Python environment

One pinned environment serves both pipelines. It is the same file CI uses,
so a local run and a CI run see identical library versions.

```bash
conda env create -f environment.yml     # once; or: micromamba create -f environment.yml
conda activate defns-refresh
```

`ModuleNotFoundError: No module named 'geopandas'` means the environment is
not active.

## DFENS Simple locally

`simple/pipeline/run_local.py` does on your computer what
`refresh-simple.yml` does in production: every ten minutes it checks NDFD,
rebuilds `simple/data/` when the forecast changed, and serves the repo root
so the page is at `http://localhost:8000/simple/`.

```bash
conda activate defns-refresh
python simple/pipeline/run_local.py
```

Options: `--once` (one refresh, then just serve), `--force` (rebuild even
if NDFD has not changed), `--warm` (load the debris-flow cache first),
`--interval 5`, `--port 8080`, `--host 0.0.0.0`, `--no-serve`. On the page,
`?data=<folder>` and `?buildings=<folder>` override the data locations.

The first build that finds rain at or above the threshold loads the
debris-flow layer into `cache/debris_flows.gpkg` (about 560 MB, kept for 30
days). That one-time load takes 15 to 20 minutes; later builds take one to
two minutes. Details of the pipeline are in `simple/README.md`.

## Nightly alerts pipeline locally

```bash
conda activate defns-refresh
python scripts/refresh.py
```

Writes to `alerts/data/`, for each NDFD window (12, 24, 48 and 72 hours)
a `forecast_{N}h.geojson` and a `flagged_ndfd_{N}h.geojson`, and for each
MRMS window (1, 24 and 72 hours) an `observed_{N}h.geojson` and a
`flagged_mrms_{N}h.geojson`. Every file carries a top-level `meta` object
with its timestamps and source. The run also refreshes the building
footprints under `alerts/data/buildings/` when their manifest is older
than 30 days (5 to 15 minutes the first time; see below).

A non-zero exit means something failed. In CI nothing is uploaded on a
non-zero exit, so the bucket keeps the previous day's files. See
`scripts/README.md` for the exit codes.

### Historical events

`python scripts/refresh.py --hindcast` regenerates the historical event
files under `alerts/data/historical/` for every event in
`scripts/events.py`; `--hindcast <event_id>` does one. The nightly run never
does this, and the nightly upload never deletes, so historical files reach
the bucket only by hand:

```bash
aws s3 sync alerts/data/historical s3://landslidesncgs-data/alerts/data/historical \
  --content-type application/json --cache-control "public, max-age=300" --profile jbliss-landslidesncgs
```

These files were read only by the offline alerts dashboard.

## Deploying

- **Site files:** merge to `development` to see a change on the dev site,
  then merge `development` into `master` for production. Both deploys sync
  the tree to the bucket and invalidate CloudFront; they take about a
  minute. `master` only accepts pull requests whose CI check passed.
- **CloudFront functions and every other AWS change:** from `infra/cdk/`,
  `npx cdk diff Web --profile jbliss-landslidesncgs` to review, then
  `npx cdk deploy Web --profile jbliss-landslidesncgs` (log in first with
  `aws sso login --profile jbliss-landslidesncgs`). See `infra/README.md`.
- **Pipelines:** nothing to deploy. The workflows run from the `master`
  branch on their schedules. Run one by hand from the Actions tab
  (`refresh-simple.yml` has a `force` input to rebuild even when NDFD has
  not changed).

## Common issues

- **The dashboard shows "Forecast data could not be loaded".** Locally,
  `simple/data/` is empty: sync it from S3 or run `run_local.py`. In
  production, check the latest `refresh-simple.yml` run in the Actions tab.
- **The stale-data banner is up in production.** `status.json` is more
  than 45 minutes old, so the pipeline has stopped checking. Look at the
  `refresh-simple.yml` runs first; if none have started, the EventBridge
  trigger or its GitHub token is the problem (`infra/lambda/refresh-simple-trigger/README.md`).
- **Git refuses to push a huge file.** `cache/debris_flows.gpkg` must never
  be committed; `cache/` and `*.gpkg` are in `.gitignore`. If it shows up as
  staged, `git rm --cached -r cache`.
- **A page's JavaScript error.** Open the browser console; the first red
  line is usually the cause.

## Reference

| What | Where |
|---|---|
| Main site pages | `index.html`, `about/`, `downloads/`, `learn-more/`, `reducing-landslide-risk/` |
| DFENS Simple page and pipeline | `simple/`, `simple/pipeline/` |
| Alerts dashboard (offline) and nightly pipeline | `alerts/`, `scripts/` |
| Debris-flow cache | `cache/debris_flows.gpkg` (never committed) |
| Python environment | `defns-refresh`, from `environment.yml` |
| Production | `https://landslidesncgs.org`, `https://dashboard.landslidesncgs.org` (serves `/simple/`) |
| Dev | `https://dev.landslidesncgs.org` (basic auth; credentials are held by the site maintainers) |

## Building footprints (Overture Maps)

The "Building footprints" layer on the dashboard comes from Overture Maps
Foundation through their Python client, chunked by county so the page can
load only what is in view.

1. `scripts/refresh.py` runs the buildings phase on every run.
2. `fetch_overture_buildings` in `scripts/data.py` skips the slow work when
   `alerts/data/buildings/manifest.json` is younger than
   `OVERTURE_BUILDINGS_CACHE_TTL_DAYS` (30). In CI the manifest is fetched
   from the bucket first and its modification time restored, so the
   extraction runs about monthly.
3. When stale or missing, it queries Overture's hosted GeoParquet through
   DuckDB for the WNC bounding box, drops footprints under 20 square
   metres, spatially joins with counties, and writes one GeoJSON per county
   plus the manifest. Geometry simplification is off
   (`OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG = 0`); the files are large, which is
   a known backlog item.
4. The page loads the manifest once and fetches county files on demand
   above zoom 12, keeping up to 20 counties in memory.

Output under `alerts/data/buildings/`: `manifest.json` (generated time,
bbox, county list with counts and sizes) and one `{GEOID}.geojson` per
county, each feature carrying only the Overture id and the polygon.

The first extraction takes 5 to 15 minutes. To force a fresh one, delete
`alerts/data/buildings/manifest.json` and run `python scripts/refresh.py`.
The `overturemaps`, `duckdb` and `pyarrow` packages come from the `pip:`
section of `environment.yml` and are imported lazily, so the rest of the
pipeline runs without them.

Tuning knobs in `scripts/config.py`: `OVERTURE_BUILDINGS_CACHE_TTL_DAYS`,
`OVERTURE_BUILDINGS_SIMPLIFY_TOL_DEG`, `OVERTURE_BUILDINGS_COORD_PRECISION`,
`OVERTURE_BUILDINGS_MIN_AREA_SQM`. In `simple/js/config.js` and
`alerts/js/config.js`: `OVERTURE_BUILDINGS_MIN_ZOOM` and
`OVERTURE_BUILDINGS_CACHE_MAX_COUNTIES`.
