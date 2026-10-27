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
| `scripts/` | The nightly alert pipeline (`refresh.py`) |
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
  EventBridge: the alerts pipeline daily at 04:00 UTC and DFENS Simple every
  ten minutes. They write only to the data bucket.
- **Infrastructure deploys** run from a developer machine with
  `npx cdk deploy` from `infra/cdk/`; CI only synthesizes. See
  `infra/README.md`.

## Tooling

`npm ci`, then `npm run lint` and `npm run format:check` for the dashboard
JavaScript and CSS, the CloudFront Functions and the CDK TypeScript
(`npm run format` rewrites them); `npm run lint:py` and
`npm run format:py:check` for Python (`ruff` from `requirements-dev.txt`,
installed into `.venv`; `npm run format:py` rewrites). CloudFront function
tests: `node --test "infra/cloudfront/test/*.test.js"`. CDK tests and
typecheck: `npm test` and `npm run typecheck` in `infra/cdk/`.
