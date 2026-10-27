# DEFNS Alerts dashboard

Source files for the **Debris Flow Early Notification System** dashboard.

**Offline since 2026-10-22.** The exploratory dashboard was taken down in favor of DFENS Simple (`simple/`): `/alerts/` pages
redirect to <https://landslidesncgs.org/simple/>, and
<https://dashboard.landslidesncgs.org/> now serves DFENS Simple (see
`infra/cloudfront/`). The code is kept here, and the daily pipeline still
writes `alerts/data/` to S3; the simple page loads its building footprints
from there.

## Phases

This dashboard is being built in three phases.

- **Phase 1 (this commit):** Static HTML/CSS shell. Layout, design system,
  ADA compliance baseline. No live data; controls don&rsquo;t do anything yet.
  Goal: validate look-and-feel against the home page before wiring up JS.
- **Phase 2 (next):** JavaScript controllers. Leaflet map, turf.js
  client-side intersection, alerts table, all interactions. Still using
  mocked JSON so reviewers can click through.
- **Phase 3:** Python data pipeline (`scripts/refresh.py`), run daily on
  GitHub Actions and dispatched from EventBridge. It writes `alerts/data/`
  straight to the S3 data bucket; nothing is committed to git.

## Files

```
alerts/
  index.html              Dashboard page (Phase 1: layout only)
  accessibility.html      WCAG 2.1 AA accessibility statement
  css/
    styles.css            Dark theme matching landslidesncgs.com palette
  js/                     (added in Phase 2)
  data/                   not in git: written to S3 by refresh-data.yml (see OPERATIONS.md)
```

## Accessibility commitments

The dashboard targets **WCAG 2.1 Level AA**. See `accessibility.html` for
the full statement. Highlights:

- Semantic HTML throughout (no `<div>` soup).
- All controls keyboard-operable with visible focus.
- Map is a visual aid; the alerts table is the canonical data source for
  screen-reader users.
- Color is never the only encoding for meaning.

When making changes, test with:

- The `axe` browser extension or `axe-core` CLI
- Lighthouse&rsquo;s Accessibility audit
- Keyboard-only navigation (Tab, Shift+Tab, Enter, Space, Arrow keys)
- A screen reader if available (VoiceOver on Mac, NVDA on Windows)

## Local preview

Open `alerts/index.html` directly in a browser, or run a quick local
server from the repo root:

```bash
python -m http.server 8000
# then visit http://localhost:8000/alerts/
```

## Phase 2 and 3 dependencies (FYI, not yet loaded)

These will be added in later phases:

- [Leaflet](https://leafletjs.com/) &mdash; interactive map
- [esri-leaflet](https://esri.github.io/esri-leaflet/) &mdash; NCGS
  AGOL FeatureServer integration
- [Turf.js](https://turfjs.org/) &mdash; client-side geo intersection
