"""Read the black-box artifacts with full provenance: timestamps, sizes, and a run identity.

The recurring failure in this investigation was mistaking a PREVIOUS run's artifact for the current one:
`result.log` and `sandbox-result.json` are plain files in the share, so a stale copy is indistinguishable
from a fresh one by content alone. Printing the modification time next to each artifact - and the sandbox's
own start time - makes that comparison possible instead of assumed.
"""

import json
import pathlib
import sys

SHARE = pathlib.Path(r"C:\Users\long\gamebuddy-sandbox")
ARTIFACTS = (
    "boot.log",
    "boot.again.log",
    "result.log",
    "sandbox-result.txt",
    "sandbox-result.json",
    "setup-stdout.txt",
    "setup-stderr.txt",
)


def emit(text):
    sys.stdout.flush()
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def read(name):
    path = SHARE / name
    if not path.exists():
        return None
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def main():
    emit("share: {}\n".format(SHARE))
    emit("artifacts, newest last:\n")
    present = []
    for name in ARTIFACTS:
        path = SHARE / name
        if path.exists():
            stat = path.stat()
            present.append((stat.st_mtime, name, stat.st_size))
    for modified, name, size in sorted(present):
        import datetime

        when = datetime.datetime.fromtimestamp(modified).strftime("%H:%M:%S")
        emit("  {:24} {:>10} bytes  modified {}\n".format(name, size, when))
    if not present:
        emit("  (none)\n")

    for name in ("boot.log", "result.log", "sandbox-result.json"):
        text = read(name)
        emit("\n===== {} =====\n".format(name))
        if text is None:
            emit("(absent)\n")
            continue
        emit(text if text.endswith("\n") else text + "\n")

    verdict = read("sandbox-result.json")
    if verdict:
        try:
            parsed = json.loads(verdict)
        except json.JSONDecodeError as error:
            emit("\nverdict unparseable: {}\n".format(error))
            return 1
        emit(
            "\n===== verdict =====\nok={} productChecks={} failingCount={}\n".format(
                parsed.get("ok"),
                parsed.get("productChecks"),
                parsed.get("failingCount"),
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
