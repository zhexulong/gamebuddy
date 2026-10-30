"""Cross-check the acceptance script's paths against what the shipping driver stages, through the mapping.

Two files have to agree on where things are, and they see different paths because a sandbox maps a host
folder to a guest path:

  * the driver stages files into a HOST folder (`C:\\Users\\<user>\\gamebuddy-sandbox`);
  * the gate reads them from the GUEST path that folder is mapped to (`C:\\gamebuddy-share`);
  * the mapping itself is declared in `blackbox.wsb`.

So the correct check is not "the driver mentions the gate's share" - those strings differ by design, and a
previous version of this file failed for exactly that reason. It is:

  driver's host folder  ==  <HostFolder> in blackbox.wsb
  gate's share          ==  <SandboxFolder> in blackbox.wsb

both read from the files rather than restated, so changing either side without the other fails here.
"""

import pathlib
import re
import xml.etree.ElementTree as ElementTree

HERE = pathlib.Path(__file__).resolve().parent
GATE = HERE / "sandbox-verify.cmd"
DRIVER = HERE / "run-blackbox.py"
CONFIG = HERE / "blackbox.wsb"

failures = 0


def report(label, ok, detail=""):
    global failures
    print(("ok   " if ok else "FAIL ") + label + ((" -> " + detail) if detail else ""))
    if not ok:
        failures += 1


gate_text = GATE.read_text(encoding="utf-8")
driver_text = DRIVER.read_text(encoding="utf-8")

# The gate's own paths.
share = re.search(r"^set SHARE=(.+)$", gate_text, re.MULTILINE)
result = re.search(r"^set RESULT=(.+)$", gate_text, re.MULTILINE)
summary = re.search(r"^set SUMMARY=(.+)$", gate_text, re.MULTILINE)

report("the gate declares exactly one SHARE", share is not None)
if share is None:
    raise SystemExit(1)
gate_share = share.group(1).strip()
print("     gate SHARE      =", gate_share)
print("     gate RESULT     =", result.group(1) if result else "(absent)")
print("     gate SUMMARY    =", summary.group(1) if summary else "(absent)")

for label, match in (("RESULT", result), ("SUMMARY", summary)):
    report("the gate's {} lives in its SHARE".format(label), match is not None)
    if match is not None:
        value = match.group(1).strip()
        report(
            "  {} is inside SHARE".format(label),
            value.startswith(gate_share) or value.upper().startswith("%SHARE%"),
            value,
        )

# The mapping, read from the configuration rather than restated here.
root = ElementTree.fromstring(CONFIG.read_text(encoding="utf-8"))
host_folder = root.findtext(".//MappedFolder/HostFolder")
sandbox_folder = root.findtext(".//MappedFolder/SandboxFolder")
report(
    "blackbox.wsb declares a mapped folder",
    host_folder is not None and sandbox_folder is not None,
)
print("     mapped host     =", host_folder)
print("     mapped sandbox  =", sandbox_folder)
report(
    "the gate reads from the mapped GUEST folder",
    sandbox_folder is not None and sandbox_folder.strip().lower() == gate_share.lower(),
    "gate={} mapped={}".format(gate_share, sandbox_folder),
)

# The driver stages into the mapped HOST folder.
share_in_driver = re.search(r'SHARE = pathlib\.Path\(r"([^"]+)"\)', driver_text)
report("the driver declares exactly one host share folder", share_in_driver is not None)
if share_in_driver is not None:
    driver_share = share_in_driver.group(1)
    print("     driver SHARE    =", driver_share)
    report(
        "the driver stages into the mapped HOST folder",
        host_folder is not None
        and driver_share.strip().lower() == host_folder.strip().lower(),
        "driver={} mapped={}".format(driver_share, host_folder),
    )

# And it must stage every input the gate requires.
for needle, description in (
    ("GameBuddy.Setup.exe", "the installer"),
    ("sandbox-verify.cmd", "the gate"),
    ("record.ps1", "the recorder"),
    ("sandbox-result.json", "the verdict it reads back"),
):
    report("the driver handles {}".format(description), needle in driver_text)

print()
if failures == 0:
    print("driver_gate_paths_agree")
raise SystemExit(failures)
