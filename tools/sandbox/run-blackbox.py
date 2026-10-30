"""Run the black-box recorder in a sandbox and print what the guest recorded.

Completely independent of RPyC. The logon command in `blackbox.wsb` copies `record.ps1` to C:\\ and runs it;
the recorder writes `C:\\boot.log` on the guest and, once the mount is live, drops copies plus the gate's
output into the host share. So the diagnosis arrives through the share, which is the one channel that is
known to work once mounting succeeds - and if mounting never succeeds, the log says so.

This is the observation tool the earlier attempts lacked: it answers "did the command run at all, and where
did it stop" without guessing.
"""

import argparse
import pathlib
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
SHARE = pathlib.Path(r"C:\Users\long\gamebuddy-sandbox")


def stage(gate_source, setup_source):
    """Put the recorder, the gate AND the installer where the mapped folder will expose them.

    The installer is easy to forget and impossible to notice as a staging error: the gate reports
    `Setup.exe present in share | FAIL:missing`, and every layout check behind it fails too, which reads as
    a product failure rather than a missing input. So all three are staged together and their sizes printed,
    making a missing or truncated copy visible before the sandbox is even launched.
    """
    SHARE.mkdir(parents=True, exist_ok=True)
    staged = []
    for source, name in (
        (HERE / "record.ps1", "record.ps1"),
        (gate_source, "sandbox-verify.cmd"),
        (setup_source, "GameBuddy.Setup.exe"),
    ):
        if not source.exists():
            raise SystemExit("absent:{} (cannot stage {})".format(source, name))
        shutil.copyfile(source, SHARE / name)
        staged.append(
            "{} ({:.1f} MB)".format(name, (SHARE / name).stat().st_size / (1024 * 1024))
        )
    print("staged into", SHARE, ":", ", ".join(staged))

    # Clear the previous run's artifacts. Without this the driver sees `boot.log` on its first poll (the file
    # is from the last run) and reports success with stale content - measured: a run printed
    # `appeared: boot.log after 0 s` and then reproduced the PREVIOUS run's log verbatim, including its 172s
    # elapsed time. Each run's evidence has to be its own.
    for stale in (
        "boot.log",
        "boot.again.log",
        "result.log",
        "sandbox-result.txt",
        "sandbox-result.json",
        "setup-stdout.txt",
        "setup-stderr.txt",
        "shortcut.txt",
        "uninstall-stdout.txt",
    ):
        path = SHARE / stale
        if path.exists():
            path.unlink()
    print("cleared previous artifacts")


def close_existing(timeout_seconds=300):
    """Wait for any previous sandbox instance to release the platform's single-instance lock."""
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(HERE / "release-sandbox-sessions.ps1"),
            "-DrainTimeoutSeconds",
            str(timeout_seconds),
        ],
        check=False,
    )


def launch(configuration):
    subprocess.run(
        [
            "cmd.exe",
            "/c",
            "start",
            "",
            "C:\\Windows\\System32\\WindowsSandbox.exe",
            str(configuration),
        ],
        check=False,
    )


def wait_for_log(timeout_seconds):
    """Poll the share for the recorder's artifacts, reporting progress so a stall is visible.

    Waits for the GUEST's own log (`boot.log`, copied out by the recorder at the end) rather than for
    `sandbox-result.json`. The gate writes its verdict before the recorder finishes, and an earlier version
    returned as soon as it saw that file - which could still be the previous run's, since the two are written
    seconds apart and a stale copy is indistinguishable by name alone.
    """
    targets = {
        "boot.log": SHARE / "boot.log",
        "result.log": SHARE / "result.log",
        "sandbox-result.json": SHARE / "sandbox-result.json",
    }
    started = time.time()
    seen = {}
    while time.time() - started < timeout_seconds:
        for name, path in targets.items():
            if name not in seen and path.exists():
                seen[name] = time.time() - started
                print("appeared:", name, "after", round(seen[name]), "s")
        if "boot.log" in seen:
            # The recorder copies its log out as the last thing it does, so this means the run is complete.
            break
        time.sleep(5)
    return seen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--wait", type=int, default=1500, help="seconds to wait for the guest log"
    )
    parser.add_argument(
        "--setup", required=True, help="GameBuddy.Setup.exe to install inside the guest"
    )
    parser.add_argument("--skip-close", action="store_true")
    arguments = parser.parse_args()

    gate_source = HERE / "sandbox-verify.cmd"
    if not gate_source.exists():
        raise SystemExit("gate absent:{}".format(gate_source))
    setup_source = pathlib.Path(arguments.setup).resolve()

    # Close any previous instance FIRST, then stage. Measured: staging 447 MB while a previous session still
    # held the share produced `PermissionError: [WinError 32]` on result.log, and - worse - a previous
    # session's still-running gate could keep writing into the share after the new inputs were placed, so the
    # artifacts read back afterwards belonged to two different runs.
    if not arguments.skip_close:
        close_existing()
    stage(gate_source, setup_source)

    configuration = HERE / "blackbox.wsb"
    print("launching:", configuration)
    launch(configuration)

    seen = wait_for_log(arguments.wait)
    print()
    if not seen:
        print("NO ARTIFACTS APPEARED.")
        print(
            "That is itself the answer: the logon command did not reach the stage where it writes to the"
        )
        print(
            "share. Check C:\\boot.log inside the guest - if it is absent too, the command never ran."
        )
        return 1

    print("=== boot.log (guest recorder) ===")
    boot = SHARE / "boot.log"
    if boot.exists():
        text = boot.read_text(encoding="utf-8-sig", errors="replace")
        sys.stdout.flush()
        sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    else:
        print("(absent)")

    print("=== result.log (gate output) ===")
    result = SHARE / "result.log"
    if result.exists():
        # The gate's transcript mixes UTF-8 Chinese from the guest locale with ASCII; decode it explicitly
        # rather than through the console's default code page.
        text = result.read_text(encoding="utf-8-sig", errors="replace")
        lines = text.splitlines()
        rendered = "\n".join(lines[-120:]) if len(lines) > 120 else text
        sys.stdout.flush()
        sys.stdout.buffer.write((rendered + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    else:
        print("(absent)")

    print("=== sandbox-result.json (verdict) ===")
    verdict = SHARE / "sandbox-result.json"
    if verdict.exists():
        # Decode explicitly and write through the binary buffer: the file starts with a UTF-8 BOM, and
        # printing that through a GBK console raised UnicodeEncodeError right where the findings were being
        # reported. A diagnostic tool must not fail while reporting.
        text = verdict.read_text(encoding="utf-8-sig", errors="replace")
        sys.stdout.flush()
        sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    else:
        print("(absent)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
