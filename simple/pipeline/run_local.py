"""
run_local.py - run DFENS Simple entirely on this computer.

Does locally what the two GitHub workflows will do in production:
  * every --interval minutes, runs the same NDFD check + refresh as
    refresh-simple.yml and writes the results into simple/data/
  * serves the repo root at http://localhost:<port>/, so the page is at
    http://localhost:<port>/simple/

URL layout (mirrors production, so relative paths in js/config.js work):
  /simple/...        -> simple/ (index.html, js/, css/)
  /simple/data/...   -> simple/data/ (written by this script, not in git)
  /alerts/data/...   -> alerts/data/ (building footprints)

Usage, from the landslides-ncgs repo root in a terminal whose Python has
geopandas (e.g. an Anaconda Prompt with the EWS env activated):

  python simple/pipeline/run_local.py           # run until Ctrl+C
  python simple/pipeline/run_local.py --warm    # prepare the debris cache first
  python simple/pipeline/run_local.py --once    # one refresh, then just serve
  python simple/pipeline/run_local.py --force   # rebuild even if NDFD unchanged

Needs geopandas whenever NDFD changes (to rebuild the forecast layer);
checks where nothing changed work without it.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent  # .../simple/pipeline
REPO = HERE.parent.parent  # .../landslides-ncgs
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "scripts"))  # shared main-pipeline modules

import ndfd_check  # noqa: E402
import settings as S  # noqa: E402

DATA_DIR = REPO / "simple" / "data"
CACHE_FILE = REPO / "cache" / "debris_flows.gpkg"  # shared with scripts/refresh.py


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Debris-flow cache
# ---------------------------------------------------------------------------
def warm_debris_cache() -> None:
    """Load the debris flows now so the first build is fast. Uses the same
    cache/debris_flows.gpkg as scripts/refresh.py; downloads it from NCGS
    (~10-20 min) only if it is missing or older than the shared TTL."""
    import data as shared_data  # needs geopandas

    t0 = time.time()
    log("Loading debris flows (downloads + tags counties/watersheds if needed)...")
    gdf = shared_data.fetch_debris_flows()
    log(f"Debris flows ready: {len(gdf):,} polygons in {time.time() - t0:.0f}s")


# ---------------------------------------------------------------------------
# One refresh cycle
# ---------------------------------------------------------------------------
def read_status() -> dict | None:
    p = DATA_DIR / "status.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def refresh_once(force: bool) -> None:
    """Run check (+ full build if needed) into a temp folder, then move the
    finished files into simple/data so the page never reads a half-written
    file. Flagged file is moved before status.json, like the production
    upload. The temp folder lives inside simple/data so it is git-ignored
    and on the same filesystem as the destination."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DATA_DIR) as tmp:
        out = Path(tmp)
        # Rebuild if any data file is missing (e.g. first run after an update).
        missing = [
            n for n in (S.FORECAST_FILENAME, S.FLAGGED_FILENAME) if not (DATA_DIR / n).exists()
        ]
        if missing and not force:
            log(f"Missing {', '.join(missing)}; rebuilding.")
        res = ndfd_check.run(out, force=force or bool(missing), prev=read_status())
        action = res["action"]
        if action == "build":
            try:
                import refresh_simple
            except ImportError as e:
                log(
                    f"Can't build: {e}. This Python has no geopandas. Activate a "
                    f"conda env with geopandas and restart. Status not updated, "
                    f"so the page will show as stale."
                )
                return
            refresh_simple.build(out)

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        for name in (S.FORECAST_FILENAME, S.FLAGGED_FILENAME, "status.json", "check.json"):
            src = out / name
            if src.exists():
                os.replace(src, DATA_DIR / name)
        st = read_status() or {}
        log(f"Refresh: {action} | flagged={st.get('n_flagged')} | NDFD updated {st.get('issued')}")


def refresh_loop(interval_min: float, force_first: bool, stop: threading.Event) -> None:
    force = force_first
    while not stop.is_set():
        try:
            refresh_once(force)
        except Exception as e:
            log(f"Refresh FAILED: {type(e).__name__}: {e} (will retry next cycle)")
            traceback.print_exc()
        force = False
        stop.wait(interval_min * 60)


# ---------------------------------------------------------------------------
# Local web server
# ---------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the repo root, so /simple/ and /alerts/data/ resolve to the
    checked-out files, and /simple/data/ to the folder this script writes.
    Everything is served no-cache so edits show on reload."""

    # Top-level folders that are never web content.
    HIDDEN = ("scripts", "cache", ".git", ".github", ".claude", "docs")

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        from urllib.parse import unquote

        path = unquote(path).lstrip("/")
        if path.startswith("simple/data/"):
            base, rest = DATA_DIR, path[len("simple/data/") :]
        else:
            base, rest = REPO, path
        target = (base / rest).resolve()
        # Don't serve anything outside the mapped folders, or pipeline code.
        if base.resolve() not in target.parents and target != base.resolve():
            return str(REPO / "__nope__")
        top = rest.split("/", 1)[0]
        if base == REPO and (top in self.HIDDEN or rest.startswith("simple/pipeline")):
            return str(REPO / "__nope__")
        return str(target)

    def do_GET(self):
        if self.path in ("/", "/simple"):
            self.send_response(302)
            self.send_header("Location", "/simple/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console for refresh messages


Handler.extensions_map = {
    **http.server.SimpleHTTPRequestHandler.extensions_map,
    ".geojson": "application/geo+json",
    ".js": "text/javascript",
    ".json": "application/json",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Run DFENS Simple locally.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument(
        "--host",
        default="127.0.0.1",
        help="127.0.0.1 = this computer only; 0.0.0.0 = your network too",
    )
    ap.add_argument("--interval", type=float, default=10, help="minutes between checks")
    ap.add_argument("--warm", action="store_true", help="prepare the debris cache before starting")
    ap.add_argument(
        "--force", action="store_true", help="rebuild on the first cycle even if unchanged"
    )
    ap.add_argument("--once", action="store_true", help="refresh once, then only serve")
    ap.add_argument("--no-serve", action="store_true", help="refresh only, no web server")
    args = ap.parse_args()

    os.chdir(REPO)  # scripts/data.py caches to ./cache relative to cwd
    # Written into status.json so the page can say when the next check is.
    os.environ["CHECK_INTERVAL_MINUTES"] = f"{args.interval:g}"
    if args.warm:
        warm_debris_cache()

    stop = threading.Event()
    if args.once:
        refresh_once(args.force)
    else:
        threading.Thread(
            target=refresh_loop, args=(args.interval, args.force, stop), daemon=True
        ).start()

    if args.no_serve:
        if args.once:
            return 0
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return 0

    alerts_data = REPO / "alerts" / "data"
    if not (alerts_data / "buildings" / "manifest.json").exists():
        log(
            f"Note: no buildings manifest under {alerts_data}; the "
            f"Building footprints layer will be empty."
        )
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    shown = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    log(f"DFENS Simple running at http://{shown}:{args.port}/simple/  (Ctrl+C to stop)")
    if not args.once:
        log(f"Checking NDFD every {args.interval:g} min.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopping.")
    finally:
        stop.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
