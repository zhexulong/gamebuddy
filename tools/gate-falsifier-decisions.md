# Gate falsifier decisions

`gates examined 348 · with a red proof 307 · external 4 · declared without 35 · undeclared 0 · zero-population-pass 0`

**The arithmetic, stated rather than implied.** `307 + 4 + 35 = 346`, two short of the 348 the same line names.
The two missing gates are the ones carrying an unreadable claim — `check:code-duplication` (a marker whose kind reads
`facades`, which is not one of the five) and `test:format-ratchet` (a marker whose prose names a planted
`tools/legacy.mjs` that deliberately is not on disk). `evaluate` reports both as findings on every run, and the census
line's five buckets cannot place them: it partitions proven / external / declared / undeclared and leaves
`unreadableClaims` out. So the reading is a three-term partition only when the third term is the gap SET rather than
the `declared without` bucket: `proven 307 + external 4 + owed 37 = 348`, where the 37 owed are the 35 recorded rows
plus those 2 unreadable claims. This is not new — before the fifth batch the same line read `253 + 4 + 86 = 343` of
345, before the seventh batch `294 + 4 + 46 = 344` of 346, and before the eighth `304 + 4 + 38 = 346` of 348. It is
written down here because a line that is two short cannot be quoted as a partition, and the next reader is owed the
difference. Both gates belong to files another lane may not touch (`tools/check-code-duplication.mjs`,
`tools/scripts/*ratchet*`), so they are recorded, not repaired.

The 37 rows the baseline records (the 35 readable debt rows the census prints as `declared without`, plus the 2
unreadable claims) divide exactly, and the split is what the fourth table is not responsible for: **15** are that
table's `provable` rows, **6** are the gates measured red at HEAD (named below), **1** reads something other
than it checks (`check:architecture`), **6** are the first table's kept rows (`check:live-run-isolation`,
`test:stardew:core`, `test:stardew:integration`, `test:voice-protocol`, and the two `not measured` tools gates
`tools/check-stardew-actor-admissibility.mjs` and `tools/check-stardew-hold-sufficiency.mjs`), and **7** were moved out
by the third batch for the environment or another lane (`check:publint`, `check:sandbox-acceptance`,
`test:gameplay-capability-catalog`, `test:frontend-turn-gate`, `check:dialogue-web-boundaries`,
`check:host-module-graph`, `audit:stardew-action-seam-terminals`).
`15 + 6 + 1 + 6 + 7 = 35`, and the 2 unreadable claims make the 37 the file holds. The three rows the eighth batch
closed were the `provable` column's `check:stardew-native-normal-player-ingress-register`,
`check:stardew-native-source-closure` and `check:stardew-native-transition-ledger`, which is why that column reads 15
and not 18.

`check-harness-conformance` prints the same numbers from the same reading (`tools/lib/harness-conformance.mjs` over
`tools/audit-gate-red-proofs.mjs`).

This document exists for one decision: **what to do with the gates that cannot fire.** A gate that cannot fire
occupies a covered position while measuring nothing, so each of them is either demonstrated, deleted, declared
`external` with a runner a reader can run, or kept with the reason it is still owed. The fourth table is the work
queue; the second is the one gate whose problem is not the proof but the reading.

How each class was decided: a gate is `cannot fire` when nothing in the repository can make it exit non-zero — a
report with no failing path, a population no file produces, an environment that decides instead of a rule, or a rule
that lives in another program's config. It is `reads the wrong thing` when its reader and its name disagree. It is
`provable` when a violation exists that it would catch, and the table names what to inject. Proven gates are not
listed: they are the 274, and their markers sit in the gate files themselves.

## The fifteen gates that could not fire: their dispositions

Nothing here is deleted for being inconvenient. A gate stays when its coverage is real, and a gate leaves the debt
set only after it was seen to fail. `external` is the fifth falsifier kind (`red-proof: external <runner command> —
<how it fails>`), and it is not self-declared: the command must be one `package.json` or a workflow actually invokes
(a command found nowhere is `external_runner_not_invoked`), the failure clause must be present, and the label was only
written after the failure was produced once. `external` gates carry their command in the census output of both tools,
so any reader can run one.

| gate | disposition | the evidence |
| --- | --- | --- |
| `audit:stardew-admission-fork-delta` | **deleted as a gate** | it sets no exit code, so as a gate it covered nothing. The `audit:` script line is gone, its baseline entry with it, and its prelive registry entry now reads `runsIn: on-demand`. The tool and its suite (`test:stardew-admission-fork-delta`) remain, so the migration decision aid loses no reader — only its false claim to be a gate |
| `check:knip` | **external** | command `pnpm knip && pnpm knip:production`, demonstrated: `export const gatePopulationProbe = 1;` added to `tools/lib/gate-population.mjs` → `Unused exports (1) gatePopulationProbe tools/lib/gate-population.mjs:121:14`, exit 1 |
| `check:tools-boundaries` | **external** | command `depcruise --config .dependency-cruiser.tools.cjs tools`, demonstrated: a new `tools/lib/tools-boundary-probe.mjs` importing `host/src/main.ts` → `error tools-must-not-import-host-production-sources: tools/lib/tools-boundary-probe.mjs → host/src/main.ts`, violations 95 → 96, exit 38 → 39. **Named here as a separate defect:** 38 of those errors pre-exist at HEAD because `tools/**` really does import the raw `host/dist-test/...` specifier, and no workflow runs this gate — so it is red and unwatched, which is the state the ledger exists to surface |
| `check:live-run-isolation` | **kept, proof owed** | it cannot be demonstrated from a checkout: it exits 1 from an absent `%LOCALAPPDATA%\GameBuddy\stardew-profiles\native-local-stable`, and red-for-absence is not red-for-a-rule. The label was deliberately not written; it answers `is this machine set up`, which is a preflight an operator runs, not a gate a census can hold |
| `check:perf-budget` | **proven (fixture)** | the ledger's `cannot fire` was wrong on this machine: the baseline records win32/x64/32/AMD Ryzen 9 9955HX, which is this box, so the gate compares instead of skipping. A saved suite reading with `admission.action/large` at 215.72 µs/op against the recorded 107.86 → `perf_budget_failed slow=1 unrecorded=0 missing=0 … +100.0%`, exit 1 |
| `check:tavern-references` | **proven, via its suite** | the injection made the gate print `verified 0 Tavern semantic references and 0 fixtures` and exit 0 instead of `blocked`; `tools/verify-tavern-semantic-references.test.mjs` answered `expected the not-measured exit, got undefined`. One marker closes both halves because the suite is the gate's own falsifier — the audit's ownership rule, as this document already records for three earlier pairs. **What the proof does not say:** the resolution rule itself is still unmeasurable without the `design/` mount; what fired is the fail-closed contract |
| `test:tavern-references` | **proven** | the same marker and the same run (above): the suite is this gate's entry file |
| `test:all` | **external, by inheritance** | its only gate-named member is `test:dialogue-web`, which is external now, so the alias owes no proof of its own. **Kept rather than deleted** (the ledger suggested deletion): `pnpm test && pnpm test:dialogue-web` is a command humans type, and deleting it would remove an affordance without removing any coverage. The census's `external:test:all inherited from test:dialogue-web` line says exactly that |
| `test:dialogue-web` | **external** | command `pnpm --filter @gamebuddy/dialogue-web test:static`, demonstrated: a hard-coded prose `aria-label` in `dialogue-web/src/components/CharactersPanel.tsx` → `✖ raw-text.2: a user-visible attribute literal is not a written-out sentence` (76 files, 3 literals, 1 prose), exit 1 |
| `test:stardew:core` | **kept, proof owed** | the runner is `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests`. This lane may not edit `integrations/stardew/**`, so the C# suite could not be broken from here, and a label written without that demonstration would be the silencer this mechanism exists to prevent |
| `test:stardew:integration` | **kept, proof owed** | the same runner shape over `GameBuddy.Stardew.Integration.Tests`, and the same bound |
| `test:voice-protocol` | **kept, proof owed** | `pnpm --dir vendor/pi-koe run test:protocol` runs inside a git submodule; breaking it means dirtying another repository, so the label waits for a lane that may |
| `tools/check-stardew-actor-admissibility.mjs` | **blocked, confirmed** | its default run prints `blocked` with `examined: 0` and an `allowEmpty` naming `integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json`, which no commit carries and nothing produces. `check-harness-conformance` counts it under `reported not measured`, never among the passes |
| `tools/check-stardew-hold-sufficiency.mjs` | **blocked, confirmed** | the same absent contract and the same `not_measured` reading |
| `test:stardew-fixture-readiness` | **proven (inject)** | the ledger's `waits on a live fixture root` was wrong: the suite writes signed synthetic readiness documents into a temp directory. `await-stardew-fixture-readiness.mjs` accepting a `fixture_blocked` document as ready → `Expected "actual" to be strictly unequal to: 0`, exit 1 |

What the four `proof owed` rows need: a lane allowed to edit the C# suite, a lane that may dirty the `vendor/pi-koe`
submodule, and a machine with the live profile mount. Each is a real gate with real coverage, and none of them is
deleted or labeled.

## Reads something other than it checks

| gate | the reader | the claim | the divergence |
| --- | --- | --- | --- |
| `check:architecture` | `package.json:34` | the architecture: `pnpm check:publint && pnpm report:clones && echo "[110] knip/module-graph/import-boundary gated by live WIP; see design/110 Task 5"` | two of the five things the name covers are measured (publint, clones); the three it most obviously claims — knip, the host module graph, the production import boundary — are a sentence printed by `echo`, which cannot fail. A reader of the gate list sees `check:architecture` and concludes the architecture is checked |

### Not in the 106: a proven gate whose aim and its fired assertion are different rules

`test:multiday-loop` is counted among the 234 proven, so it is not in the class tables. Its proof is
kept, but the record of *what it proved* is not the same as what the lane that made it aimed at, and that
difference is left here rather than quietly resolved.

| | the aim | what fired |
| --- | --- | --- |
| the marker's own words (`tools/lib/multiday-loop.test.mjs`) | "the rollover-menu branch answering `dismiss` where the loop must wait" | `✖ a menu with no audited handling stops the run by name instead of timing out` |
| the rule each one names | `decideHeldMenu`: what to do with a menu that stands while the calendar has already moved — wait, dismiss, or respond | the refusal for a menu type that appears in *neither* the wait list nor the dismissible list: it must stop the run by name instead of being dismissed or timing out |

