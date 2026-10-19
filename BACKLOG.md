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
- Remove or reconcile the duplicate and leftover constants in
  `scripts/config.py`.
- Share one header, nav and footer stylesheet across the seven top-level
  pages instead of a copy in each.
- Add security headers (HSTS, X-Content-Type-Options, CSP) through a
  CloudFront response headers policy.
