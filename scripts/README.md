# Nightly alerts pipeline

Python that produces the data files under `alerts/data/`. It was written
for the SIREN alerts dashboard, which has been offline since 2026-10-22,
but it still runs every night because DFENS Simple reads the building
footprints it produces and imports its modules for the debris-flow
intersection. Current as of 2026-10-27.

## Files

```
scripts/
  refresh.py      Driver. Live mode writes the forecast, observed and
                  flagged files for every window; --hindcast writes the
                  historical event files.
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
- `buildings/manifest.json` and one `{GEOID}.geojson` per county, refreshed
  when the manifest is older than 30 days

Every GeoJSON carries a top-level `meta` object with timestamps and source.
`--hindcast` writes `historical/{event_id}_precip.geojson`,
`historical/{event_id}_flagged.geojson` and `historical/events.json`.

## How it runs in production

`.github/workflows/refresh-data.yml`, dispatched daily at 04:00 UTC by the
EventBridge schedule in `infra/cdk/lib/trigger-stack.ts` (the workflow's
own cron is a late-running backup). The job:

1. assumes the `landslides-github-prod` role through OIDC (no stored keys);
2. fetches the buildings manifest from the bucket and restores its
   modification time, so the monthly Overture extraction only runs when due;
3. restores `cache/debris_flows.gpkg` from a monthly `actions/cache` key;
4. creates the environment from `environment.yml` with micromamba;
5. runs `python scripts/refresh.py`;
6. uploads `alerts/data/buildings/` with a one-day cache header and the rest
   of `alerts/data/` with a five-minute one, to
   `s3://landslidesncgs-data/alerts/data/`.

A non-zero exit from `refresh.py` fails the job before the upload, so a
broken run never replaces good files. Exit code 2 (some windows failed
but others were written) is treated the same way today; splitting it so
partial results publish is a deferred item in `BACKLOG.md`.

Nothing is committed to git. `--hindcast` never runs in CI; historical
files are uploaded by hand (`OPERATIONS.md`).

## Running it locally

```bash
conda env create -f environment.yml   # once
conda activate defns-refresh
python scripts/refresh.py             # live files; first run also extracts buildings (5 to 15 min)
python scripts/refresh.py --hindcast  # historical events
```

The debris-flow pathways are fetched from the NCGS ArcGIS service on the
first run and cached in `cache/debris_flows.gpkg` for 30 days. Never commit
that file.

## Lint

`ruff check scripts` and `ruff format scripts`, with ruff from
`requirements-dev.txt` (`python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`).
