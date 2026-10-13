# Parseability / attribution lane

Mission: the shared tree does not parse. Establish the exact set with attribution, classify
(a) live-lane in-flight, (b) dead-lane broken WIP, (c) committed code that does not parse;
preserve-then-revert only (b). Unit 2: the error-identity gate's own suite is run by no CI job.
Unit 3: three residuals, report only.

Constraints honoured: no `git stash` / `checkout <branch>` / `reset --hard` / `clean`;
no other lane's file reverted or staged; goal scripts in `scratch/` (gitignored), not shell strings.

## Verdict in one line

The tree parses now. The 159 syntactic errors the ratchet reported were **one live lane's file in
flight** (`host/src/stardew-game-integration-adapter.ts`) and its own lane repaired it mid-task; the
only genuine parse failure in the shared tree was **committed code**: one deleted `for` line in
`tools/run-stardew-navigation-multisource-characterization.test.mjs`, dead since 2026-09-18, restored
here (1 insertion, byte-identical to that file's pre-breakage revision, 16/16 tests green).

## Preconditions

`git log --oneline -6` at start (`aa95920b`):
```
aa95920b test(tavern): the rule is "no import loss is silent", with a planted failure
5dd66c03 test(chat): the runner double keeps the permissive failure CAS the plant drives
ca0dbbc6 fix(tavern): a claimed cancel is no longer overwritable by a failure
f03efc33 fix(tavern): a world-book entry the import cannot carry is reported
041aebdb fix(dialogue-web): the composed Game surface is asserted to be the region it already is
64a89278 fix(host): the HTTP edge classifies a typed refusal by its class, and the gate follows the local it hid behind
```
HEAD moved four times while this lane ran: `aa95920b` -> `12f901fb` -> `e48e5541` -> `a826b20d`
(+ `58?`), i.e. `50?` other lanes committed concurrently. Every command below is therefore pinned to
a wall-clock time and, where it matters, to a revision.

`git status --porcelain` (dirty list at start) is in the command log; the measured snapshot quoted in
Unit 1 is the one taken at 21:39:37.

## Command log

1. `git log --oneline -6`; `git status --porcelain` (start snapshot).
2. `host/`: `node node_modules/typescript/lib/tsc.js --project tsconfig.test.json --noEmit` -> `scratch/tsc-test.txt`, exit 2.
3. `host/`: `node node_modules/typescript/lib/tsc.js --project tsconfig.json --noEmit` -> `scratch/tsc-prod.txt`, **exit 0**.
4. `node scratch/parseability-summarise.mjs scratch/tsc-test.txt` -> `scratch/tsc-test-summary.txt`.
5. `host/`: `node scripts/check-test-typecheck-ratchet.mjs` -> `scratch/ratchet-now.txt`; `--include-dirty` -> `scratch/ratchet-dirty.txt`.
6. `dialogue-web/`: `node node_modules/typescript/lib/tsc.js --project tsconfig.json --noEmit` -> exit 0.
7. `node scratch/parse-check.mjs <globs>` -> `scratch/parse-sweep.txt`, then the wide run -> `scratch/parse-sweep-wide-before.txt` / `-after.txt`.
8. `node scratch/parse-revs.mjs tools/run-stardew-navigation-multisource-characterization.test.mjs HEAD 0ec4b90c bbb3807d fb0917c0 0ec4b90c~1`.
9. `git show HEAD:<path> > D:\gb-snap\parseability\....broken`; `git show 0ec4b90c -- <path> > ...patch`; `Get-FileHash -Algorithm SHA256`.
10. `node --check tools/run-stardew-navigation-multisource-characterization.test.mjs` (1 -> 0 after the restore).
11. `node --test tools/run-stardew-navigation-multisource-characterization.test.mjs` -> 16/16 pass.
12. `node scratch/ci-pairing.mjs` -> `scratch/ci-pairing.txt`, `scratch/ci-pairing2.txt`.
13. `node scratch/error-identity-blindspots.mjs` -> `scratch/` (stdout quoted in Unit 3).
14. `node scratch/error-identity-blindspot-probe.mjs` -> 1 finding of 5 planted.
15. `node --test tools/check-error-identity-classification.test.mjs` -> 13/13 pass.
16. `node tools/check-head-typecheck.mjs` -> `scratch/head-typecheck.txt`, `scratch/head-typecheck-final.txt`.

Nothing exceeded the twelve-minute cap.

## Unit 1 - the list, with attribution

### The reported state does not reproduce, and that is the finding

The ratchet message the task quotes (`159 syntactic error(s) present` + `159 error(s) in 13 uncommitted
file(s)`) is real but **transient**. Two independent lanes recorded it:
`.pi/tools/scaffolding-and-gate-progress.md:127-130` and `.pi/tools/store-lifecycle2-progress.md:287-291`,
and both name the file:

> `--include-dirty` fails only on another lane's live, syntactically broken
> `src/stardew-game-integration-adapter.ts` (159 syntactic errors there, semantic pass suppressed)

So all 159 errors were in **one** file; `13` was the ratchet's count of *dirty* files, not of broken
ones. Measured at 21:22 and again at 21:26, that file and the whole tree parse:

| measurement (when) | command | result |
| --- | --- | --- |
| 21:22 | `tsc -p tsconfig.json --noEmit` (host production) | **exit 0** — no syntactic error can survive in `host/src` |
| 21:22 | `tsc -p tsconfig.test.json --noEmit` | 162 diagnostics, **0 with a `TS1xxx` code**, 41 files |
| 21:26 | `node host/scripts/check-test-typecheck-ratchet.mjs` | **no** `semantic_pass_skipped` line; `excluded=1 error(s) in 9 uncommitted file(s)`; `ratchet_ok total=161 baseline=167 codes=13`, exit 0 |
| 21:26 | `tsc -p dialogue-web/tsconfig.json --noEmit` | exit 0 |
| 21:39 | `node scratch/parse-check.mjs` (1387 files, 9 globs) | **1 broken** -> the committed `tools/*` file below |
| 21:50 | same sweep after the restore | **0 broken** |

The single non-zero error count in the 162 was `stardew-live-receipt-parity.test.ts`, another lane's
untracked in-flight file.

### The dirty set, attributed (snapshot 2026-10-13 21:39:37, HEAD `a826b20d`)

`git log -1 --format='%h' -- <path>` per file; lane from that commit's subject and the file's own header.

| file | status | last commit touching it | lane / owner | class |
| --- | --- | --- | --- | --- |
| `host/src/stardew-game-integration-adapter.ts` | M | `d749fe73` dye completion rule | native Stardew adapter lane (COORDINATION list) | **(a)** — the file behind the 159; its own lane repaired and committed it (`a826b20d` moved it from `MM` to `M`) |
| `host/src/tavern/chat-pipeline-service.ts` | M | `74c5c20d` regeneration on the tail reply | chat regeneration lane | (a) |
| `host/src/tavern/p4-provider-start-execution.ts` | M | `8d577ab4` Chat row drops scaffolding | p4 provider lane (COORDINATION list) | (a) |
| `host/src/tavern/chat-thread-store.ts` | M at start, committed by 21:39 | `ca0dbbc6` | chat-thread-store lane | (a) |
| `host/src/st-card-import.ts`, `tavern/st-card-import-service.ts` | M | `f03efc33` / `ffd4fac5` | card-import lane (COORDINATION list) | (a) |
| `host/src/identity-profile.ts`, `tavern/default-companion-preset.ts` | M | `ffd4fac5` | card-import lane | (a) |
| `host/src/protocol.ts` | M | `8c000163` five new actions | stardew action lane | (a) |
| `host/src/tavern/compatibility-manifest.v1.ts` (+`.test.ts`) | M | `a4ddcd89` | card-import lane | (a) |
| `host/src/stardew-live-receipt-parity.test.ts` + `test-fixtures/stardew-live-receipts.json` | ?? | untracked | stardew live-receipt lane | (a) — the only file still contributing an unratcheted error |
| `host/tsconfig.focus-historian-promise.json`, `tsconfig.focus-turn-switch.json`, `tsconfig.dist-test-tmp.json` | ?? | untracked | focus-project configs of the live lanes | (a) — not compiled by either project |
| `tools/check-host-diagnostic-output.mjs` + `.test.mjs` + baseline | ?? | untracked | DEBUG-output gate lane (today) | (a) |
| `tools/record-stardew-live-receipts.mjs` | ?? | untracked | live-receipt lane | (a) |
| `package.json` | M | `1b5782e2` | error-identity lane (mine to read, not to stage) | (a) |
| `.github/workflows/ci.yml` | M | `58081b66` | **this lane** (Unit 2) | (a) |
| `dialogue-web/probe-tmp{,2,3}.mjs` | ?? | untracked | dialogue-web lane debris | (a) — deliberately left |
| `assets/tavern/presets/default-companion/{card,worldbook}.json` | M | `ec02cbe1` | preset lane | (a) |
| `.pi/tools/{6}.md` | D | see log | another lane's note cleanup | (a) — **not** staged by this lane |

No file was classified **(b)**: nothing is both syntax-broken and ownerless. Nothing was preserved or
reverted under the (b) protocol, because there was nothing of that kind to preserve or revert.

### (c) committed code that does not parse — found, and restored

`tools/run-stardew-navigation-multisource-characterization.test.mjs` was **broken at HEAD**, and the
breakage is a *single deleted line*, exactly the shape of this morning's `action-registry.ts` +
`game-tools.ts` pair:

```
$ git diff 0ec4b90c~1 HEAD -- tools/run-stardew-navigation-multisource-characterization.test.mjs
@@ -166,7 +166,6 @@ async function setupRunnerFixture() {
   await writeFile(join(probe, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'), 'probe');
-  for (const name of ['GameBuddy.Stardew.dll', 'GameBuddy.Stardew.Core.dll', 'Raffinert.FuzzySharp.dll']) {
     await writeFile(join(probe, name), `shared-${name}`);
     await writeFile(join(production, name), `shared-${name}`);
   }
```

- Introduced by `0ec4b90c` (2026-09-18, "replace fuzzy destination search with pure managed n-gram
  index"), which deleted the loop header while updating the bundle list. Parsed clean at `0ec4b90c~1`,
  `fb0917c0`, `bbb3807d`; broken at `0ec4b90c` and every revision since — **25 days**.
- `node --check` and the TypeScript parser agree: `SyntaxError: Illegal return statement`, TS1128 at
  186:1. Nothing in CI caught it because `tools/*.test.mjs` are run for one named file only, so the
  file's 16 tests have simply not existed for 25 days.
- **Preserved before touching anything**:
  - `D:\gb-snap\parseability\run-stardew-navigation-multisource-characterization.test.mjs.HEAD-e48e5541.broken`
    SHA256 `2EEE2EC9B591034C32591AE828CE125773BEDBA1BCBA75EDD8A5E0776B0F50D2`
  - `D:\gb-snap\parseability\0ec4b90c-introduced-the-breakage.patch`
    SHA256 `C7D3CFBD28D07F242CE0D9C532E482A4BA85491C7EDFC17AAFD73B4CD6714C89`
- Restored with an explicit one-line edit, not `git checkout`, so the diff is visible and touches
  nothing else: `1 file changed, 1 insertion(+)`, and `git diff 0ec4b90c~1 -- <path>` is now **empty**
  (the worktree content equals the pre-breakage revision byte for byte).
- Justification for restoring the *three*-entry list rather than the two the commit's prose implies:
  the tool under test still declares it —
  `tools/run-stardew-navigation-multisource-characterization.mjs:30`
  `PRODUCTION_FILES = Object.freeze(['GameBuddy.Stardew.dll', 'GameBuddy.Stardew.Core.dll', 'Raffinert.FuzzySharp.dll'])`
  — and `PROBE_SOURCE` is derived from it, so a two-entry fixture would fail
  `assertSourceClosure`. Verified empirically: `node --test` on the restored file is **16 tests,
  16 pass, 0 fail** (exit 0).

## Unit 2 - the gate whose own test nobody runs

`.github/workflows/ci.yml` was clean (not a live lane's file) and is now, next to the `check:` call:

```diff
       - run: pnpm check:error-identity-classification
+      - run: pnpm test:error-identity-classification
```

That is the repository's existing pairing convention verbatim (cf. `pnpm check:host-windows-test-preflight`
/ `pnpm test:host-windows-test-preflight`). The suite it runs is green today: `node --test
tools/check-error-identity-classification.test.mjs` -> **13 tests, 13 pass, 0 fail**.

### Every root `check:*` / `test:*` pair, and whether CI runs the test half

**Before this change: 1 of 24 pairs had its test half run by CI. After: 2 of 25.** The test half of
each pair below is executed by **no** job in either workflow (`.github/workflows/ci.yml`,
`release-windows.yml`):

```
test:dependency-risk                              (check runs in CI)
test:dialogue-web-boundaries                      (check runs in CI)
test:gameplay-capability-catalog
test:host-diagnostic-output        <-- added today, neither half wired anywhere
test:host-game-physical-seam
test:live-run-artifact-freshness
test:production-pack-load
test:scope-references
test:smoke-syntax
test:stardew-action-promotion
test:stardew-gameplay-completeness
test:stardew-loop-closure
test:stardew-native-mechanism-review-register
test:stardew-native-multiplayer-sensitivity
test:stardew-native-normal-player-ingress-register
test:stardew-native-pathfinder-source
test:stardew-native-router-exit-classifier
test:stardew-native-source-closure
test:stardew-native-transition-ledger
test:stardew-receipt-attribution
test:stardew-tool-family-stamina-evidence
test:tavern-references
test:tavern-release-prerequisites
```

The only pair CI ran before this change is `check:host-windows-test-preflight` /
`test:host-windows-test-preflight` (`ci.yml:36-37`), plus this lane's addition. Of the 24 pairs whose
test half is unrun, **only three have their `check:` half in CI** (`dependency-risk`,
`dialogue-web-boundaries`, and now-excluded `error-identity-classification`); the other 21 are not
wired into CI at all.

`check:*` with no `test:*` twin, and whether CI runs them: `complexity-gate`, `head-typecheck`,
`host-module-graph`, `host-production-import-boundary`, `knip`, `script-entries`, `workspace-debris`
(all yes); `architecture`, `diff`, `publint`, `stardew-companion-production-admission`,
`text-hygiene`, `tools-boundaries` (all **no**).

### The other gates added today

| added | gate | CI status |
| --- | --- | --- |
| today 20:44 `1b5782e2` | `check:` + `test:error-identity-classification` | check yes; test **now added by this lane** |
| today (uncommitted) | `check:` + `test:host-diagnostic-output` | **neither** half appears in any workflow; both scripts registered in the dirty `package.json:28-29` |
| today 20:21 `0f6b09ec` | `lint:eslint` | **not in any workflow**; it is in `quality:check`, and `quality:check` is itself in no workflow |
| today 20:37 `2e15390c` | `lint:ast-grep` | **not in any workflow** (same `quality:check` path) |
| today 19:36 `971085b7` | `host/scripts/check:test-typecheck-ratchet` | no `test:` script **by name**, but its suite `host/scripts/check-test-typecheck-ratchet.test.mjs` *is* run: `host/scripts/run-tests.mjs:runScriptTests()` discovers every `host/scripts/**/*.test.mjs` and CI runs `pnpm test` (`ci.yml:76`). No gap — a name-based pairing rule cannot see it |
| 2026-10-12 | `tools/check-stardew-actor-admissibility.mjs`, `tools/check-stardew-hold-sufficiency.mjs` | added to `tools/` but **registered in no `package.json` script** and in no workflow |

`check:text-hygiene` (no test twin) is likewise in `quality:check` and in no workflow.

## Unit 3 - three residuals, report only

### (i) the 7 world-info-binding mounted-child failures

Located and mechanism confirmed. The 9 `test("mounted binding service ...")` cases live in
`host/src/tavern/world-info-binding/world-info-binding-management-service.test.ts:196-529` (each drives
a child through `mounted(...)`). Every one of them is routed through
`host/src/tavern/world-info-binding/world-info-binding-management-service.ts:234`
`throw rethrowMutationError(error)`, whose tail is:

- `:417-425` — six `error.message === "<literal>"` arms,
- `:426` `isStorageError`,
- `:427` `/lease|mount|closed/i`,
- **`:428` `return conflict()`** — the catch-all. Any failure that matches no arm becomes the generic
  `conflict()`, and the original error is dropped with no record, so the child's real failure cannot be
  distinguished from a genuine revision conflict. `rethrowReadError:405-412` has the same shape with
  `return unavailable()` at `:411`.

Notes for whoever closes it: (1) the six literals are all matched by **message text**, and the gate
cannot see them — `world_info_binding_conflict`/`_locked` have bare `new Error(...)` producers in the
same file (`:449`, `:452`) and `chat_thread_scope_mismatch`/`chat_thread_revision_conflict` are thrown
as bare `new Error(...)` from `tavern/chat-thread-store.ts:1808-2230`, which trips the gate's rule 3
deliberately. (2) **I could not reproduce the failure in this worktree**: at 21:38 a run of that file
died before any test with `ERR_MODULE_NOT_FOUND` for
`@earendil-works+pi-coding-a_e7c1c840.../node_modules/@earendil-works/pi-ai/dist/providers/compat-schema.js`
— `a826b20d` ("chore(deps): upgrade Pi to 1.2.0") landed while the store was still being installed, so
any host test importing the Pi runtime fails for an environmental reason right now. That is a live
lane's state, not a finding of this lane; it should clear when `pnpm install` completes.

### (ii) the error-identity gate's blind spots — not theoretical

The shapes exist **and one of them carries the defect today**.

Shapes present in production `host/src` (217 production sources, 10 error-identity literals, 963 bare
literals; `node scratch/error-identity-blindspots.mjs`):

| shape | instances |
| --- | --- |
| `const name = x.message` (the form the gate follows) | 18 |
| `let`/`var` alias | 0 |
| plain assignment from `.message` | 3 (one is `native-companion-content.ts:204 tracked = event.message`, a chat message payload, not an `Error`; the others are in a `-fixture-worker.ts`) |
| destructuring `const { message } = …` | 0 |
| `return … .message` through a helper | 18 |

The decisive one is not a shape count, it is that **the gate's own rule is violated through a
parameter, and the gate cannot see it**:

```ts
// host/src/tavern/conversation.ts:199-201
function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && error.message === code;
}
// :146
throw classifyExactContentError(error, "chat_thread_already_exists", "tavern_exact_content_already_exists");
// :161, :163, :170
if (isErrorCode(error, "chat_thread_not_found")) ...      // ExactThreadNotFoundError, chat-thread-store.ts:1067
if (isErrorCode(error, "chat_thread_surface_mismatch")) ... // ExactThreadSurfaceMismatchError, chat-thread-store.ts:1078
```

`chat_thread_not_found` and `chat_thread_surface_mismatch` are `super("<literal>")` messages of
**exported** classes in `host/src/tavern/chat-thread-store.ts` — the same module `conversation.ts`
already imports other typed things from, and the same file whose own
`classifyInitialChatExactContentFailure:1059-1063` does it the right way with `instanceof`. Four call
sites in `conversation.ts` classify that other module's typed failure by its message text; the gate
reports none, because the literal is passed as an argument rather than compared on the spot.

Demonstrated with a 5-file fixture (`node scratch/error-identity-blindspot-probe.mjs`): one
cross-file `super("probe_identity_literal")` plus four equivalent comparisons; **the gate reports
exactly 1 of 4** — `direct.ts:2 form=direct` — and misses the parameter, `let`, and destructuring forms.

Verdict: the boundary is **live**, not theoretical. Two of the gate's stated limits are load-bearing
today (the parameter/helper hop and the identifier on the right-hand side of `===`); the other three
(`let`, destructuring, second hop) have no instance today.

### (iii) `[DEBUG-*]`-style stderr prints in non-test `host/src`

**None.** A search for `DEBUG|TRACE|DBG|VERBOSE|chat-live-p4c` across all of `host/src` (tests
included) returns 0 matches, and `git grep 'DEBUG-'` returns 0. The only stderr prints left in
production sources are bounded operational records:
`tavern/memory-management/memory-management.ts:340,348`,
`runtime-core.internal.ts:114,122,1467,1477` (`[historian] …`), `bootstrap/entry/desktop-host-entry.internal.ts:29`,
plus `continuity-semantic-chat-runtime-construction.internal.ts:388` and
`tavern/chat-pipeline-service.ts:578`. The removal lane (`tools/check-host-diagnostic-output.mjs`, whose
Arm A is exactly this class) has finished its deletions; I did not duplicate or touch any of it.

## Evidence summary

- Syntactic parse failures in the swept tree, before -> after: **1 file -> 0 files**, across 1387 files
  (`host/src`, `host/scripts`, `dialogue-web`, `tools`, `integrations`, `packages`).
- The one was committed, not dirty: `tools/run-stardew-navigation-multisource-characterization.test.mjs`,
  dead 25 days, restored with 1 insertion and verified identical to `0ec4b90c~1`.
- Preserved: 1 broken revision + 1 provenance patch under `D:\gb-snap\parseability\` (hashes above).
- Test-project diagnostics: 162 with **0** syntactic codes, all semantic, all in committed `*.test.ts`;
  ratchet `total=161 baseline=167`, exit 0 — meaningful for the first time in a while, and it did not
  grow.
- HEAD typecheck: quoted at the end of this file.

## Final gates (this lane's commit)

- `node tools/check-head-typecheck.mjs` ->
  `head_typecheck_ok rev=a826b20d4709 projects=tsconfig.json` (exit 0). The first run of the same gate
  in this lane, before the restore, was `head_typecheck_ok rev=e48e5541e889` — HEAD typechecks before and
  after, which is what made the *working tree* 159-error report a per-lane state and not a HEAD defect.
- `node scripts/check-test-typecheck-ratchet.mjs` (host) -> `test_typecheck_ratchet_ok total=161
  baseline=167 codes=13`, exit 0, no `semantic_pass_skipped` line, `excluded=1 error(s) in 9 uncommitted
  file(s)`.
- Parse sweep, 1387 files -> `broken=0`.
- `node --test tools/run-stardew-navigation-multisource-characterization.test.mjs` -> 16/16 pass.
- `node --test tools/check-error-identity-classification.test.mjs` -> 13/13 pass.

## Committed

Explicit pathspec only, after `git diff --cached --name-status` showed no `D` and no `R` and no other
lane's file:

- `tools/run-stardew-navigation-multisource-characterization.test.mjs` (1 insertion)
- `.github/workflows/ci.yml` (1 insertion)
- `.pi/tools/parseability-progress.md` (`git add -f`; `/.pi/` is gitignored while its notes are tracked)

**Not staged, deliberately**: the six `.pi/tools/*.md` deletions another lane left in the worktree, and
every `M`/`??` file belonging to a live lane listed in Unit 1.

## Handover revision

At this lane's own commit `2a784754c48a` (HEAD when the note was closed):

- `node tools/check-head-typecheck.mjs` -> `head_typecheck_ok rev=2a784754c48a projects=tsconfig.json` (exit 0).
- wide parse sweep -> `parse_sweep files=1388 broken=0` (exit 0).
- host ratchet -> `test_typecheck_ratchet_ok total=161 baseline=167 codes=13`, exit 0,
  `excluded=1 error(s) in 16 uncommitted file(s)`, and **no** `semantic_pass_skipped` line — i.e. the
  semantic pass ran and 161 is a real count for the committed tree, not the artefact of a suppressed
  pass. Before this lane it read `total=0` with 159 errors suppressed across 13 dirty files.
