# CI & test-matrix green — progress log

Task: establish what runs where, run the whole available matrix at the current commit, attribute
every red, fix the wiring gaps. Verification-first: change as little as possible, prove each change.

## Baseline (recorded at start)

`git rev-parse HEAD` = `6c4473293b6aa18fb4744df6b0d6871f9444b92c` (branch `main`).

`git log --oneline -10`:

```
6c447329 feat(dialogue-web): the player sees, edits and clears the companion's own directive
bbf57f5d feat(host): the mounted companion's own directive is readable, editable and clearable
bc848292 fix(tavern): a card's own world-book trigger words survive import
e670005d chore(vendor): our chapter migrations move to the fork's version lane
687fb0bd fix(tavern): the shipped default companion carries the card's own voice
d292e3f6 feat(stardew): five new actions reach live_verified
f43ce052 fix(deps): the Pi siblings actually moved to 1.2.0
49f7092b fix(tavern): an imported card's own system_prompt reaches the model, after the Host floor
428e5037 test(host): a test that opens a store closes it, and the ratchet says so
a511981e test(stardew): the Host must recognise the receipt its own producer emitted - and it caught two defects at once
```

`git status --porcelain` at start: `ci.yml` modified + 6 `.pi/tools/*.md` deletions + card/preset
assets + `game-tools.ts` + `stardew-game-integration-adapter.ts` + 2 tavern preset files + 4 C#
files + `stardew-action-gate-descriptors.test.mjs` + 3 `dialogue-web/probe-tmp*.mjs` + 2
`host/tsconfig.focus-*.json`. Two live lanes were at work in this tree
(`.pi/tools/residuals-progress.md` — `management-surface-panels.tsx` + `dialogue-web/tests/**`;
`.pi/tools/capture7-progress.md` — screenshot capture in a pinned worktree). Neither touched
anything this run wrote.

Writable set used: `.github/workflows/ci.yml`, `tools/test-store-teardown-baseline.json`,
`.pi/tools/ci-green-progress.md`, `scratch/**`. Nothing else was written.

## Every root + dialogue-web script, and its entry point

Full generated table: `scratch/ci-audit.mjs` -> `.tmp/ci-audit.txt` (211 root scripts, 9
dialogue-web scripts, each with the entry points that invoke it). Summary of the two lists that
matter:

- **`check:*` whose rule runs in a job but whose own `test:*` runs in no job** — at committed HEAD
  this was exactly `check:dialogue-web-boundaries` (`ci.yml:51`) and `check:dependency-risk`
  (`ci.yml:87`); `check:error-identity-classification` had already been paired today (`ci.yml:54-55`,
  2a784754). The working tree carried the pairing for both; only the `dependency-risk` half is safe
  (below).
- **`check:*` / `test:*` where BOTH halves run in no job** — 20 pairs, e.g. `check:production-pack-load`,
  `check:smoke-syntax`, `check:scope-references`, `check:host-game-physical-seam`,
  `check:gameplay-capability-catalog`, the six `check:stardew-native-*` registers, `check:tavern-references`,
  `check:tavern-release-prerequisites`, `check:stardew-action-promotion`, `check:stardew-loop-closure`,
  `check:stardew-receipt-attribution`. These are developer/ratchet tools, not CI gates.

## Entry points (what runs what)

| entry point | file:line | what it runs | notes |
| --- | --- | --- | --- |
| local commit | `.git/hooks/` | **nothing** | only `*.sample` files; no husky, lefthook or `core.hooksPath` |
| `quality:check` | `package.json:37` (docs `README.md:156`) | format:check, lint, lint:eslint, lint:ast-grep, typecheck, check:host-production-import-boundary, check:text-hygiene, check:error-identity-classification, check:host-diagnostic-output, check:test-store-teardown, check:dialogue-web-boundaries, test:stardew:core, test:stardew:integration | local-only: **no workflow invokes `quality:check`** |
| CI `host` | `ci.yml:12-89` | preflight+test, knip, script-entries, complexity-gate, workspace-debris, format, lint, host-module-graph, d-w-boundaries (+test), host-production-import-boundary, error-identity (+test), **typecheck**, head-typecheck, publint, clones, d-w build, `test:static`, `test:artifact`, Chromium, `test:mounted`, **`pnpm test`** (vendor + host), composed-runtime contract, phase0b, dependency-audit, dependency-risk (+test), sbom diff | |
| CI `voice-gateway` | `ci.yml:91-116` | `vendor/pi-koe`: install, build:protocol, build, test, typecheck | root `test:voice-protocol` is a subset of the job's `pnpm run test` |
| CI `stardew-scaffold` | `ci.yml:118-151` | dotnet restore; Core tests; Integration tests; `integrations/stardew/action-development` tests; native-local-runner contract (audit + 2 tests) | |
| release `host-release` | `release-windows.yml:13-186` | preflight+test, host-production-import-boundary, d-w-boundaries, pi-koe build, typecheck, `test:artifact`, native helper builds, dotnet restore, `host test`, `host build:release`, `host check:production-artifact`, tavern evidence gates, `test:mounted`, conformance, cleanup | static zone deliberately not run |

