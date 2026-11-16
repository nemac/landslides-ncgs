#!/usr/bin/env python3
"""Print which version of the NCGS debris-flow layer a cache file holds.

refresh-reference.yml runs this right after a rebuild, to name the copy
of the GeoPackage it keeps for good under cache/archive/ in the data
bucket:

    python scripts/debris_cache_version.py cache/debris_flows.gpkg

The version is read from the file itself, so the name always matches the
data inside. Exits with an error for a file that does not name a version.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import geopandas as gpd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import DEBRIS_VERSION_FIELD  # noqa: E402


def read_version(path: Path) -> str:
    """The layer version written on the rows of the cache file at `path`.
    Reads one row only: every row of a file holds the same version."""
    first_row = gpd.read_file(path, rows=1)
    if DEBRIS_VERSION_FIELD not in first_row.columns or first_row.empty:
        raise ValueError(f"{path} has no {DEBRIS_VERSION_FIELD} value; rebuild it first")
    version = first_row[DEBRIS_VERSION_FIELD].iloc[0]
    if not version:
        raise ValueError(f"{path} has an empty {DEBRIS_VERSION_FIELD} value; rebuild it first")
    return str(version)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("path", type=Path, help="the debris-flow GeoPackage")
    args = parser.parse_args()
    print(read_version(args.path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
