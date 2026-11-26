"""Render the Windows downloads page from published VEXSSH GitHub releases."""
import json
import os
import re
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


def render(releases):
    rows = []
    for release in releases:
        tag = release["tag_name"]
        version = VERSION.fullmatch(tag)
        if release["draft"] or not version:
            continue
        files = {a["name"] for a in release["assets"] if a["state"] == "uploaded"}
        base = f"https://github.com/{REPO}/releases"
        def link(name, label):
            return f"[{label}]({base}/download/{tag}/{quote(name)})"
        links = []
        for suffix, label in [("Online-Setup.exe", "Installer"), ("Portable.exe", "Portable")]:
            candidates = [f"{brand}-{tag[1:]}-Windows-x64-{suffix}" for brand in ("VEXSSH", "NEXSSH")]
            name = next((candidate for candidate in candidates if candidate in files), None)
            links.append(link(name, label) if name else "—")
        if links == ["—", "—"]:
            continue
        checksums = link("SHA256SUMS.txt", "SHA-256") if "SHA256SUMS.txt" in files else "—"
        rows.append((version_order(version), f"| [{tag[1:]}]({base}/tag/{tag}) | {links[0]} | {links[1]} | {checksums} |"))
    rows.sort(reverse=True)
    lines = [
        "# VEXSSH downloads", "",
        "Windows x64 releases, newest first. Versions marked `rc` are release candidates.", "",
        "Choose **Installer** to install or update VEXSSH and download WebView2 if needed. "
        "Choose **Portable** to run it directly on a PC that already has WebView2.", "",
        "| Version and release notes | Install | Run without installing | Checksums |",
        "| --- | --- | --- | --- |",
    ]
    return "\n".join(lines + [row for _, row in rows]) + "\n"


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "DOWNLOADS.md"
    output.write_text(render(load_releases()), encoding="utf-8", newline="\n")
