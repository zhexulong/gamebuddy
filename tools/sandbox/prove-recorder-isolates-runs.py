"""Assert the recorder clears each run's gate transcript before the gate starts.

Why this exists: the product gate passed 21 checks inside a real sandbox, but the verdict still reported one
failure - `[uninstall] removal completion marker written | FAIL:missing` - because `result.log` is appended
to and a 0.27-second aborted run had left that line at the top of it. The verdict rule then counted a
previous run's finding as this run's.

That is a false negative in the gate itself, so it gets an assertion rather than a comment: the recorder must
list the gate transcript first among the files it clears, and it must do so before writing its own stages
(which it appends to a different file).
"""

import pathlib

RECORDER = pathlib.Path("tools/sandbox/record.ps1")
KEEP_OWN_LOG = "boot.log"


def main():
    source = RECORDER.read_text(encoding="utf-8")

    clearing_block_start = source.find("could-not-clear-stale")
    clearing_list = source.find("foreach ($stale in @(")

    checks = {
        "declares a per-run id": "run-id=" in source,
        "clears a list of stale artifacts": clearing_list >= 0,
        "the stale list includes the gate transcript": "$GateLog" in source,
        "the stale list includes the gate's own summary": "sandbox-result.json"
        in source,
        "clearing happens before the gate is launched": source.find("gate-present")
        > source.find("could-not-clear-stale"),
        "the recorder's own log is not cleared after its first line": source.find(
            "1 recorder-started"
        )
        < clearing_block_start,
        "the recorder still writes its own log under the guest's C:": "C:\\boot.log"
        in source,
    }

    failures = 0
    for label, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + label)
        if not ok:
            failures += 1

    if failures == 0:
        print("\nrecorder_isolates_runs")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
