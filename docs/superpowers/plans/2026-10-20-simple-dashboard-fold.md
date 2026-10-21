# DFENS Simple Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Ian's DFENS Simple dashboard and its 10-minute pipeline into this repo as `simple/`, so it deploys with the main site and is live at https://landslidesncgs.org/simple/ before 10:30 AM ET on 2026-10-21.

**Architecture:** Static page under `simple/` ships with the existing root-to-bucket sync in `deploy-prod.yml`. A second cron workflow runs Ian's two-step check-then-build pipeline from `simple/pipeline/`, importing the shared modules from `scripts/`, and uploads three small files to `s3://landslides-ncgs/simple/data/`. Nothing under `simple/data/` is ever in git.

**Tech Stack:** Plain HTML/CSS/JS (Leaflet), Python 3.11 with geopandas via micromamba, GitHub Actions, AWS CLI with the existing OIDC role.

**Spec:** `docs/superpowers/specs/2026-10-20-simple-dashboard-fold-design.md`

**Source:** Ian's repo is downloaded read-only at
`/private/tmp/claude-502/-Users-jbliss-github-landslides-ncgs/9b3e7481-3622-4563-8b04-77058cf27eb8/scratchpad/dfens-simple` (referred to as `$SRC` below).

## Global Constraints

- Branch `simple-dashboard` from `origin/development` (ccf884c). PR targets `master`, merged with a merge commit.
- No IAM, bucket, or CloudFront changes. Role `arn:aws:iam::104538610210:role/landslides-github-actions-prod`, bucket `landslides-ncgs`, distribution `E139BPMQTMFRUH`, region `us-east-1`, environment `production`.
- Ian's page, styles and pipeline logic are not changed; only paths and imports.
- Every commit credits Ian in the body: `Co-Authored-By: Ian J. <ijohnson@unca.edu>` plus the Claude line from CLAUDE.md. Subject 100 chars or less, body bullets 80 chars or less.
- `simple/data/`, `out/`, `cache/` are never committed.

## Review Focus

