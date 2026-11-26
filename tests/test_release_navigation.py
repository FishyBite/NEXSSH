"""Offline regression tests for the navigation published inside GitHub Releases."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from sync_release_navigation import END, START, navigation_block, strip_navigation, sync_navigation


def candidate(number, *, draft=False, assets=None):
    version = f"1.0.0-rc.{number}"
    tag = f"v{version}"
    brand = "NEXSSH" if number == 7 else "VEXSSH"
    names = [f"{brand}-{version}-Windows-x64-{form}.exe" for form in ("Online-Setup", "Portable")]
    return {
        "id": number,
        "name": f"{brand} {version}",
        "tag_name": tag,
        "html_url": f"https://github.com/FishyBite/VEXSSH/releases/tag/{tag}",
        "draft": draft,
        "prerelease": True,
        "body": f"\r\n## What's changed\r\n\r\n- Note for {tag}.  \r\n\r\n",
        "assets": [
            {"name": name, "state": state, "browser_download_url":
             f"https://github.com/FishyBite/VEXSSH/releases/download/{tag}/{name}"}
            for name, state in (assets if assets is not None else [(name, "uploaded") for name in names])
        ],
    }


class ReleaseStore:
    def __init__(self, releases):
        self.by_id = {release["id"]: release.copy() for release in releases}
        self.writes = []

    def sync(self, order):
        # The initial paginated listing and per-release reads are separate API responses.
        return sync_navigation([self.by_id[i].copy() for i in order], self.get_release, self.set_body)

    def get_release(self, release_id):
        return self.by_id[release_id].copy()

    def set_body(self, release_id, body):
        self.writes.append(release_id)
        self.by_id[release_id]["body"] = body


class ReleaseNavigationTests(unittest.TestCase):
    def test_native_first_release_exposes_newest_downloads_first(self):
        releases = [candidate(n) for n in (9, 12, 11, 10, 8, 7)]
        releases.insert(0, candidate(14, draft=True))
        releases.append(candidate(13, assets=[("SHA256SUMS.txt", "uploaded"),
                                              ("VEXSSH-1.0.0-rc.13-Windows-x64-Portable.exe", "starter")]))
        store = ReleaseStore(releases)
        order = [r["id"] for r in releases]
        self.assertEqual(store.sync(order), 1)
        self.assertEqual(store.writes, [9])
        body = store.get_release(9)["body"]
        block = navigation_block(releases)
        self.assertIn(block.replace("\r\n", "\n"), body.replace("\r\n", "\n"))
        self.assertEqual(strip_navigation(body), releases[1]["body"])
        versions = [int(n) for n in re.findall(r"1\.0\.0-rc\.(\d+)\b", block)]
        self.assertEqual(list(dict.fromkeys(versions)), [12, 11, 10, 9, 8, 7])
        self.assertEqual(block.count('name="vexssh-versions"'), 1)
        for release in releases[1:-1]:
            self.assertIn(release["html_url"], block)
            for asset in release["assets"]:
                self.assertIn(asset["browser_download_url"], block)
        self.assertEqual(store.sync(order), 0)
        self.assertEqual(store.writes, [9])

    def test_new_release_and_change_of_native_first_preserve_handwritten_notes(self):
        releases = [candidate(n) for n in (9, 12, 11, 13, 100)]
        store = ReleaseStore(releases)
        store.sync([9, 12, 11])
        store.sync([9, 13, 12, 11])
        previous_body = store.get_release(9)["body"]
        self.assertLess(previous_body.index("1.0.0-rc.13"), previous_body.index("1.0.0-rc.12"))

        # A maintainer adds a note in the GitHub editor, which may use CRLF.
        edited = previous_body.replace("\r\n", "\n").replace("\n", "\r\n") + "Manual edit.\r\n"
        store.set_body(9, edited)
        store.writes.clear()
        self.assertEqual(store.sync([100, 9, 13, 12, 11]), 2)
        self.assertEqual(store.writes, [100, 9])
        self.assertEqual(store.get_release(9)["body"], releases[0]["body"] + "Manual edit.\r\n")
        front = store.get_release(100)["body"]
        self.assertEqual(front.count('name="vexssh-versions"'), 1)
        self.assertNotIn('name="vexssh-versions"', store.get_release(9)["body"])
        self.assertEqual(front.count(START), 1)
        self.assertEqual(front.count(END), 1)
        self.assertLess(front.index("1.0.0-rc.100"), front.index("1.0.0-rc.13"))
        self.assertEqual(strip_navigation(front), releases[-1]["body"])
        self.assertEqual(store.sync([100, 9, 13, 12, 11]), 0)

    def test_sync_keeps_notes_edited_after_the_initial_listing(self):
        releases = [candidate(9), candidate(12)]
        store = ReleaseStore(releases)
        fresh = "## What's changed\n\n- Maintainer's new change.\n"
        store.set_body(9, fresh)
        self.assertEqual(sync_navigation(releases, store.get_release, store.set_body), 1)
        self.assertEqual(strip_navigation(store.get_release(9)["body"]), fresh)

    def test_withdrawing_the_last_download_restores_the_original_notes(self):
        release = candidate(9)
        store = ReleaseStore([release])
        self.assertEqual(store.sync([9]), 1)
        store.by_id[9]["assets"] = []
        self.assertEqual(store.sync([9]), 1)
        self.assertEqual(store.get_release(9)["body"], release["body"])
        self.assertEqual(store.sync([9]), 0)


if __name__ == "__main__":
    unittest.main()
