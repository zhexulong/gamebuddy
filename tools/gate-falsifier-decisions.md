# Gate falsifier decisions

`gates examined 348 · with a red proof 321 · external 4 · declared without 21 · undeclared 0 · zero-population-pass 0`

**The eleventh batch measured `351 · 326 · 4 · 19 · 0 · 0`** and its own section at the end reconciles it
(`326 + 4 + 21 = 351`, where the 21 owed are the 19 recorded rows plus the 2 unreadable claims). The reading quoted on
this line is the ninth batch's, kept because the sections below are written against it; a reader who wants today's
count should read the newest section's table, not this number.

**The ninth batch moved that line from `307 · 4 · 35` to `321 · 4 · 21`** and the partition it states is now
`321 + 4 + 23 = 348`, where the 23 owed are the 21 recorded rows plus the 2 unreadable claims. The paragraphs below keep
the fifth-through-eighth-batch arithmetic they were written with, and each names the reading it was measured at;
nothing in them is a claim about today's count except the reconciliation they show, which is the method this document
has used since the first batch. The ninth batch's own section is at the end: it closed thirteen of the owed rows, which
is why the third bucket reads 21 and not 34.

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

Fourteen gates, each with the violation to inject. Twenty-three rows left this table in the fifth batch, twenty
left it in the sixth (all proved there), eight left it in the seventh, three left it in the eighth (all proved there),
three moved down to the red-at-HEAD table
(one in the sixth, `test:tool-corpus` and `test:dialogue-web-boundaries` in the seventh), and one left it in the twelfth
(`test:stardew-native-local-runner-fixture-contract`, repaired to read the writer and proved there); none of them is
repeated here.
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
assert.deepEqual([...DISPOSITION_STATUSES].sort(), [...schema.
defs.advisory.properties.status.enum].sort());
``

`DISPOSITION_STATUSES` is the gate's own constant — what the checker treats as a disposition it must validate.
`
defs.advisory.properties.status.enum` is the schema the advisory snapshot is written against. Sorted deep
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

## The ninth batch: thirteen gates, one marker file, and the eighty-five suites nobody triaged

Two units share this batch and they have one question in common: does the thing we claim to check check something.

### Part one — thirteen red proofs, and why the marker is in `package.json`

Every injection ran in a copy of HEAD **outside** the repository (`git archive HEAD` extracted to
`E:/tmp/gateproof/b9`, `node_modules`, `host/node_modules`, `dialogue-web/node_modules`, `host/dist-test`, `ref`,
`vendor`, `design` and `integrations/stardew/action-development/node_modules` junctioned in, its own `git init` and
commit `f1d3b9c`). The live worktree was never the injection site. Each file was restored from the copy's own commit
and the restore is proved twice — `git status --porcelain -- <path>` empty **and** `git hash-object <path>` equal to
`git rev-parse HEAD:<path>` — and every suite was re-run green from the restored file.

The eighth batch's reason for leaving fourteen rows owed was that each marker would have to live under
`integrations/stardew/**`, which that lane could not edit. It was right about the file and wrong about the mechanism:
`tools/audit-gate-red-proofs.mjs` already reads a marker from `package.json`'s `gateRedProofs` map, beside the script
that defines the gate, under the same keyword, kinds and claim syntax as a comment marker. The disposition batch used
that map for `external` labels because a project runner has no file here to carry a comment; nothing in the reader
restricts it to that kind, and a gate whose own entry file belongs to another lane is the other honest use — the
declaration still sits beside the command, and the pointer it names is the suite `package.json` actually runs, so
`evaluate` reads the proof as `executed` rather than as `proven_but_nothing_runs`.

| gate closed | the one mutation | the gate's own red line | where |
| --- | --- | --- | --- |
| `test:stardew-action-candidates` | the rejected units' predicate list emptied | `✖ 被拒单元都带可追溯的理由（谓词或 no_branch）` + `AssertionError: AddSpecialOrder@Event 必须有被拒谓词、no_branch 或提取错误` | `gateRedProofs` |
| `test:stardew-action-inventory-reconciliation` | completeness rule 3's missing-tier-B set emptied | `✖ 完备性②：B 档有单元没有裁定 → tier_b_unit_without_verdict` + `AssertionError: Missing expected exception.` | `gateRedProofs` |
| `test:stardew-action-seam-terminals` | `seam_not_terminal` folded into `seam_ok` | `✖ 审计覆盖全部「已注册但九谓词全拒」的 seam，每个都落到一个已知判据` | `gateRedProofs` |
| `test:stardew-branch-writeset` | `P4_terminalWrite` forced false | `✖ refill_watering_can：终态直写，产出候选分支` + `AssertionError: refill 应有且仅有一个候选分支` | `gateRedProofs` |
| `test:stardew-method-resolution` | the chain's depth cap narrowed 5 → 2 | `✖ the chain is bounded by depth and does not loop forever` + `AssertionError: third hop is within the bound` | `gateRedProofs` |
| `test:stardew-method-resolution-mutation` | the suite replaced by a no-op test | `STILL GREEN  M1 stop following the delegation chain` … `M5 revert to regex call extraction`, then `SOME MUTATIONS NOT CAUGHT` | `gateRedProofs` |
| `test:stardew-player-reachable-exits` | `STARDEW_ROUTING_LAYER_SHAPE` so no `Check*` router matches | `✖ 深度 1 的出口必须包含输入根的直接 gameplay 分派` + `AssertionError: pressActionButton → CheckPetAnimal（路由层真实入口，未进 register）` | `gateRedProofs` |
| `test:stardew-reachable-exits-reconciliation` | both shop-opener entries removed from `STARDEW_MENU_OPENERS` | `✖ R4：菜单绑定必须捕获无 Menu 后缀的开放器` | `gateRedProofs` |
| `test:stardew-rejected-layer-verdicts-mutation` | the unused-verdict case reduced to `assert.ok(true)` | `STILL GREEN  R4 drop the unused-verdict completeness check` + `SOME MUTATIONS NOT CAUGHT` | `gateRedProofs` |
| `test:stardew-remaining-actions` | tier C's branch writing tier B | `✖ 三档计数之和等于未匹配候选总数（总数来自 candidates 产物）` + `AssertionError: C_non_gameplay_writes 不应为空` | `gateRedProofs` |
| `test:stardew-tile-action-selectors` | the menu priority replaced by the dialogue/event priority | `✖ 连续 case 标签是别名：kitchen/Kitchen 共享同一 body` + `AssertionError: 别名共享 body：ActivateKitchen 是菜单开放器` | `gateRedProofs` |
| `test:stardew-uncovered-exit-expansion` | `INTERPRETER_SELECTOR_THRESHOLD` raised 8 → 800 | `✖ 解释器形态被识别（selector 数超阈值）` | `gateRedProofs` |
| `test:stardew-uncovered-exit-table` | the pipe escape removed from the cell writer | `✖ 表单元格里的反斜杠必须转义,不能与管道符转义互相干扰` | `gateRedProofs` |

The census moved from `with a red proof 308 · declared without 34` to `321 · 21` at the same `348` examined, and
`tools/gate-red-proof-baseline.json` lost exactly those thirteen entries (`git diff --stat`: `13 -----------`), deleted
by hand rather than by `--update` for the reason the last bullet of the previous section gives: a `--update` on this
worktree would also delete `test:tool-corpus`, whose entry is stale only because another lane's
`tools/run-tool-test-corpus.test.mjs` is untracked here and absent from a commit. Deleting it by hand keeps that row
recorded and keeps this unit's diff exactly its own thirteen.

### The one row this batch could not close, and the reason is the gate's shape

`audit:stardew-action-seam-terminals` remains owed. Its module prints an audit and **exits 0 on findings**; the only
`process.exit(1)` in it is the argument parser. A red proof would therefore have to redden the argument check, which is
not the rule the gate exists for — the third answer the ledger has used since the third batch. Making it exit non-zero
on its own findings is a change to `/integrations/stardew/**`, which this lane may not make.

`test:stardew-method-resolution-mutation` was closed with the bluntest honest injection available and the marker says
so: the suite has five mutations and each is defended by several cases at once, so removing one case at a time left the
runner green through two attempts (the presentation case deleted, then its assertions alone). Replacing the whole suite
with a no-op makes the runner name **all five** mutations as `STILL GREEN` and exit 1, which is the property the runner
exists for — it reports a survivor rather than passing over it. What that does **not** establish is that the suite
currently catches each of the five; the runner's own green did that before the injection, and this proof is about the
runner.
### Part two — the eighty-five unreached suites, triaged

The reachability lane wired sixty-eight suites and left eighty-five with their failure lines. Nobody had run them since.
Each was run three times from the live tree (`node --test <file>`, 90 s and then 150 s deadlines, with the whole output kept on the last pass), which is the
first time these lines existed as data rather than as a note:

| bucket | count | what the measurement says |
| --- | --- | --- |
| `real-and-now-fixed` | **4** | green on this tree — a lane fixed the product since: `tools/live-run/core/persona.test.mjs`, `tools/replay-stardew-navigation-multisource-characterization.test.mjs`, `tools/replay-stardew-navigation-operation.test.mjs`, `tools/run-game-operational-gate.test.mjs` |
| `stale` | **62** | one cause for sixty of them, measured below; two more assert a spelling that moved |
| `real-and-red` | **18** | own rule still fails after the family cause is removed — named below |
| `cannot-run` | **1** | `tools/prepare-tavern-live-fixture.test.mjs`: it bootstraps a live Tavern fixture through Host artifact envelopes and did not finish inside 150 s here |

`4 + 62 + 18 + 1 = 85`, and the bucket counts come from one experiment rather than from reading each failure.

#### The sixty have one cause, and it is a shared harness requirement the fakes never got

Sixty-two of the eighty-three that failed assert `blocked` against the `passed` a live result was supposed to read. The reason
behind `blocked` is not visible in most of their logs, so it was measured instead of inferred: the shared harness gained
`publishedActionWatchdogMs(client, action)`, which reads `client.state.catalogRegistrations` and throws
`native_catalog_registrations_missing` when the session's own advertisement carries none — that is the rule that closed
`test:stardew-branch-writeset`'s sibling defect earlier, and every fake client in these suites was written before it.

One edit to `tools/lib/stardew-native-smoke-harness-v1.mjs` **inside the copy** — `return 60_000` where it throws — was
applied and all eighty-three failing suites were run again: **sixty-two went green**, including two of the four
`real-and-now-fixed` members, which leaves sixty that this cause alone accounts for. The harness in the copy was restored
from its own commit afterwards. That is the family: one field (`state.catalogRegistrations`) absent from sixty
`createFake` bodies, and the repair is one line per suite — mechanical, sixty files wide, and deliberately **not** done
here: this lane's bounds are `tools/**` gate files (docblock markers only), `package.json` script lines, and the two
baselines this document cites. Naming the cause and proving it by experiment is the honest unit; editing sixty suites is
the next one, and it needs a lane whose bound covers them.

Two of the sixty-two are not the watchdog at all, and they are the task's `stale` shape rather than a product defect:
`tools/stardew-policy-isolation.test.mjs` asserts `result.EnabledActions`, a policy field the fixture writer retired, and
`tools/verify-stardew-action-projection.test.mjs` asserts the harness exports `assertExactCapabilities`, where it now
exports `assertRequiredCapabilities`. Both were red before the experiment and red after it, so the measurement cannot
tell them apart from the eighteen; the **repair** can — each is a renamed field or a removed helper, which is why they
are counted in the sixty-two and not in the eighteen.

#### The eighteen that are red on their own rule

Each names the assertion that fires, so nobody has to re-derive it:

| suite | the failure line |
| --- | --- |
| `tools/audit-stardew-nogame-subset.test.mjs` | `✖ the project compiles exactly the headless files that read no gitignored input`, `✖ no game-free file is left out of the no-game lane` |
| `tools/check-refusal-informativeness.test.mjs` | `✖ every reason family the tree emits is classified, and the verdict follows the findings` |
| `tools/check-stardew-snapshot-family-bounds.test.mjs` | `✖ every shipped snapshot family's producer ceiling is readable and within the Host's cap` |
| `tools/check-terminal-commit-single-entry.test.mjs` | `✖ the converted bus family reaches the ledger through the seam` — also the one file no reachable command names |
| `tools/derive-stardew-action-cancellation.test.mjs` | `✖ delegation is followed and inline slots are seen` |
| `tools/replay-stardew-navigation-read-only-gate.test.mjs` | the file itself fails to load |
| `tools/run-tavern-management-operation-evidence.test.mjs` | `✖ the producer exercises every operation the mounted profile declares` |
| `tools/run-tavern-narrative-gate.test.mjs` | `✖ Reference live runner stays on the composition bootstrap and authenticated Chat API and never opens SQLite or auto-promotes` |
| `tools/stardew-native-local-player-fixture.test.mjs` | `✖ a fixture whose mod has no config yet still prepares, and the config it writes is complete` |
| and nine `run-stardew-native-local-player-*-smoke.test.mjs` whose own assertion still fails with the watchdog supplied: `craft-partial-recovery-chain`, `enter-mine-ladder`, `navigation-mutation`, `place-crab-pot`, `place-crab-pot-fixture`, `place-wood-fence`, `stamina-recovery-chain`, `talk-to-npc`, `water-crop` | the shape `till-soil` shows is representative: `blocked` where `passed` was asserted |