1. A main-site deploy after the fold must not delete `simple/data/*` (the `--delete` sync). Covered by Task 1's grep check on `deploy-prod.yml`.
2. `simple/pipeline/*.py` and `simple/README.md` must not land in the public bucket. Covered by Task 1's exclude list check.
3. `refresh_simple.py` must import `data`, `analysis`, `config` from `scripts/` when run from the repo root, with no `shared/` directory present. Covered by Task 2's import check.
4. `ndfd_check.py` must run on stdlib only (the workflow's first step has no geopandas). Covered by Task 2's run under the system Python.
5. The page served at `/simple/` must find `../alerts/data/buildings/manifest.json` on the same origin. Covered by Task 1's local serve check.

---

### Task 1: Site files, gitignore, deploy exclude

**Files:**
- Create: `simple/index.html`, `simple/css/styles.css`, `simple/js/{app,config,map,table}.js` (copied verbatim from `$SRC`)
- Modify: `.gitignore` (append `simple/data/` and `out/`)
- Modify: `.github/workflows/deploy-prod.yml:51-72` (sync excludes)

- [ ] **Step 1: Copy the page**

Run from the worktree root:
```bash
mkdir -p simple && cp -R "$SRC/index.html" "$SRC/css" "$SRC/js" simple/
```
Expected: `simple/index.html`, `simple/css/styles.css`, four files in `simple/js/`. `git status` shows only additions.

- [ ] **Step 2: Ignore pipeline outputs**

Append to `.gitignore` under the "Build artifacts and caches" block:
```
simple/data/
out/
```

- [ ] **Step 3: Fix the deploy excludes**

In `deploy-prod.yml`, replace the line `--exclude "simple/*"` with two lines:
```
            --exclude "simple/data/*" \
            --exclude "simple/pipeline/*"
```
Update the comment above the step: `simple/data/` is written by `refresh-simple.yml` and must never be touched by the site sync; `simple/pipeline/` is not web content.

- [ ] **Step 4: Verify the excludes**

Run: `grep -n 'simple' .github/workflows/deploy-prod.yml`
Expected: the comment, `simple/data/*` and `simple/pipeline/*`; no bare `simple/*`.

- [ ] **Step 5: Verify the page serves on the same origin as buildings**

Run from the worktree root (background): `python3 -m http.server 8765`
Then:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/simple/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/simple/js/config.js
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/alerts/data/buildings/manifest.json
```
Expected: `200` three times. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add simple .gitignore .github/workflows/deploy-prod.yml
git commit -m "Add DFENS Simple page under simple/ and keep its S3 data out of the site sync"
```

---

### Task 2: Pipeline importing from scripts/

**Files:**
- Create: `simple/pipeline/settings.py`, `simple/pipeline/ndfd_check.py` (verbatim from `$SRC/pipeline/`)
- Create: `simple/pipeline/refresh_simple.py` (from `$SRC`, imports changed)
- Create: `simple/pipeline/run_local.py` (from `$SRC`, paths changed)
- Do not create: `simple/pipeline/shared/`

**Interfaces:**
- Consumes: `scripts/data.fetch_debris_flows()`, `scripts/analysis.find_alerts(debris_gdf, precip_gdf)`, `scripts/config.{DISPLAY_CRS, INTERSECTION_CRS}`. Unchanged modules.
- Produces: `python simple/pipeline/ndfd_check.py --out <dir>` and `python simple/pipeline/refresh_simple.py --out <dir>`, run from the repo root, used by Task 3.

- [ ] **Step 1: Copy the four pipeline files**

```bash
mkdir -p simple/pipeline
cp "$SRC"/pipeline/{settings,ndfd_check,refresh_simple,run_local}.py simple/pipeline/
```

- [ ] **Step 2: Point `refresh_simple.py` at `scripts/`**

Replace
```python
sys.path.insert(0, str(HERE / "shared"))
```
with
```python
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))
```
Update the module docstring's "Run from the repo root" line to `python simple/pipeline/refresh_simple.py --out out` and the two `# (main pipeline's ...)` import comments to say the modules come from `scripts/`.

- [ ] **Step 3: Rework `run_local.py` paths**

Same `sys.path` change as Step 2. Then:
- `REPO = HERE.parent.parent` (the landslides-ncgs root, not `simple/`).
- `DATA_DIR = REPO / "simple" / "data"`; `CACHE_FILE = REPO / "cache" / "debris_flows.gpkg"`.
- Delete `DEFAULT_MAIN_REPO`, `seed_debris_cache()`, the `--main-repo` argument and `Handler.alerts_data`. The HTTP handler serves `REPO` as its root, so `/simple/` and `/alerts/data/` both resolve naturally; keep the no-cache headers and the `/simple/data/` route pointing at `DATA_DIR`.
- Update the module docstring: usage is `python simple/pipeline/run_local.py` from the repo root, page at `http://localhost:8000/simple/`.
- Keep `--warm`, `--force`, `--once`, `--interval`, `--port`, `--host`.

- [ ] **Step 4: Compile**

Run: `python3 -I -m py_compile simple/pipeline/*.py && echo OK`
Expected: `OK`.

- [ ] **Step 5: Stdlib check runs**

Run from the worktree root with the system Python (no geopandas):
`STATUS_URL=https://landslidesncgs.org/simple/data/status.json python3 simple/pipeline/ndfd_check.py --out /tmp/simple-check`
Expected: lines starting `[check] no previous status`, `[check] NDFD updated ...`, `[check] action=build heavy=false` (or `true` if rain is forecast), exit 0, and `/tmp/simple-check/check.json` exists.

- [ ] **Step 6: Import check for the geopandas path**

Run from the worktree root in an environment with geopandas (the `defns-refresh` conda env if present, else `micromamba create -n dfens-simple python=3.11 geopandas requests`):
`python -c "import sys; sys.path.insert(0,'simple/pipeline'); import refresh_simple; print(refresh_simple.shared_data.__file__)"`
Expected: a path ending in `scripts/data.py`.
If no geopandas environment is available locally, record that here and rely on Task 3's workflow run.

- [ ] **Step 7: Commit**

```bash
git add simple/pipeline
git commit -m "Add the DFENS Simple pipeline, importing the shared modules from scripts/"
```

---

### Task 3: Refresh workflow

**Files:**
- Create: `.github/workflows/refresh-simple.yml` (from `$SRC/.github/workflows/refresh.yml`)

