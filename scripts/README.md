# Alerts pipeline and reference-data check

Python that produces the data files under `alerts/data/`. It was written
for the SIREN alerts dashboard, which has been offline since 2026-10-22.
Since 2026-10-27 it no longer runs on a schedule; what still runs daily is
the reference-data check, which rebuilds the two datasets DFENS Simple
depends on (building footprints and the debris-flow GeoPackage) only when
their upstreams change. DFENS Simple also imports this folder's modules for
the debris-flow intersection. Current as of 2026-10-27.

## Files

```
scripts/
  refresh.py      Driver. Live mode writes the forecast, observed and
                  flagged files for every window; --hindcast writes the
                  historical event files; --buildings and --debris-cache
                  rebuild one reference dataset each.
  reference_check.py  Daily decision (stdlib): compares Overture's latest
                  release and the NCGS layer's edit date with what was last
                  built, applies the 90-day floor and FORCE, logs both.
  data.py         Fetchers: NDFD forecast, MRMS observed, Stage IV hindcast,
                  NCGS debris-flow pathways (cached in cache/debris_flows.gpkg),
                  county and watershed tagging, Overture building footprints.
  analysis.py     find_alerts(): intersects precipitation polygons with
                  debris-flow pathways. Shared with simple/pipeline/.
  config.py       Constants: service URLs, bounding box, windows, categories,
                  output size knobs. Shared with simple/pipeline/.
  events.py       Historical events for --hindcast.

../environment.yml   Pinned environment, used by CI and locally (defns-refresh).
```

## What it writes

Live mode, to `alerts/data/`:

- `forecast_{N}h.geojson` and `flagged_ndfd_{N}h.geojson` for N in 12, 24, 48, 72
- `observed_{N}h.geojson` and `flagged_mrms_{N}h.geojson` for N in 1, 24, 72

`--buildings` writes `buildings/manifest.json` and one `{GEOID}.geojson`
per county; live mode never touches `buildings/`.

Every GeoJSON carries a top-level `meta` object with timestamps and source.
`--hindcast` writes `historical/{event_id}_precip.geojson`,
`historical/{event_id}_flagged.geojson` and `historical/events.json`.

## How it runs in production

**Daily: `.github/workflows/refresh-reference.yml`**, dispatched at 05:00
UTC by the EventBridge schedule in `infra/cdk/lib/trigger-stack.ts`.
`reference_check.py` runs first on plain Python and decides, per dataset,
whether to rebuild: Overture published a new release, or the NCGS layer's
data-last-edit date moved, or the last build is 90 days old, or `force` was
set. Only then does the job assume the OIDC role, create the pinned
environment, run `refresh.py --debris-cache` and/or `--buildings`, upload
the GeoPackage to `s3://landslidesncgs-data/cache/` and the footprints to
`alerts/data/buildings/` (mirrored with `--delete`), and record the new
markers in `alerts/data/reference_state.json`. A failed rebuild is retried
the next day because the state is written only after success. The buildings
rebuild fails rather than writes a partial set when one state's counties
cannot be fetched, since the mirror would otherwise delete that state's
files. Only a missing state file (HTTP 404) counts as a first run; a 403,
like any other error reading it, fails the check so the job retries the next
day, since the file has existed since 2026-10-28 and a 403 now points at the
bucket policy or origin access. A `force=true` dispatch accepts a 403 and
records a fresh state, which is the way back if the file really is gone.

**Manual: `.github/workflows/refresh-data.yml`** runs the full alerts
pipeline from the Actions tab: download the GeoPackage from the bucket,
create the environment, run `python scripts/refresh.py`, and upload
`alerts/data/` except `buildings/`, which only the daily workflow writes.
A non-zero exit fails the job before the upload, so a broken run never
replaces good files. Exit code 2 (some windows failed but others were
written) is treated the same way; splitting it so partial results publish
is a deferred item in `BACKLOG.md`.

Nothing is committed to git. `--hindcast` never runs in a workflow;
historical files are uploaded by hand (`OPERATIONS.md`).

## Running it locally

```bash
conda env create -f environment.yml   # once
conda activate defns-refresh
python scripts/refresh.py             # live files
python scripts/refresh.py --buildings # building footprints (5 to 15 min)
python scripts/refresh.py --hindcast  # historical events
```

The debris-flow pathways are fetched from the NCGS ArcGIS service on the
first run and cached in `cache/debris_flows.gpkg`; the local copy is
reused for 120 days, while production rebuilds it on upstream change.
Never commit that file.

## Lint

`ruff check scripts` and `ruff format scripts`, with ruff from
`requirements-dev.txt` (`python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`).
