#!/usr/bin/env python3
"""Record that one reference dataset was just rebuilt.

refresh-reference.yml runs this right after a dataset's rebuild and upload
succeed:

    python scripts/reference_record.py debris --out out

It copies that dataset's upstream marker from <out>/check.json into
<out>/reference_state.json, with the time of the build. Each dataset is
recorded on its own, so one failed rebuild does not make the others repeat
on the next daily check. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reference_check import DATASETS, log, record_build  # noqa: E402


def record(out: Path, name: str, now: datetime) -> dict:
    """Update <out>/reference_state.json for dataset `name`. Returns the
    new state."""
    check = json.loads((out / "check.json").read_text(encoding="utf-8"))
    state_path = out / "reference_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    recorded = record_build(state, name, check["upstream"].get(name), now)
    state_path.write_text(json.dumps(recorded, indent=2), encoding="utf-8")
    return recorded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("dataset", choices=DATASETS)
    parser.add_argument("--out", default="out", help="directory with the state and check files")
    args = parser.parse_args()

    recorded = record(Path(args.out), args.dataset, datetime.now(UTC))
    log(f"recorded {args.dataset}: {recorded[args.dataset]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
