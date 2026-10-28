"""
ndfd_check.py - fast, dependency-free first step of the DFENS Simple refresh.

Runs every few minutes (GitHub Actions in production, run_local.py on a
desktop). Standard library only, so it starts in seconds.

  1. Asks the NDFD layer for its cycle start and last data update time.
  2. Compares those with the last published status.json:
       unchanged -> action "skip": only status.checked_at is refreshed
       changed   -> action "build": refresh_simple.py rebuilds the
                    forecast layer and the flagged pathways
  3. Also reports `heavy` = whether any >= 5" polygons are over WNC, so
     the workflow only restores the large debris-flow cache when needed.

Outputs (in --out): status.json (on skip), check.json (always), and
`action=` / `heavy=` lines on $GITHUB_OUTPUT.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TypeVar

import settings as S

T = TypeVar("T")

# The hosted NDFD service stalls for about a minute and then answers a
# generic 400 ("Cannot perform query. Invalid query parameters.") while
# Esri reloads the layer each hour. Those answers, timeouts and 5xx are
# retried; a real client error such as a 404 on status.json is not.
RETRY_ATTEMPTS = 3
RETRY_DELAYS = (5, 15)  # seconds to wait before attempts 2 and 3

# requests-library exceptions that mean the connection failed or timed
# out. Matched by class name so this module never imports requests.
_TRANSIENT_REQUESTS_NAMES = frozenset(
    {"ConnectionError", "Timeout", "ConnectTimeout", "ReadTimeout", "ChunkedEncodingError"}
)


def _fetch_json(url: str, timeout: int) -> dict:
    """One request. Raises on transport errors and on ArcGIS error payloads."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "dfens-simple-refresh",
            # The HUC12 gzip bug noted in the main pipeline doesn't apply to
            # this service, but identity is cheap insurance.
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if isinstance(payload, dict) and "error" in payload:
        raise RuntimeError(f"ArcGIS error from {url}: {payload['error']}")
    return payload


def _is_transient_status(status: int) -> bool:
    return status == 429 or status >= 500


def _is_transient_requests_error(exc: Exception) -> bool:
    """Recognise a transient requests-library failure (used by the build
    step) without importing requests, so this module stays stdlib-only."""
    cls = type(exc)
    if not cls.__module__.startswith("requests"):
        return False
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status is not None and _is_transient_status(status):
        return True
    return cls.__name__ in _TRANSIENT_REQUESTS_NAMES


def _is_transient(exc: Exception) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return _is_transient_status(exc.code)
    if _is_transient_requests_error(exc):
        return True
    # URLError covers refused/reset connections and socket timeouts;
    # RuntimeError is the ArcGIS error payload raised by _fetch_json
    # and by refresh_simple.fetch_precip.
    return isinstance(exc, (urllib.error.URLError, TimeoutError, RuntimeError))


def retry(fn: Callable[[], T], *, label: str = "request") -> T:
    """Call fn() up to RETRY_ATTEMPTS times, waiting RETRY_DELAYS between
    attempts, while it raises a transient error. A non-transient error, or
    the error from the last attempt, propagates."""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == RETRY_ATTEMPTS or not _is_transient(e):
                raise
            delay = RETRY_DELAYS[attempt - 1]
            print(
                f"[check] attempt {attempt} of {RETRY_ATTEMPTS} failed "
                f"({type(e).__name__}: {e}); retrying {label} in {delay}s"
            )
            time.sleep(delay)
    raise AssertionError("unreachable")


def _get_json(url: str, params: dict | None = None, timeout: int = 60) -> dict:
    """GET JSON, retrying transient failures up to RETRY_ATTEMPTS times."""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    return retry(lambda: _fetch_json(url, timeout))


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat() if dt else None


def _from_ms(ms) -> datetime:
    return datetime.fromtimestamp(int(ms) / 1000, tz=UTC)


