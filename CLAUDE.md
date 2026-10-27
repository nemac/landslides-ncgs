# landslides-ncgs

Public site and dashboards for the North Carolina Geological Survey landslide
program. Read `README.md` for the repo layout and architecture, `BACKLOG.md`
for pending work, `OPERATIONS.md` for running things locally, and
`infra/README.md` before touching AWS.

## Branch workflow

- Branches flow **feature -> development -> master**. Open a feature branch
  from `development`, PR it into `development`, then PR `development` into
  `master`. Merge with merge commits.
- `development` is permanent. A push to it deploys the dev site; a push to
  `master` deploys production. Never suggest deleting it, even when it shows
  as fully merged.
- Delete feature branches once merged.

## Pull requests

- Open PRs with an **empty description** unless explicitly asked for one.
  Put the summary and verification in the commit message and in chat.
- Never post comments, reviews or review comments on a PR unless explicitly
  asked.

## Documentation rules

- **Never put personal names in READMEs or other docs.** Refer to people by
  role (the site maintainers, the other contributors) or leave them out.
- Keep `README.md` to purpose, repository structure and architecture.
  Procedures go in `OPERATIONS.md` or `infra/README.md`; pending work goes
  in `BACKLOG.md`.
- Record dates as absolute dates (2026-10-27), never "today" or "last week".

## Site conventions

- Plain HTML, CSS and JavaScript. No build step, no framework.
- Each main-site page is a directory with an `index.html`, served at
  `/<name>/`. Links between pages and to assets are root-absolute
  (`/about/`, `/assets/images/...`). The home page stays at the root.
- Shared images live only under `assets/`; never copy them next to a page.
  The deploy syncs `assets/` separately with a one-day cache.
- Moving or renaming a page needs a 301 from its old URL in
  `infra/cloudfront/landslides-rewrite.js`, with a test, and then a deploy
  of the `Web` stack. Retiring a page: tag the last commit that has it
  (`archive/<what>-<date>`, annotated, with a list of what it preserves),
  delete it and its page-only assets, and have the function answer 410.
- Pipeline outputs (`alerts/data/`, `simple/data/`) are never committed.

## Deploying

- Site content deploys itself on push to `development` or `master`.
- CloudFront functions and every other AWS change deploy from a developer
  machine: `cd infra/cdk && npx cdk diff Web --profile jbliss-landslidesncgs`
  to review, then `npx cdk deploy Web --profile jbliss-landslidesncgs`.
  Log in first with `aws sso login --profile jbliss-landslidesncgs`.
- When a change needs both a function update and new site files, deploy the
  function first, then merge to `master`, so old links never 404 for long.

## Checks before a PR

- `node --test "infra/cloudfront/test/*.test.js"` after any function change.
- `npm test` and `npm run typecheck` in `infra/cdk/` (covers the 10 KB
  composed-function limit).
- After moving pages or assets, resolve every local `src`, `href`, `url()`
  and `data-img` reference in the pages against the tree.
- Preview locally with the `static-site` launch config (a Python HTTP server
  on port 8000) and confirm every asset request returns 200.

## Todos

Details live in `BACKLOG.md`; this is the short list.

- Rewrite `OPERATIONS.md` and `alerts/README.md` to match how the site is
  actually built, refreshed and deployed.
- Link DFENS Simple from the home page when it is ready for the public.
- Add lint, format check, ruff and pipeline tests to `ci.yml`.
- Reproducible snapshots of flagged pipeline runs in S3.
- Run the pipelines on AWS (Fargate or Lambda) instead of GitHub Actions.
- Content-Security-Policy header, started in report-only mode.
- Publish partial `refresh.py` results safely by splitting its exit codes.
- Decide whether `FLAGGED_MIN_CATEGORY = 0` is intended.
- Resolve config drift between `scripts/config.py` and `alerts/js/config.js`.
- Flat-site cleanup: one shared stylesheet for header, nav, footer and tokens.
- Overture buildings layer: vector tiles instead of per-county GeoJSON.
- A custom 404 page: a missing object currently returns S3's raw 403 XML.
- Slack dev requests: a Slack request opens a GitHub issue, an agent run in
  Actions opens a PR with a `pr-N.landslidesncgs.org` preview.
