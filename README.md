# Landslides in Western North Carolina

Public site for the North Carolina Geological Survey's landslide program at
<https://landslidesncgs.org>, with the DFENS Simple dashboard at `/simple/`
(also served as <https://dashboard.landslidesncgs.org>). Plain HTML, CSS
and JavaScript; no build step. The data pipelines
are Python. The earlier SIREN alerts dashboard under `alerts/` was taken
offline on 2026-10-22 at Ian's request; its code stays in the repo and its
daily pipeline still runs, but `/alerts/` pages redirect to `/simple/`.

| Where | What |
|---|---|
| `index.html` and the other top-level pages, `assets/` | The main site |
| `alerts/` | SIREN dashboard, offline since 2026-10-22 (pages redirect to `/simple/`); data in `alerts/data/`, **not in git** |
| `simple/` | DFENS Simple dashboard and its own 10-minute pipeline |
| `scripts/` | The nightly alert pipeline (`refresh.py`) |
| `infra/` | Every AWS resource, as CDK, plus the cutover runbook |
| `.github/workflows/` | Deploys and data refreshes |

## How it runs

- **AWS account 710482330128** holds everything: two Route 53 zones, one
  CloudFront distribution for all production hostnames, a site bucket, a
  data bucket, and the dev site. Defined in `infra/cdk/`; see
  `infra/README.md`.
- **`master`** deploys to production on push. **`development`** deploys to
  <https://dev.landslidesncgs.org> (basic auth), which shows live production
  data.
- **Data** is written only to S3 by the refresh workflows, dispatched from
  EventBridge: the alerts pipeline daily at 04:00 UTC, DFENS Simple every
  ten minutes. Nothing under `alerts/data/` or `simple/data/` is committed.

## Working on it

- Running the pipelines and the site locally: `OPERATIONS.md`.
- Pending work and known issues: `BACKLOG.md`.
- Lint and format tooling: `npm ci`, then `npm run lint`, `npm run format`
  for the dashboard JavaScript and CSS, `ruff check scripts` for Python
  (install dev tools with `pip install -r requirements-dev.txt`).