def ndfd_state() -> dict:
    """Read cycle start, last data edit, and the >= threshold count."""
    info = _get_json(S.NDFD_LAYER_URL, {"f": "json"})
    edit = info.get("editingInfo") or {}
    last_edit_ms = edit.get("dataLastEditDate") or edit.get("lastEditDate")
    issued = _from_ms(last_edit_ms) if last_edit_ms else None

    first = _get_json(
        S.NDFD_LAYER_URL + "/query",
        {
            "where": "1=1",
            "outFields": "fromdate",
            "orderByFields": "fromdate ASC",
            "resultRecordCount": 1,
            "returnGeometry": "false",
            "f": "json",
        },
    )
    feats = first.get("features") or []
    if not feats:
        raise RuntimeError("NDFD layer returned no features")
    cycle_start = _from_ms(feats[0]["attributes"]["fromdate"])
    window_end = cycle_start + timedelta(hours=S.WINDOW_HOURS)

    count = _get_json(
        S.NDFD_LAYER_URL + "/query",
        {
            "where": S.period_where(cycle_start, S.WINDOW_HOURS, S.THRESHOLD_CATEGORY),
            "geometry": ",".join(str(c) for c in S.WNC_BBOX),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "returnCountOnly": "true",
            "f": "json",
        },
    ).get("count", 0)

    return {
        "issued": issued,
        "window_start": cycle_start,
        "window_end": window_end,
        "n_precip_polygons": int(count),
        # Anything that would change the output. Cycle start is included
        # because the window moves every 6 h even if Esri's edit time
        # somehow doesn't.
        "ndfd_key": f"{_iso(cycle_start)}|{_iso(issued)}",
    }


def previous_status() -> dict | None:
    url = os.environ.get("STATUS_URL") or S.PUBLIC_STATUS_URL
    try:
        # status.json is served with max-age=30 and the cache policy ignores
        # query strings, so a copy up to 30 s old is the best available and
        # is fine for a check that runs every 10 minutes.
        return _get_json(url, timeout=20)
    except Exception as e:
        print(f"[check] no previous status ({type(e).__name__}: {e})")
        return None


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")


def build_meta(state: dict, n_flagged: int, now: datetime) -> dict:
    return {
        "source": "NWS NDFD precipitation forecast (Accumulation by Time)",
        "issued": _iso(state["issued"]),
        "window_start": _iso(state["window_start"]),
        "window_end": _iso(state["window_end"]),
        "window_hours": S.WINDOW_HOURS,
        "min_category_shipped": S.THRESHOLD_CATEGORY,
        "n_flagged": n_flagged,
        "generated_at": _iso(now),
        "ndfd_key": state["ndfd_key"],
    }


def build_status(meta: dict, now: datetime, result: str) -> dict:
    keep = (
        "issued",
        "window_start",
        "window_end",
        "window_hours",
        "n_flagged",
        "generated_at",
        "ndfd_key",
    )
    st = {k: meta.get(k) for k in keep}
    st["checked_at"] = _iso(now)
    st["check_interval_minutes"] = S.check_interval_minutes()
    st["pipeline_version"] = S.PIPELINE_VERSION
    st["result"] = result
    return st


def run(out: Path, force: bool = False, prev: dict | None = None) -> dict:
    """Do one check. Returns {"action": "skip"|"build", "heavy": bool,
    "state": ...}. On skip, writes the refreshed status.json to `out`.
    `prev` is the last published status.json (None on first run)."""
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)

    state = ndfd_state()
    heavy = state["n_precip_polygons"] > 0
    print(
        f"[check] NDFD updated {_iso(state['issued'])}, cycle start "
        f"{_iso(state['window_start'])}, >= cat {S.THRESHOLD_CATEGORY} "
        f"polygons in WNC: {state['n_precip_polygons']}"
    )

    up_to_date = (
        prev
        and prev.get("ndfd_key") == state["ndfd_key"]
        and prev.get("pipeline_version") == S.PIPELINE_VERSION
    )
    if up_to_date and not force:
        action = "skip"
        status = dict(prev)
        status["checked_at"] = _iso(now)
        status["check_interval_minutes"] = S.check_interval_minutes()
        status["result"] = "unchanged"
        write_json(out / "status.json", status)
    else:
        action = "build"  # refresh_simple.build() writes all files

    write_json(
        out / "check.json",
        {
            "action": action,
            "heavy": heavy,
            **{k: (_iso(v) if isinstance(v, datetime) else v) for k, v in state.items()},
            "previous_key": prev.get("ndfd_key") if prev else None,
        },
    )
    print(f"[check] action={action} heavy={str(heavy).lower()}")
    return {"action": action, "heavy": heavy, "state": state}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--force", action="store_true", help="ignore the previous status and rebuild")
    args = ap.parse_args()
    force = args.force or os.environ.get("FORCE", "").lower() == "true"

    res = run(Path(args.out), force=force, prev=previous_status())
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write(f"action={res['action']}\n")
            fh.write(f"heavy={str(res['heavy']).lower()}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
