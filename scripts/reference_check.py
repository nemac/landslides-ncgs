#!/usr/bin/env python3
"""Decide whether the three reference datasets need rebuilding.

Run daily by refresh-reference.yml, before any heavy work. Standard library
only, so it runs in seconds on a plain Python.

Every upstream says when it last changed, so the expensive rebuilds happen
only when it did:

  * Overture Maps publishes numbered releases; the STAC catalog names the
    latest one. The building footprints are rebuilt when it differs from
    the release recorded at the last build.
  * The NCGS debris-flow layer reports a data-last-edit date through its
    ArcGIS metadata. The cached debris-flow GeoPackage is rebuilt when it
    moves.
  * The NC fire district layer reports the same kind of date. The cached
    WNC fire district GeoJSON is rebuilt when it moves.

Any dataset is also rebuilt when its last build is older than
REBUILD_AFTER_DAYS, in case an upstream republishes without moving its
marker, and whenever FORCE=true. A state file with no entry for a dataset
counts as no previous build, so a newly added dataset is built on its first
run. Every run logs each upstream value next to the recorded one so a stale
marker is visible in the Actions log.

Each dataset is checked on its own. When one upstream cannot be read, that
dataset is left alone, the other two are still checked, and the script
exits 1 after writing its outputs so the run shows as failed.

Outputs, for the workflow: `buildings`, `debris` and `fire_districts`
("true"/"false"), `any`, `overture_release`, `debris_last_edit` and
`fire_districts_last_edit`. Writes <out>/check.json for the job summary and
<out>/reference_state.json, which starts as the previous state.
reference_record.py updates one dataset's entry in it after that dataset's
rebuild succeeds, and the workflow uploads it at the end.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import DEBRIS_FLOW_SERVICE_URL, FIRE_DISTRICTS_SERVICE_URL  # noqa: E402

OVERTURE_CATALOG_URL = "https://stac.overturemaps.org/catalog.json"
PUBLIC_STATE_URL = "https://landslidesncgs.org/alerts/data/reference_state.json"
REBUILD_AFTER_DAYS = 90
DATASETS = ("buildings", "debris", "fire_districts")

# The NCGS ArcGIS server sometimes stalls past the 30-second timeout and
# answers fine a few seconds later (run 42165821205, 2026-11-06). So a
# timeout, a dropped connection, a 429 or a 5xx is tried again, waiting
# 5, 10 and then 20 seconds. Any other error, such as a 404, fails at once.
RETRY_ATTEMPTS = 4
FIRST_RETRY_DELAY = 5  # seconds; doubles after each failed attempt
MAX_RETRY_DELAY = 60  # seconds; also caps how long a server's Retry-After can make us wait


def log(msg: str) -> None:
    print(f"[reference-check] {msg}", flush=True)


def _fetch_json_once(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "landslides-reference-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _is_transient(error: Exception) -> bool:
    """Whether trying the same request again might work."""
    # HTTPError is a kind of URLError, so it has to be checked first.
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or error.code >= 500
    # URLError covers refused connections and failed DNS lookups.
    # TimeoutError and ConnectionError cover a server that stops answering
    # or drops the connection partway through.
    return isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError))


def _server_retry_after(error: Exception) -> int | None:
    """The wait, in seconds, that a 429 or 503 asked for in its Retry-After
    header, or None. Only the plain-seconds form is read; a date form is
    ignored and the normal backoff is used instead."""
    if not isinstance(error, urllib.error.HTTPError) or error.headers is None:
        return None
    value = (error.headers.get("Retry-After") or "").strip()
    if not value.isdigit():
        return None
    return int(value)


def _retry_delay(failed_attempt: int, error: Exception) -> float:
    """Seconds to wait after the given failed attempt (1 for the first)."""
    delay = _server_retry_after(error)
    if delay is None:
        delay = FIRST_RETRY_DELAY * 2 ** (failed_attempt - 1)
    delay = min(delay, MAX_RETRY_DELAY)
    # A little random extra time, so the EventBridge run and the backup
    # cron run never retry against the server at the same moment.
    jitter = random.uniform(0, delay * 0.2)
    return delay + jitter


def _get_json(url: str, timeout: int = 30, sleep: Callable[[float], None] = time.sleep) -> dict:
    """GET a JSON document, trying again after errors that may pass."""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return _fetch_json_once(url, timeout)
        except Exception as error:
            if attempt == RETRY_ATTEMPTS or not _is_transient(error):
                raise
            delay = _retry_delay(attempt, error)
            log(
                f"attempt {attempt} of {RETRY_ATTEMPTS} failed "
                f"({type(error).__name__}: {error}); trying {url} again in {delay:.1f}s"
            )
            sleep(delay)
    raise AssertionError("unreachable")


def latest_overture_release(fetch=_get_json) -> str:
    """The newest Overture release id, e.g. "2026-10-21.0"."""
    catalog = fetch(OVERTURE_CATALOG_URL)
    latest = catalog.get("latest")
    if not latest:
        raise RuntimeError("Overture STAC catalog has no 'latest' release")
    return str(latest)


def _layer_last_edit(url: str, label: str, fetch) -> str:
    """An ArcGIS layer's data-last-edit date as an ISO string (UTC).
    `label` names the layer in the error when it reports no date."""
    info = fetch(url + "?f=json")
    edit = info.get("editingInfo") or {}
    ms = edit.get("dataLastEditDate") or edit.get("lastEditDate")
    if not ms:
        raise RuntimeError(f"{label} reports no edit date")
    return datetime.fromtimestamp(int(ms) / 1000, tz=UTC).isoformat()


def debris_last_edit(fetch=_get_json) -> str:
    """The NCGS debris-flow layer's data-last-edit date (UTC, ISO)."""
    return _layer_last_edit(DEBRIS_FLOW_SERVICE_URL, "NCGS debris-flow layer", fetch)


