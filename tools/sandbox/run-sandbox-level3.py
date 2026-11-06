"""Level 3 acceptance: run the clean-machine install gate inside a real Windows Sandbox.

Why this exists, and why it is shaped this way:

* Windows Sandbox is the only place we can prove the installer works on a machine with no .NET SDK, no
  Node and no repository checkout - which is the premise every player machine satisfies and no developer
  machine does.
* The guest's UI cannot be driven from the host (the window is an RDP surface), and the mapped-folder
  logon channel is unreliable here: the mount has been measured arriving ~158s after `LogonCommand`, and
  a command that touches the share before then dies silently. So the control channel is RPyC over TCP
  (see `sandbox_rpyc.py`), which needs no UI and no logon-time file access.
* The gate itself is `sandbox-verify.cmd`: it installs the real Setup, asserts the real per-user layout,
  the generation, the SMAPI payload, the LGPL licence, the desktop shortcut, that the launcher runs, and
  that uninstall removes everything. Its transcript and JSON verdict are read back over the same channel,
  so no shared folder is involved in reporting either.

The verdict is the script's own: this module never decides pass/fail itself.
"""

import json
import pathlib
import sys
import time
import traceback

import sandbox_rpyc

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
ACCEPTANCE_SCRIPT = pathlib.Path(__file__).resolve().parent / "sandbox-verify.cmd"

# The gate reads its inputs from a fixed guest path, so the staging step below writes exactly there.
GUEST_STAGE = r"C:\gamebuddy-stage"
SETUP_TIMEOUT_SECONDS = 900
GATE_TIMEOUT_SECONDS = 1800


def upload(connection, host_path, guest_path):
    """Copy a file into the guest over RPyC, without a shared folder.

    The channel is text-oriented, so the bytes travel base64-encoded and are decoded by the guest's own
    module: that keeps arbitrary binaries (an installer with an embedded payload) intact.
    """
    import base64

    payload = pathlib.Path(host_path).read_bytes()
    encoded = base64.b64encode(payload).decode("ascii")
    with connection.modules.builtins.open(guest_path, "wb") as handle:
        handle.write(connection.modules.base64.b64decode(encoded))
    return len(payload)


def main():
    if not ACCEPTANCE_SCRIPT.exists():
        raise SystemExit("acceptance_script_absent:{}".format(ACCEPTANCE_SCRIPT))

    setup_argument = None
    for index, argument in enumerate(sys.argv[1:]):
        if argument == "--setup":
            setup_argument = sys.argv[index + 2]
    if setup_argument is None:
        raise SystemExit("usage: run-sandbox-level3.py --setup <GameBuddy.Setup.exe>")
    setup_path = pathlib.Path(setup_argument)
    if not setup_path.is_absolute():
        setup_path = (REPOSITORY_ROOT / setup_path).resolve()
    if not setup_path.exists():
        raise SystemExit("setup_absent:{}".format(setup_path))

    print(
        "setup:",
        setup_path,
        "({:.1f} MB)".format(setup_path.stat().st_size / (1024 * 1024)),
    )

    try:
        connection, address_path, config_path = sandbox_rpyc.new_sandbox()
    except Exception:
        print("SANDBOX BOOT FAILED")
        traceback.print_exc()
        return 2

    try:
        # The premise this gate is for: a machine with no developer tooling.
        code, out, err = sandbox_rpyc.run(
            connection, "where dotnet 2>nul & where node 2>nul & echo premise-checked"
        )
        print(
            "clean-machine premise (empty above means neither tool is present):",
            repr(out),
        )

        sandbox_rpyc.run(
            connection,
            "cmd /c if not exist {} mkdir {}".format(GUEST_STAGE, GUEST_STAGE),
        )
        written = upload(connection, setup_path, GUEST_STAGE + r"\GameBuddy.Setup.exe")
        print("uploaded setup:", written, "bytes")
        upload(connection, ACCEPTANCE_SCRIPT, GUEST_STAGE + r"\sandbox-verify.cmd")
        print("uploaded acceptance script")

        # The gate expects its share at C:\gamebuddy-share; give it exactly that, inside the guest.
        sandbox_rpyc.run(
            connection,
            "cmd /c if not exist C:\\gamebuddy-share mkdir C:\\gamebuddy-share",
        )
        sandbox_rpyc.run(
            connection,
            'cmd /c copy /y "{}\\GameBuddy.Setup.exe" C:\\gamebuddy-share\\GameBuddy.Setup.exe'.format(
                GUEST_STAGE
            ),
        )

        print(
            "--- running the acceptance gate (this installs the product inside the guest) ---"
        )
        started = time.time()
        code, out, err = sandbox_rpyc.run(
            connection,
            'cmd /c "{}"'.format(GUEST_STAGE + r"\sandbox-verify.cmd"),
            timeout_seconds=GATE_TIMEOUT_SECONDS,
        )
        elapsed = round(time.time() - started)
        print("gate exit:", code, "in", elapsed, "s")

        # Read the verdict the gate wrote. If it is absent, the gate did not reach its end, and that is a
        # failure to report - not something to infer around.
        verdict_text = None
        for attempt in range(20):
            read_code, read_out, _ = sandbox_rpyc.run(
                connection,
                "cmd /c type C:\\gamebuddy-share\\sandbox-result.json 2>nul & echo __END__",
            )
            candidate = (read_out or "").split("__END__")[0].strip()
            if candidate:
                verdict_text = candidate
                break
            time.sleep(1)

        if verdict_text is None:
            print("VERDICT ABSENT: the gate did not write sandbox-result.json")
            print("gate stdout tail:", (out or "")[-4000:])
            print("gate stderr tail:", (err or "")[-2000:])
            return 1

        verdict = json.loads(verdict_text.lstrip("\ufeff"))
        print(json.dumps(verdict, indent=2, ensure_ascii=False))

        print("--- guest install locations afterwards ---")
        code, out, err = sandbox_rpyc.run(
            connection,
            'cmd /c if exist "%LOCALAPPDATA%\\Programs\\GameBuddy" (echo program-root-present) else (echo program-root-absent)',
        )
        print("post-run:", repr(out))

        return 0 if verdict.get("ok") is True else 1
    finally:
        try:
            sandbox_rpyc.run(connection, "shutdown /s /t 3")
        except Exception:
            pass


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    raise SystemExit(main())