#### What was wired, and the reading it moved

The four `real-and-now-fixed` suites are now named by commands the corpus reaches — `tools/live-run/core/persona.test.mjs`
in `suite:live-run-harness`, the two navigation replays in `suite:stardew-tooling`, and
`tools/run-game-operational-gate.test.mjs` in `suite:tools-utilities` — and `tools/spec-reachability-baseline.json` lost
exactly those four entries. Each was run green after the edit. One first attempt glued `persona.test.mjs` to the next
token in the script string, which the reachability gate caught immediately as a **new** unreached file
(`tools/live-run/dialogue-gates.test.mjs`): a `package.json` edit that silently removes a suite from its own command is
exactly the failure this gate exists for, and it named the casualty.

| reading | before | after |
| --- | --- | --- |
| `node tools/check-harness-conformance.mjs` census | `348 · 308 · 4 · 34 · 0 · 0` | `348 · 321 · 4 · 21 · 0 · 0` |
| the partition | `308 + 4 + 34 + 2 unreadable = 348` | `321 + 4 + 21 + 2 unreadable = 348` |
| `node tools/check-spec-reachability.mjs` | `tools_suites: 85 of 402 unreached · held 84` | `tools_suites: 81 of 402 unreached · held 80` |

Neither tool exits 0 before or after, and the reasons are other lanes' and are named rather than repaired:

- `red_proof_kind_unknown:check:code-duplication` and `red_proof_pointer_missing:test:format-ratchet` are the two
  unreadable claims the header has carried since the eighth batch. They are outside the `declared without` bucket, so
  they are outside this unit's queue; the files are gate files this lane could edit for markers only, and rewriting
  another gate's claim into a readable one without reproducing its red would be the silencer this mechanism exists to
  prevent.
- `gate_declaration_stale:test:tool-corpus` — the untracked `tools/run-tool-test-corpus.test.mjs` proves that gate in
  this worktree and is absent from the commit, so its baseline entry reads stale here and is needed at HEAD. Deleting it
  would trade one red for another the moment that file lands.
- `spec_reachability_unreached_suite:tools/check-terminal-commit-single-entry.test.mjs` — a tracked suite no command
  names, and it is `real-and-red`, so wiring it would turn the corpus red. It is the eighty-fifth file and the only one
  of the eighty-five that was never in the baseline.

## The tenth batch: the sixty fakes publish what a real session publishes, and the derivation is read from the catalog

The ninth batch proved by experiment that sixty of the unreached suites were blocked on one fact and left the fix
unmade. This batch made it, and the shape of the fix is the interesting part.

### The cause, restated as the thing that had to change

`publishedActionWatchdogMs` reads `client.state.catalogRegistrations`, and that is **correct**: the Mod publishes each
action's own `WatchdogMs` on `hello_ack`, `BridgeSession.IsFreshExecutionRequest` admits a deadline at most that number,
and the docblock records the defect it caught (`fish_here` publishes 60 s, a runner wrote 120 s, the first live slice
came back `bridge_rejected:invalid_deadline` thirteen seconds after a game launch). Sixty fake clients never published
it. So the throw stays, and the **fakes** moved.

### The first derivation was wrong, and the suites said so

The instruction was to derive the advertisement from "the actions that fake advertises". The first attempt read
`snapshot.capabilities`. That is a different fact: capabilities are the GRANTED subset, and a runner equips a tool
while performing an action the grant does not name. Measured: `break_rock`'s fixture grants
`[cancel_active_execution, inspect_self, move_to_tile, travel, break_rock]`, its runner dispatches `equip_tool`, and the
suite came back `native_action_watchdog_unpublished:equip_tool` — a refusal about the fake, not about the product.
Twelve suites failed that way.

What a real session publishes is its whole registration surface: `hello_ack` carries every action the Mod enforces, with
the window each declares, and the per-action grant is a separate fact. `publishedActionRegistrations()` is that, and the
fakes now call it.

### Where the numbers come from

`readStardewActionWatchdogs()` in `tools/lib/stardew-published-action-registry.mjs` — the module that already reads this
one file for action ids, families and lifecycles — parses `FarmhandActionDefinitions.cs` for:

- the catalog's three declared constants (`DefaultWatchdogMs`, `NavigationWatchdogMs`, `LifecycleWatchdogMs`);
- a row's own `WatchdogMs:` named argument (`navigate_to_destination`);
- a row whose descriptor is a factory whose `with { WatchdogMs = … }` block declares it (`sleep` through `Lifecycle()`);
- a read-only `R(...)` row, which is not dispatchable and therefore publishes **nothing**.

Measured on the real catalog: 103 enforced actions, `navigate_to_destination` and `sleep` at 600 000 ms,
`fish_here` and `till_soil` at 60 000 ms. Nothing is hand-listed and no constant is written in JavaScript.

### The two red proofs, and what they establish

Both ran in the copy at `E:/tmp/gateproof/b9`, never in the live worktree; each was restored from the copy's own commit
and re-run green, proved twice (`git status --porcelain -- <path>` empty and `git hash-object` equal to
`git rev-parse HEAD:<path>`).

