# DFENS Simple: fold into landslides-ncgs as `simple/`

Date: 2026-10-20
Status: draft for review

## Intent

Ian Johnson built "DFENS Simple", a fixed-view variant of the alerts
dashboard (NDFD forecast, 24-hour window, 5 inches or more) for A/B
usability testing with emergency responders. He built it in a personal
repo, github.com/ijohnson37/dfens-simple, designed to deploy into the
`simple/` prefix of the production bucket and be served at
https://landslidesncgs.org/simple/.

That design cannot deploy as-is: the AWS OIDC role only trusts
`nemac/landslides-ncgs`. Rather than add a second repo to the trust policy,
we fold the simple dashboard into this repo as a `simple/` directory.

**Why fold rather than add a repo:** Jeff plans to migrate all landslides
resources to a dedicated AWS account later and wants the interim footprint
as small as possible. After the fold there is still exactly one repo, one
bucket, one CloudFront distribution and one IAM role. The main deploy
workflow already syncs the repo root to the bucket, so the simple site
deploys with no new deploy workflow at all.

**Deadline:** the simple page must be live at
https://landslidesncgs.org/simple/ before 10:30 AM ET on 2026-10-21.

## Goals

- `simple/` served live at https://landslidesncgs.org/simple/ with working
  forecast data, by tomorrow morning.
- One implementation of the shared pipeline code. The simple pipeline
  imports `scripts/data.py`, `scripts/analysis.py` and `scripts/config.py`
  instead of carrying copies.
- No new AWS resources and no IAM changes.
- Ian's work is kept intact and credited. Behavior of his page and pipeline
  is unchanged except for file paths.

## Non-goals

- Moving `alerts/data/` out of git. That is a separate, later project; the
  simple pipeline's S3-only output is the template for it.
- Any change to the main alerts dashboard, its nightly pipeline, or the
  `dashboard.landslidesncgs.org` alias.
- Reworking Ian's page, styles or pipeline logic.
- Keeping Ian's repo history. It has a single "Initial commit"; the fold
  commit names him as the author of the simple dashboard instead.

## Anti-goals (what would make this a failure)

- The main site's deploy deleting `simple/data/` (the `--delete` sync).
- The nightly refresh and the 10-minute refresh running at once and
  fighting over the debris-flow cache or the bucket.
- The simple page silently showing stale data with no warning.
- Two diverging copies of `data.py`.

## Constraints