**Interfaces:**
- Consumes: Task 2's two scripts, run from the repo root.

- [ ] **Step 1: Copy and rename**

`cp "$SRC/.github/workflows/refresh.yml" .github/workflows/refresh-simple.yml`

- [ ] **Step 2: Edit paths and names**

- `name:` → `Refresh DFENS Simple data (every 10 min)`.
- `python pipeline/ndfd_check.py --out out` → `python simple/pipeline/ndfd_check.py --out out`; same for `refresh_simple.py`.
- Concurrency group stays `refresh-ndfd`; rename to `refresh-simple` for clarity.
- Header comment: replace "This repo therefore has its own lean pipeline" wording with one line saying this is the simple dashboard's pipeline inside landslides-ncgs, independent of the nightly `refresh-data.yml`, and that the `actions/cache` key is shared with it on purpose.
- Everything else (cron, environment, cache key `debris-gpkg-v1-${{ steps.cachemonth.outputs.ym }}`, micromamba env, S3 paths, cache-control headers) unchanged.

- [ ] **Step 3: Validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/refresh-simple.yml')); print('yaml ok')"` (if PyYAML is missing, `ruby -ryaml -e 'YAML.load_file(ARGV[0]); puts "yaml ok"' .github/workflows/refresh-simple.yml`).
Expected: `yaml ok`.
Run: `grep -n 'simple/pipeline' .github/workflows/refresh-simple.yml`
Expected: two matches.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/refresh-simple.yml
git commit -m "Add the 10-minute DFENS Simple refresh workflow writing to simple/data/ on S3"
```

---

### Task 4: Docs

**Files:**
- Create: `simple/README.md` (from `$SRC/README.md`)
- Modify: `OPERATIONS.md` (add a short section)

- [ ] **Step 1: Adapt Ian's README**

Copy `$SRC/README.md` to `simple/README.md`. Edit:
- Intro: it now lives in `landslides-ncgs` under `simple/`.
- "Data pipeline" tree: `.github/workflows/refresh-simple.yml`, `simple/pipeline/...`.
- Remove the paragraph about `pipeline/shared/` copies; say the pipeline imports `scripts/data.py`, `scripts/analysis.py`, `scripts/config.py` directly.
- "Deploy": the main `deploy-prod.yml` ships `simple/` with the site; `refresh-simple.yml` writes `simple/data/`. Delete the five "Before the first run" IAM/environment steps; replace with one line: seed the data by running `refresh-simple.yml` by hand with `force` after the first deploy.
- "Run it locally": `python simple/pipeline/run_local.py` from the repo root in the `defns-refresh` env; drop `--main-repo`.

- [ ] **Step 2: Pointer in OPERATIONS.md**

Add a short section "DFENS Simple (`/simple/`)" after "Refreshing data" with three lines: where the page is, that its data comes from `refresh-simple.yml` and is not in git, and the `run_local.py` command for local testing.

- [ ] **Step 3: Commit**

```bash
git add simple/README.md OPERATIONS.md
git commit -m "Document DFENS Simple inside landslides-ncgs"
```

---

### Task 5: Ship

- [ ] **Step 1: Push and open the PR to master**

```bash
git push -u origin simple-dashboard
gh pr create --base master --title "Fold DFENS Simple into landslides-ncgs as simple/" --body-file <body>
```
Body bullets (100 chars max each): what moved, the deploy exclude change, the new workflow, that this also ships Ian's NDFD window fix from development, and the go-live steps below.

- [ ] **Step 2: Merge with a merge commit** (Jeff confirms, since this deploys to production)

`gh pr merge --merge`. Watch `Deploy to production` succeed.

- [ ] **Step 3: Seed the data**

`gh workflow run refresh-simple.yml --ref master -f force=true`, then watch it succeed.

- [ ] **Step 4: Verify live**

```bash
curl -sI https://landslidesncgs.org/simple/ | head -1
curl -s https://landslidesncgs.org/simple/data/status.json
```
Expected: `HTTP/2 200`; JSON with `checked_at` within the last few minutes and `result` of `updated`. Open the page in the browser: window shown, no stale banner, buildings load at zoom 12+.

- [ ] **Step 5: Bring development up to date**

```bash
git checkout development && git merge --ff-only origin/master && git push
```
