"""
update_data_tour.py
Rewrites data-tour.html with all change-log edits applied.

USAGE
-----
1. Save this file in your repo folder (same folder as data-tour.html).
2. In a terminal in that folder, run:    python update_data_tour.py
3. Commit the modified data-tour.html in GitHub Desktop and push.

Tested with Python 3.x — no third-party libraries required.
"""
from pathlib import Path

TARGET_FILENAME = "data-tour.html"

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Data Tour Guide | Landslides in Western North Carolina</title>
  <meta name="description" content="Browse the landslide hazard data layers for Western North Carolina, including landslide points, outlines, deposits, debris flow pathways, and probability of sliding." />
  <!-- Favicon -->
  <link rel="icon" type="image/png" href="assets/images/shared/ncgs-seal.png" />
  <link rel="apple-touch-icon" href="assets/images/shared/ncgs-seal.png" />
  <!-- ArcGIS Maps SDK for JavaScript 4.x -->
  <link rel="stylesheet" href="https://js.arcgis.com/4.31/esri/themes/dark/main.css" />
  <script src="https://js.arcgis.com/4.31/"></script>
  <!-- Source Sans Pro -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    /* ============================================================
       CSS CUSTOM PROPERTIES
    ============================================================ */
    :root {
      --clr-bg: #122518;
      --clr-primary: #C04C00;
      --clr-accent: #3E8452;
      --clr-text: #FFFFFF;
      --clr-text-muted: #D4E8D8;
      --clr-surface: #1C3521;
      --clr-surface-2: #243D29;
      --clr-border: #2E5438;
      --clr-focus: #FFD166;
      --font-main: 'Source Sans 3', 'Source Sans Pro', Arial, sans-serif;
    }

    /* ============================================================
       RESET & BASE
    ============================================================ */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      background: var(--clr-bg);
      color: var(--clr-text);
      font-family: var(--font-main);
      font-weight: 400;
      font-size: 1rem;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ============================================================
       ACCESSIBILITY UTILITIES
    ============================================================ */
    .skip-nav {
      position: absolute; top: -100%; left: 0;
      background: var(--clr-focus); color: #000;
      font-weight: 700; padding: 0.75rem 1.5rem;
      z-index: 9999; text-decoration: none;
      border-radius: 0 0 4px 0; transition: top 0.2s;
    }
    .skip-nav:focus { top: 0; }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    :focus-visible { outline: 3px solid var(--clr-focus); outline-offset: 3px; }
    :focus:not(:focus-visible) { outline: none; }

    /* ============================================================
       SITE HEADER
    ============================================================ */
    .site-header {
      background: var(--clr-bg);
      padding: 1.25rem 2rem;
      display: flex; align-items: center; gap: 1.25rem;
      border-bottom: 3px solid var(--clr-accent);
      flex-shrink: 0;
    }
    .site-header__logo {
      width: 80px; height: 80px; flex-shrink: 0;
      border-radius: 50%; overflow: hidden;
      border: 2px solid var(--clr-accent);
    }
    .site-header__logo img { width: 100%; height: 100%; object-fit: contain; }
    .site-header__text h1 {
      font-size: clamp(1.3rem, 3vw, 2rem);
      font-weight: 700; color: var(--clr-text); line-height: 1.2;
    }
    .site-header__text p {
      font-size: clamp(0.85rem, 1.4vw, 0.95rem);
      color: var(--clr-text-muted); max-width: 65ch; margin-top: 0.3rem;
    }

    /* ============================================================
       MAIN NAVIGATION
    ============================================================ */
    .site-nav {
      background: var(--clr-surface);
      border-bottom: 1px solid var(--clr-border);
      position: sticky; top: 0; z-index: 100; flex-shrink: 0;
    }
    .site-nav__list {
      list-style: none; display: flex; flex-wrap: wrap;
      padding: 0 1rem; max-width: 1400px; margin: 0 auto;
    }
    .site-nav__item a {
      display: block; padding: 1rem 1.5rem;
      color: var(--clr-text-muted); text-decoration: none;
      font-weight: 700; font-size: 0.95rem;
      border-bottom: 3px solid transparent;
      transition: color 0.2s, border-color 0.2s;
      white-space: nowrap;
    }
    .site-nav__item a:hover { color: var(--clr-text); border-bottom-color: var(--clr-accent); }
    .site-nav__item a[aria-current="page"] { color: var(--clr-text); border-bottom-color: var(--clr-primary); }

    /* ============================================================
       PAGE LAYOUT — two-column: sidebar + map
    ============================================================ */
    .page-wrapper { max-width: 1400px; margin: 0 auto; padding: 1.5rem; flex: 1; }
    .page-intro { margin-bottom: 1.25rem; }
    .page-intro h2 { font-size: 1.6rem; font-weight: 700; color: var(--clr-text); margin-bottom: 0.5rem; }
    .page-intro p { color: var(--clr-text-muted); font-size: 0.95rem; }

    /* Two-column layout */
    .tour-layout {
      display: grid;
      grid-template-columns: 260px 1fr;
      grid-template-rows: auto 1fr;
      gap: 0;
      border: 1px solid var(--clr-border);
      border-radius: 6px;
      overflow: hidden;
      min-height: 600px;
    }

    /* ============================================================
       TAB PANEL — LEFT SIDEBAR
    ============================================================ */
    .tab-list-wrap {
      background: var(--clr-surface);
      border-right: 1px solid var(--clr-border);
      grid-row: 1 / 3;
    }
    .tab-list { list-style: none; display: flex; flex-direction: column; }

    .tab-btn {
      width: 100%; padding: 1rem 1.25rem;
      background: transparent; border: none;
      border-left: 4px solid transparent;
      border-bottom: 1px solid var(--clr-border);
      color: var(--clr-text-muted);
      font-family: var(--font-main); font-weight: 700; font-size: 0.95rem;
      text-align: left; cursor: pointer;
      transition: background 0.18s, border-left-color 0.18s, color 0.18s;
    }
    .tab-btn:hover { background: var(--clr-surface-2); color: var(--clr-text); border-left-color: var(--clr-accent); }
    .tab-btn[aria-selected="true"] { background: var(--clr-surface-2); color: var(--clr-text); border-left-color: var(--clr-primary); }

    /* ============================================================
       MAP AREA — RIGHT COLUMN (top)
    ============================================================ */
    .map-container { position: relative; min-height: 420px; background: #0d1f12; }
    #tourMap { width: 100%; height: 100%; min-height: 420px; }

    .map-loading {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(18,37,24,0.85);
      color: var(--clr-text-muted); font-size: 1rem; font-weight: 700;
      z-index: 10; transition: opacity 0.4s;
    }
    .map-loading.hidden { opacity: 0; pointer-events: none; }
    .map-loading__spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--clr-border);
      border-top-color: var(--clr-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 0.75rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .map-sr-note {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: rgba(18,37,24,0.9);
      padding: 0.4rem 0.75rem; font-size: 0.78rem;
      color: var(--clr-text-muted); z-index: 5;
    }

    /* ============================================================
       DESCRIPTION PANEL — RIGHT COLUMN (bottom)
    ============================================================ */
    .desc-panels {
      border-top: 1px solid var(--clr-border);
      background: var(--clr-surface-2);
      padding: 1.25rem 1.5rem;
      overflow-y: auto;
    }
    .tab-panel { display: none; }
    .tab-panel[aria-hidden="false"] { display: block; }
    .tab-panel__legend {
      display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.75rem;
    }
    .legend-swatch {
      width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
      border: 2px solid rgba(255,255,255,0.3);
    }
    .tab-panel__legend-label { font-weight: 700; font-size: 1rem; color: var(--clr-text); }
    .tab-panel p { font-size: 0.95rem; color: var(--clr-text-muted); line-height: 1.65; }

    /* ============================================================
       COUNTY PROGRESS NOTE
    ============================================================ */
    .county-note {
      margin-top: 1.5rem; padding: 0.9rem 1.25rem;
      background: var(--clr-surface);
      border-left: 4px solid var(--clr-accent);
      border-radius: 0 4px 4px 0;
      font-size: 0.9rem; color: var(--clr-text-muted);
    }
    .county-note strong { color: var(--clr-text); }

    /* ============================================================
       FOOTER
    ============================================================ */
    .site-footer {
      background: var(--clr-surface);
      border-top: 3px solid var(--clr-primary);
      padding: 1.75rem 2rem; flex-shrink: 0;
    }
    .site-footer__inner { max-width: 1400px; margin: 0 auto; }
    .site-footer__org { font-size: 1rem; font-weight: 700; color: var(--clr-accent); }
    .site-footer__detail { font-size: 0.9rem; color: var(--clr-text-muted); margin-top: 0.25rem; }
    .site-footer__detail a { color: var(--clr-text-muted); text-decoration: underline; }
    .site-footer__detail a:hover { color: var(--clr-text); }

    /* ============================================================
       RESPONSIVE
    ============================================================ */
    @media (max-width: 768px) {
      .tour-layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto auto auto;
      }
      .tab-list-wrap { grid-row: auto; border-right: none; border-bottom: 1px solid var(--clr-border); }
      .tab-list { flex-direction: row; flex-wrap: wrap; }
      .tab-btn {
        border-left: none; border-bottom: 3px solid transparent;
        padding: 0.75rem 1rem; font-size: 0.85rem;
      }
      .tab-btn[aria-selected="true"] { border-bottom-color: var(--clr-primary); border-left: none; }
      .site-header { padding: 1rem; }
      .site-header__logo { width: 60px; height: 60px; }
    }
  </style>
