"""Replace only the managed navigation in a GitHub release description."""
import re


START = "<!-- vexssh-release-navigation:start -->"
END = "<!-- vexssh-release-navigation:end -->"
_BLOCK = re.compile(
    rf"^{re.escape(START)}\r?\n.*?^{re.escape(END)}(?=\r?$)(?:\r?\n\r?\n)?",
    re.MULTILINE | re.DOTALL,
)


def strip_navigation(body):
    body = body or ""
    starts, ends = body.count(START), body.count(END)
    if not starts and not ends:
        return body
    match = _BLOCK.search(body)
    if starts != 1 or ends != 1 or not match:
        raise ValueError("Malformed Windows release navigation markers; release notes were left untouched")
    return body[:match.start()] + body[match.end():]


def with_navigation(body, block):
    notes = strip_navigation(body)
    if not block:
        return notes
    # Keep the author's original bytes, even when the body mixes CRLF and LF.
    first_break = re.search(r"\r?\n", body or "")
    newline = first_break[0] if first_break else "\n"
    prefix = block.replace("\r\n", "\n").replace("\n", newline)
    return prefix + (newline * 2 + notes if notes else "")