Two different rules, so the proof established something real — the unaudited-menu refusal — but not the
rollover rule the aim named. Re-derivation on the snapshot this lane used, three anchors, each restored after
its run:

| anchor injected | expected by the aim | result |
| --- | --- | --- |
| `DISMISSIBLE_ROLLOVER_MENUS` branch answers `dismiss` instead of `wait` | the rollover rule | exit 0 — no assertion fired |
| the unaudited default branch answers `dismiss` instead of `blocked` | the unaudited-menu rule | exit 0 — no assertion fired |
| `WAIT_ROLLOVER_MENUS` branch answers `dismiss` instead of `wait` | the rollover rule | exit 0 — no assertion fired |

So on the module as this lane has it, neither reading of the recorded aim reproduces the recorded line: the
injection that produced it in the earlier lane reached a site the marker does not name. The current-tree pair
(`tools/lib/multiday-loop.mjs` with its suite, both carrying another lane's uncommitted changes) was synced
for a fourth attempt and had not settled after four minutes; that run was stopped rather than reported.

What this costs the ledger: nothing — the marker is a true statement that the suite went red on an injected
violation. What it costs a reader: the marker cannot be used as evidence that the *rollover* rule is guarded,
and the next lane should re-derive it from the unaudited-menu rule if it wants the stronger claim.

### Recorded from earlier batches: reader/claim mismatches on gates that are already proven

These belong to the same column but sit outside the 106 — each is a proven gate whose proof exposed a
divergence between what it reads and what its name promises. They are kept here so the pattern is visible
beside this batch's finding, not to re-open any count.

| gate | the reader | the divergence |
| --- | --- | --- |
| `check:live-run-failure-dump` | the bundle it summarises | the report's shape is a function of the result it reports: on failure the first case id changes and `cases` falls 20 → 19, so anyone counting cases sees *fewer* exactly when something broke |
| `check:stardew-native-notice-coverage` | its own `violations` array | the red run prints `"status":"failed"` with `"violations":[]` — only one of its two failure channels feeds the array, and `examined=106` is unchanged, so a consumer reading either reads a failed gate as clean |
| `check:host-windows-test-preflight` | `inspectedFiles` | the population it walked is named by a field the shared non-vacuity judge does not read; one rename from the zero-population list |
| `check:diff` | `git diff --check` | it owns no rule: the red line is git's, the green line (`git_diff_check_passed`) is all it says itself, which is why it is the one gate `zero-population-pass` names |
| `check:complexity-gate` | `--root`-relative baseline | a fixture root without the baseline file dies on `ENOENT` before measuring, and `expired_file_ceiling_extension` fires for every extension the fixture lacks — the wanted finding only appeared after three fixture repairs |
| `check:chat-card-voice` | `liveRunPersonaPaths()` | "the reviewed card's own prose" is whatever that resolver returns; a runtime root that provisions the card elsewhere changes the reading without changing a word of the gate |
| `tools/check-stardew-actor-admissibility.mjs` | its own `notInAlgebra` / `staleInAlgebra` | advertised as "a QUERY, not a report to interpret", and exactly that: both are printed and never counted in `failed` (its disposition is `blocked` in the first table, for its absent population) |
| `test:gate-red-proofs` | two guards over the marker reader | removing the comment-line guard left the suite green — its case "a marker on a code line is not a marker" cannot tell which of the two guards held it, so the assertion is true and narrower than its name |

## Needs history

None. Not one of the 106 gates still owing a proof needs a pre-fix commit, and that is itself an answer to the
question this document was built for: the unproven half of the ledger is not waiting on archaeology. Every gate in it
either has an exit path that a live violation turns, or it cannot fire at all (the first table names each of those and
what was done with it). The two places history was genuinely the only honest proof — `check:release-live-evidence` and
`test:gate-red-proofs` — are already proven and are not in this population.

## Provable, not yet proven

Fifteen gates, each with the violation to inject. Twenty-three rows left this table in the fifth batch, twenty
left it in the sixth (all proved there), eight left it in the seventh, three left it in the eighth (all proved there),
and three moved down to the red-at-HEAD table
(one in the sixth, `test:tool-corpus` and `test:dialogue-web-boundaries` in the seventh); none of them is repeated here.
Where the target is the module the suite imports it is named; where the injection is a fixture, a config or an
environment, the artefact is named instead. Rows marked `(attempted; did not fire)` are cases where a lane tried an
injection that the suite did not catch — they are still provable, but the first guess is recorded so nobody repeats
it.

| gate | the violation to inject |
| --- | --- |
| `test:stardew-action-candidates` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-action-inventory-reconciliation` | inject into `../src/analysis/stardew-action-inventory-reconciliation.mjs` |
| `test:stardew-action-seam-terminals` | the artefact it reads |
| `test:stardew-branch-writeset` | inject into `../src/analysis/stardew-branch-writeset.mjs` |
| `test:stardew-method-resolution` | inject into `../src/analysis/stardew-branch-writeset.mjs` |
| `test:stardew-method-resolution-mutation` | a mutation the mutation runner must kill |
| `test:stardew-native-local-runner-fixture-contract` | inject into `./lib/stardew-native-local-player-fixture.mjs` — **not attempted this batch**: its "fixture's own policy block" case asserts a hand-built replica rather than the writer (see the sixth-batch finding below), so the path that would turn it red is a change to the replica, which proves the assertion fires and not that the fixture is guarded |
| `test:stardew-player-reachable-exits` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-reachable-exits-reconciliation` | the artefact it reads |
| `test:stardew-rejected-layer-verdicts-mutation` | a mutation the runner must kill |
| `test:stardew-remaining-actions` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-soil-itm-canary` | a canary row the model does not carry (needs `.tmp-stardew-decompile/`, absent here) — imports `./lib/stardew-soil-itm-canary.mjs`; measured this batch: all five cases **skip** where that root is absent, so a violation here reddens nothing |
| `test:stardew-tile-action-selectors` | inject into `../src/analysis/stardew-tile-action-selectors.mjs` |
| `test:stardew-uncovered-exit-expansion` | the artefact it reads |
| `test:stardew-uncovered-exit-table` | the artefact it reads |

## Precision: does `test:host-diagnostic-output` read the production surface, or a fixture set?

It reads the production surface, and the marker would have been caught in the real tree. The answer is
measured, not assumed:

- The case is `inspect({ root: HOST_SOURCE, uncommitted: new Set() })` with `HOST_SOURCE = <repository>/host/src`
  — the repository's own production tree, not a fixture directory.
- The violation was planted in `host/src/fact-brief.ts`, an ordinary production module, and the gate answered
  `{ file: 'fact-brief.ts', line: 774, form: 'debug_marker', literal: '[DEBUG-r47] probe' }` — it named the
  production file and the exact line.
- The population was not swapped: the copy of the tree this lane used held 717 `.ts` files under `host/src`
  and the repository holds 719 today (two landed after the copy), so the reader walked the same production set
  the repository has, minus files that appeared later. Nothing in the proof depended on a fixture.

One precision the answer needs, because it limits when the gate protects: the *test* passes
`uncommitted: new Set()`, so it examines everything. The gate's own CLI calls `uncommittedSources()`, which
drops every file git reports as changed or untracked — its stated design is that a lane's in-flight file is
not a landed one. So the protection begins at commit: a `[DEBUG-…]` print written today is invisible to the
default run until it is committed, and visible to the suite immediately. If the surface that matters is the
working tree rather than HEAD, that is the knob to turn.

## Model: the two-authority equality

`test:dependency-risk`'s `gate.acceptance: the disposition list is exactly the advisory schema's status enum`
is the shape worth copying. It does not assert a list against a copy of itself; it asserts two independently
maintained authorities against each other:

``js
const schema = JSON.parse(await readFile(new URL("../security/dependency-advisories.schema.json", import.meta.url), "utf8"));
assert.deepEqual([...DISPOSITION_STATUSES].sort(), [...schema.$defs.advisory.properties.status.enum].sort());
``

`DISPOSITION_STATUSES` is the gate's own constant — what the checker treats as a disposition it must validate.
`$defs.advisory.properties.status.enum` is the schema the advisory snapshot is written against. Sorted deep
equality fails in both directions, so a status added to either side alone is a red gate: the engine cannot
learn a disposition the schema does not publish, and the schema cannot publish one the engine silently ignores.
The red proof for it is a one-word edit — dropping `mitigated` from the constant — which is exactly why the
assertion is cheap to keep honest.

The generalisation for this ledger: when a gate's rule and a second artefact both spell the same vocabulary
(a schema, a generated descriptor, a wire contract, a Mod-side enum), the assertion should be an equality
between the two, never a restatement of one in the other's tests.

## What the third batch registered

The twenty proofs in that batch (and the twenty before it) live as `red-proof:` markers in their own gate
files, and `tools/gate-red-proof-baseline.json` lost exactly those forty entries. Three further proofs were
made and deliberately held out, because each one's marker file is also the sibling falsifier of another gate:

| held out then | the line | what a marker there also closes |
| --- | --- | --- |
| `test:chat-conversational-quality-gate` | `✖ Prefix Bit-Stability: passes when M0 is 100% byte-for-byte identical across all turns` | `tools/check-chat-conversational-quality-gate.mjs` |
| `test:production-pack-load` | `✖ negative: transitive module broken in the loaded closure` | `check:production-pack-load` |
| `test:tavern-release-prerequisites` | `✖ Tavern prerequisite checker fails closed for malformed, timed-out, stderr, and nonzero live-gate results` | `check:tavern-release-prerequisites` |

The fourth batch closed all three. Each marker now sits in the suite and each closed **two** gates, which is the
arithmetic that kept them out: one marker moved the census by two. Both gates are genuinely proven by it — the audit's
ownership rule reads a marker in a sibling falsifier as proof of the gate, and the suite is that gate's falsifier — so
the hold-out was a bookkeeping worry, not a gap in the evidence. The measured lesson: a marker that closes two gates
should be written and the census moved by two, not deferred.

Three of the four suites that could not be given a baseline in that checkout still cannot, re-measured this batch on a
clean HEAD copy: `test:gameplay-capability-catalog`, `test:frontend-turn-gate` and `test:dialogue-web-boundaries` are
each red for a reason that is not their own rule. The fourth, `test:csharp-compile`, is green again (13 passing), and
its row in the `provable` table no longer carries the caveat.
## What the disposition batch registered

Four proofs and four `external` labels closed eight of the fifteen, one gate left the population, and
`tools/gate-red-proof-baseline.json` lost exactly those nine entries — measured with `--update`, which rewrote the
file and changed nothing else (`git diff --stat`: `9 ---------`):

| closed | how | marker lives in |
| --- | --- | --- |
| `check:perf-budget` | `red-proof: fixture`, a saved suite reading 100% over budget | `tools/check-perf-budget.mjs` |
| `check:tavern-references`, `test:tavern-references` | `red-proof: inject`, the absent-registry branch made to report a pass | `tools/verify-tavern-semantic-references.test.mjs` |
| `test:stardew-fixture-readiness` | `red-proof: inject`, a blocked readiness document accepted as ready | `tools/await-stardew-fixture-readiness.test.mjs` |
| `check:knip` | `red-proof: external` | `package.json` `gateRedProofs` |
| `check:tools-boundaries` | `red-proof: external` | `package.json` `gateRedProofs` |
| `test:dialogue-web` | `red-proof: external` | `package.json` `gateRedProofs` |
| `test:all` | inherited, its only member is `test:dialogue-web` | — |

A gate whose command runs a project can name no file in this repository, so it has no file to carry a comment
marker. Those labels live in `package.json`'s `gateRedProofs` map, beside the script that defines the gate, and are
parsed by the same rules as a comment marker; the audit reads one from either place. Both tools print the external
rows with their commands, so a reader can run one and watch it fail instead of trusting the label.

Three assertions were seen red once before being kept: aggregate inheritance answering `proven` for a mixed set, the
runner-invocation check answering `yes` for every command, and an external claim with no failure clause being
accepted.

## The fourth batch: twenty gates, fifteen markers, and where each line came from

Every injection in this batch ran in a copy of HEAD **outside** the repository (`git archive HEAD` extracted to
`E:/tmp/gateproof/tree`, with `node_modules`, `host/node_modules`, `ref/`, `vendor/` and `design/` junctioned in and
its own `git init`/commit so the two gates that read `git` had a tree to read). The live worktree was never the
injection site: each copy file was restored from the repository's HEAD blob and re-run green, and
`git status --porcelain` on the live tree names no file this batch wrote other than the sixteen below (the other modified
paths in that output belong to lanes in flight).

Fifteen markers closed twenty gates, because five of them sit in a gate's sibling falsifier and therefore prove the
gate and its own suite at once:

| gate closed | marker lives in | the line that fired |
| --- | --- | --- |
| `audit:stardew-native-local-runner-contract` | `tools/audit-stardew-native-local-runner-contract.mjs` | `[conforming_regression] advance-day: retired-policy-shape — this runner conformed at baseline`, `contract: 1 finding(s)`, exit 1 |
| `audit:stardew-state-coverage` | `tools/audit-stardew-state-coverage.mjs` | `publication_missing: health is marked observable but player.health is not in … CreateBridgeSnapshot's body`, exit 1 |
| `check:production-pack-load` + `test:production-pack-load` | `tools/check-production-pack-load.test.mjs` | `✖ negative: transitive module broken in the loaded closure` (verdict `passed` where `blocked` was expected), exit 1 |
| `check:tavern-release-prerequisites` + `test:tavern-release-prerequisites` | `tools/check-tavern-release-prerequisites.test.mjs` | `✖ Tavern prerequisite checker fails closed for malformed, timed-out, stderr, and nonzero live-gate results`, exit 1 |
| `tools/check-chat-conversational-quality-gate.mjs` + `test:chat-conversational-quality-gate` | `tools/check-chat-conversational-quality-gate.test.mjs` | `✖ Prefix Bit-Stability: passes when M0 is 100% byte-for-byte identical across all turns` (19 pass, 4 fail), exit 1 |
| `check:stardew-gameplay-completeness` + `test:stardew-gameplay-completeness` | `tools/check-stardew-gameplay-completeness.test.mjs` | `✖ source-derived bridge equivalence gaps fail the completeness gate`, exit 1 |
| `check:stardew-native-pathfinder-source` + `test:stardew-native-pathfinder-source` | `tools/check-stardew-native-pathfinder-source.test.mjs` | `✖ mutation: handing the coordinate goal to the native pathfinder is rejected`, exit 1 |
| `test:stardew-receipt-attribution` | `tools/check-stardew-receipt-attribution.test.mjs` | `✖ mutation: removing the measurement from a producer is blocked`, exit 1 |
| `test:test-store-teardown` | `tools/check-test-store-teardown.test.mjs` | `✖ does not count a construction whose throw is the assertion`, exit 1 |
| `test:complexity-gate` | `tools/scripts/check-file-complexity-gate.test.mjs` | `✖ verdict.2:` — a file exactly at its extension's ceiling reported over it, exit 1 |
| `test:stardew-loop-closure` | `tools/check-stardew-loop-closure.test.mjs` | `✖ an anchor with no File.cs:line hop is reported, not skipped`, exit 1 |
| `check:head-typecheck` | `tools/check-head-typecheck.mjs` | `head_typecheck_failed rev=659620fcd8bb errors=1` + `error TS2322`, exit 1 |
| `test:stardew-native-mechanism-family-register` | `tools/stardew-native-mechanism-family-register.test.mjs` | `✖ family register partitions every raw syntax match exactly once without action semantics`, exit 1 |
| `test:stardew-native-transition-family-universe` | `tools/stardew-native-transition-family-universe.test.mjs` | `✖ forbids product vocabulary and non-neutral family identities`, exit 1 |
| `test:stardew-native-virtual-receiver-register` | `tools/stardew-native-virtual-receiver-register.test.mjs` | `✖ forbids primitive or action vocabulary`, exit 1 |

The census moved from 234 to 254 and the baseline lost exactly twenty entries
(`git diff --stat`: `20 --------------------`), written by `--update` rather than by hand.

**One injection had to be moved to be honest.** The ledger's suggested target for `test:complexity-gate` was
`tools/lib/subprocess-output.mjs`, the helper the suite uses to read its child's output. Reddening that would have
proved the suite's *parser* can fail, not that the boundary rule is guarded. The proof above changes the rule itself
(`lines > ceiling` → `lines >= ceiling`) and fires on `verdict.2`, the case that names the boundary in its title.
The earlier suggestion is left standing in no table now — this paragraph is its record.

## Gates whose proof is a source-text reading

Six of the twenty proofs fire on a gate that reads source **text** rather than exercising the product, and the
marker says so by quoting the rule rather than the behaviour:

| gate | what it reads | what the proof therefore does and does not establish |
| --- | --- | --- |
| `audit:stardew-native-local-runner-contract` | a regex over each runner's source, with comments stripped | establishes that a runner spelling `config.ActionPolicyVersion` is a finding. It does **not** establish that every retired read is caught: `config["ActionPolicyVersion"]`, a destructured alias or a helper that hides the name all pass the regex |
| `audit:stardew-state-coverage` | exact fragments inside `CreateBridgeSnapshot` and the `Sensory/*.cs` publishers | establishes that deleting a publication is a finding. It can also fire on a change with no semantic effect — reformatting or re-indenting the same expression reads as `publication_missing` |
| `check:stardew-native-pathfinder-source` | a parse of every `new PathFindController(` call and its third argument | establishes that a coordinate goal is a finding. A call built through a variable or a differently-named constructor call is invisible to it |
| `check:stardew-receipt-attribution` | evidence-string regexes over the Mod's C# | establishes that a producer whose label carries no `measurement=` is a finding, at the granularity of one evidence string: a `measurement=` anywhere in the same producer satisfies every label in it |
| `check:test-store-teardown` | `host/src` text, line by line | establishes that an unclosed store in a test file is a finding. A store opened through a wrapper the opener derivation does not know is not measured |
| `tools/scripts/check-file-complexity-gate` | line counts from `git ls-files` | establishes the ceiling boundary. A file's size is what it measures; nothing about its readability |

The pattern worth keeping: a source-text gate's red proof guarantees the *predicate* fires, and the marker should say
which predicate. None of the six was rewritten — each is a real gate with real coverage — but a reader who takes any of
them for "this class of defect is caught" is reading more than the proof established.

## A gate whose aim and whose fired assertion differ, met again: `test:frontend-turn-gate`

The known case remains `test:multiday-loop` (above). A second member of the same class was found this batch, and it is
recorded here rather than fixed:

| | the aim | what it asserts |
| --- | --- | --- |
| `test:frontend-turn-gate` | the composer's Host-owned refusals are read by the capture gate | the send button's terms are exactly `["disabled", "sendUnavailable", "!value.trim()"]` |
| measured on a clean HEAD copy | — | `✖ the gate reads the composer's two Host-owned refusals, and the send button's terms are exactly those plus an empty field`, `AssertionError: … sendRefused(uiState.send) \|\| !value.trim()` |

The product's send button now spells the term `sendRefused(uiState.send)`; the test still expects `sendUnavailable`.
Whatever the right name is, the assertion is pinned to a spelling and the suite is red in the checkout for that reason,
which is why the gate cannot be given a proof today: a proof needs a green baseline to redden. This is the second
pattern the ledger was asked to watch for — an assertion about a *name* that survives the deletion of the thing it
named (`test:gate-red-proofs` had the first).

## Examined this batch and deliberately not proven

| gate | what was measured | why no marker |
| --- | --- | --- |
| `check:publint` | `node tools/check-publint.mjs` exits 0 printing `publint exited null but every failure maps to a known vendor baseline gap; non-blocking here` | `vendor/magic-context/packages/pi-plugin` is absent from the checkout and `spawnSync("bun", …)` returns `ENOENT` (only a `bun.ps1` shim exists, and Node does not apply `PATHEXT` with `shell: false`). The gate read **no** publint message and called that non-blocking. Red-for-absence is not red-for-a-rule, so the label was not written — but this one is not green either, and the line it prints is a false pass |
| `check:sandbox-acceptance` | its rule is `report.ok = summary.ok === true && !timedOut`, and the verdict comes from `sandbox-verify.cmd` under a 15-minute deadline | there is no `GameBuddy.Setup.exe` in this checkout and the run stages its share on the real account; the proof belongs on the machine that builds the installer |
| `check:stardew-companion-production-admission`, `check:stardew-native-mechanism-review-register`, `check:stardew-native-normal-player-ingress-register`, `check:stardew-native-source-closure`, `check:stardew-native-transition-ledger` | each declared command, run as `package.json` invokes it | every one of the five exits 1 or 2 on a **missing argument** before reading a file, so the declared run cannot be told apart from a violation. Their rules are falsifiable once the argument set is supplied; the ledger now says so on each row instead of calling them plain `provable` |
| `test:gameplay-capability-catalog` | the suite on a clean HEAD copy | `✖ catalog seed covers every published registry action without claiming completeness` — red for a reason that is not its rule, so no baseline exists to redden |
| `test:csharp-compile` | the suite on a clean HEAD copy | green, 13 passing — the row's "red in this checkout today" caveat no longer holds, and the row now says that. The proof was one injected C# compile error away, and the fifth batch made it |
| `audit:stardew-action-seam-terminals`, `check:dialogue-web-boundaries`, `check:host-module-graph` | their entry files | the marker would have to live under `integrations/stardew/**`, `dialogue-web/src/**` or `host/src/**`, which this lane may not edit; the injections themselves were never in question |

## The fifth batch: twenty gates, twenty markers, and three gates that are red at HEAD

Every injection ran in a copy of HEAD **outside** the repository: `git archive HEAD` extracted to
`E:/tmp/gateproof/b5`, with `node_modules`, `host/node_modules`, `dialogue-web/node_modules`, `ref/`, `vendor/` and
`design/` junctioned in and its own `git init`/commit so the gates that read `git` had a tree to read. Two readings were
taken for every gate in the same pair of runs: the copy file was rewritten from the repository's own HEAD blob
(`git cat-file blob HEAD:<path>`) and the gate re-run green. At the end of the batch
`git -C E:/tmp/gateproof/b5 status --porcelain` is empty and the one file whose line endings the copy's index
normalises (`tools/sandbox/sandbox-verify.cmd`) is byte-identical to the live worktree's copy (9532 bytes). The live
worktree was never the injection site: `git status --porcelain` on it names no file this batch wrote other than the
twenty markers and this document.

| gate closed | marker lives in | the line that fired |
| --- | --- | --- |
| `check:host-production-import-boundary` | `tools/check-host-production-import-boundary.mjs` | `"verdict": "blocked"` with `{"kind":"production_reaches_test_only_module","importer":"host/src/action-registry.ts","specifier":"./companion-control-server.test.js","line":1396}`, exit 2 |
| `check:stardew-companion-production-admission` | `tools/check-stardew-companion-production-admission.mjs` | the declared flag set plus a dev-only `--fixture-adapter` → `{"state":"blocked","evidenceClass":"production_admission_preflight","reasonCode":"admission_cli_forbidden_override"}`, exit 2 |
| `check:stardew-native-mechanism-review-register` | `tools/check-stardew-native-mechanism-review-register.mjs` | `mechanism_review_register_unreviewed: Every discovered mechanism must receive exactly one explicit review disposition.`, exit 1 (fixture: an exact report whose one mechanism has no review row; its reviewed twin prints `{"status":"valid","mechanismCount":1,...}` and exits 0) |
| `test:csharp-compile` | `tools/check-csharp-compile.test.mjs` | `csharp_compile_compile_error:Probe.csproj:… error CS0103` + `csharp_compile_failed: 1 of 1 tracked C# projects do not build`, exit 1; the control tree reports `projects=1 compiled=1 excluded=0 failed=0`, exit 0 |
| `test:sandbox-verdict` | `tools/sandbox/prove-verdict-rule.ps1` | `FAIL red transcript fails -> ok=True` plus `FAIL empty transcript does not pass vacuously` and `FAIL a transcript containing a stale failure still fails`, exit 3; restored → `verdict_rule_proven`, exit 0 |
| `test:sandbox-wiring` | `tools/sandbox/prove-driver-gate-paths.py` | `FAIL the driver stages into the mapped HOST folder -> driver=C:\Users\long\gamebuddy-sandbox-drifted mapped=C:\Users\long\gamebuddy-sandbox`, exit 1 |
| `test:stardew-action-gate-descriptors` | `tools/stardew-action-gate-descriptors.test.mjs` | `✖ published action descriptors are complete, unique, and point to declared runner contracts` — the deep-equal prints `- travel`, exit 1 |
| `test:stardew-action-gates-batch` | `tools/run-stardew-action-gates-batch.test.mjs` | `✖ a gate missing either half of its evidence is missing, never a pass` (actual `{ state: 'passed', reasonCode: 'gate_passed' }`), exit 1 |
| `test:stardew-admission-fork-delta` | `tools/audit-stardew-admission-fork-delta.test.mjs` | `✖ the detector still finds a fork in all three spellings, and names the handler` (`two triple spellings plus the split one`), exit 1 |
| `test:stardew-admission-hold-codes` | `tools/lib/stardew-admission-hold-codes.test.mjs` | `✖ the list carries nothing the Mod cannot return` + `the list claims actor_held_by_non_existent_state, which the Mod's source does not mint`, exit 1 |
| `test:stardew-automation-cadence` | `tools/run-stardew-automation-cadence.test.mjs` | `✖ a block is blocked on a timeout, …` (actual `cadence_block_exit:none`, expected `cadence_block_timeout`) and `✖ a harness timeout is a blocked block, never a product verdict`, exit 1 |
| `test:stardew-clear-fish-pond-runner` | `tools/run-stardew-native-local-player-clear-fish-pond-smoke.test.mjs` | `✖ a pond still advertised after the clear fails: the published fact must change`, exit 1 |
| `test:stardew-dialogue-stream` | `tools/check-stardew-dialogue-stream.test.mjs` | `✖ a pager that only read the current page is caught` (actual `passed`, expected `blocked`), exit 1 |
| `test:stardew-dialogue-stream-runner` | `tools/run-stardew-native-local-player-dialogue-stream-smoke.test.mjs` | `✖ one page is BLOCKED, not passed: the claim is that the pager advanced`, exit 1 |
| `test:stardew-fixture-action-coverage` | `tools/lib/fixture-action-coverage.test.mjs` | `✖ a lane that grants an unpublished action is a named violation`, exit 1 |
| `test:stardew-fixture-profile` | `tools/stardew-fixture-profile.test.mjs` | `✖ every managed fixture target has a distinct backup identity` (`target names must be unique`: 28 against 40), exit 1 |
| `test:stardew-fixture-scenario-resolution` | `tools/stardew-fixture-scenario-resolution.test.mjs` | `✖ every action-keyed fixture scenario is reachable through its action set`, naming all 23 hijacked keys, exit 1 |
| `test:stardew-fixture-transaction-inspector` | `tools/stardew-fixture-transaction-inspector.test.mjs` | `✖ transaction inspector is read-only and reports ambiguous recoverable backups` (actual `idle`, expected `ambiguous_backups`), exit 1 |
| `test:stardew-formal-action-gate` | `tools/stardew-formal-action-gate.test.mjs` | `✖ nonterminal states are not terminal` and `✖ does not mistake accepted initial response for a terminal receipt`, exit 1 |
| `test:stardew-gameplay-surface-rules` | `tools/stardew-gameplay-surface-rules.test.mjs` | `✖ content classification collapses localized copies and preserves logical operation domains` (actual `Data/Events/Town.zh-CN.xnb`), exit 1 |

The census moved from 254 to 274 and the baseline's diff is `2 20` — twenty entries deleted by `--update`, plus the two
entries it recorded for the gates whose claims are unreadable (see the arithmetic note at the top: they are `gaps` and
no other bucket can hold them). `--update` was used rather than a hand edit, so the file was rewritten by the same
reading that prints the census.

Two of the twenty needed a decision about what their proof establishes:

- `test:stardew-action-gate-descriptors` and `test:stardew-fixture-scenario-resolution` both **derive their population**
  and both defend a shrunken one — the first against the Mod's own action registry (`Set(95)` in the deep-equal), the
  second with `assert.ok(declared.size >= 10)` beside a regex over the module it checks. That is why the fourth table's
  question about name-drifted populations has no new member from this batch: the two candidates that could drift are
  the two that refuse to pass when they shrink.
- `check:host-production-import-boundary` is a **whole-tree** reading: the injected import raised `examined` from 186 to
  189, because the test module it named pulled its own imports into the closure. The restoration reading is the one
  quoted (`passed`, `examined 186`, `violations 0`), so the two numbers are from two different populations and the
  marker says so.

## Six gates red at HEAD

These are the mirror of the debt this document was built for: gates that fire, name a real finding, and are read by
nobody. Each was measured twice — on the clean HEAD copy and in the live worktree — and each printed the same line. No
workflow invokes any of them (`grep` over `.github/workflows/*.yml` names none of them), which is why they have
been red without anybody noticing. The fourth was added by the sixth batch, the fifth and sixth by the seventh.

| gate | the reading at HEAD | where the fix belongs |
| --- | --- | --- |
| `check:stardew-native-multiplayer-sensitivity` | exit 2: `mp_sensitivity_classification_drift: use_mine_ladder declares StardewValley.Locations/MineShaft.cs mp-insensitive but the exact source reads the decisive token(s) IsLocalPlayer.` + `{"actionId":"use_mine_ladder","sensitivity":"mp-insensitive","decisiveTokens":["IsLocalPlayer"]}` | the register under `integrations/stardew/action-development/contracts/generated/`, or the decompile the register was authored against — either way a file this lane may not edit. Its row left the fourth table because a proof needs a green baseline and there is none |
| `test:stardew-fixture-scenario-wiring` | exit 1: `✖ the real repository wiring is consistent` (`actual: 'failed', expected: 'passed'`), `✖ the real allowlist contains the scenarios whose runners exist`, `✖ the real config gate accepts navigation_read_only_v1` | the scenario wiring/allowlist it reads; the gate is doing its job, the tree is not |
| `test:sandbox-configs` | exit 1: `FAIL gamebuddy-sandbox.wsb: not valid XML: not well-formed (invalid token): line 1, column 1` — the file is a `#`-comment document, and the validator globs `*.wsb` | `tools/sandbox/gamebuddy-sandbox.wsb`, committed in `3f319596` ("the Windows Sandbox harness joins the repository"). The gate has been red since the day that file landed |
| `test:stardew-native-multiplayer-sensitivity` (added by the sixth batch) | exit 1: `✖ the committed register derives cleanly against the exact decompiled source` with `code: 'mp_sensitivity_classification_drift'`, `details: { actionId: 'use_mine_ladder', file: 'StardewValley.Locations/MineShaft.cs', sensitivity: 'mp-insensitive', decisiveTokens: [ 'IsLocalPlayer' ] }` | the same register as the `check:` row above: this suite runs that register over the committed tree, so it inherits the drift rather than contributing one. **What it adds to the census:** a gate can be red at HEAD because another gate's population is red, and the two share one defect — the ledger should name both, not count two findings |
| `test:tool-corpus` (added by the seventh batch) | exit 1: `tool_test_corpus suites=235 quarantined=0` then 85 failing of 2506, of which the decisive one is a gate already red at HEAD — `✖ the committed register derives cleanly against the exact decompiled source`, `code: 'mp_sensitivity_classification_drift'`, naming `use_mine_ladder` | the corpus runs `tools/**`'s own suites, so it inherits every red member. Its row left the fourth table for the same reason the `mp-sensitivity` suite's did: a proof needs a green baseline, and its population contains a suite that is red at HEAD. **The aggregate inherits its members' debt** — the third gate in this table whose red is somebody else's defect |
| `test:dialogue-web-boundaries` (added by the seventh batch) | exit 1: `✖ every dialogue-web/src file belongs to exactly one golden zone` — `AssertionError: file appearance.ts matches 0 zones:` | its own hand-written `ZONES` manifest, which is the population it is named for. The gate is doing its job: `dialogue-web/src/appearance.ts` landed in `8711b9af` and the manifest was never told about it, so this is shape 1 of the four the batch watches for — **a population keyed by a name that drifted**, here caught rather than passed. It was recorded as “moved out for another lane” by the third batch; the truth is that it is red at HEAD, and it belongs in this table |

## Message defects met this batch

The third thing this batch was asked to watch for: a proof is worth less when the failure line cannot name the member.

| gate | the failure line | what it does not say |
| --- | --- | --- |
| `check:stardew-native-mechanism-review-register` | `mechanism_review_register_unreviewed: Every discovered mechanism must receive exactly one explicit review disposition.` | `fail()` computed `{ missingMechanismIds }` and the CLI's catch prints only `${code}: ${message}`, so the one fact a reader needs — which mechanism — is dropped. Its sibling `check-stardew-native-multiplayer-sensitivity` prints `error.details` as JSON on the next line, so the shape exists in the tree and this gate does not use it |
| `test:stardew-admission-fork-delta` | `AssertionError [ERR_ASSERTION]: two triple spellings plus the split one` | the count disagrees and the member does not: the dropped spelling (`actor.CanMove`) is not named, so a reader learns a spelling went missing but not which |

The other eighteen name their member: a gate id, an action id, a file:line, a code string, an expected-against-actual
value, or — in `test:stardew-fixture-scenario-resolution` — all 23 hijacked keys with their expected and resolved
scenarios side by side.

## What the batch examined and deliberately did not prove

| gate | what was measured | why no marker |
| --- | --- | --- |
| `check:stardew-native-normal-player-ingress-register`, `check:stardew-native-source-closure`, `check:stardew-native-transition-ledger` | each declared command, run as `package.json` invokes it | they exit 1 or 2 on the argument list alone (`normal_player_ingress_arguments_required`, the source-closure usage line, `transition_ledger_arguments_required`). Their inputs are not in this repository: an exact mechanism report, a certificate/universe/boundary-model triple, and a ledger plus scope manifest. **The eighth batch built the three missing fixture sets** and closed all three rows; the reasoning that stopped this batch is left standing above because it was right about the argument list and wrong about the cost of the schemas |
| `test:stardew-action-candidates`, `test:stardew-action-inventory-reconciliation`, `test:stardew-action-seam-terminals`, `test:stardew-branch-writeset`, `test:stardew-method-resolution` | their entry files | each entry file lives under `integrations/stardew/action-development/tests/`, and the audit reads a marker only from a file the gate owns, so the marker would have to live in a file this lane may not edit — the same bound as `audit:stardew-action-seam-terminals` in the first table |
| `test:sandbox-configs`, `test:stardew-fixture-scenario-wiring`, `check:stardew-native-multiplayer-sensitivity` | their default runs, twice | red at HEAD (the section above), so there is no green baseline to redden |

## The sixth batch: twenty gates, twenty markers, and one gate that reads a replica

Every injection ran in a copy of HEAD **outside** the repository: `git archive HEAD` extracted to
`E:/tmp/gateproof/b6`, with `node_modules`, `ref/` and `design/` junctioned in and its own `git init`/commit, so the
suites that read `git` or the decompile had a tree to read. The live worktree was never the injection site. For each
of the twenty the copy file was rewritten, the suite run, then the file restored from its own HEAD blob
(`git cat-file blob HEAD:<path>`) and the suite re-run — every pair in this batch answered `red exit=1 green exit=0
restore-clean=""` (the copy's `git status --porcelain -- <path>` empty), and the twenty suites were green at baseline
in that copy before any of it.

| gate closed | marker lives in | the line that fired |
| --- | --- | --- |
| `test:stardew-gameplay-surface-selector` | `tools/stardew-gameplay-surface-selector.test.mjs` | `✖ extracts nested literal case and comparison selectors without treating strings in comments as operations` — `commented_out`, taken from a `//` comment, appears in the actual selector list, exit 1 |
| `test:stardew-lifecycle-cold-session` | `tools/run-stardew-lifecycle-cold-session.test.mjs` | `✖ a stage that produced no evidence is never a pass` (`actual: { state: 'blocked', reasonCode: 'admission_refused' }`, `expected: … 'lifecycle_stage_evidence_missing:admission'`), exit 1 |
| `test:stardew-native-completion-event-register` | `tools/stardew-native-completion-event-register.test.mjs` | `✖ fails closed for missing local Poll` + `Missing expected exception` against `{ code: 'completion_event_register_wiring_missing' }`, exit 1 |
| `test:stardew-native-event-continuation-trace` | `tools/stardew-native-event-continuation-trace.test.mjs` | `✖ fails closed for a registration that does not bind the event to its handler` + `Missing expected exception` against `native_event_trace_registration_missing`, exit 1 |
| `test:stardew-native-farmer-sprite-callback-boundary` | `tools/stardew-native-farmer-sprite-callback-boundary.test.mjs` | `✖ fails closed for stale callback locator`, `actual: Error: Callback store must assign endOfAnimationFunction.` where `farmer_sprite_callback_locator_stale` was expected, exit 1 |
| `test:stardew-native-field-continuation-trace` | `tools/stardew-native-field-continuation-trace.test.mjs` | `✖ fails closed if a supposed consumer does not reference field` + `Missing expected exception` against `field_continuation_callsite_invalid`, exit 1 |
| `test:stardew-native-local-runner-contract` | `tools/audit-stardew-native-local-runner-contract.test.mjs` | `✖ regressing a baseline-conforming runner back to the retired shape is a finding` + `audit must report the regression` (`actual: 0`, `expected: 1`); `✖ a NEW runner written in the retired shape is a finding …` also fired, exit 1 |
| `test:stardew-native-local-runner-entry` | `tools/stardew-native-local-runner-entry.test.mjs` | `✖ every registered gate runner declares a CLI entry point`, `actual: [ 'run-stardew-native-local-player-body-owner-hold-smoke.mjs' ]` against `[]`, exit 1 |
| `test:stardew-native-mechanism-review-register` | `tools/stardew-native-mechanism-review-register.test.mjs` | `✖ requires exactly one non-semantic disposition for every exact discovered mechanism` + `Missing expected exception` against `mechanism_review_register_unreviewed`, exit 1 |
| `test:stardew-native-normal-player-ingress-register` | `tools/stardew-native-normal-player-ingress-register.test.mjs` | `✖ requires the partial inventory gap to be exactly router-anchored and rejects a gap on exhaustive inventory` + `Missing expected exception` against `normal_player_ingress_exhaustive_inventory_has_gap`, exit 1 |
| `test:stardew-native-router-invocation-inventory` | `tools/stardew-native-router-invocation-inventory.test.mjs` | `✖ fails closed for a non-unique source router signature` + `Missing expected rejection` against `router_inventory_method_anchor_missing`, exit 1 |
| `test:stardew-native-source-closure` | `tools/stardew-native-source-closure.test.mjs` | `✖ fails closed for unknown completion, unmodeled runtime edges, and post-source vocabulary` + `Missing expected exception` against `/unknown blocking edges/`, exit 1 |
| `test:stardew-native-state-machine-family-register` | `tools/stardew-native-state-machine-family-register.test.mjs` | `✖ fails closed for omitted partial-family gap, stale anchor, and missing owner` + `Missing expected exception` against `state_machine_family_gap_missing`, exit 1 |
| `test:stardew-native-tool-owner-slice` | `tools/stardew-native-tool-owner-slice.test.mjs` | `✖ fails closed for omitted invocation or an unanchored dynamic gap` + `Missing expected exception` against `tool_owner_slice_unclassified`, exit 1 |
| `test:stardew-native-tool-update-dispatch-boundary` | `tools/stardew-native-tool-update-dispatch-boundary.test.mjs` | `✖ fails closed for source parsing gaps inside the exact Tool.Update body` + `Missing expected exception` against `tool_update_dispatch_parse_gap`, exit 1 |
| `test:stardew-native-transition-ledger` | `tools/stardew-native-transition-ledger.test.mjs` | `✖ rejects empty routers, missing continuation registration/resume, and partial exits without a gap` + `Missing expected exception` against `transition_ledger_partial_exit_without_gap`, exit 1 |
| `test:stardew-native-virtual-member-invocation-register` | `tools/stardew-native-virtual-member-invocation-register.test.mjs` | `✖ fails closed when an exact implementation inventory becomes stale` + `Missing expected rejection` against `virtual_member_invocation_register_stale`, exit 1 |
| `test:stardew-player-command-equivalence-audit` | `tools/stardew-player-command-equivalence-audit.test.mjs` | `✖ reports a bridge equivalence gap when a required human-path guard is absent` (`actual: 'source_guard_equivalence_candidate'`, `expected: 'bridge_equivalence_gap'`), exit 1 |
| `test:stardew-player-command-graph` | `tools/stardew-player-command-graph.test.mjs` | `✖ classifies only known continuous helpers as supporting and retains unknown calls unresolved`, plus `✖ reports command roots as pending candidates …` and `✖ extracts direct calls as candidate edges …`, exit 1 |
| `test:stardew-tool-family-stamina-evidence` | `tools/check-stardew-tool-family-stamina-evidence.test.mjs` | `✖ a seam that drops the lastClick reset is reported` + `expected a lastClick failure, got []`, exit 1 |

The census moved from 274 to 294 and the baseline from 66 to 46 entries; `--update` wrote it (`git diff --stat` on
`tools/gate-red-proof-baseline.json`: `20 --------------------`, no additions), so the file was rewritten by the same
reading that prints the census. `check-harness-conformance` prints
`gates examined 346 · with a red proof 294 · external 4 · declared without 46 · undeclared 0 · zero-population-pass 0`
and `gate_falsifiers: passed`.

### Two rows proved on a different rule than the one the table guessed

Both rows were marked `(attempted; did not fire)` by an earlier lane, and in both cases the earlier guess addressed a
rule the fixture does not exercise:

| gate | the earlier guess | what fired |
| --- | --- | --- |
| `test:stardew-native-completion-event-register` | "a forbidden field the register stops refusing" — removing a word from `noProductTerms`'s set changes nothing, because the fixture throws `primitiveId`, which is in the set for every plausible edit | the local-`Poll` wiring requirement (`!polls.length`): without it the missing-Poll fixture derives cleanly and `assert.throws` reports `Missing expected exception` |
| `test:stardew-native-tool-owner-slice` | "a declaration mismatch the slice stops refusing" | the unclassified-invocation rule (`missing.length`): the failing fixture carries `records: []`, so the rule that fires is "every exact invocation needs a record", not the declaration binding |

### The gate this batch did not prove, and why: it asserts a replica

`test:stardew-native-local-runner-fixture-contract` was in this batch's list and was dropped for cause. Its fourth case
is titled *"the fixture's own policy block carries no retired field"*, and its subject is a **local** function:

``js
/** The policy block `applyDerivedPolicy` writes, for one run's actions. */
function fixturePolicyFor(actions) {
  return { DeniedActions: [], DeniedActionFamilies: [], ExperimentalActions: actions.filter(/* … */) };
}
``

A retired field added to the real writer (`tools/lib/stardew-native-local-player-fixture.mjs`) cannot turn that case
red; only editing the replica inside the test can. So a proof there would establish that the assertion fires, never
that the fixture is guarded — the shape this document's "two-authority equality" section exists to prevent, met in
reverse: the assertion compares a copy against a literal, and nothing compares the copy against the writer. The row
stays in the fourth table carrying that reason; `test:stardew-tool-family-stamina-evidence` took the twentieth slot.

### The four shapes, as this batch met them

1. **A population keyed by a name that drifted** — no new member. Two of the twenty derive their population from
   another authority and both refuse to pass when it shrinks: `test:stardew-native-local-runner-entry` reads the
   descriptor tables and its third case asserts `names.length >= 40` *and* names the one runner it was written for,
   and `test:stardew-native-local-runner-contract` counts `runnerCount >= 50` beside its findings.
2. **`status: failed` with an empty `violations` array** — not met in this batch (no gate here prints a status report).
3. **A failure line that cannot name the member** — one clear member: `test:stardew-player-command-graph`'s
   `assert.ok(graph.reachableEdges.some((edge) => edge.classification === "candidate_dispatch_edge"))` printed
   `AssertionError: The expression evaluated to a falsy value:` with `actual: false, expected: true` — no message, no
   edge id, no classification. Twelve of the twenty fire as `Missing expected exception` (ten) or `Missing expected
   rejection` (two), which name the rule only through the test title and the `expected: { code: … }` object; that is
   weaker than a message but the code is named, so only the `assert.ok` case is recorded as a defect.
4. **A gate reading a file another lane renamed** — none of the twenty. The two that read files by name
   (`run-stardew-native-local-player-body-owner-hold-smoke.mjs` through the descriptor tables, and the twenty runner
   sources `local-runner-contract` walks) resolve today; the renaming lane's 86 files were test files, and none of
   this batch's entries is one of them.

One further reading this batch produced, which is not one of the four but belongs beside them: the *first* injection
attempt for `test:stardew-native-farmer-sprite-callback-boundary` — deleting the stale-slice comparison — went red on
the **next** rule (`Callback store must assign endOfAnimationFunction.`), because the fixture's stale locator is three
bytes long and fails the store-content rule once the hash comparison is gone. The suite did fire, and the rule removed
is load-bearing, but the reader sees a different code than the one removed. The marker says which rule was deleted.
### Why these twenty claims name the injection site by role, not by path

`evaluate` treats every repo-relative path a proof names as a pointer that must be *executed* by a declared script or
a workflow (`runnerText.includes(pointer)`), and reports the rest as `proven_but_nothing_runs`. A production module is
imported, never run, so naming `tools/lib/<module>.mjs` in a marker adds a finding that says nothing about the proof —
and this batch was told not to grow that population. Measured: naming the module paths took the list from 29 entries to
46; naming the site as "the `<module>` module" took it back to 29, the same 29 the pre-batch copy prints. The path a
reader needs is one hop away in the suite's own import, and the two markers whose subject *is* an executed file
(`test:stardew-lifecycle-cold-session`'s driver, `test:stardew-native-local-runner-contract`'s audit, and
`test:stardew-tool-family-stamina-evidence`'s checker) keep their paths and stayed `executed`. The count is recorded
here because a marker convention that keeps a gate honest should not be inferred from silence.

## The seventh batch: eight gates, and the bound the queue runs into

Every injection ran in a copy of HEAD **outside** the repository: `git archive HEAD` extracted to
`E:/tmp/gateproof/b7`, with `node_modules`, `host/node_modules`, `dialogue-web/node_modules`, `ref/`, `vendor/` and
`design/` junctioned in and its own `git init`/commit. The live worktree was never the injection site. Seven of the
eight are a file rewritten, the command run, the file restored from the copy's own commit and the command re-run green;
the restore was proved two ways — `git status --porcelain -- <path>` empty **and** `git hash-object <path>` equal to
`git rev-parse HEAD:<path>`. The eighth (`test:stardew:all`) plants a new file instead of rewriting one, so its restore
proof is the deletion plus an empty `git status` for the whole copy; its red and green readings are two full gate runs,
which is why it is the pair with the longest wall clock in the batch.

| gate closed | marker lives in | the line that fired |
| --- | --- | --- |
| `test:stardew-state-coverage` | `tools/audit-stardew-state-coverage.test.mjs` | `✖ an engine state with no row is named`, exit 1 — the population check's "a guard with no row" rule disabled in `tools/audit-stardew-state-coverage.mjs`, so a synthetic `isRafting` state went unreported |
| `test:stardew-static-companion-admission` | `tools/lib/stardew-companion-production-admission.test.mjs` | `✖ production admission is Windows-only and accepts only canonical drive absolute grammar`, exit 1 — the canonical-drive-absolute grammar disabled in the production-admission module, so `/admission_path_not_absolute/` stopped throwing |
| `test:stardew-static-companion-evidence` | `tools/lib/stardew-companion-live-evidence.test.mjs` | `✖ rejects tampering and fails closed when a STOP has no authoritative body settled fact`, exit 1 — the body-settled rule disabled in the live-evidence module, so `production_live_body_settle_evidence_unavailable` is no longer in the code list |
| `test:stardew-static-companion-fixture` | `tools/stardew-companion-live-scenario.test.mjs` | `✖ rejects structural fixture mutations`, exit 1 — the phrase-manifest integrity comparison disabled in the live-scenario module, so a `sha256:deadbeef` integrity is accepted |
| `test:stardew-attachment-telemetry` | `tools/stardew-attachment-telemetry.test.ps1` | `attachment_telemetry_contract_missing:Publish-Telemetry "failed"`, exit 1 — the failed-outcome publication renamed in the attachment regression prover |
| `test:stardew-loop-closure-mutation` | `tools/check-stardew-loop-closure.mutation.mjs` | `STILL GREEN  M1 treat a private entry as callable` + `SOME MUTATIONS SURVIVED`, exit 1 — the private-entry case removed from the loop-closure suite, which is the defect the runner exists to find |
| `test:stardew-scaffold` | `tools/verify-stardew-scaffold.test.mjs` | `✖ scaffold checker rejects forbidden embodiment surfaces anywhere in the Mod source tree`, exit 1 — the `new Farmer` term dropped from the scaffold verifier's exact-text list |
| `test:stardew:all` | `tools/test-stardew-all.mjs` | `RED  GameBuddy.Stardew.Core.Tests/… 867/868`, `"status": "failed"` with that project named in `failed`, exit 1 — a failing xunit fact planted in the project inside the copy; probe deleted → `"status": "passed"`, `"failed": []`, exit 0 |

The census moved from `with a red proof 296 · declared without 46` to `304 · 38`, `gate_falsifiers: passed`, and
`tools/gate-red-proof-baseline.json` lost exactly those eight entries, written by `--update` rather than by hand
(`git diff --stat`: `8 --------`).

### Two rows left the queue for a measurement, not a proof

Both were red at HEAD, and both are worth naming because the ledger had them filed under a gentler reason:

| gate | the reading at HEAD | what it says about the ledger |
| --- | --- | --- |
| `test:tool-corpus` | `tool_test_corpus suites=235 quarantined=0` then `✖ the committed register derives cleanly against the exact decompiled source` — 85 failing of 2506 on a tree whose only modifications were this batch's own injections | the corpus is derived from `package.json` and green when every member is; one red member makes it red. It inherits `test:stardew-native-multiplayer-sensitivity`'s drift, so it belongs beside that row |
| `test:dialogue-web-boundaries` | `✖ every dialogue-web/src file belongs to exactly one golden zone` — `file appearance.ts matches 0 zones:` | the third batch moved this row out as "red for a reason that is not its own rule". Measured now, it is its own rule firing on a hand-written `ZONES` list that was never told about `dialogue-web/src/appearance.ts` (committed in `8711b9af`) — shape 1, the population keyed by a name that drifted, **caught** rather than passed |

### Why this batch is eight and not twenty, measured rather than split

The batch was asked for the next twenty. The remaining 38 debt rows do not offer twenty that this lane can close, and
the arithmetic is worth writing down because it is the queue's real shape:

| the remaining rows, by reason | count | why a proof cannot be written from here |
| --- | --- | --- |
| the marker would have to live in another lane's file | 14 | thirteen `integrations/stardew/action-development/tests/**` entry files (`test:stardew-action-candidates`, `-action-inventory-reconciliation`, `-action-seam-terminals`, `-branch-writeset`, `-method-resolution`, `-method-resolution-mutation`, `-player-reachable-exits`, `-reachable-exits-reconciliation`, `-rejected-layer-verdicts-mutation`, `-remaining-actions`, `-tile-action-selectors`, `-uncovered-exit-expansion`, `-uncovered-exit-table`) plus `audit:stardew-action-seam-terminals`. The marker is a repo edit, and `integrations/stardew/**` is not this lane's |
| red at HEAD, so no green baseline to redden | 8 | `test:sandbox-configs`, `test:stardew-fixture-scenario-wiring`, `test:stardew-native-multiplayer-sensitivity`, `check:stardew-native-multiplayer-sensitivity`, `test:frontend-turn-gate`, `test:gameplay-capability-catalog`, and the two this batch measured: `test:tool-corpus`, `test:dialogue-web-boundaries` |
| the rule lives in another program or another repository | 5 | `check:publint` (no `bun` binary for its `spawnSync`), `check:sandbox-acceptance` (no installer, and it stages on a real account), `check:host-module-graph` and `check:dialogue-web-boundaries` (a root `.dependency-cruiser.*.cjs` is the entry file), `check:architecture` (an `echo`) |
| kept rows whose runner is another lane's | 6 | `test:stardew:core`, `test:stardew:integration` (`dotnet test` over `integrations/stardew/tests/**`), `test:voice-protocol` (a submodule), `check:live-run-isolation` (a machine preflight), and the two `not measured` tools gates |
| needs a valid synthetic input before any rule can be reddened | 3 | `check:stardew-native-normal-player-ingress-register`, `check:stardew-native-source-closure`, `check:stardew-native-transition-ledger` exit 1 or 2 on the argument list alone; with no fixture set there is no green baseline, and "an invalid input is refused" is not the rule each gate exists for. Left owed with that reason rather than given a proof that establishes nothing. **The eighth batch built those three fixture sets and closed the row**; see its own section |
| written but skipped | 1 | `test:stardew-soil-itm-canary`: all five cases `skip` where `.tmp-stardew-decompile/` is absent, so a violation there reddens nothing |
| asserts a replica | 1 | `test:stardew-native-local-runner-fixture-contract`, on the sixth batch's reason |

`14 + 8 + 5 + 6 + 3 + 1 + 1 = 38`. The split at the top of this document counts the same 38 as
`18 + 6 + 1 + 6 + 7`, because it keeps the third batch's attribution for `test:frontend-turn-gate`,
`test:gameplay-capability-catalog` (red, but filed as "moved out for another lane") and `check:architecture` (the
reads-other row). Two counts of one population, agreeing at 38 — which is why the header says 38 and not something the
reader has to derive. The eighth batch then removed the three `needs a valid synthetic input` rows, so both counts
read 35 today: `14 + 8 + 5 + 6 + 0 + 1 + 1` and `15 + 6 + 1 + 6 + 7`.

### The four shapes, as this batch met them

1. **A population keyed by a name that drifted** — two members, both caught rather than passed:
   `test:dialogue-web-boundaries`'s `ZONES` list no longer knows `appearance.ts`, and `test:tool-corpus`'s verdict is
   only as green as its 235 derived members. The difference matters: the first is a hand-written population that went
   stale and said so; the second derives its population and inherits a member's red.
2. **`status: failed` with an empty `violations` array** — not met. `test:stardew:all` prints `"status": "failed"`
   with the project named in `", "failed": [...]`, so both channels carry the member.
3. **A failure line that cannot name the member** — one: `test:stardew-scaffold`'s red line names the *rule*
   ("rejects forbidden embodiment surfaces anywhere in the Mod source tree") but not *which* forbidden surface and not
   the file it was found in. The assertion is `assert.match(output, /forbidden Phase 1 surface: new Farmer/)` against
   the verifier's console text, and `assert.notEqual(code, 0)` fires first without a message, so a reader who breaks a
   *different* term sees a red case with no member named. The other seven name theirs.
4. **A gate asserting a replica** — no new member; `test:stardew-native-local-runner-fixture-contract` still carries the
   sixth batch's reason, and this batch did not manufacture a proof for it.

### What the two Integration-bound injections do and do not establish

`test:stardew-scaffold` and `test:stardew:all` were reddened by editing `integrations/stardew/**` **inside the copy**,
which is a different thing from editing it in the repository: nothing another lane owns was touched, and the copy was
reverted to its own commit. What the two proofs establish is that each gate fires on a real violation of its rule. What
they do not establish is anything about the Mod's own correctness — the injected violations were synthetic, and both
markers say which rule was broken rather than claiming the suite guards a shipped defect.

## The eighth batch: three gates that needed a legal input before they could be reddened

These were the three rows the seventh batch left as `needs a valid synthetic input`, and it was right about the
argument list: each declared command exits 1 or 2 before reading a file, so a proof made against that run would only
establish that an illegal argument list is refused. The work was to build a **legal** input for each gate, watch it go
green, and only then move one thing.

All of it ran in a copy of HEAD outside the repository (`git archive HEAD` into `E:/tmp/gateproof/b8`, its own
`git init` and commit). The fixtures were authored there and measured there; they were copied into `tools/fixtures/**`
only after they were green, and the live worktree was never the injection site. Every restore is proved twice per
file — `git status --porcelain -- <path>` empty **and** `git hash-object <path>` equal to `git rev-parse HEAD:<path>`
— and each gate was re-run green from the restored file.

| gate | the legal fixture, green (exit 0) | the one mutation | the gate's own red line | exit |
| --- | --- | --- | --- | --- |
| `check:stardew-native-normal-player-ingress-register` | `tools/fixtures/stardew-native-ingress-register` — one entrypoint, one resolved edge, one exhaustive router inventory and one root, every anchor a byte span of the fixture's own `FixtureInputRouter.cs`: `{"artifactKind":"native_normal_player_ingress_and_caller_register_check","entrypointCount":1,"edgeCount":1,"rootCount":1,"gapCount":0,"closureState":"not_claimed"}` | the register's `entrypoints` row deleted | `normal_player_ingress_no_entrypoints_or_gaps: A non-empty ingress proof needs an entrypoint or an explicit blocking entrypoint gap.` | 1 |
| `check:stardew-native-normal-player-ingress-register` | the same fixture, restored and re-run green | its `callerEdges` row deleted while `routerExitInventories[0].edgeIdsInSourceOrder` still names that edge | `normal_player_ingress_inventory_invalid: Router inventory needs existing ordered edge IDs.` | 1 |
| `check:stardew-native-source-closure` | `tools/fixtures/stardew-native-source-closure` — a schema-v2 certificate, its universe, boundary model, content manifest and target assembly, all four attestations computed from the fixture's own bytes: `{"mechanismCount":1,"edgeCount":1,"unknownBlockingEdgeIds":["gap:fixture-input-content-interpreter"],"closureState":"partial_with_unknown_blocking",…}` | the certificate's one edge ID `gap:fixture-input-content-interpreter` renamed to `gap:fixture-input-content-interpreters` | `{"error":"source_closure_check_failed","message":"certificate edge not in validated universe: gap:fixture-input-content-interpreters"}` | 1 |
| `check:stardew-native-transition-ledger` | `tools/fixtures/stardew-native-transition-ledger` — a schema-v2 ledger over one reviewed in-scope mechanism, its exact mechanism report, review register and scope manifest: `{"sourceMechanismCount":1,"mechanismReviewDispositionCounts":{"in_scope_root":1},"transitionCount":4,"rootBindingCount":1,"scopedMechanismCount":1,"blockingNodeCount":0,"closureState":"partial"}` | one of `transition:commit`'s two exit-inventory rows deleted | `transition_ledger_exit_inventory_incomplete: Every explicit handoff needs exactly one source-anchored exit inventory row.` | 1 |

The attestations inside each fixture are computed with the repository's own helpers (`collectCSharpSources`,
`sourceManifestSha256`), not hand-written hashes, so a reader can re-derive them instead of trusting them. The marker
kind is `fixture` for all three — the legal input is synthetic — and each marker names its fixture directory and the
mutation, in the gate file itself.

The census moved from `with a red proof 304 · declared without 38` to `307 · declared without 35` at the same
`348` examined, and `tools/gate-red-proof-baseline.json` lost exactly those three entries (`git diff --stat`:
`3 ---`), written by `--update` on the clean copy rather than by hand. The three-term partition the header now states
is `307 + 4 + 37 = 348`, where the 37 owed are the 35 recorded rows plus the 2 unreadable claims. `proven_but_nothing_runs`
is unchanged at 33 before and after: the three markers name directories, not file paths, so no pointer joins that list.

### What each proof establishes, and what it does not

What it establishes: the gate, given its real argument set, exits 0 on a legal input and exits 1 naming a rule when one
row or one reference is moved. That is the fact the seventh batch could not get — the declared run could not be told
apart from a violation. What it does not establish: that the gate guards a *shipped* defect. No pre-fix commit was
replayed (there is no real good-vs-bad pair for any of the three), so the mutation is synthetic and the markers say
which rule each one broke. It also does not establish coverage completeness: the ingress proof moves rows, not the
byte spans, so `normal_player_ingress_locator_stale` (a real predicate, already asserted red in
`tools/stardew-native-normal-player-ingress-register.test.mjs`) is not what these two runs fired.

### A probe that did not redden: the ledger's "ordered" handoffs

Reversing `transition:commit`'s `handoffs` array **and** swapping their `sequence` values
(`transition:out-of-scope@1@after_commit, transition:resume@0@continuation`) still exits 0 with
`transitionCount 4, rootBindingCount 1`. The `sequence` integer is the only order authority, and neither ascending
array order nor contiguity is checked, while `tools/README.md:193` describes these handoffs as "ordered, typed,
source-anchored". That is a reader/claim divergence of the kind the "reads something other than it checks" table holds;
it is recorded here rather than repaired, because this unit does not change a gate's rule.

### Two message defects, and the one gate that names its member

`check-stardew-native-normal-player-ingress-register` and `check-stardew-native-transition-ledger` both build
`details` carrying the member (`{ rootId }`, `{ nodeId }`, `{ edgeId }`, `{ gapId }`) and both CLI `catch` blocks print
only `${code}: ${message}`. Every message in those two gates is rule prose, so `normal_player_ingress_root_invalid` and
`transition_ledger_exit_inventory_incomplete` name the rule and never the row — the same shape the seventh batch
recorded for `check:stardew-native-mechanism-review-register`, now with two more members.
`check-stardew-native-source-closure` is the one of the three that names its member, and it does so in the CLI
(`certificate edge not in validated universe: <edgeId>`), not in the module's `fail`.

### Documentation drift, recorded not fixed

`tools/README.md:162` documents `check:stardew-native-source-closure -- --certificate <certificate.json>` as the way to
run that gate. The gate requires six flags and `args.length === 12`, so the documented command exits 2 with the usage
line — which is how this gate was reachable only as an argument check until this batch gave it a real fixture set.

## The three `reported not measured` gates: two keep-blocked, one measured

`node tools/check-harness-conformance.mjs` named three gates under `reported not measured`. They were not one finding,
and filing them as one is what kept the list unpaid: two read a document that has never existed, and the third reads a
directory that is empty on purpose while its rule measures eight things.

| gate | what it reads | what was measured | disposition |
| --- | --- | --- | --- |
| `tools/check-stardew-actor-admissibility.mjs` | `integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json` | the file has never existed: `git log --all -- <path>` prints nothing, `git ls-files integrations/stardew/action-development/contracts/` lists twelve files and none under `actor-admissibility/`, and nothing in the tree writes that path | **keep-blocked** |
| `tools/check-stardew-hold-sufficiency.mjs` | the same path | the same, and it is the tool that measures the row which blocks both gates | **keep-blocked** |
| `tools/check-vendor-patches-apply.mjs` | `patches/vendor-magic-context/*.patch` | the directory holds no patch because the seams merged into the pin (`magic-context-airp`), and the sealed rule **did** measure: 4 seam files, 8 of 8 declared extension points present at pin `5c100922`, exit 0 | **measured** — the report said `examined: 0` |

The reading before and after, from the same command in the same checkout:

```
before  gates examined 348 · with a red proof 308 · external 4 · declared without 34 · undeclared 0 · zero-population-pass 0
        reported not measured 4  (check-preset-round-trip.mjs, check-stardew-actor-admissibility.mjs,
                                  check-stardew-hold-sufficiency.mjs, check-vendor-patches-apply.mjs)
after   gates examined 348 · with a red proof 308 · external 4 · declared without 34 · undeclared 0 · zero-population-pass 0
        reported not measured 3  (check-preset-round-trip.mjs, check-stardew-actor-admissibility.mjs,
                                  check-stardew-hold-sufficiency.mjs)
```

`308 + 4 + 34 = 346`, plus the two unreadable claims the header names, is the 348 examined — unchanged, because no gate
entered or left the population. What moved is the third bucket: a gate whose report could not show what it measured now
shows it, so the list is two blocked gates and one gate whose input is a build artifact
(`check-preset-round-trip.mjs`: `host/dist-test/tavern/preset-store.js`, built by `pnpm --dir host build:test`).

### Why the two stardew gates stay blocked, and who decides

Both read ONE document, and only half of it is missing from it. Every algebra field has an authority that already owns
it, and the two gate headers now name them with their lines so a producer has somewhere to read from instead of a place
to copy into:

| contract field | authority |
| --- | --- |
| `states` | `ActorDispositionKind` and `WorldModel.KindForWire` — `integrations/stardew/WorldModel.cs:23`, `:118` |
| `causes` | `WorldModel.HoldReasonCode` — `:308` |
| `environmentReads` | `WorldModel.ReadFacts` — `:251` (the facts the disposition is a pure function of) |
| `actions[].admissibleIn` | `FarmhandActionCatalog.ModalResolvingActionIds` / `EventActingActionIds` / `ModalFamilyActionsWithoutAnEventPath` — `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs:895`, `:921`, `:936` — joined to the profile rule in `integrations/stardew/ExecutionAdmission.cs:353` |
| `remedies` | `host/src/stardew-action-remedy.ts:49` |
| `adjudication.decisionSites` | measured at 5 sites in 4 files; the verdicts are the design decision, not a scan result |
| `orphanHoldResidual` | **nothing** — see below |

Deriving the algebra and then asserting INV-1/INV-3/INV-4 over it would assert nothing about the Mod: totality,
liveness and acyclicity are properties of a STATEMENT someone makes about the state space, and a producer that builds
the statement from the code it describes makes all three true by construction. The gate exists for the gap between the
statement and the code, so the statement has to be somebody's.

The row that actually blocks it is the residual, and it is measured rather than assumed. With the companion set taken
from `ReadFacts` (nine members) the search over `ref/external/StardewValleyDecompiled` reads:

| reading | count |
| --- | --- |
| files scanned | 948 |
| writes of `Farmer.canMove = false` | 58 |
| accompanied by a declared read | 41 |
| **orphans** | **17** |
| unparsed (the brace walk's own bound) | 4 |

Exactly one of the 17 releases the flag inside its own method (`ParrotUpgradePerch.cs:797`); the other sixteen are
holds no declared read can name — `Crop.harvest` (two sites), `Farmer.animateOnce`, `Farmer.grabObject`,
`Farmer.PerformKiss`, `Event.OnPlayerControlSequenceEnd`, `ScreenFade.FadeScreenToBlack`, `BusStop`,
`Desert.playerReachedBusDoor`, `ManorHouse.performAction`, `MineShaft.enterMineShaft`,
`VolcanoDungeon.UseVolcanoShortcut`, `FishingGame.gameDoneAfterFade`, `Object.rainTotem` and the two birthing events.
Each needs one verdict — `missing_read` (our state space is incomplete), `deeper_accompaniment` (established in a callee
the analysis cannot see) or `not_a_hold` (the write does not hold the actor) — and writing one from this ledger would be
a claim about Stardew's source that only a read of that source can support. **Who decides:** the Mod owner, through the
`game-action-boundary` → `game-action-implement` pipeline, because a `missing_read` verdict is a new fact in
`ActorWorldFacts` plus a hold code in `WorldModel.HoldReasonCode`, which is the Mod's gameplay state. **What the gate
checks then:** unchanged — every write of `Farmer.canMove = false` is accompanied by one of the declared reads or
carries an adjudicated row, compared bidirectionally, plus the algebra invariants over the authored statement.

The four `unparsed` rows (`GameLocation.cs:9287`, `:9297`, `:9321`, `:9345`) are this tool's own bound rather than a
decision, and they block the CLI's green as well; they are named in the header instead of sitting inside a count.

### What changed for `check-vendor-patches-apply`, and the proof

The gate read the PATCH directory for its population and reported that count as `examined`. In sealed mode that
directory has no member, so a run that verified eight declared extension points at a named pin printed `examined: 0` —
true of the directory, false of the run — and `tools/lib/assert-non-vacuous.mjs` reads `examined`, so it filed the gate
as `gate_zero_population_allowed:vendor-patches-apply:examined` on every census. `examined` now counts the mode's own
population: patches in patch mode, and the declared extension points read out of the pin in sealed mode, with
`extensionPoints` as the number declared. `allowEmpty` keeps its job — declaring why an empty patch directory is healthy
— and stops being what the shared judge has to lean on. The summary line names the population it counted, so no reader
has to infer the unit from the mode.

The suite was also red at HEAD for a reason of its own, which this unit had to fix before any green could be claimed:
two sealed fixtures pinned one of the four `MERGED_SEAMS` files, so the other three read
`vendor_seam_file_missing_from_pin` — a fixture defect that looked exactly like the loss the gate exists to catch — and
one expectation had `measured: 2` baked in from that smaller fixture. `seamFiles()` pins every declared seam from this
checkout's submodule; 20 of 20 cases pass, where 18 of 20 passed before.

| reading | value |
| --- | --- |
| the gate on the real tree | `vendor_patches: examined 8 of 8 extension point(s) at pin=5c100922…, 4 merged seam file(s), 0 violation(s) [passed]`, exit 0 |
| the shared judge over that report | `passed (examined 8)` |
| red proof (sealed counter reverted to the patch count) | judge answers `gate_zero_population_allowed:vendor-patches-apply:examined all seams merged upstream into magic-context-airp` for a run whose status is `passed`; the case "a pin carrying the seam is passed" fails `0 !== 8` on the population assertion |
| restored | 20/20 green, gate exit 0, judge `passed (examined 8)` |

The marker lives in `tools/check-vendor-patches-apply.test.mjs`, beside the patch-mode injection it already carried.
The gate is in the `with a red proof` bucket and stays there; what moved is only that its green run is now a
measurement of `MERGED_SEAMS` rather than a zero with a reason attached.

### Owed by someone else, recorded here rather than repaired

- `test:tool-corpus` is `gate_declaration_stale` in the census on this checkout — `tools/run-tool-test-corpus.test.mjs`
  is another lane's in-flight file, so the baseline entry that owes a proof for it is now stale. `check-harness-conformance`
  fails on that finding before and after this batch; it is not this batch's unit.
- `check-preset-round-trip.mjs` reads `host/dist-test/tavern/preset-store.js`, which is a build artifact: the honest
  reading there is "build the test tree", not a contract anyone can author.
