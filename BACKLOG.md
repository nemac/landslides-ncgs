# Backlog

Work we know we need to do but have not scheduled. Keep each item short;
details belong in an issue or PR once someone picks it up.

## Committed to

- **Link DFENS Simple from the home page.** The dashboard at `/simple/`
  is not linked from `index.html` yet. When it is ready for the public,
  add it to the home-page card grid and the site nav, linking
  `https://dashboard.landslidesncgs.org/`. (The SIREN dashboard at
  `/alerts/` was taken offline on 2026-10-22 and now redirects to
  `/simple/`; it is not coming back to the home page.)
- **Test the intersections.** Still to write: tests for
  `scripts/analysis.py` (the intersection logic).
- **Make the archived flagged runs reproducible.** Since 2026-10-27
  `refresh-simple.yml` copies the three output files of every run that
  flags a pathway to `s3://landslidesncgs-data/simple/archive/<generated_at>/`,
  a prefix CloudFront does not serve and the lifecycle rule does not touch.
  Those files show what was flagged but not how to get there again: the
  archive still needs the NDFD precipitation input for the window, the
  thresholds and category cutoffs in force, the debris-flow data version
  and the code commit. Runs that flag nothing keep nothing but their log.
- **Run the pipelines on AWS ("Option B").** Decided 2026-10-21 as the end
  state. Done so far: the dedicated account and CDK app (`infra/`), data in
  S3, the debris-flow GeoPackage kept in the data bucket by
  `refresh-reference.yml`, and the EventBridge schedules
  (`infra/cdk/lib/trigger-stack.ts`) that dispatch the GitHub workflows.
  What remains: run `simple/pipeline/` (every 10 minutes) and the
  `refresh-reference.yml` rebuilds on AWS instead of GitHub Actions. That
  means a container image with geopandas and GDAL (ECR), an execution role
  with data-bucket access, and Fargate or Lambda with enough storage.
  Lambda's 15-minute limit fits the Simple pipeline but not a reference
  rebuild (an Overture extract is 5 to 15 minutes, a debris-flow re-fetch
  10 to 20), so those need Fargate. The schedules would then invoke the
  task directly instead of GitHub.
- **Slack dev requests.** A request in Slack opens a GitHub issue; an agent
  run in Actions works the issue and opens a pull request into
  `development`, which gets its own preview site at
  `pr-<number>.landslidesncgs.org` (`pr-preview.yml`, live since 2026-10-28).
  The design was written 2026-10-21; nothing beyond the previews is built.

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
- **A custom 404 page.** A missing page on the production site answers
  S3's raw `AccessDenied` XML with a 403 (checked 2026-10-28), because
  origin access gives CloudFront no `s3:ListBucket`. Add a `/404/` page and
  an error response on each distribution that serves it with a 404 for a
  403 from the site bucket, leaving the data behaviors alone so a missing
  data file still fails loudly.
- Decide whether `FLAGGED_MIN_CATEGORY = 0` in `scripts/config.py` is the
  intended production setting or a leftover from testing.
- **Flat-site cleanup, readable without a framework.** The five main-site
  pages each carry their own copy of the header, nav, footer and colour
  token CSS.
  Plan: one shared `assets/css/site.css` for tokens, header, nav and footer,
  with each page keeping only its own styles; move inline styles into
  classes; for the repeated header and nav markup either keep one short
  identical block per page or add a 30-line Python script that stitches
  partials (Python is already in use for the pipelines). Keep the existing
  BEM class names and one file per page. No React or build framework.
- **Overture buildings layer size and leftovers.** Simplification tolerance
  is not the lever that matters: 841 MB across 77 county files with single
  files up to 63 MB is. If the layer survives the simplified dashboard,
  convert it to vector tiles (PMTiles via tippecanoe, one file served with
  range requests) instead of per-county GeoJSON. Either way fix the
  `fetch_overture_buildings` log line that still prints "~3m" with
  tolerance 0.

## Deferred

These affect only the SIREN alerts pipeline (`scripts/refresh.py`,
`refresh-data.yml`), which has run by hand only since the alerts dashboard
went offline on 2026-10-22. DFENS Simple has its own pipeline and is not
affected. Revisit if the alerts dashboard returns.

- **Publish partial `refresh.py` results safely.** Deferred 2026-10-27. A
  partial refresh (exit code 2) fails the workflow step, so nothing is
  uploaded and no window publishes. Exit code 2 covers two cases that need
  different handling: some precipitation windows failed but the rest were
  intersected (safe to publish), and the debris-flow load failed after
  precipitation was written (must not publish, or fresh precipitation sits
  next to stale flagged files). Split those into separate codes in
  `refresh.py`, then have `refresh-data.yml` publish on the first and fail
  on the second. In 96 scheduled runs it happened twice, both on
  2026-07-20 during setup.
- **Config parity between `scripts/config.py` and `alerts/js/config.js`.**
  The duplicate and dead constants are gone and both files now share one
  `WNC_BBOX` (checked 2026-10-28), but `config.js` still mirrors the
  thresholds, category cutoffs, bbox and window lists by hand. Add a small
  Python test that parses `config.js` and asserts the shared values agree.
