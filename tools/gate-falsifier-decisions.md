# Gate falsifier decisions

`gates examined 344 · with a red proof 254 · external 4 · declared without 86 · undeclared 0 · zero-population-pass 0`

The populations are a partition of the 344 gates, so they reconcile with the census line:
`254 + 4 + 86 = 344`. Of the 86 gates still owing a proof, 71 are provable today (the fourth table; its first
five rows need their own argument set supplied before the rule can be exercised at all), seven are named in the tables
above — one that reads something other than it checks, four that wait on a machine or another lane, two that report
`not measured` — and eight were moved out of the fourth table by this batch: three whose marker would have to live in a
file this lane may not edit, two decided by the environment, and three suites red in this checkout for reasons that are
not their own rules.

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
listed: they are the 234, and their markers sit in the gate files themselves.

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

Seventy-one gates, each with the violation to inject. Where the target is the module the suite imports it is
named; where the injection is a fixture, a config or an environment, the artefact is named instead. Rows
marked `(attempted; did not fire)` are cases where this lane tried an injection that the suite did not catch —
they are still provable, but the first guess is recorded so nobody repeats it.

| gate | the violation to inject |
| --- | --- |
| `check:host-production-import-boundary` | a production host import of a test/dev-only module — imports `./check-host-production-import-boundary.mjs` |
| `check:stardew-companion-production-admission` | **the declared command supplies no flag** — `node tools/check-stardew-companion-production-admission.mjs` exits 2 with `admission_cli_required_flag_missing` before reading anything; a proof must invoke it with its flag set and an admission it must refuse — imports `./lib/stardew-companion-production-admission.mjs` |
| `check:stardew-native-mechanism-review-register` | **the declared command supplies no arguments** — it exits 1 with `mechanism_review_register_arguments_required`; a proof must pass `--mechanism-report`, `--register` and `--source-root` and a register row with no review verdict — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `check:stardew-native-multiplayer-sensitivity` | a sensitivity the register misses (register and decompile root are both present) — imports `./lib/stardew-native-multiplayer-sensitivity.mjs` |
| `check:stardew-native-normal-player-ingress-register` | **the declared command supplies no arguments** — it exits 1 with `normal_player_ingress_arguments_required`; a proof must pass the register, report and source root and an ingress path its register does not carry — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `check:stardew-native-source-closure` | **the declared command supplies no arguments** — it prints its usage and exits 2; a proof must pass the six flags and an unresolved source symbol — imports `./lib/stardew-native-source-attestation.mjs` |
| `check:stardew-native-transition-ledger` | **the declared command supplies no arguments** — it exits 1 with `transition_ledger_arguments_required`; a proof must pass the five inputs and a ledger row with no mechanism — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `test:csharp-compile` | a compile error in the Mod — **the caveat this row carried is stale**: measured this batch, the suite is green on a clean HEAD copy (13 passing), so an injected compile error can be seen red here — imports `./check-csharp-compile.mjs` |
| `test:sandbox-configs` | a sandbox config the python validator must refuse |
| `test:sandbox-verdict` | a verdict rule the PowerShell prover must refuse |
| `test:sandbox-wiring` | a driver bound to the wrong gate path |
| `test:stardew-action-candidates` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-action-gate-descriptors` | inject into `./lib/stardew-published-action-registry.mjs` |
| `test:stardew-action-gates-batch` | inject into `./stardew-action-gate-descriptors.mjs` |
| `test:stardew-action-inventory-reconciliation` | inject into `../src/analysis/stardew-action-inventory-reconciliation.mjs` |
| `test:stardew-action-seam-terminals` | the artefact it reads |
| `test:stardew-admission-fork-delta` | the artefact it reads |
| `test:stardew-admission-hold-codes` | inject into `./stardew-admission-hold-codes.mjs` |
| `test:stardew-attachment-telemetry` | a telemetry shape the PowerShell prover must refuse |
| `test:stardew-automation-cadence` | inject into `./run-stardew-action-gates-batch.mjs` |
| `test:stardew-branch-writeset` | inject into `../src/analysis/stardew-branch-writeset.mjs` |
| `test:stardew-clear-fish-pond-runner` | inject into `./run-stardew-native-local-player-clear-fish-pond-smoke.mjs` |
| `test:stardew-dialogue-stream` | inject into `./check-stardew-dialogue-stream.mjs` |
| `test:stardew-dialogue-stream-runner` | inject into `./run-stardew-native-local-player-dialogue-stream-smoke.mjs` |
| `test:stardew-fixture-action-coverage` | inject into `./fixture-action-coverage.mjs` |
| `test:stardew-fixture-profile` | inject into `./lib/stardew-fixture-profile.mjs` |
| `test:stardew-fixture-scenario-resolution` | an action-keyed rule removed so a fallback claims it (attempted; did not fire) — imports `./lib/stardew-native-local-player-fixture.mjs` |
| `test:stardew-fixture-scenario-wiring` | inject into `./check-stardew-fixture-scenario-wiring.mjs` |
| `test:stardew-fixture-transaction-inspector` | inject into `./lib/stardew-fixture-profile.mjs` |
| `test:stardew-formal-action-gate` | inject into `./lib/stardew-formal-action-gate.mjs` |
| `test:stardew-gameplay-surface-rules` | inject into `./lib/stardew-gameplay-surface-rules.mjs` |
| `test:stardew-gameplay-surface-selector` | inject into `./lib/stardew-gameplay-surface-selector.mjs` |
| `test:stardew-lifecycle-cold-session` | inject into `./run-stardew-lifecycle-cold-session.mjs` |
| `test:stardew-loop-closure-mutation` | a mutation the mutation runner must kill |
| `test:stardew-method-resolution` | inject into `../src/analysis/stardew-branch-writeset.mjs` |
| `test:stardew-method-resolution-mutation` | a mutation the mutation runner must kill |
| `test:stardew-native-completion-event-register` | a forbidden field the register stops refusing (attempted; did not fire) — imports `./lib/stardew-native-completion-event-register.mjs` |
| `test:stardew-native-event-continuation-trace` | inject into `./lib/stardew-native-event-continuation-trace.mjs` |
| `test:stardew-native-farmer-sprite-callback-boundary` | inject into `./lib/stardew-native-farmer-sprite-callback-boundary.mjs` |
| `test:stardew-native-field-continuation-trace` | inject into `./lib/stardew-native-field-continuation-trace.mjs` |
| `test:stardew-native-local-runner-contract` | inject into `./audit-stardew-native-local-runner-contract.mjs` |
| `test:stardew-native-local-runner-entry` | inject into `./stardew-action-gate-descriptors.mjs` |
| `test:stardew-native-local-runner-fixture-contract` | inject into `./lib/stardew-native-local-player-fixture.mjs` |
| `test:stardew-native-mechanism-review-register` | inject into `./lib/stardew-native-mechanism-review-register.mjs` |
| `test:stardew-native-multiplayer-sensitivity` | inject into `./lib/stardew-decompile-root.mjs` |
| `test:stardew-native-normal-player-ingress-register` | inject into `./lib/stardew-native-normal-player-ingress-control-slice.mjs` |
| `test:stardew-native-router-invocation-inventory` | inject into `./lib/stardew-native-router-invocation-inventory.mjs` |
| `test:stardew-native-source-closure` | inject into `./lib/stardew-native-source-closure.mjs` |
| `test:stardew-native-state-machine-family-register` | inject into `./lib/stardew-native-state-machine-family-register.mjs` |
| `test:stardew-native-tool-owner-slice` | a declaration mismatch the slice stops refusing (attempted; did not fire) — imports `./lib/stardew-native-tool-owner-slice.mjs` |
| `test:stardew-native-tool-update-dispatch-boundary` | inject into `./lib/stardew-native-tool-update-dispatch-boundary.mjs` |
| `test:stardew-native-transition-ledger` | inject into `./lib/stardew-native-transition-ledger.mjs` |
| `test:stardew-native-virtual-member-invocation-register` | inject into `./lib/stardew-native-virtual-member-invocation-register.mjs` |
| `test:stardew-player-command-equivalence-audit` | inject into `./lib/stardew-player-command-equivalence-audit.mjs` |
| `test:stardew-player-command-graph` | inject into `./lib/stardew-player-command-classification.mjs` |
| `test:stardew-player-reachable-exits` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-reachable-exits-reconciliation` | the artefact it reads |
| `test:stardew-rejected-layer-verdicts-mutation` | a mutation the runner must kill |
| `test:stardew-remaining-actions` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-scaffold` | a removed scaffold artefact its verifier requires |
| `test:stardew-soil-itm-canary` | a canary row the model does not carry (needs `.tmp-stardew-decompile/`, absent here) — imports `./lib/stardew-soil-itm-canary.mjs` |
| `test:stardew-state-coverage` | inject into `./audit-stardew-state-coverage.mjs` |
| `test:stardew-static-companion-admission` | inject into `./stardew-companion-production-admission.mjs` |
| `test:stardew-static-companion-evidence` | inject into `./stardew-companion-live-evidence.mjs` |
| `test:stardew-static-companion-fixture` | inject into `./lib/stardew-companion-live-scenario.mjs` |
| `test:stardew-tile-action-selectors` | inject into `../src/analysis/stardew-tile-action-selectors.mjs` |
| `test:stardew-tool-family-stamina-evidence` | inject into `./check-stardew-tool-family-stamina-evidence.mjs` |
| `test:stardew-uncovered-exit-expansion` | the artefact it reads |
| `test:stardew-uncovered-exit-table` | the artefact it reads |
| `test:stardew:all` | a member suite's own falsifier; it runs them |
| `test:tool-corpus` | a broken entry in its own corpus |

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
| `test:csharp-compile` | the suite on a clean HEAD copy | green, 13 passing — the row's "red in this checkout today" caveat no longer holds, and the row now says that. The proof is one injected C# compile error away, left for the next batch |
| `audit:stardew-action-seam-terminals`, `check:dialogue-web-boundaries`, `check:host-module-graph` | their entry files | the marker would have to live under `integrations/stardew/**`, `dialogue-web/src/**` or `host/src/**`, which this lane may not edit; the injections themselves were never in question |