## Matrix at HEAD 6c447329 (working tree, 2026-10-14 ~02:0x)

| command | result |
| --- | --- |
| `node tools/check-head-typecheck.mjs` | `head_typecheck_ok rev=6c4473293b6a projects=tsconfig.json` exit 0 |
| `host/ tsc -p tsconfig.json --noEmit` | exit 0 |
| `dialogue-web tsc --project tsconfig.json --noEmit` | exit 0 |
| `pnpm --filter @gamebuddy/dialogue-web test:static` | **203 tests, 203 pass, 0 fail**, 17.3 s, exit 0 |
| `pnpm --filter @gamebuddy/dialogue-web test:artifact` | **13 tests, 13 pass, 0 fail**, 3.0 s, exit 0 |
| `pnpm --filter @gamebuddy/dialogue-web test:mounted` | **151 passed, 1 skipped, 0 failed**, 2.2 m, exit 0 |
| `pnpm check:dialogue-web-boundaries` (depcruise rule) | `no dependency violations found (40 modules, 59 dependencies)` exit 0 |
| `pnpm test:dialogue-web-boundaries` (rule's suite) | **RED 3/4** — `file components/AppBar.tsx matches 0 zones` (details below) |
| `pnpm test:dependency-risk` | 13/13 pass, exit 0 |
| `node host/scripts/check-test-typecheck-ratchet.mjs` | **RED** `test_typecheck_ratchet_failed new=1`, `TS2322: 35 -> 36`, exit 1 |
| `node tools/check-error-identity-classification.mjs` | `error_identity_classification_ok scope=host/src` exit 0 |
| `node tools/check-host-diagnostic-output.mjs` | `host_diagnostic_output_ok sites=13 files=8` exit 0 |
| `node tools/check-test-store-teardown.mjs` | RED before fix, `test_store_teardown_ok files=30` after |
| `node --test tools/check-test-store-teardown.test.mjs` | 15/15 pass |
| `node --test tools/check-error-identity-classification.test.mjs` | 13/13 pass |
| `node --test tools/check-host-diagnostic-output.test.mjs` | 16/16 pass |

There is no root `test:static`; the static zone is `pnpm --filter @gamebuddy/dialogue-web test:static`.

Zones: `test:static` -> `ci.yml:73`; `test:artifact` -> `ci.yml:74` **and** `release-windows.yml:68`;
`test:mounted` -> `ci.yml:77` **and** `release-windows.yml:127`. All three are named explicitly by
CI; `pnpm test` is the vendored + Host suites only and runs no dialogue-web zone, as the task stated.

## Red attributions

1. **ratchet `new=1` (TS2322 35 -> 36)** — PRE-EXISTING at HEAD~, not grown by HEAD. Own
   confirmation: `scratch/ratchet-rev-count.mjs HEAD~ 6c447329` -> `rev=HEAD~ errors=162
   TS2322=36` and `rev=6c447329 errors=162 TS2322=36`. Same conclusion already recorded by two
   lanes (`.pi/tools/preset-voice-progress.md:34-37`, `.pi/tools/worldbook-keys-progress.md:87-88`).
   After my commits the count is unchanged (`c5f0b6bd`: `new=1`, `TS2322 35 -> 36`).
2. **`test:dialogue-web-boundaries`** — PRE-EXISTING RED at HEAD. `tools/check-dialogue-web-boundaries.test.mjs:159`
   "every dialogue-web/src file belongs to exactly one golden zone" fails: the `ZONES`/`GOLDEN`
   manifest (`:19-54`) names 16 files, `collectSourceFiles()` walks 42, and **26 match no zone**
   (`scratch/boundary-unzoned.mjs`): `components/AppBar.tsx`, `ChatSurface.tsx`, `ChatsSurface.tsx`,
   `CharactersSurface.tsx`, `SettingsSurface.tsx`, `MemorySurface.tsx`, `GameSurface.tsx`,
   `ManagementApp`-era `management-surface-panels.tsx`, `SurfaceView.tsx`, ... The file and the
   manifest are both clean (`git status`), so this is HEAD, not a lane's WIP; it predates the last
   two commits and was already recorded as pre-existing by `.pi/tools/capture-defects-progress.md:110-113`.
   The depcruise rule itself is green, so this is a stale *golden-manifest*, not a boundary breach.
3. **`check:test-store-teardown` `new=1`** — OURS (landed today). `tavern/companion-voice-service.test.ts:195`
   gained `createChatThreadStore(...)` in `bbf57f5d` (HEAD~1) with no baseline entry; the handle is
   closed in `finally { threads.close?.(); }`, so it is a well-formed opening the per-file ratchet did
   not know about. `--include-dirty` (the predicate CI would run) reports the same single growth.
   Fixed by the gate's own `--update` remedy: commit **c5f0b6bd**.
4. **mounted `getByLabel('Rename Chat')`** — not observed. The whole mounted zone is green
   (151 passed, 1 skipped, 0 failed). The hash the task named, `8009eb48`, is not an object in this
   repository (`git cat-file` fails), so whatever fixed it, HEAD is already clean.

## What was wired

| commit | file | change |
| --- | --- | --- |
| **4aee4e01** | `.github/workflows/ci.yml` | `+ - run: pnpm test:dependency-risk` — pairs the rule at `:87` with its suite (13/13 green). Staged hunk-scoped (`git apply --cached scratch/ci-hunk-2.patch`) so the sibling lane's `test:dialogue-web-boundaries` line was not swept in. |
| **c5f0b6bd** | `tools/test-store-teardown-baseline.json` | records `tavern/companion-voice-service.test.ts: 1` (`files` 29->30), per the gate's own remedy, so `checks:test-store-teardown` is green again. |

**NOT wired, deliberately:** `+ - run: pnpm test:dialogue-web-boundaries`. It is still in the working
tree, uncommitted. Wiring it today makes CI red (red #2). It needs its golden-zone manifest
repointed first - and that is a design/110 decision, not a wiring one: the product now has six peer
surfaces (chat/chats/characters/settings/memory/game) while the manifest still describes three
assemblers.

## The honest gaps (no entry point runs them)

- **89 root `test:*` scripts run nowhere**; 69 of them are `node --test tools/*.test.mjs`. CI names
  exactly one `tools/*.test.mjs` (`tools/desktop-composition-launch.test.mjs`, `ci.yml:84`) plus the
  three runner-contract tests (`ci.yml:148-150`). This is the gap the parseability lane flagged
  (`.pi/tools/parseability-progress.md:132-133`): a `tools/*` suite can be dead for 25 days unnoticed.
- **25 root `check:*` scripts run nowhere**; the 20 pairs in the "both halves" list above.
- **`test:host-diagnostic-output` and `test:test-store-teardown`** are today's gates whose rules live
  only in the local `quality:check`; their suites run in no entry point at all.
- Not a gap: `dialogue-web` `check:css` (runs inside `test:static`, `dialogue-web/package.json:10`);
  `host/scripts/*.test.mjs` (discovered by `run-tests.mjs:runScriptTests`, run by `pnpm test`);
  `check:test-typecheck-ratchet` (no `test:` script by name, but its suite is a `host/scripts/*.test.mjs`).

## Seven gates added today — reachability

| gate | rule entry point | its suite entry point |
| --- | --- | --- |
| `check-test-store-teardown.mjs` | `quality:check` | **none** (`test:test-store-teardown` runs nowhere) |
| `check-error-identity-classification.mjs` | `ci.yml:54` + `quality:check` | `ci.yml:55` |
| `check-test-typecheck-ratchet.mjs` | host `typecheck` -> `ci.yml:56`, release, `quality:check` | host script-test discovery -> `pnpm test` (`ci.yml:78`, release) |
| prompt-tool-name gate | `test:static` -> `ci.yml:73` | same suite (it is a `*.test.mjs` in the zone) |
| mirror-key gate | `test:static` -> `ci.yml:73` | same |
| touch-floor + label-wrap gates | `test:mounted` -> `ci.yml:77`, release `:127` | same (`ui-hygiene-runtime.spec.ts`) |
| `check-release-persona-hygiene.mjs` | `production-artifact.mjs:9` import -> release `build:release`/`check:production-artifact` | host script-test discovery -> `pnpm test` |

## Needs the owner's call

1. **Re-wire `check:dialogue-web-boundaries` with its suite?** The rule is green, the suite is red on
   a 26-file stale manifest. Either the manifest is repointed (design/110) and then the
   `test:dialogue-web-boundaries` line lands, or the suite stays unwired on purpose.
2. **Should the local-only gates (`host-diagnostic-output`, `test-store-teardown`) and the
   `tools/*.test.mjs` corpus run on every PR?** Adding them to the CI host job is 2-4 lines and both
   are green now, but it grows PR CI and it was a deliberate `quality:check` placement.
3. The `tools/*.test.mjs` corpus is the single biggest unrun surface (69 suites). One aggregate
   step (`node --test tools/*.test.mjs`) would close it, at the cost of whatever those suites'
   shared-state and runtime cost turns out to be.
