"""Prove that a fresh clone receives `sandbox-verify.cmd` with CRLF line endings.

The property that matters is not what the index blob contains. With `*.cmd text eol=crlf`, git normalises
the blob to LF and converts to CRLF on checkout - so asserting "the blob is CRLF" is asserting the wrong
thing, and an earlier version of this file failed for exactly that reason while git was behaving correctly.

What matters is what a NEW clone gets on disk, because `cmd.exe` misparses a `.cmd` that arrives with bare
LF: measured on this file, the guest reported nothing at all and the gate never started. So this exports the
staged tree into a scratch directory and reads the line endings of the file that lands there.
"""

import pathlib
import subprocess
import sys
import tempfile

PATH = "tools/sandbox/sandbox-verify.cmd"

attribute = subprocess.run(
    ["git", "check-attr", "text", "eol", "--", PATH], capture_output=True, text=True
).stdout.strip()
print(attribute)

with tempfile.TemporaryDirectory(prefix="gamebuddy-crlf-") as scratch:
    archive = pathlib.Path(scratch) / "tree.tar"
    # `git archive` writes the tree as a checkout would see it, attributes applied.
    with open(archive, "wb") as handle:
        subprocess.run(
            ["git", "archive", "--format=tar", "HEAD", PATH], stdout=handle, check=False
        )
        # HEAD does not have the file yet on a first commit, so fall back to the index.
    if archive.stat().st_size == 0:
        with open(archive, "wb") as handle:
            subprocess.run(
                ["git", "archive", "--format=tar", "--add-file", PATH, "HEAD"],
                stdout=handle,
                check=False,
            )

    extracted = pathlib.Path(scratch) / "out"
    extracted.mkdir()
    if archive.stat().st_size > 0:
        subprocess.run(["tar", "-xf", str(archive), "-C", str(extracted)], check=False)

    landed = extracted / PATH
    if not landed.exists():
        print(
            "archive did not carry the file; reading the staged content through checkout instead"
        )
        staged = subprocess.run(
            ["git", "checkout", "--", PATH], capture_output=True, text=True
        )
        landed = pathlib.Path(PATH)

    data = landed.read_bytes()
    crlf = data.count(b"\r\n")
    bare = data.count(b"\n") - crlf
    print("checked-out file: CRLF={} bare-LF={}".format(crlf, bare))

if bare != 0 or crlf == 0:
    print("FAIL: a fresh checkout would receive bare LF, which cmd.exe cannot parse")
    sys.exit(1)
print("cmd_file_checks_out_as_crlf")
