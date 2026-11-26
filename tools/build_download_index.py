"""Render the Windows downloads page from published VEXSSH GitHub releases."""
import json
import os
import re
from datetime import date
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


REPO = "FishyBite/VEXSSH"
VERSION = re.compile(r"v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?")


def version_order(match):
    major, minor, patch, pre = match.groups()
    # Numeric prerelease identifiers sort numerically; a final release sorts last.
    parts = tuple((0, int(p)) if p.isdigit() else (1, p) for p in (pre or "").split("."))
    return int(major), int(minor), int(patch), pre is None, parts


def load_releases():
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "VEXSSH-downloads"}
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    page = 1
    while True:
        req = Request(f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}", headers=headers)
        with urlopen(req, timeout=30) as response:
            batch = json.load(response)
        yield from batch
        if len(batch) < 100:
            return
        page += 1


def download_links(release):
    tag = release["tag_name"]
    files = {a["name"] for a in release["assets"] if a["state"] == "uploaded"}
    base = f"https://github.com/{REPO}/releases/download/{tag}"
    links = []
    for suffix, label in [("Online-Setup.exe", "Installer"), ("Portable.exe", "Portable")]:
        for brand in ("VEXSSH", "NEXSSH"):
            name = f"{brand}-{tag[1:]}-Windows-x64-{suffix}"
            if name in files:
                links.append(f"[{label}]({base}/{quote(name)})")
                break
    if links and "SHA256SUMS.txt" in files:
        links.append(f"[SHA-256]({base}/SHA256SUMS.txt)")
    return links


def change_notes(body):
    """Read the release author's highlights, including GitHub-generated release notes."""
    body = (body or "").replace("\r\n", "\n").strip()
    heading = re.search(r"^(#{1,6})[ \t]+(?:what['’]s (?:changed|new)|changes|highlights)[ \t]*$",
                        body, flags=re.IGNORECASE | re.MULTILINE)
    if heading:
        body = body[heading.end():].strip()
        next_heading = re.search(r"^#{1," + str(len(heading[1])) + r"}[ \t]+", body, flags=re.MULTILINE)
        if next_heading:
            body = body[:next_heading.start()]
    # Full release notes are linked after the downloads; keep section headings local to this version.
    body = re.sub(r"^\*\*Full Changelog\*\*:.*$", "", body, flags=re.IGNORECASE | re.MULTILINE)
    return re.sub(r"^#{1,6}[ \t]+(.+?)[ \t]*$", r"**\1**", body.strip(), flags=re.MULTILINE)


def render(releases):
    versions = []
    for release in releases:
        version = VERSION.fullmatch(release["tag_name"])
        if version and not release["draft"] and (links := download_links(release)):
            versions.append((version_order(version), release, links))
    versions.sort(key=lambda entry: entry[0], reverse=True)
    lines = [
        "# VEXSSH downloads", "",
        f"[Open GitHub Releases](https://github.com/{REPO}/releases) for Windows downloads and release notes.", "",
        "Choose **Installer** to install or update VEXSSH on Windows x64. "
        "Choose **Portable** to run it directly with WebView2 already installed. "
        "Versions marked `rc` are release candidates.",
    ]
    for index, (_, release, links) in enumerate(versions):
        tag = release["tag_name"]
        published = date.fromisoformat(release["published_at"][:10])
        heading = f"## {tag[1:]}" + (" · Latest download" if index == 0 else "")
        notes = change_notes(release.get("body"))
        if not notes:
            notes = "The publisher did not provide change notes for this release."
            if index + 1 < len(versions):
                previous = versions[index + 1][1]["tag_name"]
                notes += f" [Compare with {previous[1:]}](https://github.com/{REPO}/compare/{previous}...{tag})."
        links.append(f"[Full release notes](https://github.com/{REPO}/releases/tag/{tag})")
        lines.extend(["", heading, "", published.strftime("%d %B %Y"), "", notes, "", " · ".join(links)])
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "DOWNLOADS.md"
    output.write_text(render(load_releases()), encoding="utf-8", newline="\n")