- Builds on `origin/development` (commit ccf884c, "protect simple/ on
  deploy"). Development and master are otherwise identical in code. That
  commit also carries Ian's NDFD cumulative-layer fix in `scripts/data.py`
  and `scripts/refresh.py`. The simple pipeline does not depend on it (it
  only calls `fetch_debris_flows()` and `find_alerts()`, which are
  unchanged), but merging this branch into master ships the fix to the
  nightly pipeline. See "Shipping ccf884c" under Decisions.
- The `production` environment has no protection rules or branch policy,
  so a 10-minute cron job using it will not stall on approvals. `master`
  has no branch protection. The PR must be merged with a merge commit, not
  squashed, so development can be fast-forwarded afterwards.
- `scripts/data.py` imports rasterio inside a try/except, so the simple
  refresh environment needs only `geopandas` and `requests`.
- The CloudFront function `landslides-rewrite` already appends
  `index.html` to trailing-slash paths, so `/simple/` resolves with no
  infrastructure change.
- Ian's git identity for the credit line, from ccf884c:
  `Ian J. <ijohnson@unca.edu>`.
- The production deploy fires on any push to `master`. Deploys exclude
  `*.py`, `*.md`, `scripts/*`, `cache/*` and a few others already.
- The IAM role `landslides-github-actions-prod` trusts only
  `repo:nemac/landslides-ncgs:environment:production`; both new workflow
  jobs must use `environment: production`.
- CloudFront uses the managed CachingOptimized policy, which honors origin
  `Cache-Control`. Ian's short max-age headers work unchanged.
- The GitHub Pages site (development branch) will also serve `simple/` but
  has no `simple/data/`; the page's stale-data banner covers that. Accepted.

## Decisions

### Layout

```
simple/
  index.html, css/, js/          Ian's page, unchanged
  README.md                      Ian's README, paths and deploy section updated
  pipeline/
    settings.py                  unchanged
    ndfd_check.py                unchanged
    refresh_simple.py            imports from ../../scripts instead of shared/
    run_local.py                 paths updated (see below)
  data/                          gitignored; S3-only in production
.github/workflows/refresh-simple.yml   Ian's refresh.yml, paths updated
```

`simple/pipeline/shared/` is dropped. Ian's copies are byte-identical to
`scripts/` on development, so nothing is lost.

### Deploy: no new deploy workflow

`deploy-prod.yml` keeps syncing the repo root. Changes:

- Replace Ian's `--exclude "simple/*"` with `--exclude "simple/data/*"`.
  The site files under `simple/` must deploy; the data must never be
  touched by the site sync.
- `simple/pipeline/` is already covered by the existing `*.py` and `*.md`
  excludes. Add `--exclude "simple/pipeline/*"` anyway so a future
  non-Python file there cannot leak into the bucket.

### Refresh: one new workflow

`refresh-simple.yml` is Ian's `refresh.yml` with:

- `python simple/pipeline/ndfd_check.py` and
  `python simple/pipeline/refresh_simple.py` run from the repo root.
- Its own concurrency group (`refresh-simple`), separate from the nightly
  `refresh-data` group. The two write to different S3 prefixes and the
  nightly job commits to git while this one never does, so they can
  overlap safely.
- The debris-flow cache uses the same `actions/cache` path (`cache/`) and
  the same monthly key scheme as `refresh-data.yml`, so the cold fetch
  happens once a month for both, not twice. Builder: copy the exact key
  from `refresh-data.yml`.
- Python environment: micromamba with `geopandas` and `requests`, as Ian
  had it. (Development has no `environment.yml`; that file lives on
  Jeff's `jeffs-improvements` branch and is out of scope here.)
- Cron stays at every 10 minutes. Public repo, so minutes are free.

### Pipeline imports

`refresh_simple.py` and `run_local.py` replace

```python
sys.path.insert(0, str(HERE / "shared"))
```

with the repo's `scripts/` directory (`HERE.parent.parent / "scripts"`),
mirroring how `scripts/refresh.py` already sets up its own imports. Module
names (`data`, `analysis`, `config`) stay the same, so no other lines
change.

`scripts/data.py` writes its debris cache to `cache/debris_flows.gpkg`
relative to the working directory. Both workflows run from the repo root,
so the cache location is shared. Builder: confirm this by reading the
cache path in `scripts/data.py` before relying on it.

### Local run

`run_local.py` currently serves its own repo at `/simple/` and the main
repo's `alerts/data` at `/alerts/data/`. After the fold both live under one
root, so it serves the repo root and writes to `simple/data/`. The
`--main-repo` option and the debris-cache seeding from a sibling checkout
go away; the cache is `cache/` in this repo, the same one
`scripts/refresh.py` uses. The README's local-run section is updated to
match, and OPERATIONS.md gets a short pointer to it.

### Git hygiene

`.gitignore` gains `simple/data/` and `out/`. `cache/` is already ignored.

### Shipping ccf884c (Jeff's call, pending)

Merging a development-based branch into master ships Ian's NDFD fix to the
nightly pipeline. Its first effect is the 04:00 UTC run on 2026-10-21: the
"24h" NDFD window becomes exactly 24 hours instead of 24 to 30, and the
forecast and flagged metadata gain `window_start` and a redefined `issued`
(Esri's last data load rather than the pipeline run time). The main
dashboard reads `issued` and `window_end`, both still present.

Recommended: ship it. It is a correctness fix, Ian wrote both halves
together, and an A/B test is cleaner when both dashboards use the same
window semantics. Verification then includes a look at the main dashboard
after the first nightly run.

Alternative if Jeff says no: branch from `origin/master`, bring over only
the `deploy-prod.yml` exclude, leave ccf884c on development, and merge
master into development afterwards instead of fast-forwarding.

### Branch and merge sequence

1. Branch `simple-dashboard` from `origin/development`.
2. One commit (or a small series) adding `simple/`, the workflow and the
   deploy change, with Ian credited in the message body.
3. PR into `master`. After merge, fast-forward `development` to `master`
   so the Pages site and the next PR base stay in sync.
4. Go live: the merge's push to master runs `deploy-prod.yml` (site files
   only). Then dispatch `refresh-simple.yml` by hand with `force: true` to
   seed `simple/data/`. Verify https://landslidesncgs.org/simple/ loads,
   shows a window, and has no stale banner.

## What is left to the builder

- Exact wording of README and OPERATIONS.md edits.
- Whether `run_local.py` keeps its `--port`, `--interval`, `--once`,
  `--warm` and `--force` options (keep them unless they break).
- Commit granularity.
- Any lint fixes needed for the moved files to pass the repo's existing
  checks on master (there are none on development; ESLint and ruff config
  live only on `jeffs-improvements`).

## Verification before go-live

- `python -I -m py_compile` on the three pipeline files.
- Run `simple/pipeline/ndfd_check.py --out /tmp/x` locally: it is stdlib
  only and should print an action without error.
- `python -m http.server` from the repo root; open
  http://localhost:8000/simple/ and confirm the page loads, the stale
  banner appears (no local data), and building footprints load from
  `../alerts/data/`.
- After merge: both Actions runs green, then the live URL checks above.
