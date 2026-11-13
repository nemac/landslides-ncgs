# Simulated-storm test mode (work in progress)

**Status: not finished and not used by the page.** Nothing in this folder
is loaded by DFENS Simple or run by any workflow, and the site deploy
skips it. It is kept here so the work is not lost.

## What it is for

A way to show and test the dashboard when no heavy rain is forecast. A
script would write sample storm data, and the page would show it with a
clear warning that it is not a real forecast.

## What is here

`frontend.patch` holds the page-side half, taken out of the live code on
2026-11-12:

- a striped "SIMULATED STORM" banner (`app.js`, `styles.css`);
- forecast rings drawn from the local `forecast_24h.geojson` instead of
  the live NWS layer (`MAP.setForecastLocal` in `map.js`);
- a `SIMULATED-` prefix on the CSV file name (`app.js`);
- a `forecast_source` column in the CSV (`table.js`).

The page turns these on when the flagged file's `meta.simulated` is true.

## What is missing

- The script that makes the sample data. The page code names it
  `pipeline/simulate_storm.py`; it and its `demo/` data folder were never
  committed.
- A fix in `simple/js/app.js`: the patch calls
  `MAP.setForecastLocal(forecast)`, but the load code no longer keeps the
  forecast file in a variable named `forecast`. As written it throws.
- Tests, and an accessibility check of the banner.

## Putting the page code back

From the repo root:

```bash
git apply --3way simple/pipeline/simulated-storm/frontend.patch
```

The patch was made against the commit that added this folder. The four
files it touches will change over time, so expect to fix conflicts by
hand. The original code is also in the `dfens-simple` repo at commit
`2f10f05`.
