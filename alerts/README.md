# SIREN alerts dashboard (offline)

The exploratory **Slope Instability and Rainfall Early Notification**
dashboard. Taken offline on 2026-10-22 in favour of DFENS Simple
(`simple/`): every `/alerts/` page now redirects to
<https://landslidesncgs.org/simple/>, and
<https://dashboard.landslidesncgs.org/> serves DFENS Simple (see
`infra/cloudfront/`). Current as of 2026-10-27.

## What is still here and why

```
alerts/
  index.html      The dashboard page (not reachable in production)
  css/styles.css  Dark theme
  js/             config.js, map.js, alerts.js, app.js
  data/           not in git; buildings/ written to S3 by refresh-reference.yml, the rest by a manual refresh-data.yml run
```

- `alerts/data/buildings/` is live: the daily reference check rebuilds it
  when Overture publishes a release, and DFENS Simple reads it. The rest of
  `alerts/data/` is refreshed only by a manual `refresh-data.yml` run.
- The page and its JavaScript are kept in case the full view comes back.
  `simple/js/map.js` began as a copy of `alerts/js/map.js`; the two have
  since diverged, and consolidating them into one shared module is a
  backlog item. The code is still linted and still synced to the buckets.

## Local preview

```bash
python3 -m http.server 8000    # from the repo root
# http://localhost:8000/alerts/
```

The page reads `alerts/data/` on the same origin; sync it from S3 or run
`python scripts/refresh.py` first (`OPERATIONS.md`).

## Third-party libraries

Loaded from unpkg with integrity hashes: Leaflet 1.9.4, esri-leaflet 3.0.12,
esri-leaflet-geocoder 3.1.5 and Turf 7.4.0. `simple/test/sri.test.js` checks
the hashes against the files served.

## Accessibility

The dashboard was built to WCAG 2.1 AA: semantic HTML, keyboard-operable
controls with visible focus, the table as the canonical data source for
screen readers, and colour never the only encoding. Test changes with the
axe browser extension or Lighthouse, keyboard-only navigation, and a screen
reader where possible.
