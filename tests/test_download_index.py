"""Regression tests for the public Windows release history."""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from build_download_index import render


def release(version, body, *, brand="VEXSSH", draft=False, assets=None):
    tag = f"v{version}"
    if assets is None:
        assets = [
            (f"{brand}-{version}-Windows-x64-{suffix}.exe", "uploaded")
            for suffix in ("Online-Setup", "Portable")
        ]
    return {
        "tag_name": tag,
        "name": f"{brand} {version}",
        "html_url": f"https://github.com/FishyBite/VEXSSH/releases/tag/{tag}",
        "body": body,
        "published_at": "2026-11-26T05:06:38Z",
        "draft": draft,
        "prerelease": "-rc." in version,
        "assets": [{"name": name, "state": state} for name, state in assets],
    }


class DownloadIndexTests(unittest.TestCase):
    def test_changes_and_downloads_stay_under_their_version(self):
        page = render([
            release("2.0.0-rc.9", "The file browser remembers the last folder."),
            release("1.0.0-rc.7", "## What's Changed\n\n- Fixed terminal alignment.", brand="NEXSSH"),
            release("2.0.0-rc.11", "## What's changed\n\n- Added Serial recording.\n\n## Packaging\n\nPackaging-only details."),
        ])
        headings = list(re.finditer(r"(?m)^#{2,6}[ \t]+[^\n]*?(\d+\.\d+\.\d+-rc\.\d+)[^\n]*$", page))
        self.assertEqual([h[1] for h in headings], ["2.0.0-rc.11", "2.0.0-rc.9", "1.0.0-rc.7"])
        self.assertNotRegex(page, r"(?m)^\s*\|\s*:?-{3}")
        self.assertNotIn("Packaging-only details", page)

        ends = [h.start() for h in headings[1:]] + [len(page)]
        changes = ["Added Serial recording.", "The file browser remembers the last folder.", "Fixed terminal alignment."]
        for heading, end, change in zip(headings, ends, changes):
            version = heading[1]
            with self.subTest(version=version):
                section = page[heading.end():end]
                self.assertIn(change, section)
                self.assertTrue(all(other not in section for other in changes if other != change))
                brand = "NEXSSH" if version == "1.0.0-rc.7" else "VEXSSH"
                for suffix in ("Online-Setup", "Portable"):
                    file_path = f"/download/v{version}/{brand}-{version}-Windows-x64-{suffix}.exe"
                    self.assertIn(file_path, section)
                    self.assertLess(section.index(change), section.index(file_path))

    def test_only_published_windows_assets_are_offered(self):
        page = render([
            release("2.0.0", "Ready.", assets=[("VEXSSH-2.0.0-Windows-x64-Portable.exe", "uploaded")]),
            release("2.0.1", "Draft only.", draft=True),
            release("2.0.2", "Checksum only.", assets=[("SHA256SUMS.txt", "uploaded")]),
            release("2.0.3", "Upload in progress.", assets=[("VEXSSH-2.0.3-Windows-x64-Portable.exe", "starter")]),
        ])
        self.assertIn("/download/v2.0.0/VEXSSH-2.0.0-Windows-x64-Portable.exe", page)
        self.assertNotIn("Online-Setup.exe", page)
        for hidden_version in ("2.0.1", "2.0.2", "2.0.3"):
            self.assertNotIn(hidden_version, page)


if __name__ == "__main__":
    unittest.main()
