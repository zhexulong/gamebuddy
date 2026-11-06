"""Does pywinsandbox establish a working control channel on this host?

This is the whole question for approach 2. The library boots an "online" sandbox (networking on, RPyC
server started by its own logon script) and then talks to it over TCP. If that works, the file-bus's
mount-race problem becomes irrelevant - but note that its logon script still has to survive the same
mount race, so this test is really "does the library's own bootstrap win where ours did not".

It prints what happened at each stage and never swallows an exception: a failure here has to name
which stage failed.
"""

import sys
import traceback

print("python:", sys.version)

try:
    import winsandbox

    print("winsandbox imported:", winsandbox.__file__)
except Exception:
    print("IMPORT FAILED")
    traceback.print_exc()
    raise SystemExit(1)

import winsandbox.utils.sandbox_feature_state as feature_state

try:
    enabled = feature_state.is_sandbox_feature_enabled()
    print("sandbox feature enabled:", enabled)
except Exception:
    print("feature check failed")
    traceback.print_exc()

print("--- creating online sandbox (this boots a guest and starts its RPyC server) ---")
try:
    sandbox = winsandbox.new_sandbox(networking=True)
    print("sandbox object:", sandbox)
    print("connection tuple:", sandbox._connection_tuple)
except Exception:
    print("SANDBOX CREATION FAILED")
    traceback.print_exc()
    raise SystemExit(1)

print("--- round trip: run a command inside the guest ---")
try:
    proc = sandbox.rpyc.modules.subprocess.run(
        ["cmd.exe", "/c", "echo hello-from-guest && hostname && ver"],
        capture_output=True,
        text=True,
    )
    print("exit code:", proc.returncode)
    print("stdout:", repr(proc.stdout))
    print("stderr:", repr(proc.stderr))
except Exception:
    print("ROUND TRIP FAILED")
    traceback.print_exc()
    raise SystemExit(1)

print("--- does the guest have .NET / node? (the Level 3 premise) ---")
try:
    probe = sandbox.rpyc.modules.subprocess.run(
        ["cmd.exe", "/c", "where dotnet 2>nul & where node 2>nul & echo done"],
        capture_output=True,
        text=True,
    )
    print("stdout:", repr(probe.stdout))
except Exception:
    print("PREMISE PROBE FAILED")
    traceback.print_exc()

print("--- shutting the sandbox down ---")
try:
    sandbox.shutdown()
    print("shutdown requested")
except Exception:
    print("shutdown failed (not fatal for the test)")
    traceback.print_exc()