</head>
<body>
  <a class="skip-nav" href="#main-content">Skip to main content</a>

  <!-- ============================================================
       SITE HEADER
  ============================================================ -->
  <header class="site-header" role="banner">
    <div class="site-header__logo">
      <a href="index.html" aria-label="Return to home page">
        <!-- CHANGE 1: updated logo path to shared subfolder -->
        <img src="assets/images/shared/ncgs-seal.png" alt="North Carolina Geological Survey seal" />
      </a>
    </div>
    <div class="site-header__text">
      <h1>Landslides in Western North Carolina</h1>
      <p>
        Explore current and historical information about landslides across the region,
        and access resources to help you plan for and build resilience to landslide hazards.
      </p>
    </div>
  </header>

  <!-- ============================================================
       MAIN NAVIGATION
  ============================================================ -->
  <nav class="site-nav" aria-label="Main navigation">
    <ul class="site-nav__list" role="list">
      <li class="site-nav__item"><a href="index.html">Home</a></li>
      <li class="site-nav__item"><a href="data-tour.html" aria-current="page">Data Tour Guide</a></li>
      <li class="site-nav__item"><a href="learn-more.html">Learn More</a></li>
      <li class="site-nav__item"><a href="downloads.html">Downloads</a></li>
      <li class="site-nav__item"><a href="about.html">About</a></li>
    </ul>
  </nav>

  <!-- ============================================================
       MAIN CONTENT
  ============================================================ -->
  <main id="main-content" class="page-wrapper">
    <div class="page-intro">
      <h2>Data Description</h2>
      <p>
        The intent of the landslide hazard mapping program is to provide the public, local government,
        and local and state emergency agencies with a description and the location of areas where slope
        movements have occurred, or are likely to occur, and the general areas that may potentially be
        exposed to these slope movements.
      </p>
      <p style="margin-top:0.5rem;">
        The data produced by the landslide hazard mapping program are described below. Browse the data
        to learn how they contribute to understanding landslide events in western North Carolina.
      </p>
    </div>

    <!-- ============================================================
         TAB INTERFACE + MAP
         ARIA pattern: tablist / tab / tabpanel
    ============================================================ -->
    <div class="tour-layout">

      <!-- LEFT: Tab list -->
      <div class="tab-list-wrap" role="presentation">
        <ul class="tab-list" role="tablist" aria-label="Landslide data layers" aria-orientation="vertical">
          <li role="presentation">
            <button class="tab-btn" role="tab" id="tab-points"
              aria-controls="panel-points" aria-selected="true" data-layer="points"
            >Landslide Points</button>
          </li>
          <li role="presentation">
            <button class="tab-btn" role="tab" id="tab-outlines"
              aria-controls="panel-outlines" aria-selected="false" data-layer="outlines"
            >Landslide Outlines</button>
          </li>
          <li role="presentation">
            <button class="tab-btn" role="tab" id="tab-deposits"
              aria-controls="panel-deposits" aria-selected="false" data-layer="deposits"
            >Landslide Deposits</button>
          </li>
          <li role="presentation">
            <button class="tab-btn" role="tab" id="tab-debris"
              aria-controls="panel-debris" aria-selected="false" data-layer="debris"
            >Potential Debris Flows</button>
          </li>
          <li role="presentation">
            <button class="tab-btn" role="tab" id="tab-sliding"
              aria-controls="panel-sliding" aria-selected="false" data-layer="sliding"
            >Probability of Sliding</button>
          </li>
        </ul>
      </div>

      <!-- RIGHT TOP: Map -->
      <div class="map-container" role="region" aria-label="Interactive landslide data map">
        <div class="map-loading" id="mapLoading" aria-live="polite" aria-label="Map loading">
          <div class="map-loading__spinner" aria-hidden="true"></div>
          Loading map&hellip;
        </div>
        <div id="tourMap" tabindex="0"
          aria-label="Landslide data map for Western North Carolina. Use arrow keys to pan, plus and minus to zoom.">
        </div>
        <div class="map-sr-note" aria-live="polite" id="mapStatus">
          Map showing: <strong id="currentLayerName">Landslide Points</strong>
        </div>
      </div>

      <!-- RIGHT BOTTOM: Description panels -->
      <div class="desc-panels">

        <!-- Panel: Landslide Points -->
        <div id="panel-points" role="tabpanel" aria-labelledby="tab-points"
          aria-hidden="false" class="tab-panel">
          <div class="tab-panel__legend">
            <div class="legend-swatch" style="background:#E8001C;" aria-hidden="true"></div>
            <span class="tab-panel__legend-label">Landslide Points</span>
          </div>
          <p>
            Landslide points identify the initiation (source) areas of slope movements. Attributes of
            this layer include descriptions of slope movement type, location, dimensions, movement dates,
            and geomorphic, hydrologic, and other site data for individual slope movements, where known.
          </p>
        </div>

        <!-- Panel: Landslide Outlines -->
        <div id="panel-outlines" role="tabpanel" aria-labelledby="tab-outlines"
          aria-hidden="true" class="tab-panel">
          <div class="tab-panel__legend">
            <div class="legend-swatch" style="background:transparent;border:2px solid #FFFF00;border-radius:2px;" aria-hidden="true"></div>
            <span class="tab-panel__legend-label">Landslide Outlines</span>
          </div>
          <p>
            Landslide Outlines show the approximate areal extents of relatively recent, individual slope
            movements where their initiation (source) areas are known. Outlines were determined from field
            investigations, features visible in various vintages (1940&ndash;most current) of aerial
            photography and orthophotography, and a variety of digital maps derived from LiDAR digital
            elevation models.
          </p>
        </div>

        <!-- Panel: Landslide Deposits — CHANGE 3: dual swatches -->
        <div id="panel-deposits" role="tabpanel" aria-labelledby="tab-deposits"
          aria-hidden="true" class="tab-panel">
          <div class="tab-panel__legend" style="flex-direction:column;align-items:flex-start;">
            <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;">
              <div class="legend-swatch" style="background:#FFAA00;border-radius:2px;" aria-hidden="true"></div>
              <span class="tab-panel__legend-label">Not Field Verified</span>
            </div>
            <div style="display:flex;align-items:center;gap:.4rem;">
              <div class="legend-swatch" style="background:#FFAA00;border:2px solid #9fe671;border-radius:2px;" aria-hidden="true"></div>
              <span class="tab-panel__legend-label">Field Verified</span>
            </div>
          </div>
          <p>
            Landslide Deposits represent the areal extents of significant volumes of earth, debris, and
            rock fragments that have accumulated primarily because of past debris flows and debris slides
            and, to a lesser extent, rock falls and rockslides. These deposits indicate areas that can be
            affected by future landslides and can be unstable in some circumstances. Debris flow deposits
            mainly occur in valleys and can transition upslope into debris slide, rock fall, and rockslide
            deposits nearer steep source areas.
          </p>
        </div>

        <!-- Panel: Potential Debris Flows — CHANGE 4: swatch color updated -->
        <div id="panel-debris" role="tabpanel" aria-labelledby="tab-debris"
          aria-hidden="true" class="tab-panel">
          <div class="tab-panel__legend">
            <div class="legend-swatch" style="background:#fcecc2;border:2px solid transparent;border-radius:2px;" aria-hidden="true"></div>
            <span class="tab-panel__legend-label">Potential Debris Flow Pathways</span>
          </div>
          <p>
            The Potential Debris Flow Pathways layer shows where landslides might go if a slope movement
            occurs from a high landslide susceptibility area. Changes in the landscape as a result from
            human activity, future debris flows, and other types of landslides can alter the potential
            pathways of subsequent debris flows; therefore, this data represents general areas that could
            potentially be affected by future landslide impacts.
          </p>
        </div>

        <!-- Panel: Probability of Sliding — CHANGE 5: dual swatches High/Moderate -->
        <div id="panel-sliding" role="tabpanel" aria-labelledby="tab-sliding"
          aria-hidden="true" class="tab-panel">
          <div class="tab-panel__legend" style="flex-direction:column;align-items:flex-start;">
            <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;">
              <div class="legend-swatch" style="background:#FF0000;border-radius:2px;" aria-hidden="true"></div>
              <span class="tab-panel__legend-label">High</span>
            </div>
            <div style="display:flex;align-items:center;gap:.4rem;">
              <div class="legend-swatch" style="background:#FFAA00;border-radius:2px;" aria-hidden="true"></div>
              <span class="tab-panel__legend-label">Moderate</span>
            </div>
          </div>
          <p>
            This layer shows areas where debris flows and debris slides might start on unmodified slopes.
            Landslides happen under specific conditions; therefore, the likelihood of occurrence is
            relatively small. Debris flows and debris slides originating on unmodified slopes become more
            frequent in Western North Carolina when precipitation is 5 inches or more in a 24-hour period.
            Be aware of High and Moderate Probability of Sliding areas during extreme precipitation events.
            Use caution when modifying High and Moderate slopes because they may be unstable with or
            without extreme rain events.
          </p>
        </div>

        <!-- CHANGE 6: "Did you know?" box (hidden — restore by removing display:none) -->
        <div class="county-note" role="note" style="display:none;">
          <strong>Did you know?:</strong> Lorem ipsum dolor sit amet, consectetur adipiscing elit,
          sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
        </div>

      </div><!-- /.desc-panels -->
    </div><!-- /.tour-layout -->
  </main>

  <!-- ============================================================
       SITE FOOTER
  ============================================================ -->
  <footer class="site-footer" role="contentinfo">
    <div class="site-footer__inner">
      <div class="site-footer__org">North Carolina Geological Survey</div>
      <div class="site-footer__detail">Asheville Regional Office</div>
      <div class="site-footer__detail">
        <a href="tel:+18282964500">828-296-4500</a>
      </div>
    </div>
  </footer>

  <!-- ============================================================
       ARCGIS JS API — Map initialization & tab layer toggling
  ============================================================ -->
  <script>
    require([
      "esri/Map",
      "esri/views/MapView",
      "esri/layers/FeatureLayer",
      "esri/layers/MapImageLayer"
    ], function(Map, MapView, FeatureLayer, MapImageLayer) {

      const BASE_URL = "https://maps.deq.nc.gov/arcgis/rest/services/DEMLR/NCGS_Landslide_Read_Vector/FeatureServer";

      // All 5 layers loaded explicitly — full visibility control, no ID guesswork
      const layers = {
        points: new FeatureLayer({
          url: BASE_URL + "/0",
          visible: true,
          title: "Landslide Points"
        }),
        outlines: new FeatureLayer({
          url: BASE_URL + "/1",
          visible: false,
          title: "Landslide Outlines"
        }),
        deposits: new FeatureLayer({
          url: BASE_URL + "/2",
          visible: false,
          title: "Landslide Deposits"
        }),
        debris: new MapImageLayer({
          url: "https://maps.deq.nc.gov/arcgis/rest/services/DEMLR/North_Carolina_Channelized_Debris_Flow_Susceptibility_Model/MapServer",
          visible: false,
          title: "Potential Debris Flow Pathways"
        }),
        sliding: new MapImageLayer({
          url: "https://maps.deq.nc.gov/arcgis/rest/services/DEMLR/Landslide_Susceptibility/MapServer",
          visible: false,
          title: "Probability of Sliding"
        })
      };

      const LAYER_LABELS = {
        points:  "Landslide Points",
        outlines:"Landslide Outlines",
        deposits:"Landslide Deposits",
        debris:  "Potential Debris Flow Pathways",
        sliding: "Probability of Sliding"
      };

      const map = new Map({
        basemap: "topo-vector",
        layers: Object.values(layers)
      });

      const view = new MapView({
        container: "tourMap",
        map: map,
        center: [-82.17, 35.58],
        zoom: 8,
        ui: { components: ["zoom", "attribution"] }
      });

      let activeLayer = "points";

      view.when(() => {
        document.getElementById("mapLoading").classList.add("hidden");

        // Keyboard pan/zoom support
        const mapDiv = document.getElementById("tourMap");
        mapDiv.addEventListener("keydown", (e) => {
          switch (e.key) {
            case "ArrowLeft":
              view.goTo({ center: [view.center.longitude - 0.5, view.center.latitude] });
              e.preventDefault(); break;
            case "ArrowRight":
              view.goTo({ center: [view.center.longitude + 0.5, view.center.latitude] });
              e.preventDefault(); break;
            case "ArrowUp":
              view.goTo({ center: [view.center.longitude, view.center.latitude + 0.3] });
              e.preventDefault(); break;
            case "ArrowDown":
              view.goTo({ center: [view.center.longitude, view.center.latitude - 0.3] });
              e.preventDefault(); break;
            case "+": case "=":
              view.goTo({ zoom: view.zoom + 1 }); e.preventDefault(); break;
            case "-": case "_":
              view.goTo({ zoom: view.zoom - 1 }); e.preventDefault(); break;
          }
        });
      }).catch(() => {
        document.getElementById("mapLoading").innerHTML =
          '<span style="color:#FFD166;">&#9888; Map could not load. Please check your connection.</span>';
      });

      function setActiveLayer(key) {
        activeLayer = key;
        // Show only the selected layer, hide all others — direct object references
        Object.entries(layers).forEach(([k, layer]) => {
          layer.visible = (k === key);
        });
        document.getElementById("currentLayerName").textContent = LAYER_LABELS[key];
      }

      // ============================================================
      // TAB INTERACTION — WCAG 2.1 pattern
      // ============================================================
      const tabs   = Array.from(document.querySelectorAll('[role="tab"]'));
      const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => activateTab(tab));
        tab.addEventListener("keydown", (e) => {
          let idx = tabs.indexOf(document.activeElement);
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault(); tabs[(idx + 1) % tabs.length].focus();
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault(); tabs[(idx - 1 + tabs.length) % tabs.length].focus();
          } else if (e.key === "Home") {
            e.preventDefault(); tabs[0].focus();
          } else if (e.key === "End") {
            e.preventDefault(); tabs[tabs.length - 1].focus();
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); activateTab(document.activeElement);
          }
        });
      });

      function activateTab(selectedTab) {
        tabs.forEach(t => {
          t.setAttribute("aria-selected", "false");
          t.setAttribute("tabindex", "-1");
        });
        panels.forEach(p => p.setAttribute("aria-hidden", "true"));

        selectedTab.setAttribute("aria-selected", "true");
        selectedTab.removeAttribute("tabindex");

        const panelId = selectedTab.getAttribute("aria-controls");
        document.getElementById(panelId).setAttribute("aria-hidden", "false");

        setActiveLayer(selectedTab.dataset.layer);
      }

      // Initialize tabindex on non-selected tabs
      tabs.forEach((t, i) => { if (i !== 0) t.setAttribute("tabindex", "-1"); });
    });
  </script>
</body>
</html>"""

def main():
    out_path = Path(__file__).resolve().parent / TARGET_FILENAME
    out_path.write_text(HTML, encoding="utf-8", newline="\n")
    print(f"[OK] Wrote {out_path} ({len(HTML):,} bytes)")

if __name__ == "__main__":
    main()
