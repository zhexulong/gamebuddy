# shots — the capture kit

A tracked, parameterized harness so a full screenshot set stops being a fresh hand-written lane each
time. One entry, one pinned commit, default runtime discovery, honest skips, resumable phases.

## One command

```text
node tools/shots/run.mjs --commit <sha|HEAD> --out D:\gb-modcheck\shots-final14
```

This runs the full pipeline (check → pin → build → launch → capture → cleanup → report) and delivers
the set (PNGs, per-item `*.txt`, `README.txt`, `REPORT.txt`) into `--out`. The run root and the pinned
worktree are **kept** under `<out>.stage` so the report remains verifiable.

Fast prerequisites, named per item, before the long build starts:

```text
node tools/shots/run.mjs --check --commit HEAD --out D:\gb-modcheck\shots-final14
```

Resumable stepwise mode (each phase is separately runnable; capture skips drivers that already wrote
their per-driver fact file unless `--force`):

```text
node tools/shots/run.mjs pin   --out D:\gb-modcheck\shots-final14 --commit HEAD
node tools/shots/run.mjs build --out D:\gb-modcheck\shots-final14 --runtime D:\gb-art\diag1\generations\<id>\runtime
node tools/shots/run.mjs launch …
node tools/shots/run.mjs capture …            (or --driver=a,b to re-run a subset, --force to redo done ones)
node tools/shots/run.mjs cleanup …
node tools/shots/run.mjs report …
```

`--check` reads only presence facts and prints **present|absent + length only** for the credential —
the value never enters a command line, a log, or this README.

## The four worktree prerequisites (each one bit a lane)

A detached worktree is bare: no `node_modules`, no submodules, no build outputs. `pin` materializes
everything from the MAIN checkout (`<repo>` in the recipe below):

| # | Prerequisite | Shape (why) | Recipe |
|---|--------------|-------------|--------|
| 1 | `host/node_modules/typescript` | **physical copy** — a junction makes host's tsc entry resolve out of the repo root and the build fails with `typescript_entry_escapes_repository_root` | robocopy `<repo>\host\node_modules\typescript` → `<wt>\host\node_modules\typescript`; junction every other child of `host\node_modules` |
| 2 | `dialogue-web/node_modules/vite` + its pnpm siblings | vite **physical copy**; the 8 siblings (`rolldown`, `postcss`, `esbuild`, `picomatch`, `tinyglobby`, `jiti`, `lightningcss`, `yaml`) **junctioned** | robocopy vite; junction the 8 from `<repo>\node_modules\.pnpm\node_modules\<name>` |
| 3 | `host/native/windows-stale-lock-reclaimer/.dist` | copied from main, then rebuilt fresh in the build phase from the pinned source | robocopy `.dist` (pin), `node host/scripts/build-windows-stale-lock-reclaimer.mjs` (build phase) |
| 4 | `integrations/stardew/bin/Release/net6.0` | compiled from the pinned source — never copied | `dotnet build .../GameBuddy.Stardew.csproj -c Release -p:GamePath=<gameDir>` (build phase) |

`pin.ps1` also junctions the root `node_modules` and the `vendor/{pi-koe,magic-context}` submodules
(which is why the worktree checks use `git diff --name-only HEAD --ignore-submodules=all`, never
`git status`). The pinned worktree must report 0 changed files before AND after the build — that is
the **no-overlay** proof. If a phase could only proceed via a patch, the kit stops and reports
instead (`DONE-PIN-FAIL` / `DONE-BUILD-FAIL`).

## Runtime fixture

`build-desktop-launcher-test-generation.mjs` needs a directory that **directly contains `node.exe`**
(a runtime ROOT fails with `desktop_launcher_test_fixture_node_missing`). The kit accepts
`--runtime <dir>`; otherwise it probes `GB_SHOTS_RUNTIME`, then scans `GB_SHOTS_RUNTIME_SEARCH`
(default `D:\gb-art`) for the newest `generations\*\runtime` that has a real `node.exe` inside.

## Launch + isolation

The child is driven through the tracked authority `tools/desktop-composition-launch.mjs`
(`launchDesktopCompositionGateChild`), imports it from the **pinned worktree** (`pin` refuses a
commit whose launcher lacks the exports the kit uses), never rewrites it, and

- sets the deployment manifest's `runtimeRoot` to the launcher's OWN declared data root
  (`desktopCompositionMutableRootPaths(root).data`) — overriding it to the temp root is what made
  an older run's declared layout look unused;
- checks the child's stderr is 0 bytes at ack, at ready and after mount before anything is believed
  (the product's own `[probe:m0_*]` Class-B markers may make it non-zero; the kit treats that as
  "no error tokens" and says which);
- runs `launch.measureRunRoots()` (declared AND resolved) and `assertDesktopCompositionRunRoots`
  after launch and after the run;
- never deletes `%LOCALAPPDATA%\GameBuddy`;
- **keeps the run root** `<out>.stage\root` until the report is accepted (cleanup never touches it).

## Capture

Eleven drivers under `capture/`, run over CDP against the mounted product tab. Each writes its
per-item fact file (`<out>/<driver>.txt`) with **measured numbers and quoted strings — never a class
name, never a pixel**: the driver is the only observer of the PNGs and reports computed layout facts
through the browser's own engine (`getBoundingClientRect`, `getComputedStyle`, `elementFromPoint`,
`Range`, offsetParent/getClientRects) at the two frozen viewports 1440x900 and 400x800.

Everything the last good lane learned is in these drivers: six surfaces × both sizes with
`overlays: 0` and horizontal overflow 0; a real conversation (send `你好`, quote the reply verbatim
with chars/sentences/`em.message-action` count); the variant flow (regenerate keeps the player-row
count at 1, the bubble handle identical, swipe back byte-identical, pager VISIBLE labels); Chinese
beat letter-spacing plus both contrast ratios; card-import review field names (human words,
snake_case 0); Characters grid columns + panel height; chat-select switching surface + title;
settings control widths; the contrast floor (lowest text contrast anywhere). A phase that cannot run
(no credential, no display, …) writes a **named skip** — it never silently passes.

## Report

`report` assembles `README.txt` (metadata: pinned commit, overlay proof, generation facts, entry
facts, `measureRunRoots` both halves, measurements per driver) and `REPORT.txt` (the 缺陷清单 by
surface + width, the resolved-probes section, what is right, and a plain *"I am reporting computed
facts, not pixels"* statement).

## Cleanup

`cleanup` writes the stop flag, waits for `DONE-LAUNCH`, sweeps guardian orphan processes (the
`\\?\`-prefixed family), kills only this lane's own processes, verifies the ports are closed,
verifies the run wrote **no tracked file change** in the main checkout, and reports the KEPT run root.

## Hard rules the kit enforces

- One generation build at a time; never `build-test-artifact-locked.mjs`.
- No overlays, no patches, no source edits in the pinned worktree.
- No inline logic in shell strings — every check that needs shell logic is a file under
  `probes/` (e.g. the PowerShell syntax parser `probes/ps-parse.ps1`).
- Asserts never weakened: no `skip`, no `as any`, no silent swallow of a product failure.
- The run root and the worktree are kept; the main checkout's files and other lanes' work are
  never touched, reset, stashed or cleaned.