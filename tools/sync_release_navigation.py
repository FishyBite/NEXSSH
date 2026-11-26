"""Put the version-sorted Windows downloads on the first public GitHub release."""
import json
import os
from urllib.request import Request, urlopen

from build_download_index import REPO, VERSION, download_links, load_releases, version_order
from release_navigation_block import END, START, strip_navigation, with_navigation


def navigation_block(releases):
    versions = []
    for release in releases:
        tag = release["tag_name"]
        version = VERSION.fullmatch(tag)
        if release["draft"] or not version:
            continue
        downloads = [link for link in download_links(release) if not link.startswith("[SHA-256]")]
        if downloads:
            versions.append((version_order(version), tag, downloads))
    if not versions:
        return ""
    versions.sort(reverse=True)
    lines = [
        START, "", '## <a id="vexssh-versions" name="vexssh-versions">Windows releases by version</a>', "",
        "Select a version for its release notes, or download the Windows x64 build here.", "",
    ]
    for index, (_, tag, downloads) in enumerate(versions):
        release_link = f"[{tag[1:]}](https://github.com/{REPO}/releases/tag/{tag})"
        if index == 0:
            release_link = f"**{release_link} · Latest download**"
        lines.append("- " + " · ".join([release_link, *downloads]))
    return "\n".join([*lines, "", "---", "", END])


def sync_navigation(releases, get_release, update_body):
    published = [r for r in releases if not r["draft"]]
    block = navigation_block(published)
    for release in published:
        strip_navigation(release.get("body"))  # Detect malformed markers before the first write.

    changes = 0
    for index, release in enumerate(published):
        # Update the destination first; only remove old copies after that succeeds.
        if (index > 0 or not block) and START not in (release.get("body") or ""):
            continue
        latest = get_release(release["id"])
        if latest["draft"] or latest["tag_name"] != release["tag_name"]:
            raise RuntimeError("Release changed during navigation refresh; retry with the current list")
        body = latest.get("body") or ""
        updated = with_navigation(body, block if index == 0 else "")
        if updated != body:
            update_body(latest["id"], updated)
            changes += 1
    return changes


def main():
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Cache-Control": "no-cache",
        "User-Agent": "VEXSSH-release-navigation",
    }

    def get_release(release_id):
        url = f"https://api.github.com/repos/{REPO}/releases/{release_id}"
        with urlopen(Request(url, headers=headers), timeout=30) as response:
            return json.load(response)

    def update_body(release_id, body):
        url = f"https://api.github.com/repos/{REPO}/releases/{release_id}"
        request = Request(url, json.dumps({"body": body}).encode(), method="PATCH",
                          headers={**headers, "Content-Type": "application/json"})
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
        if (result.get("body") or "").replace("\r\n", "\n") != body.replace("\r\n", "\n"):
            raise RuntimeError("The saved release navigation differed from the update")

    print(f"Updated {sync_navigation(load_releases(), get_release, update_body)} release descriptions.")


if __name__ == "__main__":
    main()
