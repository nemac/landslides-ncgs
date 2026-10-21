# Backlog

Work we know we need to do but have not scheduled. Keep each item short;
details belong in an issue or PR once someone picks it up.

## Committed to

- **Update documentation.** `README.md` is a placeholder, `OPERATIONS.md`
  describes a single-machine workflow with another developer's paths and
  predates the GitHub Actions cron, and `alerts/README.md` still describes
  Phase 1 and links to an `accessibility.html` that does not exist. Rewrite
  all three to match how the site is actually built, refreshed and deployed.
- **Link SIREN from the home page.** The dashboard at `/alerts/` is
  deliberately not linked from `index.html` yet. When it is ready for the
  public, add it to the home-page card grid and the site nav.
- **PR checks and tests.** Run `npm run lint`, `npm run format:check` and
  `ruff check` in a GitHub Actions workflow on every pull request, and add
  tests for `scripts/analysis.py` (the intersection logic) and the
  frontend's threshold filtering.

- **Move `alerts/data/` out of git into S3.** Decided 2026-10-20, to run
  after the DFENS Simple fold lands. The repo carries about 950 MB of data
  under `alerts/data/` (841 MB of it building footprints) and a 1.8 GB
  history from 92 daily bot commits; GitHub Pages has a soft 1 GB limit we
  are already at. Git history does not need to be kept. The pattern to copy
  is `simple/pipeline/` plus `refresh-simple.yml`: the pipeline writes
  straight to the bucket, commits nothing, and sets short `Cache-Control`
  on data files so no CloudFront invalidation is needed.
  - `refresh-data.yml` stops committing to `master` and stops dispatching
    the deploy; it uploads `alerts/data/` to `s3://landslides-ncgs/alerts/data/`
    with `aws s3 sync` and per-file `Cache-Control` (see the headers item
    below). Seed the prefix once by hand before switching.
  - `deploy-prod.yml` must add `--exclude "alerts/data/*"` to its root
    `--delete` sync before the first S3-only refresh, or the next code
    deploy wipes the live data. Same one-line pattern as `simple/data/*`.
  - Stop tracking the folder (`git rm -r --cached alerts/data`, add it to
    `.gitignore`). To shrink the clone as well, rewrite history with
    `git filter-repo --path alerts/data --invert-paths` and force-push, or
    start a fresh repo; either way Ian re-clones once and his fork goes
    stale. Leaving history alone breaks nothing but keeps the 1.8 GB.
  - Fresh checkouts will have no data. Add a small `scripts/sync_data.py`
    (or `aws s3 sync` one-liner in OPERATIONS.md) that pulls the current
    `alerts/data/` down from the live site; running `scripts/refresh.py`
    locally still works as it does today. Buildings are 841 MB, so the
    download beats regenerating.
  - The GitHub Pages dev site (development branch) loses its data: it would
    need CORS on CloudFront to read from landslidesncgs.org. Preferred:
    retire the Pages site rather than add CORS plumbing.
  - Turn on S3 versioning for the bucket if anyone wants to look at
    yesterday's alerts after the git record goes away; that is the only
    thing the git history gave us.
  - Cost is negligible: about a gigabyte of storage plus a few hundred
    small uploads a day. Later migration to the dedicated AWS account
    becomes one bucket sync, one role and one distribution.

- **Reproducible snapshots of flagged runs.** Requested 2026-10-21. Today
  each refresh overwrites `alerts/data/flagged_*.geojson`, and the only
  record of past runs is git history, which the S3 move above gives up.
  - When nothing is flagged, keep nothing but one log line (run time,
    windows checked, "nothing flagged").
  - When a run flags any debris flows, keep a dated, read-only snapshot
    (for example `s3://landslides-ncgs/alerts/snapshots/<run time>/`) with
    every asset and input needed to reproduce that forecast exactly: the
    flagged outputs, the NDFD/MRMS precipitation inputs per window, the
    thresholds and category cutoffs in force, the debris-flow basin data
    version, and the code commit.

- **Everything on AWS except the code.** Decided 2026-10-21: the end state
  is that GitHub holds only source code and every runtime piece (data,
  schedules, pipelines, site) lives in the dedicated AWS account. Steps,
  in order:
  1. `alerts/data/` to S3 (the item above).
  2. **Run the DFENS Simple pipeline itself on AWS** ("Option B"). Today
     only the *trigger* is on AWS (EventBridge Scheduler + a stdlib Lambda
     that calls `workflow_dispatch`, see
     `infra/lambda/refresh-simple-trigger/`); the scripts still run on
     GitHub Actions. Moving them means a container image with geopandas
     and GDAL (ECR), the 570 MB debris-flow cache in S3 instead of
     `actions/cache`, an execution role with bucket access, and Fargate or
     Lambda with enough storage. Lambda's 15-minute limit is shorter than
     the monthly cold debris-flow fetch (~20 min), so either keep that
     one step on Actions or use Fargate. `scripts/` would then have two
     runtimes to keep working.
  3. Then the nightly `refresh-data.yml` the same way.
