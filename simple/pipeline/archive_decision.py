"""
archive_decision.py - should refresh-simple.yml keep a copy of this run?

Standard library only. Prints "true" or "false" for the workflow:
    python3 simple/pipeline/archive_decision.py --out out

A run that flagged pathways is archived. The one exception is a run that
was built only to try a failed fire district lookup again, and failed
again: the first run for that forecast is already archived with the same
pathways, and a retry happens every 10 minutes, so archiving each one
would pile up copies that say nothing new.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import ndfd_check


def should_archive(status: dict, check: dict) -> bool:
    """`status` is this run's status.json and `check` its check.json."""
    if (status.get("n_flagged") or 0) <= 0:
        return False
    lookup_failed = status.get("fire_districts") == ndfd_check.FIRE_DISTRICTS_UNAVAILABLE
    failed_again = bool(check.get("fire_district_retry")) and lookup_failed
    return not failed_again


def main() -> int:
    parser = argparse.ArgumentParser(description="Decide whether to archive this run.")
    parser.add_argument("--out", default="out", help="folder with status.json and check.json")
    args = parser.parse_args()
    out = Path(args.out)

    status = json.loads((out / "status.json").read_text(encoding="utf-8"))
    check = json.loads((out / "check.json").read_text(encoding="utf-8"))
    print(str(should_archive(status, check)).lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
