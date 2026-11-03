# frontend — the frontend live run

A tracked, parameterized harness that drives the product's own UI at a pinned commit and reports what
the player saw, what a turn cost, what the runtime held, and when the first screen painted.

It is a **live run**, not a screenshot kit: the drivers click the real send button, swipe real
variants and open real surfaces, so the geometry it captures is the geometry a player gets. The
screenshots are one of its four observations, not its definition.

Four observations, all written into each driver's own facts file:

| prefix | answers |
|---|---|
| (unprefixed) | what is on screen and where — rectangles, visibility, counts |
| `TIMINGS` | how long each phase of a turn took, from the product's own marks |
| `SWITCHES` | how long moving between surfaces took, from the product's own marks |
| `CAPABILITY` | the durable transcript's shape, and its growth across turns |
| `INJECTION` | which authored-context blocks and entries reached the request |
| `RUNTIME` | DOM nodes, heap, mark count at the end of the driver |
| `PAINT` | first paint, first contentful paint |

Absence is reported as `null` or `unobserved:<reason>`, never as `0`: a heap that the browser does not
expose and a page that never painted are not measurements of zero. The same rule is why `INJECTION`
says `unobserved:no_provider_request_capture` rather than "0 entries" — a run that recorded no
provider request did not observe an empty request, it observed nothing. The frontend run dials the
operator's gateway, so that is the reading a normal run produces; the reader takes a capture written
where `GB_SHOTS_WIRE_REQUESTS` points (which is what `tools/live-run/core/stub-provider.mjs` records)
as soon as a run supplies one.

Two marks families are READ, never re-measured: a driver that timed its own click would be a second
opinion about where the time went. `gamebuddy:turn:*` lives in `dialogue-web/src/components/turn-timings.ts`,
`gamebuddy:switch:<surface>:start|done` in `dialogue-web/src/composed-surface-route.ts` — the module every
surface selection goes through. A switch's `done` is the commit and its paint, NOT the surface's own
data: `done` with no `start` is Back or Escape (the browser moved the history entry, nobody pressed an
entry), and it carries no duration because no selection was ever made.

## Which drivers observe, and which do not

Every driver that changes surface or sends a turn now calls `observe()`: a, b, c, d, e, f, g, h, i, j,
k, l, m, n, o, p, q, r, s, t. Each records `observationStart(page)` at its start and passes it as
`sinceMs`, because the mark buffer belongs to the PAGE and the drivers share one page: without a
baseline the last driver to read would report every earlier driver's turn and switch as its own — the
same misattribution that made `PAINT` report one firstPaint on every driver.

No driver is left out. A driver whose scenario takes an early named skip writes its skip and exits
before reaching `observe()`, so its facts file carries no `SWITCHES` line at all — and each section of
`README.txt` names the drivers that wrote no line of it, so a silent driver is a listed absence rather
than an empty space.

## One command

```text
node tools/live-run/frontend/run.mjs --commit <sha|HEAD> --out D:\gb-modcheck\shots-final14
```

This runs the full pipeline (check → pin → build → launch → capture → cleanup → report) and delivers
the set (PNGs, per-item `*.txt`, `README.txt`, `REPORT.txt`) into `--out`. The run root and the pinned
worktree are **kept** under `<out>.stage` so the report remains verifiable.

Fast prerequisites, named per item, before the long build starts:

```text
node tools/live-run/frontend/run.mjs --check --commit HEAD --out D:\gb-modcheck\shots-final14
```

Resumable stepwise mode (each phase is separately runnable; capture skips drivers that already wrote
their per-driver fact file unless `--force`):

```text
node tools/live-run/frontend/run.mjs pin   --out D:\gb-modcheck\shots-final14 --commit HEAD
node tools/live-run/frontend/run.mjs build --out D:\gb-modcheck\shots-final14 --runtime D:\gb-art\diag1\generations\<id>\runtime
node tools/live-run/frontend/run.mjs launch …
node tools/live-run/frontend/run.mjs capture …            (or --driver=a,b to re-run a subset, --force to redo done ones)
node tools/live-run/frontend/run.mjs cleanup …
node tools/live-run/frontend/run.mjs report …
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