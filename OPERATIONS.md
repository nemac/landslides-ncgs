# DEFNS Dashboard - Operations Guide

Quick reference for running the dashboard locally, refreshing data, and
troubleshooting common issues.

## Table of contents

1. [Daily workflow: starting fresh](#daily-workflow-starting-fresh)
2. [Refreshing data](#refreshing-data)
3. [After making code changes](#after-making-code-changes)
4. [Stopping everything](#stopping-everything)
5. [Common issues](#common-issues)
6. [Reference: file locations](#reference-file-locations)

---

## Daily workflow: starting fresh

To open the dashboard from a fully-closed state, you need **two Anaconda Prompt
windows running at the same time**:

### Window 1 — Web server (leave running)

```
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
python -m http.server 8000
```

You'll see `Serving HTTP on :: port 8000`. **Leave this window open**.
Don't type anything else in it. The server stays alive as long as the
window stays open.

### Window 2 — Everything else

```
conda activate EWS
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
```

Use this window to refresh data, run scripts, or anything else. Window 1
just keeps serving files.

### Browser

Open: `http://localhost:8000/alerts/`

**First-time-per-session tip**: press `F12` to open DevTools, click the
**Network** tab, check **"Disable cache"**. Keep DevTools open while
developing. This saves you from cache headaches when files change.

---

## Refreshing data

### Live precipitation (NDFD + MRMS) — most common

In **Window 2**:

```
python scripts/refresh.py
```

Takes 30 seconds to 2 minutes. Writes four files:

- `alerts/data/forecast.geojson`
- `alerts/data/observed.geojson`
- `alerts/data/flagged_ndfd.geojson`
- `alerts/data/flagged_mrms.geojson`

After it finishes, **hard-refresh the browser** (`Ctrl+F5`) to see the new
data on the dashboard.

### Historical event data — only when events change

In **Window 2**:

```
python scripts/refresh.py --hindcast
```

Re-generates files for every event in `scripts/events.py`. Only run this
when:

- You added or edited an event in `events.py`
- You changed an optimization knob in `config.py` (like
  `FLAGGED_MIN_CATEGORY`)
- You want to retry a fetch that failed before

To re-process just one event without touching the others:

```
python scripts/refresh.py --hindcast may_2026_storm
```

After it finishes, **hard-refresh the browser** to see the new historical
data.

### How often to refresh?

| Data | Refresh cadence |
|---|---|
| Live precipitation | Whenever you want current weather. Will be automated via cron in Phase 3b. |
| Historical events | Only when adding events or changing config. Files don't expire. |
| Debris flow polygons | Auto-cached for 30 days. The script handles this transparently. |

---

## After making code changes

The two scenarios behave differently. Pick the right one or things break
silently.

### Frontend changes (HTML, CSS, JS in `alerts/`)

1. **Stop the web server first** (Window 1: `Ctrl+C` or `Ctrl+Break`, or
   just close the window). Windows holds file locks open while
   `python -m http.server` is running, which prevents file overwrites
   from working correctly.
2. Drop the new files into place (`alerts/index.html`,
   `alerts/css/styles.css`, `alerts/js/*.js`, etc.)
3. **Restart the web server** (Window 1):
   ```
   cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
   python -m http.server 8000
   ```
4. **Hard-refresh the browser** (`Ctrl+F5`)

If the dashboard still shows old behavior after a hard refresh, see
[Common issues](#common-issues) below.

### Backend changes (Python files in `scripts/`)

1. Drop the new files into place (`scripts/refresh.py`, `scripts/data.py`,
   etc.)
2. Re-run the relevant refresh command in Window 2:
   ```
   python scripts/refresh.py            # live data
   python scripts/refresh.py --hindcast # historical events
   ```
3. **Hard-refresh the browser** (`Ctrl+F5`)

No need to stop the web server for Python file changes. The server only
serves files in `alerts/`; nothing in `scripts/` runs through it.

### Config file changes (`scripts/config.py`)

Same as backend changes. Edit `config.py`, re-run the appropriate refresh
command, hard-refresh browser.

Examples of config changes:

- `FLAGGED_MIN_CATEGORY = 0` -> `11` for production (smaller files)
- `FLAGGED_SIMPLIFY_METERS = 10` -> `25` (smaller files, less detail)

---

## Stopping everything

### Pause but keep state

Just close the browser tab. Window 1 and Window 2 stay open; nothing is
lost. To resume, just open `http://localhost:8000/alerts/` again.

### Stop the web server

In Window 1: `Ctrl+C` or `Ctrl+Break`, or close the window.

If `Ctrl+C` doesn't work (common on Windows Anaconda Prompt):

- Try `Ctrl+Break` instead
- Or just close the window (the X button)
- Or open Task Manager and end the `python` process

### Stop everything for the day

Close both windows. Close the browser tab. Done. Nothing persists
between sessions on the local machine; the code lives in git.

To restart from scratch tomorrow, go back to
[Daily workflow](#daily-workflow-starting-fresh).

---

## Common issues

### "Site can't be reached" at localhost:8000

The web server isn't running. Open Window 1 and start it:

```
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
python -m http.server 8000
```

### Dashboard looks old after I replaced files

This bites everyone. Multiple possible causes:

1. **Windows didn't actually overwrite the file** (because the server had
   a file lock). Fix: stop server, replace files, restart server,
   hard-refresh. See [After making code changes](#after-making-code-changes).
2. **Browser cached the old version.** Fix: hard-refresh (`Ctrl+F5`), or
   open DevTools (`F12`) -> Network tab -> check "Disable cache".
3. **The file in your editor isn't the one on disk.** Fix: open the file
   in a text editor and search for distinctive text from the new version.

If you're not sure, look at DevTools -> Network -> click the file ->
Response tab. That's the actual content the browser is reading.

### `python: can't open file 'scripts/refresh.py'`

Wrong directory. Make sure you're in the repo root:

```
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
```

### `ModuleNotFoundError: No module named 'geopandas'`

Wrong conda environment. Activate EWS:

```
conda activate EWS
```

The prompt should show `(EWS)` at the start of the line.

### Loading spinner never goes away

Most likely a JavaScript error broke initialization. Open DevTools ->
Console (`F12`). Look for red errors. The first red line is usually the
cause.

If the console shows `[DEFNS] Live data: 4/4 files loaded.` and the
spinner is still visible, that's a CSS specificity bug (the `[hidden]`
attribute isn't winning over `display: flex`). Should be fixed in
current code, but if it returns, search `styles.css` for
`.loading-indicator[hidden]` to verify the override exists.

### `python scripts/refresh.py --hindcast` fails for one event but not others

Normal. Each event is independent. If one event's source data is missing
(404 from NWPS), that event fails but the others continue. Check the
console output for which event failed and why.

For Hurricane Helene specifically, NWPS has data gaps from Sept 27-29,
2024 - the storm took out NCEI's Asheville operations. This is
documented in `events.py`.

### GitHub Desktop says a file is too big to push

`cache/debris_flows.gpkg` is ~560 MB and must never be committed. Verify
the `.gitignore` file at the repo root includes:

```
cache/
*.gpkg
```

If the file shows up in the Changes tab, run from terminal:

```
git rm --cached -r cache
```

This un-tracks it without deleting from disk.

---

## Reference: file locations

| What | Where |
|---|---|
| Repo root | `C:\Users\ijohnson\Documents\GitHub\landslides-ncgs\` |
| Dashboard HTML/CSS/JS | `alerts/` |
| Live data files | `alerts/data/forecast.geojson` etc. |
| Historical event files | `alerts/data/historical/` |
| Python scripts | `scripts/` |
| Debris flow cache | `cache/debris_flows.gpkg` (NEVER commit) |
| Conda environment | EWS (shared with wnc_alert project) |
| Local URL | `http://localhost:8000/alerts/` |
| Production URL (deploy TBD) | `https://landslidesncgs.com/alerts/` |

### Quick commands cheat sheet

```
# Start the day
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs
python -m http.server 8000            (Window 1, leave running)

conda activate EWS                    (Window 2)
cd C:\Users\ijohnson\Documents\GitHub\landslides-ncgs

# Get fresh live data
python scripts/refresh.py

# Regenerate historical events (rare)
python scripts/refresh.py --hindcast

# Browser
http://localhost:8000/alerts/         (then Ctrl+F5 to hard-refresh)
```

---

## Building footprints (Overture Maps)

The dashboard's "Building footprints" reference layer is sourced from Overture Maps Foundation via their official Python client. The pipeline:

1. `scripts/refresh.py` runs the buildings phase as part of every refresh
2. A cache check inside `defns_data.fetch_overture_buildings` skips the slow work if the file is < 30 days old (controlled by `OVERTURE_BUILDINGS_CACHE_TTL_DAYS` in `scripts/config.py`)
3. When stale or missing, the function queries Overture's hosted GeoParquet via DuckDB for the WNC bbox, simplifies geometries to 10m tolerance, and writes `alerts/data/buildings_wnc.geojson`
4. The frontend lazy-loads this file when the user toggles the layer on

### First-run timing
The first extraction takes **5-15 minutes** (it's a large DuckDB query against Overture's S3-hosted GeoParquet). After that, the cache check skips this phase for the next 30 days.

### When to force a fresh extract
Delete `alerts/data/buildings_wnc.geojson` and run `python scripts/refresh.py`. The cache check will see no file and re-extract.

### Output schema
`buildings_wnc.geojson` features have these properties:
- **id** — Overture GERS UUID (stable across releases)
- **class** — Overture building classification (e.g., "residential", "commercial", "industrial")
- **height** — Building height in meters (often null for ML-derived footprints)
- **geometry** — Polygon footprint, WGS84

This schema is the contract for any future spatial-join work (e.g., flagged debris flows × buildings). The frontend currently uses only `geometry`; the other fields are pre-staged for future intersect features.

### Multi-state coverage
Overture is a global dataset. The WNC bbox `(-84.5, 34.8, -81.0, 36.7)` captures buildings in NC, TN, GA, SC, and VA wherever they fall inside the bbox — same multi-state coverage we get for debris flows and county labels.

### Dependencies
The buildings phase requires `overturemaps` and `duckdb` Python packages (see `scripts/requirements.txt`). Install via `pip install -r scripts/requirements.txt`. These are imported lazily inside `fetch_overture_buildings` so the rest of the pipeline runs even if these packages aren't installed — you'd just see a clean error message in the buildings phase.
