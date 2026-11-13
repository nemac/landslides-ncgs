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
- Building footprints (rebuilt by `refresh-reference.yml` when Overture
  publishes a release, read from `../alerts/data/` on the same origin)

## Data pipeline: its own, every 10 minutes

The full alerts pipeline (`scripts/refresh.py`) is too heavy to keep up
with NDFD, which updates about hourly, and has not run on a schedule since
2026-10-27. The simple page therefore has its own lean pipeline that
produces only the files this page needs and uploads them straight to S3.
Nothing under `simple/data/` is committed to git.

```
.github/workflows/refresh-simple.yml   (cron: every 10 min)
  simple/pipeline/ndfd_check.py        stdlib only, ~5 s
      NDFD unchanged since last status.json?  -> skip (re-upload status only)
      last run had no fire districts?         -> build (try the lookup again)
      otherwise                                -> build
  simple/pipeline/refresh_simple.py    geopandas, only on "build"
      fetch all categories for the 24 h period, clip to WNC -> forecast_24h.geojson
      any >= 5" polygons? download cache/debris_flows.gpkg from the data
      bucket (kept current by refresh-reference.yml), bbox prefilter,
      find_alerts() on candidates
      any flagged pathways? tag each with its fire district from
      cache/fire_districts_wnc.geojson (also from the data bucket)
  -> s3://landslidesncgs-data/simple/data/
        forecast_24h.geojson             (map layer, Cache-Control max-age=60)
        flagged_ndfd_24h_min11.geojson   (max-age=60)
        status.json                      (max-age=30, rewritten every run)
```

The pipeline imports `scripts/data.py`, `scripts/analysis.py` and
`scripts/config.py` directly (the debris-flow fetch with county and
watershed tagging, and the intersection), so results match the full
dashboard. The debris-flow GeoPackage (`cache/debris_flows.gpkg`) is
rebuilt by `refresh-reference.yml` when the NCGS layer changes and shared
through the data bucket.

### Fire districts

Each flagged pathway is tagged with its NC fire district from the NC
Office of State Fire Marshal layer. The WNC districts are kept in
`cache/fire_districts_wnc.geojson`, which `refresh-reference.yml` rebuilds
and shares through the data bucket when the layer's data-last-edit date
changes (or after 90 days, or when forced). If the file is missing, the
pipeline downloads the districts from the service itself
(`simple/pipeline/fire_districts.py`). The match is done in
`simple/pipeline/fire_district_join.py`.

Each pathway in the flagged file carries six fields:

| Field | Meaning |
|-------|---------|
| `fdid` | The fire department's id |
| `fire_department` | The fire department's name |
| `fd_county` | The district's county |
| `fd_address` | The fire department's address |
| `district_updated` | When the state last updated the district (YYYY-MM-DD) |
| `fire_district_status` | `district`; `no_district` for land the state marks "No District"; `outside_nc` when no district polygon matches |

The flagged file's `meta.fire_districts` says how the lookup went for the
whole file: `ok`; `unavailable` when the lookup failed, in which case the
six fields are empty; or `not_run` when nothing was flagged.

A district file with polygons missing would publish the pathways inside
them as `outside_nc`, so three checks guard against it:

- A download is saved only when it holds exactly as many districts as
  the service itself counts for the WNC box.
- A copy with fewer than `FIRE_DISTRICTS_MIN_COUNT` (`settings.py`)
  polygons counts as a failed lookup, and a download that short is
  never saved.
- A run that marks any pathway `outside_nc` prints a `::warning::` line,
  which shows on the Actions run page. The state layer covers all of
  NC, so that answer should be rare and is worth a look.

`status.json` carries the same `fire_districts` value. While it reads
`unavailable`, `ndfd_check.py` builds again on every 10-minute check
instead of waiting for the next NDFD update, so a short outage clears
itself. The first run for a forecast is archived as usual; a repeat that
fails again is not (`archive_decision.py`), so a long outage does not
fill the archive with copies.

A pathway is matched by a point inside it. When that point is not in a
real district (it fell in one of the thin "No District" strips the state
layer puts between districts, or in a gap with no polygon), the pathway
takes whichever polygon covers most of it, "No District" included.
Pathway and district shapes that cross themselves are repaired first
(`make_valid`); one unrepaired shape would make the overlap step fail
and cost every pathway in the file its district.

