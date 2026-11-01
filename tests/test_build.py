"""Build updates rely on Git history, not backup copies."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
APPROVED_TEMP = Path(r"C:\Temp\opencode")


class BuildTests(unittest.TestCase):
    def test_update_replaces_output_without_creating_backups(self):
        with tempfile.TemporaryDirectory(dir=APPROVED_TEMP if APPROVED_TEMP.exists() else None) as directory:
            folder = Path(directory)
            output = folder / "reader.html"
            output.write_text("old output", encoding="utf-8")

            subprocess.run(
                [sys.executable, str(PROJECT / "build.py"), "--update", "--output", str(output)],
                check=True, capture_output=True,
            )

            self.assertIn("<title>Comic Reader</title>", output.read_text(encoding="utf-8"))
            self.assertEqual(list(folder.iterdir()), [output])

    def test_existing_output_requires_update_flag(self):
        with tempfile.TemporaryDirectory(dir=APPROVED_TEMP if APPROVED_TEMP.exists() else None) as directory:
            output = Path(directory) / "reader.html"
            output.write_text("keep this", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(PROJECT / "build.py"), "--output", str(output)],
                capture_output=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "keep this")


if __name__ == "__main__":
    unittest.main()
