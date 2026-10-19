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

- Compression and cache headers for the S3 deploy (see the task card from
  the audit session).
- Handle `refresh.py` exit code 2 (partial success) in
  `refresh-data.yml` so one failed window does not block publishing the
  others.
- Decide whether `FLAGGED_MIN_CATEGORY = 0` is the intended production
  setting or a leftover from testing.
- Remove or reconcile the duplicate and leftover constants in
  `scripts/config.py`.
- Share one header, nav and footer stylesheet across the seven top-level
  pages instead of a copy in each.
- Add security headers (HSTS, X-Content-Type-Options, CSP) through a
  CloudFront response headers policy.