### How the page shows fire districts

The page shows only what the flagged file says and never guesses a
district. It trusts the districts only when `meta.fire_districts` is `ok`
and every pathway has one of the three statuses.

- **Districts known:** the table is grouped. Real districts come first
  (highest forecast rain, then most pathways, then name), then a
  "No District" group and an "Outside North Carolina" group, each shown
  only when it has pathways. Each heading can be collapsed, and has a
  "Show on map" button that fits the map to that group. The summary reads
  like `12 pathways in 3 fire districts (2 with no district, 1 outside
  North Carolina)`.
- **Districts not known** (the lookup failed, or a file from before the
  fire district fields): the table is a plain list sorted by rain, county
  and pathway ID, and a notice says that fire district information is
  unavailable right now.

The page reloads its data every few minutes. The status cards are redrawn
on every reload, but the map's pathways and the table are redrawn only
when the pathways or the `meta.fire_districts` marker changed, so an open
popup stays open and keyboard focus stays where it was. After a real
redraw, focus returns to the same row or group button, or to the table's
heading when that row or group is gone.

The pathway popup on the map and the CSV follow the same rule as the
table. The popup shows the district, "No District (state fire district
data)" or "Outside North Carolina", and "Not available" when the
districts are not known. The CSV starts with the pathway's own columns
(`pathway_id` first), then `fire_district_status` (`district`,
`no_district`, `outside_nc`, or `unavailable` when the districts are not
known) right before the five fire district columns it explains, which are
blank when it is `unavailable`, and ends with the times.

### Expected freshness

| Step | Typical time |
|------|--------------|
| NWS updates NDFD; Esri reloads the layer | about hourly |
| Next scheduled check (EventBridge Scheduler, every 10 min) | 0–10 min |
| Run: skip | ~30 s |
| Run: build | ~1–2 min; ~3–5 min with heavy rain (~20 min if the GeoPackage is missing from the bucket) |
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

## Tests

The page's JavaScript is plain `<script>` files, so the tests evaluate
them in a sandbox or in jsdom rather than importing them. Everything runs
from the repo root with `npm ci` done once.

| Command | What it covers |
|---------|----------------|
| `npm run test:simple` | `simple/test/`: config overrides and tables; the flagged table in both fire district modes, and the CSV; the page contract (every id and asset the scripts use is in `index.html`); app.js in jsdom with a mocked `fetch` and a fixed clock (threshold filter, status cards, stale banner, error state, overlapping loads, toggles, download); map.js against a Leaflet stand-in (NDFD period filter and notice, MRMS and radar tiles, pathway popups and zoom, reference and parcels layers, owner-name parsing, per-county buildings cache); the CDN integrity hashes (downloads from unpkg) |
| `npm run test:e2e` | `simple/e2e/`: the real page in Chromium, served by the same Python server as the launch config, reading `simple/test/fixtures/` through `?data=`; every outside host but unpkg, which serves Leaflet, is blocked. Includes an axe scan for WCAG 2.2 A and AA problems in the grouped, plain and empty states. Needs `npx playwright install chromium` once |
| `python3 -m unittest discover -s simple/pipeline -p "test_*.py"` | The pipeline's check script, the fire district fields and download, the fire district join, and the sync of shared values between `settings.py`, `config.js` and `scripts/config.py`. The join tests need geopandas and are skipped without it; run them in the `defns-refresh` environment |

The fixtures in `simple/test/fixtures/` are three data folders (`live`,
`stale`, `empty`) whose timestamps sit around 2026-10-27T18:40Z, the
fixed clock both JavaScript suites use. `live` has four pathways, one of
them category 10, so the threshold filter has something to drop, and
fire districts for each. `stale` has no fire district fields, like a file
from the older pipeline, so it shows the plain list and the notice.

In CI these are the "Simple dashboard tests" and "Simple dashboard
browser test" jobs in `ci.yml`, kept apart so a browser problem never
blocks the Node checks. `map.js` exposes its private helpers as
`DFS_MAP._test` for the map tests only.

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
