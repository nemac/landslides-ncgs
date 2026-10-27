# Landslides in Western North Carolina

Public website for the North Carolina Geological Survey's landslide program
at <https://landslidesncgs.org>, with the DFENS Simple debris-flow dashboard
at `/simple/` (also served as <https://dashboard.landslidesncgs.org>). The
site is plain HTML, CSS and JavaScript with no build step; the data
pipelines are Python.

## Repository structure

| Path | What |
|---|---|
| `index.html`, `about/`, `downloads/`, `learn-more/`, `reducing-landslide-risk/` | The main site, one directory per page, served at `/<name>/` |
| `assets/` | Images shared by every page |
| `simple/` | DFENS Simple dashboard and its ten-minute data pipeline |
| `alerts/` | The earlier SIREN dashboard, offline since 2026-10-22; its pages redirect to `/simple/` and its daily pipeline still writes `alerts/data/` |
| `scripts/` | The alerts pipeline (`refresh.py`, manual since 2026-10-27) and the daily reference-data check (`reference_check.py`) |
| `infra/` | Every AWS resource as a CDK app, the CloudFront functions, and the cutover runbook |
| `.github/workflows/` | CI, site deploys and data refreshes |
| `BACKLOG.md` | Pending work and known issues |
| `OPERATIONS.md` | Running the pipelines and the site locally |

Nothing under `alerts/data/` or `simple/data/` is committed; that data lives
only in S3.

## Architecture

- **One AWS account** (710482330128) holds everything, defined in
  `infra/cdk/`: two Route 53 zones and one certificate (`Dns` stack); the
  production CloudFront distribution for every public hostname, the site
  bucket, the data bucket, and the dev distribution and bucket (`Web`
  stack); the GitHub OIDC roles the workflows assume (`Ci` stack); and the
  EventBridge schedules that trigger the data refreshes (`Trigger` stack).
- **CloudFront functions** in `infra/cloudfront/` do the URL work the S3
  origin cannot: append `index.html` to directory URLs, redirect old flat
  page names, answer 410 for retired pages, map the dashboard host onto
  `/simple/`, and put basic auth in front of the dev site.
- **Branches deploy.** A push to `master` deploys production; a push to
  `development` deploys <https://dev.landslidesncgs.org>, which sits behind
  basic auth and reads live production data. Both use the reusable
  `deploy-site.yml` workflow, which syncs the tree to the bucket and
  invalidates CloudFront.
- **Data refreshes** run as GitHub Actions workflows dispatched by
  EventBridge: DFENS Simple every ten minutes, and a daily check of the two
  slow-changing reference datasets that rebuilds only what changed. They
  write only to the data bucket. See the next section.
- **Infrastructure deploys** run from a developer machine with
  `npx cdk deploy` from `infra/cdk/`; CI only synthesizes. See
  `infra/README.md`.

## GitHub workflows

Everything automated lives in `.github/workflows/`. GitHub's own cron runs
hours late for this repository, so the scheduled workflows are dispatched
on time by EventBridge Scheduler through a small Lambda
(`infra/cdk/lib/trigger-stack.ts`); each workflow keeps its cron only as a
backup, and a concurrency group stops two runs of the same workflow from
overlapping. Workflows that touch AWS assume an OIDC role; no AWS keys are
stored in GitHub. Nothing any workflow produces is committed to git.

| Workflow | Runs | What it does |
|---|---|---|
| `ci.yml` | Every pull request | Three jobs: CDK typecheck, tests and synth plus the CloudFront function and Simple-pipeline tests; ESLint, Prettier, ruff, the Lambda tests and the CDN integrity-hash check; and the `scripts/` tests in the pinned Python environment. `master` requires the first job to pass. |
| `deploy-dev.yml` | Push to `development` | Deploys the tree to the dev bucket and invalidates the dev distribution, via `deploy-site.yml`. |
| `deploy-prod.yml` | Push to `master` | The same for production. |
| `deploy-site.yml` | Called by the two above | Syncs pages, CSS and JS with `no-cache` and `assets/` with a one-day cache, deleting files that left the repo, then invalidates CloudFront. Pipelines, infra, docs and data folders are excluded. |
| `refresh-simple.yml` | Every 10 minutes (EventBridge) | The DFENS Simple pipeline. A stdlib check asks NDFD whether the forecast changed; if not, only `status.json` is re-uploaded as a heartbeat. If it did, the forecast and flagged files are rebuilt, downloading the debris-flow GeoPackage from the bucket only when rain at or above the threshold is forecast. Any run that flags pathways is also copied to `simple/archive/<timestamp>/` in the data bucket and kept for good. A `force` input rebuilds regardless. |
| `refresh-reference.yml` | Daily at 05:00 UTC (EventBridge) | Keeps the building footprints and the debris-flow GeoPackage current. `scripts/reference_check.py` reads Overture's latest release id and the NCGS layer's edit date, logs both next to the values recorded at the last build, and rebuilds a dataset only when its marker changed, when its last build is 90 days old, or when `force` is set. What was built is recorded in `alerts/data/reference_state.json`. |
| `refresh-data.yml` | Manual only | The full alerts pipeline for the offline SIREN dashboard. Off the schedule since 2026-10-27; run it from the Actions tab to regenerate that dashboard's files. |
| `token-expiry-reminder.yml` | Once, a month before the GitHub token expires (EventBridge) | Opens an issue with the renewal steps. A `dry_run` input prints the issue instead. |

The EventBridge schedules are `landslides-refresh-simple-10min`,
`landslides-refresh-reference-daily` and the one-time token reminder. They
need a deploy of the `Trigger` stack when they change.

## Tooling

`npm ci`, then `npm run lint` and `npm run format:check` for the dashboard
JavaScript and CSS, the CloudFront Functions and the CDK TypeScript
(`npm run format` rewrites them); `npm run lint:py` and
`npm run format:py:check` for Python (`ruff` from `requirements-dev.txt`,
installed into `.venv`; `npm run format:py` rewrites). CloudFront function
tests: `node --test "infra/cloudfront/test/*.test.js"`. CDK tests and
typecheck: `npm test` and `npm run typecheck` in `infra/cdk/`.
