#!/usr/bin/env python3
"""Decide whether the two reference datasets need rebuilding.

Run daily by refresh-reference.yml, before any heavy work. Standard library
only, so it runs in seconds on a plain Python.

Both upstreams say when they last changed, so the expensive rebuilds happen
only when they did:

  * Overture Maps publishes numbered releases; the STAC catalog names the
    latest one. The building footprints are rebuilt when it differs from
    the release recorded at the last build.
  * The NCGS debris-flow layer reports a data-last-edit date through its
    ArcGIS metadata. The cached debris-flow GeoPackage is rebuilt when it
    moves.

Either dataset is also rebuilt when its last build is older than
REBUILD_AFTER_DAYS, in case an upstream republishes without moving its
marker, and whenever FORCE=true. Every run logs both upstream values next
to the recorded ones so a stale marker is visible in the Actions log.

Outputs, for the workflow: `buildings` and `debris` ("true"/"false"),
`overture_release`, `debris_last_edit`, and the reasons. Writes
<out>/reference_state.json, the state to upload once the rebuilds succeed,
and <out>/check.json for the job summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import DEBRIS_FLOW_SERVICE_URL  # noqa: E402

OVERTURE_CATALOG_URL = "https://stac.overturemaps.org/catalog.json"
PUBLIC_STATE_URL = "https://landslidesncgs.org/alerts/data/reference_state.json"
REBUILD_AFTER_DAYS = 90
DATASETS = ("buildings", "debris")


def log(msg: str) -> None:
    print(f"[reference-check] {msg}", flush=True)


def _get_json(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "landslides-reference-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def latest_overture_release(fetch=_get_json) -> str:
    """The newest Overture release id, e.g. "2026-10-21.0"."""
    catalog = fetch(OVERTURE_CATALOG_URL)
    latest = catalog.get("latest")
    if not latest:
        raise RuntimeError("Overture STAC catalog has no 'latest' release")
    return str(latest)


def debris_last_edit(fetch=_get_json) -> str:
    """The NCGS layer's data-last-edit date as an ISO string (UTC)."""
    info = fetch(DEBRIS_FLOW_SERVICE_URL + "?f=json")
    edit = info.get("editingInfo") or {}
    ms = edit.get("dataLastEditDate") or edit.get("lastEditDate")
    if not ms:
        raise RuntimeError("NCGS debris-flow layer reports no edit date")
    return datetime.fromtimestamp(int(ms) / 1000, tz=UTC).isoformat()


def previous_state(fetch=_get_json, url: str | None = None) -> dict:
    """The state recorded by the last successful run, or {} on first run."""
    url = url or os.environ.get("REFERENCE_STATE_URL") or PUBLIC_STATE_URL
    try:
        return fetch(url)
    except (urllib.error.URLError, ValueError, OSError) as e:
        log(f"no previous state ({type(e).__name__}: {e}); treating as first run")
        return {}


def decide(
    upstream: str,
    recorded: dict | None,
    now: datetime,
    *,
    force: bool = False,
    rebuild_after_days: int = REBUILD_AFTER_DAYS,
) -> tuple[bool, str]:
    """Whether one dataset needs a rebuild, and why.

    `recorded` is that dataset's entry from the previous state:
    {"value": <upstream marker at last build>, "built_at": <ISO>}.
    """
    if force:
        return True, "forced"
    if not recorded or not recorded.get("value") or not recorded.get("built_at"):
        return True, "no previous build recorded"
    if recorded["value"] != upstream:
        return True, f"upstream changed: {recorded['value']} -> {upstream}"
    built_at = datetime.fromisoformat(recorded["built_at"])
    age = now - built_at
    if age > timedelta(days=rebuild_after_days):
        return True, f"last build is {age.days} days old (limit {rebuild_after_days})"
    return False, f"unchanged ({upstream}), built {age.days} days ago"


def next_state(
    previous: dict, upstream: dict[str, str], rebuild: dict[str, bool], now: datetime
) -> dict:
    """The state to record after this run: rebuilt datasets take the new
    upstream marker and timestamp, the others carry their previous entry."""
    state = {"checked_at": now.isoformat()}
    for name in DATASETS:
        if rebuild[name]:
            state[name] = {"value": upstream[name], "built_at": now.isoformat()}
        else:
            state[name] = dict(previous.get(name) or {})
    return state


def write_outputs(values: dict) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out", default="out", help="directory for the state and check files")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    force = os.environ.get("FORCE", "false").lower() == "true"

    upstream = {
        "buildings": latest_overture_release(),
        "debris": debris_last_edit(),
    }
    previous = previous_state()
    log(f"Overture latest release:        {upstream['buildings']}")
    log(f"Overture release last built:    {(previous.get('buildings') or {}).get('value')}")
    log(f"NCGS debris layer last edited:  {upstream['debris']}")
    log(f"NCGS edit date last built:      {(previous.get('debris') or {}).get('value')}")

    rebuild: dict[str, bool] = {}
    reasons: dict[str, str] = {}
    for name in DATASETS:
        rebuild[name], reasons[name] = decide(upstream[name], previous.get(name), now, force=force)
        log(f"{name}: {'REBUILD' if rebuild[name] else 'skip'} - {reasons[name]}")

    state = next_state(previous, upstream, rebuild, now)
    (out / "reference_state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    (out / "check.json").write_text(
        json.dumps({"upstream": upstream, "rebuild": rebuild, "reasons": reasons}, indent=2),
        encoding="utf-8",
    )
    write_outputs(
        {
            "buildings": str(rebuild["buildings"]).lower(),
            "debris": str(rebuild["debris"]).lower(),
            "overture_release": upstream["buildings"],
            "debris_last_edit": upstream["debris"],
            "any": str(any(rebuild.values())).lower(),
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
