"""The building footprints have one owner: refresh-reference.yml, through
`refresh.py --buildings`. A plain `refresh.py` run (live mode) must write
nothing under alerts/data/buildings/ and never call the Overture extract;
`--buildings` runs that extract and nothing else.

Run from the repo root in an environment with geopandas:
    python -m unittest discover -s scripts -p "test_*.py"
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
import refresh  # noqa: E402

LIVE_PHASES = (
    "_refresh_ndfd",
    "_refresh_mrms",
    "_load_debris_flows",
    "_refresh_flagged_ndfd",
    "_refresh_flagged_mrms",
)


class BuildingsOwnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data_dir = Path(tmp.name)
        self._patch(mock.patch.object(refresh, "DATA_DIR", self.data_dir))
        self.live_phases = {
            name: self._patch(mock.patch.object(refresh, name)) for name in LIVE_PHASES
        }
        self.extract = self._patch(
            mock.patch.object(refresh.defns_data, "fetch_overture_buildings")
        )

    def _patch(self, patcher):
        started = patcher.start()
        self.addCleanup(patcher.stop)
        return started

    def _run(self, *argv) -> int:
        with mock.patch.object(sys, "argv", ["refresh.py", *argv]):
            return refresh.main()

    def test_plain_run_writes_nothing_under_buildings(self):
        self.assertEqual(self._run(), 0)
        self.extract.assert_not_called()
        self.assertFalse((self.data_dir / config.OVERTURE_BUILDINGS_SUBDIR).exists())

    def test_buildings_flag_runs_only_the_extract(self):
        with mock.patch.dict(os.environ, {"OVERTURE_RELEASE": "2026-10-21.0"}):
            self.assertEqual(self._run("--buildings"), 0)
        self.extract.assert_called_once_with(output_dir=self.data_dir, release="2026-10-21.0")
        for phase in self.live_phases.values():
            phase.assert_not_called()


if __name__ == "__main__":
    unittest.main()
