# tools/sandbox

Clean-machine acceptance for the player install path: a real Windows Sandbox with no .NET, no Node and no
repository checkout installs the shipped installer, runs the launcher, and uninstalls.

**The runbook is [`design/operations/sandbox-acceptance.md`](../../design/operations/sandbox-acceptance.md).**
It carries the assertions, the commands, why this is not a blocking gate, the run flow, and the measured
facts. This file does not repeat any of that — two copies drift.

## Files

| File | Purpose |
|---|---|
| `sandbox-verify.cmd` | the assertions; runs inside the guest |
| `record.ps1` | guest recorder: stages to `C:\boot.log`, clears the run's transcript, runs the gate |
| `blackbox.wsb` | the sandbox configuration: one mapped folder, one logon command |
| `run-blackbox.py` | driver for the real sandbox |
| `run-sandbox-acceptance.mjs` | host-side twin of the assertions, needs no sandbox |
| `install-round-trip.ps1` | install/uninstall against a scratch root |
| `release-sandbox-sessions.ps1` | clears a stuck session (elevated terminates `vmwp`) |
| `validate-sandbox-configs.py` | rejects an invalid `.wsb` before launch |
| `normalise-acceptance-script.py` | CRLF normalisation and the uninstall-wait shape |
| `prove-verdict-rule.ps1` | the verdict rule can say FAIL, and names the check |
| `prove-recorder-isolates-runs.py` | a previous run's findings cannot count as this run's |
| `prove-driver-gate-paths.py` | driver host folder ↔ mapped folder ↔ gate guest path agree |
| `report-gate-assertions.py` | lists every assertion, by category |
| `report-share-state.py` | share contents and sandbox process state |
| `read-artifacts-with-provenance.py` | artifacts with timestamps, so a stale file is visibly stale |

## Commands

```
pnpm test:sandbox-configs      # every .wsb is valid XML, no BOM, no raw metacharacters in <Command>
pnpm test:sandbox-verdict      # green→pass, red→names the check, empty→does not pass
pnpm test:sandbox-wiring       # recorder clears each run; driver/mapping/gate paths agree
pnpm check:sandbox-acceptance -- --setup desktop/dist/setup/GameBuddy.Setup.exe
pnpm run:sandbox-level3       -- --setup desktop/dist/setup/GameBuddy.Setup.exe
```
