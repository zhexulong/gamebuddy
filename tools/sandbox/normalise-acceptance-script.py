"""Normalise the acceptance script to CRLF and assert its uninstall wait shape.

`cmd.exe` misparses a `.cmd` file that uses bare LF line endings, so the shipping file must be CRLF - a fact
measured the hard way, when a script written with LF produced "was unexpected at this time" instead of
running.

The uninstall wait asserts the program root has disappeared. An earlier version of this check also required
the removal marker file, on the theory that the marker is written after the rmdir. That theory was not
confirmed: a purpose-built proof could not reproduce the ordering gap locally, and the sandbox run that
looked like a counter-example turned out to be a 0.5-second stub invocation that ran before any install had
happened. So the check asserts what was actually observed to work, rather than an unverified ordering.
"""

import pathlib

GATE = pathlib.Path("tools/sandbox/sandbox-verify.cmd")


def main():
    text = GATE.read_text(encoding="utf-8")
    normalised = text.replace("\r\n", "\n").replace("\n", "\r\n")
    GATE.write_bytes(normalised.encode("utf-8"))

    data = GATE.read_bytes()
    crlf = data.count(b"\r\n")
    bare_lf = data.count(b"\n") - crlf

    checks = {
        "file is CRLF only": bare_lf == 0,
        "the uninstall wait polls the program root": 'if not exist "%PROGRAM_ROOT%" goto :removed'
        in normalised,
        "the uninstall wait has a bounded budget": "if %WAITED% GEQ" in normalised,
        "the marker is still asserted once the wait ends": 'if exist "%MARKER%"'
        in normalised,
    }

    failures = 0
    for label, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + label)
        if not ok:
            failures += 1
    print("  (CRLF={}, bare-LF={})".format(crlf, bare_lf))
    if failures == 0:
        print("\nacceptance_script_ready")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
