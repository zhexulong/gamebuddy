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
provider request did not observe an empty request, it observed nothing.

**How the capture is produced.** The launch phase starts a recording proxy
(`tools/live-run/core/recording-provider-proxy.mjs`, wired by `lib/wire-capture.mjs`) in front of the
endpoint the product resolves, and points the launched Host child at it through the product's own
`GAMEBUDDY_OPERATOR_GATEWAY_BASE_URL` switch. `launch.log` says which happened and `launch.json`
carries it as `wireCapture`.

Three facts make that a measurement of the real run rather than of a substitute:

1. **the provider request never crosses the browser.** `dialogue-web` posts a turn to the Host and
   reads that turn's SSE; the Host's Pi session is what posts to the gateway. So the proxy sits there,
   between the Host and the gateway, and not between the page and the Host: nothing a driver can
   intercept over CDP carries a provider body, whatever the capture phase listens for.
2. **the endpoint is the product's own, and the reply is the real model's.** The upstream is read from
   the generation's catalog (`operatorGatewayBaseUrl()`) instead of being spelled here, so the run
   dials the address it would have dialled; the request is forwarded unchanged and the endpoint's own
   reply streams back. A stub that answered instead would change what the run measures.
3. **attribution is by identity, never by position.** The Host stamps each outbound request with the
   turn it belongs to and the submission key that turn was accepted under
   (`X-GameBuddy-Turn-Id` and `X-GameBuddy-Idempotency-Key`, `host/src/provider-turn-header.internal.ts`).
   Two identities because the two parties know different things: the Host knows `turn_<uuid>`, and no
   page is ever given it (a browser sees only an HMAC turn handle); a browser marks its own turn with
   the idempotency key it submitted under. The key is what lets a reader holding a driver's marks name
   the request that driver caused, so the join needs no knowledge of the store's schema. A request with
   no headers is recorded with `turnId: null` and `idempotencyKey: null` and reported as
   `no_capture_for_turn`. Arrival order is not turn order: a `/models` probe, a transport retry or a
   second surface inserts a record and shifts every later position.

The file is `<stage>/state/wire-requests.jsonl`: one JSON object per line, appended as each request
arrives, and each line names its own writer. An append is the right shape for a run that streams -
rewriting a growing document after every request costs the square of the run and loses every earlier
record if the process is killed mid-write. Each record is
`{ source, at, method, path, turnId, idempotencyKey, body }` and carries no headers: the credential
travels in `authorization`, and this file lives for the whole run and is kept beside the report. The
reader refuses a file whose lines disagree about the writer (`capture_source_conflict`, naming both) or
whose line declares none (`capture_source_undeclared`), and calls zero records `capture_file_empty`
rather than a capture that saw none. What the capture cannot see: the connection's own `/models` probe
(not a turn, and it posts no body), the reply, and anything the Host does after the request - `TIMINGS`
and `CAPABILITY` cover those.

What a reading still cannot claim: a record whose turn carries a turn id but no submission key cannot be
attributed to any page, and is reported as `unobserved:<n>_capture_records_naming_a_turn_and_no_submission_key`
rather than guessed into a neighbour. That is the shape a Host older than the key header would produce,
and a turn shape that reused a turn without its key would land there too.

A run whose recorder could not start says `wire capture: unavailable:<reason>` in `launch.log` and every
driver reads `unobserved:no_provider_request_capture:<reason>`; the run keeps dialling its own gateway.

Two marks families are READ, never re-measured: a driver that timed its own click would be a second
opinion about where the time went. `gamebuddy:turn:*` lives in `dialogue-web/src/components/turn-timings.ts`,
`gamebuddy:switch:<surface>:start|done` in `dialogue-web/src/composed-surface-route.ts` — the module every
surface selection goes through. A switch's `done` is the commit and its paint, NOT the surface's own
data: `done` with no `start` is Back or Escape (the browser moved the history entry, nobody pressed an
entry), and it carries no duration because no selection was ever made.

## Which drivers observe, and which do not

Every driver that changes surface or sends a turn now calls `observe()`: a, b, c, d, e, f, g, h, i, j,
k, l, m, n, o, p, q, r, s, t, u. Each records `observationStart(page)` at its start and passes it as
`sinceMs`, because the mark buffer belongs to the PAGE and the drivers share one page: without a
baseline the last driver to read would report every earlier driver's turn and switch as its own — the
same misattribution that made `PAINT` report one firstPaint on every driver.

No driver is left out. A driver whose scenario takes an early named skip writes its skip and exits
before reaching `observe()`, so its facts file carries no `SWITCHES` line at all — and each section of
`README.txt` names the drivers that wrote no line of it, so a silent driver is a listed absence rather
than an empty space.

## Waiting for a panel, not for a duration

`activateSurface` commits the surface's region and its paint; it commits nothing about that surface's
data. The 角色 panel renders `<section data-opening-editor>` as soon as the panel mounts and its
`.opening-variant-row` rows only once the card read lands, so in between the editor holds ZERO rows and
no buttons - which is also exactly what a companion already down to one opening holds. On a contended
machine driver M's fixed 1600 ms sleep read that 0 as a product fact, pressed a save control that did
not exist yet (`saving the one-opening set: no_button:保存开场白`) and died 30 s later inside the next
surface switch; the same code passed 20/20 on an idle machine.

`waitForPanel` (`capture/common.cjs`) is the instrument: the panel root present, the product's own
`.loading-text` gone from that root, and the item count unchanged across two reads. A panel that never
reaches that state fails the driver as `panel_never_settled:<name>` with the selectors it waited for
and the page's last reading, instead of a number measured from a panel that was not there.

Driver M's two reads of that editor now wait for it. Everything else that sleeps after
`activateSurface` was audited and **left**, for a reason per group: their reads are layout or
descriptive probes that print absence literally (`a`, `b`, `c`, `d`, `g`, `h`, `i`); a missing value
turns into a named skip rather than a false fact (`j`); the driver sends its own turn and re-reads when
the transcript is short, which is a self-heal rather than a measurement (`n`, `p`); the read is repeated
in a loop before anything is acted on (`e`, `t`); or the assertion that matters waits on the product's
own turn marks (`f`). The same shape does remain in `k`, `l`, `o`, `q`, `r` and `s`, where a pre-load
read is a count the driver then acts on - each needs its own live run to confirm the panel root and the
item selector, which is why they are listed here rather than guessed at blind.

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

Twenty-one drivers under `capture/`, run over CDP against the mounted product tab. Each writes its
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