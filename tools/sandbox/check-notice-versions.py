"""Compare the versions the notices claim against the versions the bundles actually carry.

The notices document names a version per library, and those came from NuGet's "latest" resolution rather than
from the bundled files. That is a precision gap with a real consequence: a notice that names the wrong version
misdates the licence, which is worse than naming none, because it looks authoritative.

This reads each assembly's own file version and prints it beside the claim, so a mismatch is visible.
"""

import pathlib
import re
import subprocess
import sys

NOTICES = pathlib.Path("assets/smapi/THIRD-PARTY-NOTICES.txt")
ROOT = pathlib.Path("assets/smapi/win-x64")


def file_version(path: pathlib.Path) -> str:
    script = (
        "$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('{0}'); "
        "Write-Output ($v.FileVersion)"
    ).format(str(path).replace("'", "''"))
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True
    )
    return (result.stdout or "").strip()


claims = {}
for line in NOTICES.read_text(encoding="utf-8").splitlines():
    match = re.match(
        r"\s+(smapi-internal/\S+\.dll)\s+(\S.*?)\s{2,}(MIT|BSD-2-Clause|LGPL-3\.0)",
        line,
    )
    if match:
        claims[match.group(1)] = (match.group(2).strip(), match.group(3))

rows = []
for relative, (project, licence) in sorted(claims.items()):
    path = ROOT / relative
    if not path.exists():
        rows.append((relative, project, "FILE-MISSING", ""))
        continue
    rows.append((relative, project, file_version(path), licence))

width = max((len(row[0]) for row in rows), default=10) + 2
lines = [
    "{:{w}} {:<36} {:<20} {}".format(
        "assembly", "notice claim", "actual file version", "licence", w=width
    )
]
for relative, project, version, licence in rows:
    lines.append(
        "{:{w}} {:<36} {:<20} {}".format(relative, project, version, licence, w=width)
    )

sys.stdout.flush()
sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8", errors="replace"))

mismatches = 0
for relative, project, version, licence in rows:
    claimed = re.search(r"(\d+(?:\.\d+)+)", project)
    if not claimed or version in ("", "FILE-MISSING"):
        continue
    if not version.startswith(claimed.group(1).split(".")[0] + "."):
        mismatches += 1
sys.stdout.buffer.write(
    ("\nversion-family mismatches: {}\n".format(mismatches)).encode()
)