- **Migrate the DFENS Simple trigger with everything else.** When the
  project moves to its own AWS account, recreate (or redeploy with
  `infra/lambda/refresh-simple-trigger/deploy.sh` after editing its
  account-specific names): secret `landslides/github-dispatch-token`,
  Lambda `landslides-refresh-simple-trigger`, roles
  `landslides-refresh-simple-trigger-lambda` and
  `-scheduler`, schedule `landslides-refresh-simple-10min`. The GitHub
  token in the secret has an expiry and must be renewed by hand.

## From the October 2026 audit, not yet decided

- **CloudFront and S3 response headers.** Production serves GeoJSON with no
  `Content-Encoding` and no `Cache-Control`; flagged files are 11-12 MB raw
  on wet days and county building files up to 63 MB. Enable CloudFront's
  automatic compression (Gzip and Brotli, objects up to 10 MB) and set
  `Cache-Control` per file class when files are written: long for
  `assets/` and buildings, short (about 5 minutes) for `alerts/data/*.geojson`,
  no-cache for HTML, CSS and JS. Do this wherever the data ends up being
  written once it leaves the repo, not only in `deploy-prod.yml`.
- **Publish partial `refresh.py` results safely.** Any non-zero exit code
  currently fails the CI step, so the commit and deploy are skipped and no
  window publishes that day. Exit code 2 covers two different cases that
  need different handling: some precipitation windows failed but the rest
  were intersected (safe to publish), and the debris-flow load failed after
  precipitation was written (must not publish, or fresh precipitation sits
  next to stale flagged files). Split those into separate codes in
  `refresh.py`, then have `refresh-data.yml` publish on the first and fail
  on the second. Low urgency: in 96 runs it has only happened twice, both
  on 2026-07-20 during setup, and the only realistic trigger is the monthly
  cold debris-flow cache.
- Decide whether `FLAGGED_MIN_CATEGORY = 0` is the intended production
  setting or a leftover from testing.
- **Explore and resolve config drift between `scripts/config.py` and
  `alerts/js/config.js`.** Known today: `config.py` defines the
  `DEBRIS_CONTEXT_TILE_*` block twice, still carries Folium and Streamlit
  leftovers (`OUTPUT_DIR`, `MAP_FILENAME`, `MAP_CENTER`), and has two
  bounding boxes that disagree on the east edge (`WNC_BBOX_WGS84` xmax
  -80.8 vs `WNC_BBOX` -81.0). `config.js` mirrors thresholds, category
  cutoffs, bbox and window lists by hand with nothing checking they match.
  Work out which constants are actually read on each side, delete the dead
  ones, and add a small Python test that parses `config.js` and asserts the
  shared values agree (first candidate for the tests item above).
- **Flat-site cleanup, readable without a framework.** The seven top-level
  pages each carry their own copy of the header, nav, footer and colour
  token CSS, and `intro-landslides.html` has 75 inline `style=` attributes.
  Plan: one shared `assets/css/site.css` for tokens, header, nav and footer,
  with each page keeping only its own styles; move inline styles into
  classes; for the repeated header and nav markup either keep one short
  identical block per page or add a 30-line Python script that stitches
  partials (Ian already runs Python). Keep the existing BEM class names and
  one file per page. No React or build framework.
- **Security headers via a CloudFront response headers policy.** None are
  sent today. Attach the managed security headers policy for HSTS and
  `X-Content-Type-Options: nosniff`, then add a custom Content-Security-Policy
  listing self, unpkg, Google Fonts and the map data hosts (ArcGIS, Iowa
  Mesonet, OpenStreetMap, NC OneMap). Start CSP in report-only mode because
  of the number of external hosts.
- **Overture buildings layer size and leftovers.** Simplification tolerance
  is not the lever that matters: 841 MB across 77 county files with single
  files up to 63 MB is. If the layer survives the simplified dashboard,
  convert it to vector tiles (PMTiles via tippecanoe, one file served with
  range requests) instead of per-county GeoJSON. Either way fix the
  `fetch_overture_buildings` log line that still prints "~3m" with
  tolerance 0, and the `_refresh_overture_buildings` docstring that names a
  single-file output that no longer exists.