| the injected violation | the line that fired | exit |
| --- | --- | --- |
| the derivation returns the default for every row instead of resolving the row's own window | `✖ the watchdog is each registration's own declared window, never one constant` + `✖ the real catalog publishes the window the live defect was measured against` + `✖ one action declaring two different windows is refused rather than last-wins` | 1 |
| `catalogRegistrationsFor` supplies `descriptor: { watchdogMs: 60_000 }` for an action the catalog declares no window for | `✖ an advertised action the catalog declares no window for is still refused by name` + `AssertionError … Expected values to be strictly deep-equal` | 1 |

The second is the one that matters most: it is the gate against the fix being satisfied by publishing junk. A read-only
action stays advertised and stays without a window, so `publishedActionWatchdogMs` refuses it by name — the
`native_action_watchdog_unpublished:<action>` path is still reachable through a fake.

### What the tree reads now

| reading | ninth batch | tenth batch |
| --- | --- | --- |
| `node tools/check-spec-reachability.mjs` | `tools_suites: 85 of 402 unreached · held 84` | `tools_suites: 21 of 402 unreached · held 20` |
| the sixty suites, one command | 60 red on `native_catalog_registrations_missing` | `node --test` over `suite:stardew-native-local-smoke`: 410 tests, 410 pass, 0 fail, exit 0 |
| `tools/gate-red-proof-baseline.json` | 24 entries | 23 entries (`--update`, which removed `test:tool-corpus` and nothing else) |

Sixty of the eighty-five are wired and green, plus the four the ninth batch wired: **64 of 85**. The twenty-one that
remain are named, and nineteen of them are the ones the ninth batch left:

- **seventeen `real-and-red`** — their own assertion still fails: `audit-stardew-nogame-subset`,
  `check-refusal-informativeness`, `check-stardew-snapshot-family-bounds`, `derive-stardew-action-cancellation`,
  `replay-stardew-navigation-read-only-gate`, `run-tavern-management-operation-evidence`,
  `run-tavern-narrative-gate`, `stardew-native-local-player-fixture`, and the nine smoke suites whose second assertion
  survives a supplied watchdog (`craft-partial-recovery-chain`, `enter-mine-ladder`, `navigation-mutation`,
  `place-crab-pot`, `place-crab-pot-fixture`, `place-wood-fence`, `stamina-recovery-chain`, `talk-to-npc`,
  `water-crop`) — plus `tools/check-terminal-commit-single-entry.test.mjs`, which no command has ever named;
- **two `stale` by spelling** — `stardew-policy-isolation` asserts `result.EnabledActions`, a policy field the fixture
  writer retired, and `verify-stardew-action-projection` asserts a runner imports `assertExactCapabilities` where the
  reader now sees `assertRequiredCapabilities`. Neither is the watchdog, and neither is repaired here;
- **one `cannot-run`** — `prepare-tavern-live-fixture` bootstraps a live Tavern fixture through Host artifact envelopes
  and does not finish offline.

### Two things this batch did not do, and one it could not control

- The `test:tool-corpus` entry left the baseline through `tools/audit-gate-red-proofs.mjs --update`, which rewrote the
  file from its own reading and removed exactly that one entry. **What that costs:** the gate is proven in this worktree
  by `tools/run-tool-test-corpus.test.mjs`, which is still untracked. At a commit without that file the gate is
  unproven, so the deletion is correct only once that suite lands; the census reads `declared without 21` and not the
  20 the request expected, because `--update` recorded the 23 remaining gaps and `held` excludes the two unreadable
  claims — `23 − 2 = 21`.
- The suites were converted in one sweep because the conversion was uniform once the derivation was right
  (`publishedActionRegistrations()` needs nothing from the file it lands in). The sweep still needed three hand edits
  for fakes whose state is a local (`crop-runner-harness`, `body-owner-hold`, `pickup-forage`), two import merges, and
  one first attempt that was wrong for a reason worth keeping: a first version read `snapshot.capabilities` and broke
  twelve suites, which is the measurement quoted above.
- **`package.json`'s new `suite:stardew-native-local-smoke` line landed inside another lane's commit** (`35c6fb0b`,
  "a crash report inside the tree, or holding a credential, fails the ladder"), not in this batch's. The wiring is in
  HEAD and the reachability reading above depends on it, but its attribution is wrong and a whole-tree commit is how
  that happened. Nothing is repaired by rewriting history; it is recorded so the next reader of that commit's diff is
  not surprised by sixty suite names it does not explain.

## The eleventh batch: the two `dotnet test` gates, and a reader that could not see a project runner

Two of the twenty-one owed rows are gates whose whole rule is one command. `test:stardew:core` is
`dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests` and `test:stardew:integration` is the same
command over `GameBuddy.Stardew.Integration.Tests`, so the only input that makes either exit non-zero is a **C# xunit
fact that fails**. No JavaScript file can redden them, which is why the ninth batch's mechanism (a `package.json`
`gateRedProofs` marker pointing at a suite) needed one more piece this batch supplied: a falsifier written in C#.

### The triage of the twenty-one

| class | count | members |
| --- | --- | --- |
| `csharp-falsifiable` | **2** | `test:stardew:core`, `test:stardew:integration` — **closed here** |
| `needs-history` | **0** | none: every remaining row has a live violation to inject, or cannot fire at all |
| `cannot-fire` | **10** | `audit:stardew-action-seam-terminals` (it prints its findings and exits 0; the only `process.exit(1)` is the argument parser, and the module is `integrations/stardew/action-development/src/**`), `check:live-run-isolation` (a machine preflight — it exits 1 from an absent profile root, and red-for-absence is not red-for-a-rule), `check:publint` (it `spawnSync`s `bun`, which this checkout does not have: the vendor `bun.ps1` is a shim Node does not resolve, so the run reads no publint message and prints a false pass), `check:sandbox-acceptance` (needs `GameBuddy.Setup.exe` and stages its share on a real account), `test:voice-protocol` (runs inside the `vendor/pi-koe` submodule), `test:stardew-soil-itm-canary` (all five cases skip where `.tmp-stardew-decompile/` is absent), `check:host-module-graph` and `check:dialogue-web-boundaries` (the rule lives in a root `.dependency-cruiser.*.cjs`), `tools/check-stardew-actor-admissibility.mjs` and `tools/check-stardew-hold-sufficiency.mjs` (the contract they read has never existed, and the missing half is a Mod-owner verdict over the 17 orphan holds the eighth batch counted) |
| `reads-the-wrong-thing` | **2** | `check:architecture` (three of the five things its name covers are an `echo`), `test:stardew-native-local-runner-fixture-contract` (asserts a hand-built replica of the fixture's policy block rather than the writer) |
| red at HEAD, so no green baseline to redden | **6** | `check:stardew-native-multiplayer-sensitivity` and `test:stardew-native-multiplayer-sensitivity` (`mp_sensitivity_classification_drift` on `use_mine_ladder`, measured at exit 2 and exit 1 again this batch), `test:gameplay-capability-catalog` (`Published registry actions missing covered catalog rows: fish_here.`), `test:frontend-turn-gate` (expects `sendUnavailable`, the product spells `sendRefused(uiState.send)`), `test:sandbox-configs` (`FAIL gamebuddy-sandbox.wsb: not valid XML`), `test:stardew-fixture-scenario-wiring` (`✖ the real config gate accepts navigation_read_only_v1`) |
| provable, but not by a C# test | **1** | `test:dialogue-web-boundaries` — **measured green this batch** (4 pass, 0 fail), so it leaves the red-at-HEAD set; its falsifier is a file matching no zone in `dialogue-web/src/**`, which this lane may not write |

`2 + 0 + 10 + 2 + 6 + 1 = 21`. The last two classes are not new reasons: they are the ledger's recorded ones,
re-measured in this checkout rather than restated from the table above — and one of them has changed since it was
written, which is why `test:dialogue-web-boundaries` is named with its measurement instead of its old disposition.

### The falsifier: a project derived from the real one, never a copy of what it produces

`integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SuiteRedProofTests.cs` holds one fact per gate. Each
reads the real `.csproj`, resolves its relative includes, adds one `Compile` glob over the real project's own source
directory, and writes the derived project file into a temporary directory beside two injected facts:

| the injected fact | why it is there |
| --- | --- |
| `InjectedFacts.AnInjectedFailingFact` | the violation: the thing the gate must report as a failed run |
| `InjectedFacts.AnInjectedPassingFact` | the control: a configuration that reported *every* fact as failed would satisfy the exit code and the fact's name and not the summary line |

Then it runs the gate's own command shape — `dotnet test <derived project> --filter FullyQualifiedName~<probe>` — with
`DOTNET_CLI_UI_LANGUAGE=en` and `VSLANG=1033`, because the assertion is on the runner's summary line and this machine's
runner prints Chinese without them, and asserts three things: a non-zero exit, the runner naming the failing fact, and
the summary reading `Failed: 1, Passed: 1`.

Nothing about the project is written by hand: the target framework, packages, analyzer and warning policy, the
`ProjectReference` elements and every compiled source come from the real file and the real directory, so a file added
to the suite, a reference added to its csproj, or a project that stops being a test project is inside the probe the day
it lands. The failing fact lives in the temporary directory and the repository stays green, which is the same rule the
seventh batch followed for `test:stardew:all` when it planted a fact in `GameBuddy.Stardew.Core.Tests` inside a copy.

Each of the three assertions was seen red once, by injecting the defect it exists to catch into the copy at
`E:/tmp/gateproof/b10` (the repository was never the injection site; the copy's own file was restored from `.orig`
after each run):

| injection | the line that fired |
| --- | --- |
| the failing fact made to pass | `Did not expect result.ExitCode to be 0 because the gate is \`dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests\`, so a failing fact in it must exit non-zero` |
| the failing fact renamed | `Expected result.Output … to contain "Failed GameBuddy.Stardew.SuiteRedProofProbe.InjectedFacts.AnInjectedFailingFact" because the runner must name the fact it reported as failed` |
| the control fact made to fail too | `Expected result.Output to match regex "Failed!\s+-\s+Failed:\s+1,\s+Passed:\s+1,"` with `Failed: 2, Passed: 0` in the runner's output |

**What the proof establishes:** the gate's runner reports a failing fact as a failure, names it, and exits non-zero,
in the project the gate actually runs. **What it does not:** that the real suite's facts pass — that is the gate's own
green reading and the run that contains this falsifier, and asserting it here would turn one failing fact anywhere in
the suite into a red falsifier that names only the injected one. It also does not establish that a fact whose body was
deleted is still discovered; only that a discovered fact that fails is reported and fails the gate.

### The counts, measured before and after

| project | reading |
| --- | --- |
| `GameBuddy.Stardew.Core.Tests` | 873 passed, 0 failed, 0 skipped (`dotnet test`, this checkout) |
| `GameBuddy.Stardew.Integration.Tests`, before this batch's file | 2764 passed, **5 failed**, 2 skipped of 2771 — the five were another lane's uncommitted hold work (`NavigationHoldEvidenceTests.AWarpHoldSaysToWaitForTheWindowRatherThanToRetry` and four more, in `WorldModel.cs`, `StardewBodyController.cs` and that lane's own test files) |
| `GameBuddy.Stardew.Integration.Tests`, after it | **2771 passed, 0 failed, 2 skipped** of 2773 (`SuiteRedProofTests` is the two new facts; the other side of the delta — 2764 → 2771 — is the other lane landing its work) |
| `SuiteRedProofTests` alone | 2 passed, 0 failed — 28 s warm in the worktree, 15 s in the copy |

The gate was green in this checkout both times it was measured with the new facts, so no claim here rests on a copy:
the `E:/tmp/gateproof/b10` tree was used for the injections, not for the baseline.

### The reader that could not see a project runner, repaired

`tools/audit-gate-red-proofs.mjs` asked "does anything run this pointer" with `runnerText.includes(pointer)`, which is
true only when a command names the **file**. `dotnet test <project directory>` names a directory and compiles every
`.cs` beneath it, so both new markers read as `proven_but_nothing_runs` — a warning about the proof that was really
about the reader. The derivation now also accepts a C# pointer beneath a project directory a `dotnet test`/`dotnet
build` command names, and it is deliberately limited to that runner: a tool that merely parses a tree
(`depcruise … tools`) is not what the claim "nothing runs this" is about, and the narrower rule moves exactly two
existing rows, both of which are compiled by `dotnet build integrations/stardew/GameBuddy.Stardew.csproj`.

| reading | before | after |
| --- | --- | --- |
| `proven_but_nothing_runs` rows | 32 | 30 |
| the two that left | — | `audit:stardew-scene-kind-projection:integrations/stardew/navigation/scenecontracts.cs`, `check:terminal-idle-publication:integrations/stardew/farmhandexecutioncontroller.cs` |
| `test:stardew:core`, `test:stardew:integration` | `proven_but_nothing_runs` for the falsifier's own file | absent from that list, which is the reading the markers claim |

The suite case is `a proof's pointer is executed when a runner names the file or the project directory it sits in`, in
`tools/audit-gate-red-proofs.test.mjs`, and it was seen red on the old reader before the fix was kept:

```
✖ a proof's pointer is executed when a runner names the file or the project directory it sits in
  + [{ gate: 'check:a', pointer: 'integrations/stardew/tests/Project/InjectedTests.cs' }]
  - []
```

### The census

| reading | before | after |
| --- | --- | --- |
| `node tools/check-harness-conformance.mjs` | `351 · 324 · 4 · 21 · 0 · 0` | `351 · 326 · 4 · 19 · 0 · 0`, `gate_falsifiers: passed` |
| `node tools/audit-gate-red-proofs.mjs --gaps` | 23 gaps (21 recorded + 2 unreadable) | 21 gaps (19 recorded + 2 unreadable) |
| `tools/gate-red-proof-baseline.json` | 23 entries | 21 entries — exactly `test:stardew:core` and `test:stardew:integration` removed |

`326 + 4 + 19 = 349`, plus the two unreadable claims the header still names (`check:code-duplication`'s malformed
marker and `test:format-ratchet`'s pointer to a planted file that is not on disk), is the 351 examined. Both remain
owed and neither is this batch's: they are gate files another lane owns, and rewriting a claim into a readable one
without reproducing its red would be the silencer this ledger exists to prevent.

## The twelfth batch: two gates that printed a pass having measured nothing

Two rows of this ledger were never "no red proof yet". They were gates that reported a pass while reading nothing —
`publint exited null but every failure maps to a known vendor baseline gap; non-blocking here` at exit 0, and five
skipped cases at exit 0 — which is the defect family the ninth and eleventh batches spent their time deleting, and
blocked-with-a-reason is the honest state for both. Neither gate is deleted: `check:publint` has no substitute (it
checks the published shape of the vendored package) and the canary protects an ITM contract.

| gate | the reading, measured before | the reading, after |
| --- | --- | --- |
| `check:publint` | `publint exited null but every failure maps to a known vendor baseline gap; non-blocking here`, **exit 0** | `publint_not_measured:executable_unresolvable:bun - no file this process can spawn; found …\bun.cmd (a batch shim, which Node refuses to spawn with \`shell: false\`), …\bun.ps1 (a PowerShell shim, not an executable image), …\bun (an extensionless shell-script shim, not a Win32 executable image)`, **exit 2** |
| `test:stardew-soil-itm-canary` | `tests 5 · pass 0 · skipped 5`, **exit 0** | `soil_itm_canary_not_measured:decompile_root_absent:E:\projects\ai-game-companion\.tmp-stardew-decompile` plus the six absent witnesses, **exit 2** |

### The canary: the runner decides, because the suite cannot

`test:stardew-soil-itm-canary` is now `node tools/stardew-soil-itm-canary-gate.mjs`. Two facts shape it: `node --test`
exits 0 when every case skips, and it also collapses a child's own status to 1, so the blocked verdict cannot be
published from inside the suite file. The runner asks `missingSoilItmWitnesses()` before any case is registered, prints
`soil_itm_canary_not_measured:decompile_root_absent:<root>` with the witness paths under it, and exits 2. The root, the
marker and the witness list live once, in `tools/lib/stardew-soil-itm-canary.mjs`, and
`tools/derive-stardew-soil-itm-canary.mjs` now reads the same list instead of carrying its own copy.

`--allow-absent-decompile-root` runs the five skips on purpose and says so first
(`soil_itm_canary_not_measured:decompile_root_absent_allowed:<root>`); the default is the blocked verdict. Running the
suite file directly bypasses the runner, so the file fails there with the same marker instead of reporting five skips —
the bypass is closed rather than documented.

| | measured on a tree without `.tmp-stardew-decompile/` |
| --- | --- |
| HEAD's suite, `node --test tools/stardew-soil-itm-canary.test.mjs` | `tests 5 · pass 0 · skipped 5`, exit 0 |
| this batch, `node tools/stardew-soil-itm-canary-gate.mjs` | the marker above, exit 2 |
| this batch, the suite file run directly | the marker on stderr, exit 1 |
| this batch, `--allow-absent-decompile-root` | `tests 6 · pass 1 · skipped 5`, exit 0 — the five skips plus the runner's own contract case |

The red proof is the second row: the runner was seen red on an injected pre-fix shape (returning `status: "run"` when
`missing.length > 0`), where `tools/stardew-soil-itm-canary-gate.test.mjs` reported three failures —
`'run' !== 'not_measured'`, the flag case, and the end-to-end case that spawns the runner and receives exit 0 over five
skips. The document does not carry a `red-proof:` marker for that, and neither gate is claimed `proven` here: both ids
still sit in `tools/gate-red-proof-baseline.json`, and deleting an entry from that file is outside this lane's edit set.
The two-line change that closes the pair when its owner takes it: prefix the "Measured red (…)" lines in
`tools/check-publint.test.mjs` and `tools/stardew-soil-itm-canary-gate.test.mjs` with `red-proof: `, and delete
`check:publint` and `test:stardew-soil-itm-canary` from that baseline.

### The other all-skip suites this batch found, and did not repair

The shape is not unique to the canary — two more suites can report green having measured nothing, and both are measured
on this machine only because its prerequisites happen to exist:

| suite | the prerequisite it skips on | measured here | the all-skip reading |
| --- | --- | --- | --- |
| `check:stardew-loop-closure` (`tools/check-stardew-loop-closure.test.mjs`) | `resolveStardewDecompileRoot()` — the whole suite wraps it in a try/catch | 8 pass, exit 0 | `GAMEBUDDY_STARDEW_DECOMPILE_ROOT=.tmp/empty-decompile` → `tests 8 · pass 0 · skipped 8`, **exit 0** |
| `test:gameplay-capability-catalog` (`tools/check-gameplay-capability-catalog.test.mjs`) | `design/gameplay-capability-catalog.json`, which the unversioned `design/` mount carries | 6 pass, exit 0 | not reproducible here without unmounting `design/`; the skip reason is the same `existsSync` guard |

Neither is a one-liner: each needs the same runner-or-guard shape as the canary, its rule belongs to another lane's
gate, and the canary's own guard is the pattern to copy.


### `check:publint`: three facts before a verdict

`spawnSync("bun", ["x", "publint", "--strict"], { shell: false })` starts no file on a machine whose `bun` is npm's
shim: Win32 needs an executable image, Node applies no `PATHEXT` without a shell, and it refuses a `.cmd` outright. The
child never ran, `status` was `null`, the message list was empty, and the gate read that emptiness as "every failure
maps to a known vendor baseline gap". Three facts are now required before any verdict is printed:

1. the runner resolves to a file this process can spawn — the whole PATH is searched, so a shim in one directory cannot
   hide a real `bun.exe` in the next, and each refused shim is named with why it cannot be started;
2. it answers `<runner> --version`;
3. the run's own output carries publint's `Running publint v<semver>` line.

Any of the three missing is `publint_not_measured:<reason>:<what was found>`, exit 2 — not a failure, because no rule
was evaluated. A run that started, spoke as publint and reported problems is `failed` with publint's own status. The
vendor-gap tolerance survives but now needs parsed messages (`messages.length > 0 && blocked.length === 0 &&
activeGaps.length > 0`), so an unexplained non-zero exit is red whether or not a gap happens to be active.

The message shapes are publint 0.3.25's real ones, measured here rather than assumed: `publint run --help` lists
`--level`, `--pack`, `--strict` and `--version` and **no JSON reporter**, and a real run prints
`Running publint v0.3.25 for @cortexkit/pi-magic-context...`, `Packing files with bun pack...`, `Linting...` and then
either a message list or nothing. That is why the parse accepts a per-line object or one array, and why the identity
line, not a parsed message, is what proves publint itself spoke: on this package's current shape publint exits 0 with
one suggestion and no machine-readable code at all.

The red proof is the pre-fix tolerance branch, injected into a copy of the gate under `.tmp/red/` and driven by the real
falsifier: `tools/check-publint.test.mjs` reported `an unexplained non-zero exit is a failure, not a tolerated gap` →
`AssertionError: no parsed message means no gap could be matched, 'passed' !== 'failed'`. The second reading is the
history one: at HEAD this gate printed the false pass above at exit 0, and on the same machine it now prints the
`executable_unresolvable` marker at exit 2.

### The census

| reading | before this batch | after |
| --- | --- | --- |
| `node tools/check-harness-conformance.mjs` | exit 0 (measured as this batch's first reading); the population line the eleventh batch recorded, `gates examined 351 · with a red proof 326 · external 4 · declared without 19 · undeclared 0 · zero-population-pass 0` | exit 0, `gates examined 351 · with a red proof 326 · external 4 · declared without 19 · undeclared 0 · zero-population-pass 0` — the same numbers, now measured rather than inherited |
| `gate_falsifiers` verdict | `passed` | `passed` |
| the intermediate reading, with the canary's runner not yet in the index | `350 · 326 · 4 · 18 · 0 · 0 · untracked_not_counted 1: tools/stardew-soil-itm-canary-gate.mjs` and `gate_declaration_stale: test:stardew-soil-itm-canary` | gone once the file was staged — the population is the index, so a gate file no commit carries is inert and named, never silently counted |

`326 + 4 + 19 = 349`, plus the two unreadable claims the header still names (`check:code-duplication`'s malformed
marker and `test:format-ratchet`'s pointer to a planted file) is the 351 examined. Neither gate of this batch moves a
census number — both stay in the recorded bucket for the reason given above — so the line this batch measured is the line
the previous one recorded, which is the point: what changed is two gates going from *green having measured nothing* to
*blocked with a reason*, and no column of this census counts that.

### What this batch did not do: the class gate

The task this lane was given also asked for one gate over `tools/**` and `package.json` that flags a test script able to
report green with `skip ≡ pass`. It is not here, and the reason is measurable rather than aesthetic: the population is
derivable (every `test:` script, from `package.json`, exactly as `tools/lib/gate-population.mjs` derives it), but the
property is not. "This suite can go green with every case skipped" is a fact about a run, and the only static evidence
is the presence of a `skip:` option — a string test, which is the form the request excluded. Of the three all-skip
members this batch found, two are green here and skip elsewhere, so a string gate would flag them without telling a
guarded suite (the canary now) from an unguarded one (its old shape). The detection that does work is the one applied
to each member: run it where its prerequisite is absent and read the exit code.

## The thirteenth batch: the actor-admissibility contract written from the fact union, and two gates that finally run

For weeks `tools/check-stardew-actor-admissibility.mjs` and `tools/check-stardew-hold-sufficiency.mjs` printed `blocked`
with `examined: 0`, because `integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json`
had never existed. An earlier lane refused to write it, and was right to: deriving the contract from the code the gate
then checks makes every invariant true by construction. What changed is not the objection but the subject. The six holds
the boundary card had to name by reading call paths now **exist in `ActorWorldFacts`** (`SelfAnimation`, `Warping`,
`DayTransition`, `ScreenFade`, `ControlsFrozen`, `Minigame`), so the contract can be read out of the fact union and the
Mod's own classifier, and the gates are left checking two things the contract cannot make true: the engine sites that
hold the body, and the engine lines that release it.

### The shape: population from code, judgement authored, both re-checked

`tools/derive-stardew-actor-admissibility.mjs` (new, `pnpm derive:stardew-actor-admissibility`) derives, and derives
only:

| what | from |
| --- | --- |
| the fact population | the parameter list of `ActorWorldFacts`, in declaration order |
| each fact's engine read | the argument `ReadFacts` passes for that parameter (positionally; both `new ActorWorldFacts(...)` calls must agree on arity or derivation fails) |
| each fact's kind / wire / reason code / transient kind | the `Classify` branch that tests it (through `HasMountedModal` where the branch names a helper) crossed with `KindForWire` and `HoldReasonCode` |
| each read's holding predicate (`holdsWhen`) | the comparison `Classify` applies to the fact, the comparison `ReadFacts` reads the member with, and the member's declared TYPE |
| precedence | the order of the returns in `Classify` |

Everything a reader might disagree with is authored in that file and re-checked by the gates: the release of each fact
(clears-read anchor + body-release anchor or a stated mechanism), the 16 residual rows, the 4 unattributable sites, and
the decision-site adjudication. A second run is byte-identical (`regenerated: byte-identical to the previous run`); the
run that produced the committed file was printed as `CHANGED` and the one after it as identical.

Resulting structure, printed by the generator: **facts 15 · release paths 16 · named unknowns 1**, over a residual of
16 rows (15 `named_by_fact`, 1 `named_unknown`), 4 unattributed sites, 16 declared reads.

### What the contract does not claim, and why that is written down instead of dropped

The gate header it replaces declared INV-1 totality, INV-3 liveness and INV-4 acyclicity over an **action** algebra:
which of the catalog's 103 actions is admissible in which disposition, and which remedy restores it. That half is not
in this contract. `admissibleIn` for one action is decided by `ExecutionAdmission.Admit`'s own ladder over the action's
`AdmissionProfile` and its event path (`ExecutionAdmission.cs:368-499`), and a generator that re-encoded that ladder
would be a second authority for a fact the Mod already owns - the duplicate-authority defect this repository has paid
for repeatedly. So the gate claims the algebra the contract does own (the fact algebra), and its header says what it no
longer claims rather than leaving three checks silently empty.

### The two rule changes the real data forced

**1. Accompaniment is directional.** The search accepted ANY write to a companion member, so a write that **clears** a
fact counted as evidence for a hold that fact exists to name - the check computing the opposite of its own docstring.
Measured, three companion sets against the same 948 files and 58 held sites:

| companion set | accompanied | orphans |
| --- | --- | --- |
| the 9 reads the disposition had before this lane | 41 | 17 |
| those plus the 7 reads the six new facts added, no direction | 46 | 12 |
| with each read's `holdsWhen` predicate evaluated | **42** | **16** |

Five sites were rescued by the wider set and four of those rescues are clearing writes: `PauseForSingleAnimation = false`
(Farmer.cs:8448, and Farmer.cs:9315 through `EndEmoteAnimation`), `globalFade = false` (ScreenFade.cs:88, and
BusStop.cs:316 through `busLeftToDesert`). Only `Desert.cs:117` (`Game1.freezeControls = true`) is a real establishment.
Those four rows are now adjudicated in the contract instead of passed over.

**2. A release is asserted, not assumed.** Both gates counted ENTRY sites only, so a hold whose release was deleted or
moved kept every gate green - and "the engine can no longer leave this hold" is exactly what the residual exists to
adjudicate. Every fact (16 anchors) and every residual row (16 anchors) now pins the engine line **by content**: the
gate re-reads it, requires the row's pinned statement to still be that line, and - for a fact release - requires the
write to be a literal in the CLEARING direction (`_isWarping = false`, `globalFade = false`, `freezePause = 0`), so a
release rewritten to raise its own fact is red.

### The readings, from the same commands in the same checkout

```
before  node tools/check-stardew-hold-sufficiency.mjs
        blocked: .../actor-admissibility.v1.json absent, so this was not measured
        {"gate":"stardew_hold_sufficiency/v1","status":"blocked","examined":0,...}    exit 2
after   scanned files: 948 · writes of Farmer.canMove=false: 58 · ACCOMPANIED 42 · ORPHANS 16 · unparsed 4
        {"gate":"stardew_hold_sufficiency/v1","status":"passed","examined":62,...}    exit 0

before  node tools/check-stardew-actor-admissibility.mjs
        blocked: .../actor-admissibility.v1.json absent, so this was not measured
        {"gate":"stardew_actor_admissibility/v1","status":"blocked","examined":0,...}  exit 2
after   FACT-1 15/15 · FACT-2 15 · FACT-3 4 kinds · IFACE-1 16 reads · FACT-4 27 anchors · IFACE-2 948/58/42/16/4
        DECISION-1 5 sites in 4 files · DECISION-2 180256 lines · DECISION-3 3 owed
        {"gate":"stardew_actor_admissibility/v1","status":"passed","examined":15,...}   exit 0
```

### The four red proofs

The contract was copied to `%TEMP%\actor-admissibility-red` (`AGENTS.md` copied; `ref/` and `host/` junctions to the
real trees; the needed `integrations/stardew` files copied), and every case mutated **that** copy, ran the real gate with
the fixture as cwd, and restored the copy afterwards (`node .tmp/red-proof-actor-admissibility.mjs`). The committed
contract was never touched to watch a gate fail.

| the injected lie | the gate's own line | exit |
| --- | --- | --- |
| a residual row points its release at an engine line that writes no release (`FarmerSprite.cs:783`, the declaration line) | `release_pins: .../Crop.cs:541: release anchor .../FarmerSprite.cs:783 now reads "private void doneWithAnimation()", the row pinned "owner.CanMove = true;"` | 1 |
| a residual row cites a release line that is not in the engine tree (`FarmerSprite.cs:9999`) | `release_pins: .../Crop.cs:541: release anchor .../FarmerSprite.cs:9999 does not resolve` | 1 |
| a fact of `ActorWorldFacts` has no row (`SelfAnimation` deleted) | `FAIL FACT-1 population 15 ActorWorldFacts member(s), 14 declared` + `- UNDECLARED fact: SelfAnimation` | 1 |
| a fact's body release moved to a line that writes something else (`Game1.cs:6270`) | `FAIL FACT-4 release 27 release anchor(s) still write what their row says` + `- Warping: body release .../Game1.cs:6270 now reads "player.faceDirection(facingDirectionAfterWarp);", the contract pinned "player.forceCanMove();"` | 1 |

### The census

```
gates examined 351 · with a red proof 326 · external 4 · declared without 19 · undeclared 0 · zero-population-pass 0
judged here 118 (with a self-report 37 · declared without a report 81) · excluded 233 (233 proven, external or recorded)
gate_falsifiers: passed
```

`326 + 4 + 19 = 349`, plus the two unreadable claims the header names (`check:code-duplication`, `test:format-ratchet`),
is the 351 examined - unchanged, because no gate entered or left the population. What moved is the third reading: the
`reported not measured N (...)` line is **gone**, because both stardew gates now print a report whose `examined` is 62
and 15 instead of `0` with a stated reason. They remain *recorded* in `tools/gate-red-proof-baseline.json`, i.e. owed in
the ledger rather than proven: adding a `red-proof:` marker to either would make that file's entry stale, and the
baseline is another lane's file (`--update` is its own commit), so this lane left the ledger's arithmetic alone
deliberately.

### What a reader can now act on

- **One named unknown.** `ParrotUpgradePerch.cs:797` is a real hold nothing in `ActorWorldFacts` can name: the release
  lives in a per-location `NetMutex` (`RequestLock` defers both callbacks, `NetMutex.cs:44-59`, and runs them from
  `Update`, `:83-90`). The row carries the reason and what would settle it (a 30 s live probe on the perch logging
  `IsLocked()` per tick, or a `NetMutex`-scoped fact another lane would have to add).
- **Three second spellings the tree still carries**, printed by every run of the admissibility gate and declared with an
  owner and a closing condition: `farmhandexecutioncontroller.cookingactions.cs:178` and
  `farmhandexecutioncontroller.modalactions.cs:546` answer a non-hold refusal with `player_not_actionable`, and
  `StardewBodyController.cs:1127` answers a movement lock with it from `!localPlayer.CanMove` instead of
  `WorldModel.DescribeNavigationHold`. Closing them is a Mod change and is not in this lane.
- **Four sites the analysis cannot attribute at all** are named with the tool's own bound (`enclosingMethod` loses the
  `switch` arm at `GameLocation.cs:9287/9297/9321/9345`) and re-checked bidirectionally, so the list can neither grow nor
  quietly empty itself.

### Three statements this lane could not correct

- `tools/check-prelive-gate-registry.mjs:564-570` and `:621-627` still say "measured red at HEAD - ENOENT on
  ...actor-admissibility.v1.json, an input nothing in this tree produces". Both statements are now false: the file
  exists, `pnpm derive:stardew-actor-admissibility` produces it, and both gates exit 0. The registry is outside this
  lane's pathspec.
- `tools/lib/harness-conformance.mjs:500-507` carries the same sentence in the comment above the
  `GATES_WITH_FALSIFIER` entries; the run it describes (`blocked`, `examined: 0`, `not_measured`) no longer happens.
- `tools/gate-red-proof-baseline.json` still records both gates as owing a red proof, which is correct for the ledger
  and will stay correct until a lane that owns that file writes the markers and runs `--update`.

## The thirteenth batch: a gate over the registry of gates, for the check that measured nothing

Four false readings in one month, all one shape: a check exits 0 having read nothing, and its exit status is the only
thing downstream reads.

| gate | what it reported | what it had read |
| --- | --- | --- |
| `check:publint` | `publint exited null but every failure maps to a known vendor baseline gap; non-blocking here`, exit 0 | nothing: `spawnSync("bun", …)` with `shell: false` starts no file where `bun` is an npm shim, so the message list was empty and the tolerance branch read that emptiness as a pass |
| `test:stardew-soil-itm-canary` | a passing suite | `tests 5 · pass 0 · skipped 5`, exit 0 - `node --test` does not fail an all-skip run |
| `check:cross-language-wire-parity` | `passed` over `fields examined 178` | 31 of 37 frames paired; the six it could not pair were named in prose BELOW the verdict |
| `check:stardew-native-multiplayer-sensitivity` | green | a register marked generated, 96 of 106 actions, refused by its own producer |

Each was fixed on its own (`b00e40a4`, `9918a084`, `2738fa62`). Nothing asked the question of the NEXT gate, so this
batch built the check that does: `tools/check-gate-populations.mjs`, wired as a prelude L0 rung, with
`check:gate-populations` / `test:gate-populations` in `package.json`.

### The reading at this commit

```
gates examined 346 · with a population line 288 · without 57 · unreadable 1
findings 57 · without_population 45 · skip_can_pass 12 · pairs_a_subset 0 (causes are not disjoint: a gate can be silent for two reasons)
outside 13 (no source file to read; counted apart from the partition, named with the command)
population: the index, which does not carry 0 gate file(s) yet
self: with a population line - check:gate-populations is a member of the population and is classified by the same call, not by an exemption
```

`288 + 57 + 1 = 346`: every member of the derived population lands in exactly one bucket, and the causes line splits
the 57. The `outside` half is the population's other members - `pnpm knip`, `dotnet test`, a PowerShell transcript, the
aggregates whose command is another script - and it is printed with the command rather than dropped, because a gate whose
reading cannot be taken is not a gate that passed. The 57 are not all this batch's: `test:action-surface-parity` landed in
another lane's commit between this lane's readings and is recorded here, because the baseline is the TREE's measured debt.

**Reconciliation with the other gate-meta tools.** The population is `tools/lib/gate-population.mjs` - the ONE derivation
(every `package.json` script in the `audit:`/`check:`/`test:` namespace, plus every `tools/check-*.mjs` file no script
names) - restricted to what the INDEX carries, which is `tools/lib/indexed-sources.mjs`'s rule and the reason this gate's
baseline cannot be moved by a file another lane has not staged. The arithmetic, measured in one run rather than reasoned
about: `357` indexed members, `13` of them naming no source file (the `outside` line), plus the `2` ladder suites
`deriveGatePopulation` does not name at all
(`integrations/stardew/action-development/tests/action-{source-projection,projection-parity}-drift.test.mjs`), which is
`357 − 13 + 2 = 346` examined - and `346 + 13 = 359` is that tool's own total on this tree. `node
tools/audit-gate-red-proofs.mjs` reads `gates examined 357 · with a red proof 333 · external 4 · declared without 18 ·
undeclared 0` with this batch, and names both of its gates proven (`check:gate-populations` kind=history at
`tools/check-gate-populations.mjs:77`, `test:gate-populations` kind=inject at `tools/check-gate-populations.test.mjs:14`).
`node tools/check-harness-conformance.mjs` prints the same census from the same reading, and its partition is exact as a
four-term sum: `proven 333 + external 4 + owed 20 + 0 undeclared = 357`, where the 20 owed are the 18 recorded rows plus
the two unreadable claims (`check:code-duplication`, `test:format-ratchet`) that no bucket of that line can hold. Its one
remaining `unlisted` member is `check:generated-artifact-reproducibility` - another lane's gate, whose declaration its owner
has not written - which this lane neither declares nor silences; `check-harness-conformance` therefore still exits 1 on a
gate this batch does not own. This batch moved that census by exactly two, both proven by the markers above.

### The three red proofs, and how each copy was made

Every proof is a copy of the tree OUTSIDE the repository: `git archive HEAD package.json tools` extracted to
`E:/tmp/gatepop/<name>`, then one member restored to the shape that shipped. The live worktree was never the injection
site. Each copy carries `package.json` and `tools/` only, which is why each reads `unreadable 22` - entries whose command
names a `host/` or `integrations/` source are BLOCKED and named, never counted as passes - and `339 examined` instead of
344. A copy has no index, so the population is the directory scan there and `populationSource: "directory"` says so.

| proof | what was restored | the line it produced |
| --- | --- | --- |
| pre-fix `check:publint` | `git show b00e40a4^:tools/check-publint.mjs` | `gate_without_population: check:publint: prints no count of the objects it examined` + `gate_population_finding_unrecorded: gate_without_population check:publint`, exit 1 |
| pre-fix `test:stardew-soil-itm-canary` | `9918a084^`'s script (`node --test tools/stardew-soil-itm-canary.test.mjs`) and its suite | `gate_skip_can_pass: test:stardew-soil-itm-canary: runs node --test over 1 suite(s) that can all skip, and nothing decides before the runner` + `gate_population_finding_unrecorded: gate_skip_can_pass test:stardew-soil-itm-canary`, exit 1 |
| pre-fix wire parity verdict | the unpaired frame stopped reaching `gaps` - collected and printed, no longer blocking - which is the shape `2738fa62` describes ("31 of 37 frames, six named in prose below the verdict") | `gate_pairs_a_subset_and_passes: check:cross-language-wire-parity: holds unpaired and nothing compares that count or the refusal it feeds, so the verdict cannot read it` + `gate_population_finding_unrecorded: gate_pairs_a_subset_and_passes check:cross-language-wire-parity`, exit 1 |

The third proof is the only one that is a reconstruction rather than a restored blob: `2738fa62` CREATED the wire parity
gate already fixed, so its pre-fix version is in no commit. The injection restores exactly what that commit message says
the first version did - the frame is still collected and still printed, and it no longer reaches the verdict - and both the
gate and its falsifier record the shape it was reconstructed from.

Two of the three proofs also taught the classifier something it had wrong, which is why they were run instead of the rule
being declared correct:

- a 90-character window between a population word and its number read the pre-fix publint sentence "missing types
  condition for exports: ${path}" as a population line, and passed the exact defect it was built for. The window is one
  token now;
- blanking quoted literals without respecting template literals let the wire gate's own
  `${report.frames.unpaired.join(", ")}` open a quote that never closed, and the reconstructed pre-fix gate read as clean.
  The blanking is template-aware now.

### Why the debt is a baseline and not a list of exemptions

The brief for this check said: no allow-list of gates; a gate that legitimately cannot print a population declares that and
says why. The 56 findings are not exemptions - they are the debt - and they live in `tools/gate-population-baseline.json`,
written by `--update` from a real reading and never by hand. The ratchet turns both ways: a finding the baseline does not
record is red (a new silent gate cannot land), and a baseline row that is no longer a finding is red too (a paid debt must
be deleted, so a row cannot outlive what it described). That is the same mechanism `tools/audit-gate-red-proofs.mjs` uses
for gates never seen red, and the same `--update` shape as `tools/cognitive-complexity-baseline.json`.

What makes 57 rows acceptable where a 57-line allow-list would not be: the rows ARE the measurement. They are keyed by
cause and gate (`gate_without_population check:diff`), they expire in both directions, and the number is printed on every
run. The alternative - a gate that can never be green - is a gate nobody keeps running, which is how this debt stayed
invisible for a month.

There is a third answer, and this branch needed it within the hour: a row whose gate the INDEX stops carrying is **inert**,
printed as `gate_population_baseline_inert` and counted as neither green nor red. `inert` exists because another lane's
whole-tree commit brought `test:action-surface-parity` into the population and a later reset took it out again, which made a
recorded row read `stale` on a branch where the gate simply was not there. That is the same rule
`tools/lib/indexed-sources.mjs` applies to the population itself - a gate file that is not staged is not yet anyone's - and
the alternative, deleting the row, would have meant re-adding it on the next commit.

### What this check does not see, stated rather than implied

- It is a SOURCE reading. It runs no gate. A population word in a dead branch reads exactly like one on the verdict line:
  the rule says a gate NAMES what it examined and can tell the two outcomes apart, not that the number is right. The design
  that would say so - run every gate's default invocation and judge its output - is the ladder inside the ladder for 345
  gates including C# compiles, which is why `tools/lib/harness-conformance.mjs` runs the `tools/check-*.mjs` half and this
  one reads the report contract of all of them.
- `gate_pairs_a_subset` accepts two shapes: the count compared against zero, or the block that collects it handing the same
  failure to a collection the verdict compares (the wire parity gate is the second shape, and a rule that accepted only the
  first would have reported the FIXED gate). A count routed through a helper two functions away is accepted as clean
  although this reading cannot follow it.
- `gate_without_population` has three accepted answers, and the third is the strongest: a report key the shared judge reads
  (`tools/lib/assert-non-vacuous.mjs`), a printed count naming a read object, or a not-measured verdict carrying a non-zero
  exit. A gate that prints `0 findings` has answered none of them, which is the defect.
- The vocabulary is a declaration, not a derivation: `POPULATION_WORDS` and `SUBSET_WORDS` are two short lists in the gate.
  A gate that counts `witnesses`, `hunks` or `deltas` is reported silent until a word is added - and that is visible, because
  the finding names the gate and the cause on the line a reader is already reading.

### The deviation this batch had to make, and why

`tools/lib/harness-conformance.mjs` gained one registration line (`check-gate-populations.mjs` in `GATES_WITH_FALSIFIER`)
and this document gained this section; both are outside the four paths the brief named. The registration is not optional:
without it that suite reports `gate_without_falsifier: check-gate-populations.mjs`, L0 stops on it, and the gate would be
wired into the ladder as a red rung - the one outcome a gate about false readings must not produce. The same line was added
by `2738fa62` for the wire parity gate when it entered L0.

### The unit this batch had to split, and how it was verified

`27a0bc83` (another lane's whole-tree commit, `fix(gates): an artefact marked generated must be reproducible by its
producer`) swept up this lane's in-flight `package.json` - the two scripts - `tools/prelive.mjs` - the one rung - and
`tools/lib/harness-conformance.mjs` - the registration - while this gate was still being finished. The lines are in `HEAD`
byte for byte (`git show HEAD:package.json` names both scripts; `git show HEAD:tools/prelive.mjs` names the rung), so
nothing was lost, but the rule this breaks is "one unit, one commit": the unit is finished by the commit that carries the
three new files and this section, and the pathspec it used is printed in its own body. What the incident costs a reader is
one cross-reference, written here rather than discovered later. It also cost a baseline regeneration: the same commit
brought `check:generated-artifact-reproducibility` into the population, so the row count is the tree's and moves with it.

### Unchanged by this batch

The 56 rows are recorded, not repaired. Eight of them are in files this lane may not edit
(`integrations/stardew/action-development/tests/*`), one is a register derived against a decompiled tree, and the rest are
`tools/` gates whose owner is whoever next touches them. Each already names what it prints today and what it would have to
print instead: a count of the objects it examined, on the line a reader already reads.

## The generated-artefact census: one gate for a class that cost two days

`tools/check-generated-artifact-reproducibility.mjs` (L0, `check:`/`test:` pair, measured 0.7-0.8 s). The class is an
artefact that says it is generated and that its own producer cannot reproduce, and it has cost two days in three shapes:
`native-multiplayer-sensitivity.v1.json` hand-edited into a state its derive tool REFUSED (96 actions against a
106-action catalog, four retired ids, found only because a test compared action sets), `action-surface.v1.json` stale
twice in one day, and `action-source-projection.v1.json` drifting by three lines whose only signal was
`180614 !== 180548`. In each case the file claimed derivation, nothing asserted that it COULD be derived, and the truth
was recovered by diffing a hundred kilobytes by hand.

### The population, derived and paired

Two claim forms, both read from the tree: a tracked path under `generated/` or `derived/`, and a comment marker on one of
the first three lines naming the file as generated. A tree named `inputs/` is the one stated exclusion - a pinned input
copy of another tree's artefact - and it is printed rather than folded away. Every claimant is then paired with a
producer from the gate's own `ARTEFACT_PRODUCERS` map; a claimant with no producer is
`generated_artifact_without_producer:<path>`, a finding and never a pass, which is exactly the mp-sensitivity shape.

Measured on this tree: `artefacts examined 6 · with a declared producer 6 · undeclared 0 · declared_by_test 1 ·
reproduced 1 · not re-derived 5 (inputs_unchanged 4, declared_by_test 1) · pinned inputs 1`.

### What reproduces, byte for byte, measured rather than assumed

| artefact | producer | bytes | measured |
| --- | --- | --- | --- |
| `contracts/generated/action-surface.v1.json` | `dotnet <ActionDevelopmentActionSurfaceExport.dll>` | 63 891 | equal, 0.6 s for this and the two below together |
| `contracts/generated/action-deadline-windows.v1.json` | the same DLL, `--deadline-windows` | 5 342 | equal |
| `contracts/generated/action-handler-groups.v1.json` | the same DLL, `--handler-groups` | 6 463 | equal |
| `contracts/generated/native-multiplayer-sensitivity.v1.json` | `tools/derive-stardew-native-multiplayer-sensitivity-register.mjs` | 81 835 | equal, 262 ms, 106 actions |
| `contracts/projection/action-source-projection.v1.json` | `src/action-source-projection-producer.mjs` | 180 614 | equal, 88 ms - the incident's own byte count |
| `contracts/generated/snapshot-sample.v1.json` | `xunit SnapshotLoopbackExportTests.PublishesEveryFamilyTheHeadlessWorldCanHonestlyConstruct` | 12 451 | equal under `--with-test-producers` |

The register's derive tool writes a cwd-relative path, so the gate runs it in a sandbox under
`.tmp/generated-artefact-reproducibility/` whose read paths are junctions (`ref/`, `Handlers/`, `src/`) and 45 hard links
(`farmhandexecutioncontroller.*.cs`) into the real tree and whose output path is a real empty directory. The tracked file
is never opened for writing by the default run, and the one producer that writes in place (the xunit export) is behind
`--with-test-producers`, which compares and then restores the artefact's original bytes - it left this tree byte-identical
(hash `620A4110…` before and after).

### The two red proofs, replayed from history

Both ran in a copy of HEAD outside the repository (`git archive HEAD` extracted to `E:/tmp/gateproof/repro`, with `ref/`
and the exporter's `bin/` junctioned in and its own `git init`/commit), because the population is the index.

| injected | what the gate said |
| --- | --- |
| `230775c7^`'s `native-multiplayer-sensitivity.v1.json` laid over the copy (95 actions, four retired ids) | `generated_artifact_not_reproducible:…native-multiplayer-sensitivity.v1.json:61:$.declaredActionIds`, naming `break_container_source`, `chop_tree_source`, `break_rock_source`, `advance_day` as members the artefact carries and fifteen the producer emits that it does not (`use_mine_ladder` among them), exit 1 |
| the three-line projection drift put back (`sweep_scythe` dropped from the host lists) | `generated_artifact_not_reproducible:…contracts/projection/action-source-projection.v1.json:4642:$.mod.experimentalActionIds`, naming `sweep_scythe` and each of `$.host.adapterActionIds`, `$.host.toolActionIds`, `$.host.toolRouteActionIds`, exit 1 - the line and the member, not two byte counts |
| an empty `contracts/generated/probe.v1.json` added | `generated_artifact_without_producer:<path>`, exit 1 |

The falsifier suite's own two injections were measured the same way: dropping the `inputs/` exclusion reads
`examined 9 · undeclared 3` and names the pinned copy; reducing `describeMismatch` to two byte counts reddens the drift
case at `actual '(bytes)' / expected '$.a'`.

### The deletion this unit carries, and what was proven before it

`contracts/generated/action-source-projection.v1.json` (91 524 bytes) was found by the population scan and cannot be
reproduced: it is an obsolete revision of the projection - 65 registrations against the producer's 106, a `sources` list
still naming `integrations/stardew/Handlers/*.cs` (the list the producer replaced with `canonical_handler_groups`), and
the producer's declared output is `contracts/projection/`, which is byte-exact. Unreferenced three ways before deleting:
`git grep` finds no reader of the path, no reader of its distinctive keys (`mod_handler_farming`,
`mod_handler_machines_animals`, `mod_handler_resource_tools`), and no reader of its basename; and the `design/` mount
names neither the path, the basename, nor those keys - so it was a duplicate, not an input. An unreferenced artefact
marked generated that nothing can regenerate is a trap for the next reader, and the gate names a re-introduction as
`generated_artifact_without_producer` because no producer is declared for that path.

### What this gate does not verify, stated

- A declared input that is a DIRECTORY contributes that directory's own mtime, so a change deep inside it does not move
  the number that decides whether to spend the producer's cost. `--re-derive-all` is the reading that covers a
  re-decompile or a directory reshuffle; it re-derived all five runnable artefacts in 1.1 s.
- A JSON artefact that claims derivation only in prose has no header to read, so the scan does not find it. The declared
  map covers the JSON artefacts this tree has (`contracts/projection/` carries no marker and is declared instead).
- The `declared_by_test` bucket is a COUNT, not a measurement, in the default run: `snapshot-sample.v1.json` is named and
  never folded into the pass, and `--with-test-producers` is the run that measures it (it did, above).

### The census

Measured 2026-11-13 with the unit's files staged in a private index (`GIT_INDEX_FILE` + `git read-tree HEAD` + `git add`,
so the reading is the commit's, not the worktree's): `gates examined 353 · with a red proof 328 · external 4 · declared
without 19 · undeclared 0 · zero-population-pass 0`, with `proven:check:generated-artifact-reproducibility
kind=history` and `proven:test:generated-artifact-reproducibility kind=inject`. The previous line was
`351 · 326 · 4 · 19 · 0 · 0`, so this unit adds the two scripts and proves both.

One registration is pending and is named here rather than done by this unit: `tools/lib/harness-conformance.mjs`'s
`GATES_WITH_FALSIFIER` still needs the entry for `check-generated-artifact-reproducibility.mjs`, and the file currently
holds another lane's hunk (its `check-gate-populations.mjs` entry). Until that entry lands,
`check-harness-conformance` reports `unlisted 1 (check:generated-artifact-reproducibility)` and
`gate_without_falsifier`. The line to add is the file name, under a comment saying what its default run prints
(`artefacts examined 6 · with a declared producer 6 · undeclared 0 · reproduced 5 · not re-derived 1` plus the four-entry
`checks[]` and `examined`) and what its falsifier proves (the `inputs/` exclusion dropped → `examined 9 · undeclared 3`;
`describeMismatch` degraded to byte counts → the drift case red at `actual '(bytes)' / expected '$.a'`).

The other three red members of the L0 rung on this worktree are not this unit's and are recorded as named debt:
`check-code-duplication` (`clone groups 319 · new 14 · grown 1`, in C# partials another lane holds uncommitted),
`check-cognitive-complexity`, and `check-harness-conformance`'s own `falsifier_entry_stale: check-gate-populations.mjs`
(another lane's untracked gate that the register already declares). This unit's gate is green in that rung: `exit 0`,
829 ms.

## The fourteenth batch: the matrix between the surfaces, and two red proofs replayed from this repository's own history

`check:action-surface-parity` / `test:action-surface-parity`. One defect class, five instances in two days: a thing the
companion can SAY that one layer accepts and the next refuses or silently reinterprets - `charge` required by the wire and
absent from the tool schema, `sweep_scythe` in the catalog and in the completion contract and mounted nowhere, a
`for_each` source the grammar accepted and the Mod answered `for_each_source_unavailable`, an `express_emote` the prompt
named and no surface mounted, a `refusalDetail` the Mod sent and the Host refused. Each was found by a human noticing, and
the two gates written afterwards each covered one PAIR (tool schema vs wire, plan example vs wire). The matrix is the unit
this section records: the action catalog crossed with the six surfaces that must carry each action, every one of them read
from its own authority - the wire's `exactArgs` rows (following a shared frozen list and `textOnlyRow` by name), the
Mod's `ExecutionArgumentProperties` switch, the catalog's `argumentSchema`, the plan grammar's two published admission sets
plus its descriptor derivation, and the tool surface twice (what `parameters` declares, what `toArgs` forwards).

**The falsifier is history first.** Two real commits are replayed into a copy under the OS temp directory rather than
synthesized: at `0d4ce1b2~1` the wire required `charge` on `till_soil` and `water_crop` while the tool schema and the
projector did not offer it, and the gate names both refusals
(`surface_refuses_what_another_accepts:till_soil:charge:tool-schema:catalog` and
`...:till_soil:charge:tool-args:catalog`, and the same pair for `water_crop`); at `8c53105e~1` the catalog carried
`sweep_scythe` and no tool mounted it (`surface_silently_omits_action:sweep_scythe:tool-schema` and `:tool-args`). Both
suites skip with a named reason when those commits are not in the clone, so a shallow checkout reads `not measured`
instead of green.

**Four injections on the real declarations, each seen red once.** Deleting `charge` from the `till_soil` mount's
`parameters` names the schema refusing it; deleting `charge` from its `toArgs` names the projector in its place;
deleting `sleep` from the wire declaration and deleting its arm from the Mod's switch each name an omission. Two
blocked cases prove the third verdict: a `toArgs` spread this reader cannot enumerate is
`tool_args_unreadable:till_soil`, and an empty source tree is `action_surface_population_empty` with `examined 0`.

**One decision made rather than assumed.** The plan grammar's per-action vocabulary IS the descriptor's
(`declaredArgumentsOf(registration)`), so this gate does not invent a second copy of the names: it reads that dependency
and blocks if the derivation changes shape. A `continue` added beside the grammar's two declared filters is
`plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:...` and the run is BLOCKED, because an arbitrary skip
condition is a hand-written vocabulary this reader cannot enumerate - and a matrix over the actions it removed would be
exactly the false reading the gate exists to prevent. Dropping a lifecycle from `PLAN_ACTION_LIFECYCLES` instead stays
green on purpose: that set IS the declaration, and the report prints `plan grammar admission: lifecycles ... (omits 7)`
on every run so a shrink is visible rather than silent.

**What it does not cover, said in the gate's own header.** Value-level constraints (enums, ranges) are one owner per
fact and are read from their declaration by the tool schema itself; the JSON wire schema's action enum is
`check-stardew-action-promotion.mjs` (`missing_schema_execution_action`); `for_each` sources and `where` words are not a
per-action argument; frame fields belong to `check-cross-language-wire-parity.mjs` and
`check-refusal-detail-state-parity.mjs`.

### The census

Measured on this worktree: `actions examined 106 · surfaces 6 · pairs checked 307`, population per authority
`catalog 106 · mod 103 · plan-grammar 96 · tool-schema 103 · tool-args 103 · wire 103`, and the only omission
declarations used are `plan-grammar-lifecycle 7` and `read_only 15`. The gate is green here (`exit 0`, ~120 ms of file
reads and no child process), and the matrix has no live hole today: the five instances above are all closed on this tree,
each by the surface that owned it.

It is registered in `tools/lib/harness-conformance.mjs`'s `GATES_WITHOUT_FALSIFIER` with the reason that its default run
prints a population line and findings rather than a `checks[]` report, so the harness reads its falsifier suite instead.
The one `falsifier_entry_stale` that remains in `check-harness-conformance` is the one named in the previous section -
`check-gate-populations.mjs`, another lane's untracked gate that the register already declares - not this unit's.


## The twelfth batch: one gate that read its own replica

`test:stardew-native-local-runner-fixture-contract` was the single row in the "asserts a replica" class, and it left the
queue because the replica was deleted rather than because a proof was manufactured against it. Its fourth case compared
a hand-built `fixturePolicyFor(actions)` against a literal, and the config it handed the runners was built the same way,
so the writer could retire a field and both would stay green.

- **The producer**: `configureNativeLocalPlayer` (`tools/lib/stardew-native-local-player-fixture.mjs:1240`) is what
  `prepareNativeLocalPlayerFixture` calls to build the `config.json` a run ships. The gate now invokes it once per runner
  and asserts against its output; the policy fields are read from `ModConfig`'s own `ActionPolicyOptions` mapping, and a
  retired policy field is a list the record no longer declares.
- **The historical red**: `a0d756df` added `result.EnabledActions` to that writer, on the belief that "the Mod reads the
  enabled set from that field". `ModConfig` has never declared it since. At that commit the replica case passes
  (`✔ the fixture's own policy block carries no retired field`); at `27a0bc83`, the last shipped revision carrying the
  field, the old gate is 4/4 green while the repaired gate reds naming `EnabledActions`.
- **Two gates green from one deletion**: the writer no longer emits the retired key, so
  `tools/stardew-policy-isolation.test.mjs:138` — red at HEAD for that exact line — passes again beside this one.
- **Behaviour-neutral, measured**: the writer emits 16 top-level config keys and `ModConfig` declares 15 of them; the
  sixteenth is `Portfolio`, a retired topology block outside this gate's policy axis. With the retired key still written
  the count was 17 emitted and 2 undeclared, and deserialisation dropped it, so the value never reached the game.

Measured on a worktree that also carried other lanes' untracked `tools/check-*.mjs`: `gates examined 357 · with a red
proof 333 · external 4 · declared without 18 · undeclared 0 · zero-population-pass 0 · unlisted 1`. The delta this unit
owns is one gate out of `declared without` and into `with a red proof`; the rest of that reading moved for reasons
outside it.

## The thirteenth batch: ten gates that can now say how much they measured

`node tools/check-gate-populations.mjs` read `gates examined 346 · with a population line 288 · without 57 ·
unreadable 1` before this unit and `298 · without 47` after it. A gate with no population line cannot tell "I measured
nothing" from "I measured and found nothing", which is the shape behind three false greens in one day; the ten below
were chosen by what the ladder already leans on, not by which were cheapest.

**How the ten were ranked.** `tools/prelive.mjs`'s `PRELUDE_RUNGS` is the only list of gates whose verdict stops a
live run, so its members come first. Next are gates another gate or runner spawns and whose exit code that caller
reads. Then the gates a CI composite (`quality:check`) names, and last the single-file gates the CI `gates` job runs
that were cheapest to give a real population. Every member's population is derived from the tree, not listed.

| rank | gate | population line it now prints | zero handling |
| --- | --- | --- | --- |
| L0 rung | `check:catalog-fact-ownership` | `fields examined N · models M` | blocked, `owner_declares_no_fact` (exit 2) |
| L0 rung | `check:stardew-task-action-coverage` | `actions examined N · covered C · excluded E · tasks T` | its dependency refuses first (below) |
| L0 rung | `tools/check-live-run-verdict-guards.mjs` | `modules examined N` | blocked, `no_module_examined` (exit 2) |
| spawned by `run-stardew-action-gates-batch.mjs` | `audit:stardew-native-local-runner-contract` | `runners examined N · conforming C · on the retired contract D` | blocked, `no_runner_examined` (exit 2) |
| `quality:check` composite | `check:text-hygiene` | `files examined N · violations V` | blocked, `listing_unreadable` / `no_text_file_examined` (exit 2) |
| `quality:check` composite | `check:error-identity-classification` | `files examined N` | blocked, `no_production_source` (exit 2) |
| CI gates job | `check:silent-failure` | `sites examined N` | finding, `silent_site_population_empty` (exit 1) |
| CI gates job | `check:duplicated-authority` | `authorities examined N` | blocked, `no_declared_authority` (exit 2) |
| CI gates job | `check:stardew-mod-folder-name` | `files examined N` | blocked, `authority_unreadable` (exit 2) |
| CI gates job | `test:stardew:all` | `projects examined N · passed P · failed F` | finding `no_project` (exit 1) / blocked `test_tree_unreadable` (exit 2) |

**Twelve red proofs, each a copy outside the repository with that gate's population emptied.** Each row is the reading
the copy produced, not a plan: `owner_declares_no_fact` (the owner's model list emptied, exit 2);
`stardew_action_surface_has_no_execution_actions` (artifact emptied, exit 1 - see below); `no_module_examined`
(`--root` on an empty directory, exit 2); `no_runner_examined` (a `tools/` with no runner smoke file, exit 2);
`no_text_file_examined` (a `git init` tree whose `.gitignore` is `*`, exit 2) and `listing_unreadable` (no worktree at
all, exit 2); `no_production_source` (a scope holding no `.ts`, exit 2); `silent_site_population_empty` (a tree where
the scan matches no silent site, exit 1); `no_declared_authority` (the declaration table emptied, exit 2);
`authority_unreadable` (the PowerShell seam absent, exit 2); `stardew_mod_tests_no_project` (a test tree with no
`.csproj`, exit 1) and `test_tree_unreadable` (no test tree, exit 2).

**The one gate whose zero its dependency owns.** `check:stardew-task-action-coverage` cannot print a blocked line of its
own for an empty execution population, and that is the finding this batch records rather than hides: its task table
reads the same artifact at import time and throws `stardew_action_surface_has_no_execution_actions` when the execution
filter yields nothing (`tools/lib/multiday-daily-tasks.mjs`, `readExecutionPopulation`). Emptying the artifact therefore
ends the run at exit 1 with that error before the gate's own reading exists - loud, and never green, but the reason is
the dependency's and `allowEmpty` is not available to a gate that never reached its verdict. The population line is what
makes its ordinary runs measurable; a guard restating the dependency's refusal inside the gate was written, seen
unreachable, and removed instead of kept as a branch nothing can enter.

**The census row it cannot read.** `unreadable 1` is `check:stardew-native-multiplayer-sensitivity`. Its command names
`--register integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json`, and
`tools/lib/gate-population.mjs`'s `COMMAND_PATH` alternation matches the `js` prefix of `.json` without anchoring the
extension, so the entry file is recorded as `…-sensitivity.v1.js` - a path that does not exist. The census cannot read
source it cannot find, so the row is counted apart from both buckets instead of being judged; the repair belongs to that
derivation (`tools/lib/gate-population.mjs`, outside this unit's bounds), not to this gate.

**What this unit did not touch.** No gate's rule changed: only the coverage each one reports and the verdict an empty
population earns. Two of the ten are red on this worktree for reasons older than the unit and outside it -
`check:text-hygiene` (200 worktree line-ending violations) and `check:silent-failure` (2 undeclared sites, the first
`host/src/companion-loop.ts:240:reportTurnDecision`) - and both now print how many objects produced those numbers.

## The fifteenth batch: the eighteen owed rows, four verdicts, and the two the census could not place

Measured against `2b8a81bb` — the revision every injection ran against, extracted with `git archive` to
`E:/tmp/gateproof/b18` outside the repository, with `node_modules`, `host/node_modules`, `dialogue-web/node_modules`,
`ref`, `vendor` and `design` junctioned in — and re-read on the worktree after the markers landed:

```
before  gates examined 357 · with a red proof 333 · external 4 · declared without 18 · undeclared 0 · zero-population-pass 0
after   gates examined 357 · with a red proof 341 · external 7 · declared without  7 · undeclared 0 · zero-population-pass 0
```

Eleven of the eighteen left the debt set: eight carry a red proof now, two are `external` by label, and
`check:architecture` is `external` by inheritance once its two unproven members were closed. Seven remain owed, and none
is waiting on archaeology.

### The verdicts for the eighteen

| verdict | count | gates |
| --- | --- | --- |
| `provable-now` | 8 | `check:dialogue-web-boundaries`, `check:host-module-graph`, `test:frontend-turn-gate`, `test:gameplay-capability-catalog`, `check:stardew-native-multiplayer-sensitivity`, `test:stardew-native-multiplayer-sensitivity`, `tools/check-stardew-actor-admissibility.mjs`, `tools/check-stardew-hold-sufficiency.mjs` |
| `already-proven` | 2 | `check:publint`, `test:dialogue-web-boundaries` |
| `cannot-fire` | 5 | `audit:stardew-action-seam-terminals`, `check:live-run-isolation`, `check:sandbox-acceptance`, `test:stardew-soil-itm-canary`, `test:voice-protocol` |
| `red at HEAD` | 2 | `test:sandbox-configs`, `test:stardew-fixture-scenario-wiring` |
| `provable by derivation` | 1 | `check:architecture` |

`8 + 2 + 5 + 2 + 1 = 18`. The fifth row is not a fifth kind of evidence: `check:architecture` is an aggregate whose rule
is its members', and it left the debt set by inheritance rather than by a marker — recorded separately so the four
verdicts keep their force. `test:dialogue-web-boundaries` is `already-proven` *and* its injection is the zone-drift one
below; it is counted once, in the bucket that names the defect.

### `already-proven`: the reader accepts one spelling, and the proof was written in another

This is the bucket the ledger was asked to watch, and its mechanism is one function. `readRedProofMarkers` (`tools/audit-gate-red-proofs.mjs:149`)
anchors only on a comment line matching `^red-proof:\s+<kind>\s`, and `classify` reads nothing else. Two owned files state
their proofs in prose:

| gate | the file | what it says today | what the reader saw |
| --- | --- | --- | --- |
| `check:publint` | `tools/check-publint.test.mjs:10-15` | "Measured red (inject): restoring the pre-fix tolerance branch …" and "Measured red (history): the default run on a machine with only npm's `bun` shims …" | no marker → the gate owes a proof |
| `test:dialogue-web-boundaries` | `tools/check-dialogue-web-boundaries.test.mjs:10-15` | "The proofs behind it, each seen red on a copy of the tree outside the repository and green again once removed: …" | no marker → the gate owes a proof |

Both claims are true on this tree and were re-derived before being re-spelled: the publint injection reproduces
`'passed' !== 'failed'` and the zone injection reproduces `no-module-to-surface`. So the repair is the marker grammar,
not a new proof — the fact existed the whole time in the file the gate owns, and only its spelling was wrong. A census
that reports a written-down proof as owed is reading its own bookkeeping and calling it debt.

**Two more of the same family, outside the eighteen, and they are the whole of the two-gate gap.** `check:code-duplication`
carries five readable proofs and one marker whose kind reads `facades`; `test:format-ratchet` carries four and one claim
naming `tools/legacy.mjs` and `tools/inflight.mjs`, files the suite plants in a temp copy and deliberately never commits.
`assignStatus` puts `malformed` above everything and `pointer_missing` above `proven`, so both gates are reported as
`unreadableClaims`, and `unreadableClaims` is **not a bucket on the census line** — which is why the line reads
`341 + 7 + 7 = 355` of 357. The two unaccounted gates are exactly those two, they were unaccounted before this batch
(`333 + 4 + 18 = 355`), and they are gates with proofs rather than gates without. Neither file is repaired here: both
belong to lanes that own the ratchets, and the honest change is in the reader — a fourth bucket on the census line — not
in a claim rewritten to satisfy a regex.

**The two spellings disagree inside one file, which is the sharpest reading of the defect.** The same run closes with
`9 gate(s) still owe a red proof; 7 of them are recorded in tools/gate-red-proof-baseline.json; 7 are external and 357
of 357 are accounted for` — and that sentence *does* reconcile, because it counts `reading.gaps.length`, which contains
the two unreadable claims. So one line in `tools/audit-gate-red-proofs.mjs` accounts for every gate and the other, five
lines above it, cannot. `describeGateCensus` is handed `recorded: held` and is never told about
`reading.unreadableClaims.length`; a reader who checks the arithmetic finds the discrepancy and no way to close it.

### The proofs, each with the line that fired and the reading after the restore

Every injection ran in the copy. Restored two ways for each: `git -C E:/tmp/gateproof/b18 hash-object <path>` equals
`git -C <repo> rev-parse 2b8a81bb:<path>`, and `git status --porcelain -- <path>` is empty in the live worktree. No new
`proven_but_nothing_runs` row appeared: the audit's `unexecutedProofs` list is the same 30 entries as before, so every
pointer a marker names is a file a script or workflow runs.

| gate | the violation | the line it printed | exit |
| --- | --- | --- | --- |
| `test:frontend-turn-gate` | `\|\| uiState.streaming` added to the send button's `disabled` in `Composer.tsx` | `✖ the gate reads the composer's two Host-owned refusals, and the send button's terms are exactly those plus an empty field` — "the send button refuses on sendRefused(uiState.send) \|\| !value.trim() \|\| uiState.streaming; … any other term is a refusal it cannot see" | 1 |
| `check:publint` | the pre-fix tolerance branch restored (`blocked.length === 0 && activeGaps.length > 0`) | `✖ an unexplained non-zero exit is a failure, not a tolerated gap`, `'passed' !== 'failed'` | 1 |
| `test:dialogue-web-boundaries` | `import "./components/ChatSurface"` added to `game-lifecycle-controls.ts` | `✖ current cross-surface drift is exactly the documented ledger`, `found: no-module-to-surface\|dialogue-web/src/game-lifecycle-controls.ts\|…ChatSurface.tsx` | 1 |
| `check:dialogue-web-boundaries` | the same import, the cruiser itself | `error no-module-to-surface: dialogue-web/src/game-lifecycle-controls.ts → dialogue-web/src/components/ChatSurface.tsx`, `x 1 dependency violations` | 1 |
| `check:host-module-graph` | `import "./test-support/canonical-test-root.test-support"` added to `host/src/main.ts` | `error no-test-fixtures-in-production: host/src/main.ts → host/src/test-support/canonical-test-root.test-support.ts`, `x 1 dependency violations` | 1 |
| `test:gameplay-capability-catalog` | one published primitive action with no catalog row pushed into `action-surface.v1.json` | `✖ catalog seed covers every published registry action without claiming completeness`, `Published registry actions missing covered catalog rows: probe_uncovered_action.` | 1 |
| `check:stardew-native-multiplayer-sensitivity` | `use_mine_ladder`'s native `MineShaft` seam declared `mp-insensitive` (the shipped row, replayed) | `mp_sensitivity_classification_drift: use_mine_ladder declares StardewValley.Locations/MineShaft.cs mp-insensitive but the exact source reads the decisive token(s) IsLocalPlayer.` | 2 |
| `test:stardew-native-multiplayer-sensitivity` | the same register row | `✖ the committed register derives cleanly against the exact decompiled source`, `code: 'mp_sensitivity_classification_drift'` | 1 |
| `tools/check-stardew-actor-admissibility.mjs` | the `Idle` hold reason given `player_busy_probe` | `FAIL  FACT-3 named`, status failed, `Idle carries player_busy_probe; a body that is not held must not carry a hold code` | 1 |
| `tools/check-stardew-hold-sufficiency.mjs` | one `environmentReads` entry removed from the contract | status failed: `residual_adjudicated` (18 orphans against 16 rows) and `adjudication_named` naming a `namedBy` that is not a declared fact | 1 |

Green after the restore, in the live worktree: `can-start-turn` 5/5, `check-publint.test` 11/11,
`check-dialogue-web-boundaries.test` 4/4, `check-gameplay-capability-catalog.test` 6/6,
`stardew-native-multiplayer-sensitivity.test` 18/18, the two `depcruise` configs `no dependency violations found`
(238 and 80 modules), admissibility `examined 15` passed, hold sufficiency `examined 62` passed.

Two of the ten are **history**, not injection: the `use_mine_ladder` row shipped and was repaired on this branch, and
both mp-sensitivity gates were in the red-at-HEAD table of an earlier batch for exactly this finding. The register row
was rebuilt from the shipped shape rather than invented, which is why the line it produced is the line the ledger
already recorded, word for word.

### `cannot-fire`: five rows, restated in today's terms

| gate | why no input can turn it red | what would make it firable |
| --- | --- | --- |
| `audit:stardew-action-seam-terminals` | it is a report writer. `stardew-action-seam-terminals-audit.mjs` classifies every seam into `seam_ok` / `terminal_in_delegate` / `seam_not_terminal` / `seam_writes_but_no_terminal`, writes the artefact, and sets no exit code anywhere; `suspectSeamReferences` is printed, never turned into a status. Its declared command also exits 1 on a missing `--candidates`, which is indistinguishable from a violation. The precedent is `audit:stardew-admission-fork-delta`, deleted as a gate for the same reason | a verdict threshold (e.g. `--fail-on-suspect`) that turns a suspect row into exit 1, or the `audit:` script line removed so the tool is on-demand and no longer claims a gate |
| `check:live-run-isolation` | it exits 1 from an absent `%LOCALAPPDATA%\GameBuddy\stardew-profiles\native-local-stable`, and today it does so by an uncaught `live_run_isolation_source_profile_config_missing` stack trace. Red-for-absence is not red-for-a-rule: it answers "is this machine set up" | the live profile mount, plus a report that separates a missing prerequisite (blocked, exit 2) from a measured violation (exit 1) |
| `check:sandbox-acceptance` | `report.ok = summary.ok === true && !timedOut` over `sandbox-verify.cmd` under a 15-minute deadline, and no `GameBuddy.Setup.exe` exists in a checkout; the run stages its share on the real account | the machine that builds the installer, run once red and once green |
| `test:stardew-soil-itm-canary` | two reasons, and the second is new. The witness root `.tmp-stardew-decompile/` is absent (the available decompile is a namespace-layout snapshot: 3 of the 6 witnesses do not exist at the paths the gate probes). And when the six are staged, the suite dies before measuring: `stardew-soil-itm-canary.test.mjs:43` calls `new URL(witness, root)` with `root` a native path from `fileURLToPath`, so it throws `ERR_INVALID_URL` on Windows **and** on POSIX — `new URL("a/b", "/tmp/x/")` throws too. The five cases have never run anywhere with the witnesses present | `pathToFileURL(root)` in that `fixture()`, plus a staged tree whose layout carries `StardewValley/Tools/Hoe.cs`; then a model row removed is the red |
| `test:voice-protocol` | `pnpm --dir vendor/pi-koe run test:protocol` runs inside a git submodule: breaking it dirties another repository, and a marker cannot live there | a lane that may commit in `vendor/pi-koe` |

### `red at HEAD`: two rows that are neither provable nor cannot-fire

A red proof needs a green baseline to redden. These two are red on their own rule at `2b8a81bb`, so the honest record is
the finding, not a marker.

| gate | the reading | where the fix belongs |
| --- | --- | --- |
| `test:sandbox-configs` | `FAIL gamebuddy-sandbox.wsb: not valid XML: not well-formed (invalid token): line 1, column 1`, exit 1 — the file is a `#`-comment instructions document (`HOW TO RUN … only a human can do this step`) sitting inside the directory `validate-sandbox-configs.py` globs as `*.wsb`; red since `3f319596` landed it | the file: either a real `.wsb` or a name the glob does not claim |
| `test:stardew-fixture-scenario-wiring` | `✖ the real repository wiring is consistent` and the two real-tree allowlist cases (`the real config gate accepts navigation_read_only_v1`), exit 1 | the fixture scenario wiring and allowlist the gate reads; the whole synthetic half of the suite is green, so the gate is doing its job and the tree is not |

### What this batch did not do

- It did not touch `check:code-duplication`'s `facades` marker or `test:format-ratchet`'s planted-path claim. Both are
  proven gates misreported by the reader, not gates owing a proof, and both belong to the lanes that own the ratchets.
  The repair is a bucket on the census line (`unreadableClaims`), which lives in `tools/lib/harness-conformance.mjs`.
- It did not use `--update` on the baseline. The eleven stale entries were deleted one line each, by hand, and the file's
  only other change is the comma the last remaining entry inherited. `node tools/audit-gate-red-proofs.mjs` now reports
  zero `baseline_entry_stale` and zero `no_red_proof`.
- It did not claim `check:architecture` for itself. That gate is a `pnpm ... && pnpm ...` chain with no rule of its own;
  it left the debt set by inheritance, and the census prints the members it inherited from.

## The sixteenth batch: the census prints its fifth bucket, and the arithmetic is the assertion

The fifteenth batch left repairs to this document's own record that belong to one family: a claim a reader cannot
reconcile from what is printed.

### Line one: the bucket that was never printed

`describeGateCensus` partitioned four buckets and printed five numbers, so the two gates whose claim `assignStatus` calls
`malformed` or `pointer_missing` were in no term of the arithmetic. The line now prints them, and the numbers are read
from the same run, before and after:

```
before  gates examined 357 · with a red proof 341 · external 7 · declared without 7 · undeclared 0 · zero-population-pass 0
after   gates examined 357 · with a red proof 341 · external 7 · declared without 7 · unreadable 2 · undeclared 0 · zero-population-pass 0
        341 + 7 + 7 + 2 + 0 = 357        (the line before read 341 + 7 + 7 = 355 of 357)
```

The bucket is `reading.unreadableClaims`, the same list `evaluate` turns into `red_proof_kind_unknown` /
`red_proof_pointer_missing` findings on every run, so the line and the findings cannot disagree. `check-harness-conformance`
prints the identical line from the same `describeGateCensus`, because the numbers are one reading of one population -
`gateRedProofLedger` now carries `unreadable` beside `undeclared` and `external` for that reason.

### Line two: printing it once would have left the next bucket unprintable

Adding the bucket fixes this instance. What makes the class impossible is that `describeGateCensus` reads its own numbers
back off the line it just built, sums the five partition terms, and compares the sum with the population it printed:

```
census_does_not_reconcile:<sum>:<examined>                 a bucket is printed and the arithmetic does not close
census_does_not_reconcile:<bucket>_not_printed:<examined>  a partition bucket is absent from the line
```

Measured on the live numbers with the bucket printed as `0`: `census_does_not_reconcile:355:357`. Measured on a copy of
`tools/` outside the live tree (`.tmp/census-copy`) with `· unreadable ${unreadable} ·` deleted from the template:
`census_does_not_reconcile:unreadable_not_printed:357` - the pre-fix line is not just wrong now, it is unprintable. The
line is the partition or it is not a reading.

`zero-population-pass`, `unlisted` and `untracked_not_counted` stay off the partition on purpose: each cuts across it (a
proven gate can also name no population field), so adding one to the sum would make a correct line look wrong.

### The two prose proofs: re-spelled, and the reader left alone

The two files the fifteenth batch re-spelled carried their proofs twice: the marker form from that batch, and the prose
above it that said the same thing in a grammar the reader ignores. Both prose blocks are gone, and every fact they stated
is in a marker:

| gate | markers | what they state |
| --- | --- | --- |
| `check:publint` | `tools/check-publint.test.mjs:10` (inject), `:13` (history) | the pre-fix tolerance branch excusing an exit no parsed message explains; and, with only npm's `bun` shims installed, the run that printed `publint exited null but every failure maps to a known vendor baseline gap` at exit 0 having read no message, now `publint_not_measured:executable_unresolvable:bun` at exit 2 |
| `test:dialogue-web-boundaries` | `tools/check-dialogue-web-boundaries.test.mjs:13, :16, :19, :22` (inject) | a new module importing a surface named by `no-module-to-surface` (`zone-probe.ts -> components/ZoneProbeSurface.tsx`); a surface that declares a wire contract answering `module <name> is claimed by 2 zones`; both chat declarations deleted stopping the run with `no module declares a chat wire contract`; the fixture below losing its cycle pair and naming the rule it could no longer fire |

The reader was **not** widened, and this is the finding to record: the documented convention in this file and in
`tools/audit-gate-red-proofs.mjs`'s own header is `red-proof: <kind> <claim>` - keyword, colon, **space**, kind - and the
anchor `^red-proof:\s+[A-Za-z][A-Za-z-]*\s` accepts exactly that, so the files were the side that disagreed. Two smaller
constraints the transcription had to respect, both of them the reader's declared behaviour rather than accidents: a
marker's claim may run at most three comment lines (`MARKER_WINDOW`), and a marker consumes its window outright, so
consecutive markers are written three lines apart or the second one is read as the first one's tail.

The prose that remains above the markers is a method note - each proof was seen red on a copy of the tree outside the
repository and green again once the injection was removed - and states no claim of its own, so there is still one
spelling per fact.

## The pinned configuration: a gate that blocked a tree built `Release`

`tools/check-generated-artifact-reproducibility.mjs` (L0, `check:`/`test:` pair). The gate's first witness recorded the
Mod export producer as `bin/Debug/net6.0/…`; the Mod build this repository makes (`build:stardew`, and the ladder) is
`-c Release`. On a tree that carried only the Release build the gate answered `reproduced 2 · not re-derived 1 · blocked`
and exited 2: a tree holding the assembly all along read as "not measured". The rule - a producer that cannot run is
blocked, never green - was right. The resolution was wrong.

### What changed

- `ARTEFACT_PRODUCERS` no longer spells the assembly's path. The three surface artefacts carry a `resolve` descriptor
  (`directory`, `name`, `project`, `build`); `resolveProducer` finds every `bin/<configuration>/<framework>/<name>` the
  tree holds, takes the newest mtime (the path breaks a tie, so two readings of one tree cannot disagree), and runs that
  one. No configuration is preferred, and a Debug build can only win by being the newest AND by being named.
- The report says which assembly each artefact's bytes came from, three ways: `producer assembly: <path> (<artefact>;
  N build(s) present, newest wins)`, the same path inside the `reproduced:` line, and `producerAssemblies` in the JSON.
- No build at all still blocks, now naming the project and the command:
  `generated_artifact_producer_unavailable:<artefact>:missing_built_assembly:<project>`, its detail listing the
  configurations searched and `build it with: dotnet build <project> -c Release`. Exit 2, never green.
- The resolver stats through a link. `withFileTypes` reports a junctioned `bin/Release` as a symlink and not a directory,
  so the first version of this change read `searched: no configuration` over a tree that had the build. Found by running
  the gate over a tree built for the purpose, not by reading the resolver, and pinned by a falsifier case.

### The four readings

| tree | gate | reading |
| --- | --- | --- |
| export project carrying only `bin/Release` | pre-fix (`HEAD`) | `reproduced 2 · not re-derived 1 (declared_by_test 1)`, and for all three surface artefacts `missing_input:` the pinned Debug assembly, exit 2 |
| the same tree | this file | `reproduced 5 · not re-derived 1 (declared_by_test 1)`, each surface artefact from `bin/Release/net6.0/…`, exit 0 |
| this checkout, default run | this file | `reproduced 2 · not re-derived 4 (inputs_unchanged 3, declared_by_test 1)`, exit 0 - the surface artefacts' inputs have not moved, so their cost is not spent |
| this checkout, `--re-derive-all` after `dotnet build … -c Release` | this file | `reproduced 5 · not re-derived 1 (declared_by_test 1)`, `producer assembly: …/bin/Release/net6.0/…`, exit 0 |

**6 of 6 accounted** in both `--re-derive-all` readings: five reproduced, one `declared_by_test` - the bucket the
default path must keep printing and not measuring, which is why `--with-test-producers` stays off it.

The Release-only tree was built for the reading rather than inferred: a scratch root under `.tmp/` whose real paths
(`tools`, `host`, `protocol`, `integrations/stardew/src`, `…/Handlers`, `…/Sensory`, `…/action-development/src`) are
hard-linked so a script's own path is its own path, whose bulk inputs (`ref/`, the contracts, `node_modules`) are
junctions, and whose export project holds `bin/Release` alone. Hard links rather than junctions for the two scripts the
gate spawns, because a junction makes `process.argv[1]` and `fileURLToPath(import.meta.url)` disagree and the projection
producer's main guard then answers nothing at exit 0 - a scratch-tree artefact, not a product defect, but it cost a
reading to notice.

### The stale Release build this unpinning found

The Release assembly standing in this worktree (built 2026-11-06, 6 144 bytes) did **not** reproduce the surface:
`generated_artifact_not_reproducible:…action-surface.v1.json:1:$.actions by actionId`, naming the two members the
artefact carries that the producer does not emit (`fish_here`, `sweep_scythe`) and three `nativeBinding`/`approach`
members the producer emits that the artefact does not. A real finding, reported as a mismatch and not as a block - the
difference this change bought, since the same staleness was previously invisible (a newer Debug build shadowed it) or
unreadable (no Debug build = blocked). `dotnet build … -c Release` (6 656 bytes) reproduced all three byte for byte.
The mismatch check was not touched: `describeMismatch` is the same function, and the member it named is the one a reader
needs.

### What this still does not verify

- "Newest wins" is an mtime rule, not a provenance rule. A build that is newest but compiled from older sources is
  chosen, and the gate answers with the mismatch above rather than diagnosing staleness: nothing here reads MSBuild's
  inputs or runs `--no-incremental`.
- The default run still skips an artefact whose declared inputs have not moved, and resolves the assembly only when it is
  about to run one. A tree with no build at all is green in the default run and blocked under `--re-derive-all`. The skip
  is the gate's cost rule and this unit did not change it: "I could not measure this" is stated whenever the producer
  would run, not about a producer the run did not need.
- `packages/game-action-program/tests/mod-projection.test.mjs`, `integrations/stardew/action-development/src/action-surface-export-check.mjs`
  and `integrations/stardew/tests/actiondevelopmentactionsurfaceexport/action-surface-export-drift.test.mjs` each still
  spell `bin/Debug/net6.0/…` for the same assembly. They are outside this unit's pathspec, and a lane that builds Release
  alone will meet the same blocked reading there. The fix is the resolver above, not a second spelling.

### The census, after this unit

`tools/audit-gate-red-proofs.mjs` over this worktree: `gates examined 357 · with a red proof 341 · external 7 · declared
without 7 · unreadable 2 · undeclared 0 · zero-population-pass 0`, with `proven:check:generated-artifact-reproducibility
kind=history` and `proven:test:generated-artifact-reproducibility kind=inject`. `tools/check-harness-conformance.mjs`
exits 0 and names neither the gate nor its falsifier. The suite grew from 17 cases to 21: a Release-only tree resolving
and reproducing, the newest of two builds winning (in both directions, Debug named when it wins), a tree with no build
blocked with the project and the command printed, and a junctioned configuration still found. All four were seen red
against `HEAD`'s gate file before they were green - `actual ['--deadline-windows']` where
`['…/bin/Release/net6.0/…', '--deadline-windows']` was expected, and `actual 0` where exit 2 was expected.
