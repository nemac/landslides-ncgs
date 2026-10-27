# Backlog

Work we know we need to do but have not scheduled. Keep each item short;
details belong in an issue or PR once someone picks it up.

## Committed to

- **Update documentation.** `README.md` was rewritten 2026-10-21.
  `OPERATIONS.md` still describes a single-machine workflow with another
  developer's Windows paths, and `alerts/README.md` still describes Phase 1
  and links to an `accessibility.html` that does not exist. Rewrite both to
  match how the site is actually built, refreshed and deployed.
- **Link DFENS Simple from the home page.** The dashboard at `/simple/`
  is not linked from `index.html` yet. When it is ready for the public,
  add it to the home-page card grid and the site nav, linking
  `https://dashboard.landslidesncgs.org/`. (The SIREN dashboard at
  `/alerts/` was taken offline on 2026-10-22 and now redirects to
  `/simple/`; it is not coming back to the home page.)
- **PR checks and tests.** `ci.yml` already runs the CDK typecheck, tests
  and synth plus the CloudFront Function tests on every pull request. Still
  to add: `npm run lint` (fails today on two unused variables in
  `alerts/js`), `npm run format:check` (Prettier would reformat about 1,300
  lines across five frontend files; run `npm run format` once and commit),
  `ruff check scripts`, and tests for `scripts/analysis.py` (the
  intersection logic) and the frontend's threshold filtering.
- **Decommission the NEMAC account resources.** After the cutover in
  `infra/README.md` reaches step 12 (48 hours after the GoDaddy name-server
  change), run its decommission list and record the date here.
  Done: ____-__-__.

- **Reproducible snapshots of flagged runs.** Requested 2026-10-21. Today
  each refresh overwrites `alerts/data/flagged_*.geojson`, and the only
  record of past runs was git history, which the move to S3 gave up.
  - When nothing is flagged, keep nothing but one log line (run time,
    windows checked, "nothing flagged").
  - When a run flags any debris flows, keep a dated, read-only snapshot
    (`s3://landslidesncgs-data/alerts/snapshots/<run time>/`, a prefix
    reserved for this) with
    every asset and input needed to reproduce that forecast exactly: the
    flagged outputs, the NDFD/MRMS precipitation inputs per window, the
    thresholds and category cutoffs in force, the debris-flow basin data
    version, and the code commit.

- **Run the pipelines on AWS ("Option B").** Decided 2026-10-21 as the end
  state; the data move, the dedicated account and the CDK app are done (see
  `infra/`). What remains: run `simple/pipeline/` and then `scripts/refresh.py`
  on AWS instead of GitHub Actions. That means a container image with
  geopandas and GDAL (ECR), the 570 MB debris-flow cache in S3 instead of
  `actions/cache`, an execution role with data-bucket access, and Fargate
  or Lambda with enough storage. Lambda's 15-minute limit is shorter than
  the monthly cold debris-flow fetch (~20 min), so either keep that one
  step on Actions or use Fargate. `scripts/` would then have two runtimes
  to keep working. The EventBridge trigger (`infra/cdk/lib/trigger-stack.ts`)
  already exists and would invoke the task directly instead of GitHub.

## From the October 2026 audit, not yet decided

- **CloudFront response headers, remaining piece: CSP.** Compression,
  per-class `Cache-Control` set at upload, HSTS and
  `X-Content-Type-Options: nosniff` (the managed security headers policy)
  shipped with the CDK app. Still open: a Content-Security-Policy listing
  self, unpkg, Google Fonts and the map data hosts (ArcGIS, Iowa Mesonet,
  OpenStreetMap, NC OneMap), started in report-only mode because of the
  number of external hosts. Flagged files above 10 MB are still served
  uncompressed (CloudFront's limit); pre-compressing them at upload is the
  fix if it matters.
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
- **Flat-site cleanup, readable without a framework.** The five main-site
  pages each carry their own copy of the header, nav, footer and colour
  token CSS.
  Plan: one shared `assets/css/site.css` for tokens, header, nav and footer,
  with each page keeping only its own styles; move inline styles into
  classes; for the repeated header and nav markup either keep one short
  identical block per page or add a 30-line Python script that stitches
  partials (Python is already in use for the pipelines). Keep the existing BEM class names and
  one file per page. No React or build framework.
- **Overture buildings layer size and leftovers.** Simplification tolerance
  is not the lever that matters: 841 MB across 77 county files with single
  files up to 63 MB is. If the layer survives the simplified dashboard,
  convert it to vector tiles (PMTiles via tippecanoe, one file served with
  range requests) instead of per-county GeoJSON. Either way fix the
  `fetch_overture_buildings` log line that still prints "~3m" with
  tolerance 0, and the `_refresh_overture_buildings` docstring that names a
  single-file output that no longer exists.
