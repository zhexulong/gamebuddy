"""Report the share contents and the sandbox process state, in one readable block.

Written as a file rather than an inline `python -c` because nested quoting through bash -> PowerShell ->
python was repeatedly mangled, which wasted turns on shell mechanics instead of on the problem.
"""

import pathlib
import subprocess

SHARE = pathlib.Path(r"C:\Users\long\gamebuddy-sandbox")

print("share:", SHARE)
if SHARE.exists():
    for entry in sorted(SHARE.iterdir()):
        print(
            "  {:32} {:>8.1f} MB  {}".format(
                entry.name, entry.stat().st_size / 1048576, entry.stat().st_mtime
            )
        )
else:
    print("  (missing)")

print()
print("sandbox processes:")
completed = subprocess.run(
    [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Get-Process -ErrorAction SilentlyContinue | "
        "Where-Object { $_.ProcessName -match 'Sandbox|vmwp' } | "
        "Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize | Out-String",
    ],
    capture_output=True,
    text=True,
)
print(completed.stdout.strip() or "  (none)")