def fire_districts_last_edit(fetch=_get_json) -> str:
    """The NC fire district layer's data-last-edit date (UTC, ISO)."""
    return _layer_last_edit(FIRE_DISTRICTS_SERVICE_URL, "NC fire district layer", fetch)


def previous_state(fetch=_get_json, url: str | None = None, *, force: bool = False) -> dict:
    """The state recorded by the last successful run, or {} on first run.

    Only a 404 is a first run. CloudFront answers 403 for a missing object
    in the data bucket, and that used to count as a first run too, but the
    state file has existed since 2026-10-28: a 403 now more likely means
    the bucket policy or origin access broke, and rebuilding both datasets
    would hide that and reset their markers. So a 403, like any other
    failure (a 5xx or refused connection that outlasts _get_json's retries,
    a body that is not JSON), fails the check and the job is retried the
    next day.

    A forced run rebuilds everything regardless, so it accepts a 403 and
    starts from an empty state. That is the way back if the file really is
    gone: dispatch the workflow with force=true and it records a new one.
    """
    url = url or os.environ.get("REFERENCE_STATE_URL") or PUBLIC_STATE_URL
    try:
        return fetch(url)
    except urllib.error.HTTPError as e:
        if e.code == 404 or (e.code == 403 and force):
            log(f"no previous state (HTTP {e.code}); treating as first run")
            return {}
        raise


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


def starting_state(previous: dict, now: datetime) -> dict:
    """The state before any rebuild in this run: every dataset keeps its
    previous entry. reference_record.py updates one entry after that
    dataset's rebuild succeeds, so a failed rebuild is never recorded."""
    state = {"checked_at": now.isoformat()}
    for name in DATASETS:
        state[name] = dict(previous.get(name) or {})
    return state


def record_build(state: dict, name: str, value: str, now: datetime) -> dict:
    """A copy of `state` where dataset `name` was just built from the
    upstream marker `value`."""
    if name not in DATASETS:
        raise ValueError(f"unknown dataset: {name}")
    if not value:
        raise ValueError(f"no upstream marker to record for {name}")
    recorded = dict(state)
    recorded[name] = {"value": value, "built_at": now.isoformat()}
    return recorded


def read_upstream() -> tuple[dict[str, str | None], dict[str, str]]:
    """Each dataset's upstream marker, and the error for each one that
    could not be read. The three sources are separate servers, so one
    being down must not stop the other two from being checked."""
    # Built here, not at import, so a test can swap any reader.
    readers = {
        "buildings": latest_overture_release,
        "debris": debris_last_edit,
        "fire_districts": fire_districts_last_edit,
    }
    upstream: dict[str, str | None] = {}
    errors: dict[str, str] = {}
    for name in DATASETS:
        try:
            upstream[name] = readers[name]()
        # Deliberately broad: whatever went wrong with one source, the
        # other datasets still get checked.
        except Exception as error:
            upstream[name] = None
            errors[name] = f"{type(error).__name__}: {error}"
    return upstream, errors


def decide_all(
    upstream: dict[str, str | None],
    errors: dict[str, str],
    previous: dict,
    now: datetime,
    *,
    force: bool = False,
) -> tuple[dict[str, bool], dict[str, str]]:
    """decide() for every dataset. A dataset whose upstream could not be
    read is left alone, even on a forced run: with no marker there is
    nothing to record for the rebuild."""
    rebuild: dict[str, bool] = {}
    reasons: dict[str, str] = {}
    for name in DATASETS:
        if name in errors:
            rebuild[name] = False
            reasons[name] = f"upstream check failed ({errors[name]})"
        else:
            rebuild[name], reasons[name] = decide(
                upstream[name], previous.get(name), now, force=force
            )
    return rebuild, reasons


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

    # Without the previous state nothing can be decided, so this one
    # failure still stops the whole check.
    previous = previous_state(force=force)
    upstream, errors = read_upstream()
    rebuild, reasons = decide_all(upstream, errors, previous, now, force=force)
    for name in DATASETS:
        last_built = (previous.get(name) or {}).get("value")
        log(f"{name}: upstream {upstream[name]}, last built from {last_built}")
        log(f"{name}: {'REBUILD' if rebuild[name] else 'skip'} - {reasons[name]}")

    state = starting_state(previous, now)
    (out / "reference_state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    (out / "check.json").write_text(
        json.dumps(
            {"upstream": upstream, "rebuild": rebuild, "reasons": reasons, "errors": errors},
            indent=2,
        ),
        encoding="utf-8",
    )
    write_outputs(
        {
            "buildings": str(rebuild["buildings"]).lower(),
            "debris": str(rebuild["debris"]).lower(),
            "fire_districts": str(rebuild["fire_districts"]).lower(),
            "overture_release": upstream["buildings"] or "",
            "debris_last_edit": upstream["debris"] or "",
            "fire_districts_last_edit": upstream["fire_districts"] or "",
            "any": str(any(rebuild.values())).lower(),
        }
    )
    # The outputs are written first, so the workflow can still rebuild the
    # datasets that were checked. The failure then marks the run as failed.
    if errors:
        log(f"could not check: {', '.join(sorted(errors))}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
