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
