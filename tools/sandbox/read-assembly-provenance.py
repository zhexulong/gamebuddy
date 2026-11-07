"""Read the company and copyright metadata out of the vendored third-party assemblies.

This is evidence for a licensing question, not a verdict: an assembly's own metadata names who claims it, which
is what tells us which upstream projects we are actually redistributing. The licence of each one then has to be
checked at its source - the metadata does not state it.
"""

import pathlib
import sys

ROOT = pathlib.Path("assets/smapi/win-x64")

entries = []
for path in sorted(ROOT.rglob("*.dll")):
    entries.append(path)

if not entries:
    raise SystemExit("no assemblies found")

lines = []
for path in entries:
    # PowerShell's FileVersionInfo is the only ready way to read Win32 version resources; run it per file so
    # one unreadable assembly cannot hide the rest.
    import subprocess

    script = (
        "$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('{0}'); "
        "Write-Output ($v.CompanyName + '||' + $v.ProductName + '||' + $v.LegalCopyright)"
    ).format(str(path).replace("'", "''"))
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True
    )
    fields = (result.stdout or "").strip().split("||")
    while len(fields) < 3:
        fields.append("")
    relative = path.relative_to(ROOT).as_posix()
    lines.append("{:<42} {:<28} {}".format(relative, fields[0][:27], fields[2][:70]))

sys.stdout.flush()
sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8", errors="replace"))
