# Gate falsifier decisions

`gates examined 345 · with a red proof 230 · cannot fire 15 · reads the wrong thing 1 · needs history 0 · provable 99`

The four class counts are a partition of the 115 gates that owe a red proof, so they reconcile with the
census line: `230 + 115 = 345` examined, and `15 + 1 + 0 + 99 = 115`. `check-harness-conformance` prints the
same numbers from the same reading (`tools/lib/harness-conformance.mjs` over `tools/audit-gate-red-proofs.mjs`).

This document exists for one decision: **which of the unproven gates should be deleted rather than kept.**
A gate that cannot fire occupies a covered position while measuring nothing, so the first table is the
deletion list and the fourth is the work queue. The middle two are the gates whose problem is not the proof
but the reading.

How each class was decided: a gate is `cannot fire` when nothing in the repository can make it exit
non-zero — a report with no failing path, a population no file produces, an environment that decides instead
of a rule, or a rule that lives in another program's config. It is `reads the wrong thing` when its reader and
its name disagree. It is `provable` when a violation exists that it would catch, and the table names what to
inject. Proven gates are not listed: they are the 230, and their markers sit in the gate files themselves.

## Deletion candidates

Every gate here cannot be turned red by any input. The last column is what the decision costs: a row whose
`lost` names real coverage is a gate to move onto the external runner or behind a mount, not to delete.

| gate | what it claims | why it cannot fire | what is lost if deleted |
| --- | --- | --- | --- |
| `audit:stardew-admission-fork-delta` | an audit of the delta if the forked admission sites converged onto `AdmitExecution` | it sets no exit code: every input prints a report, and only a missing `--source-root` throws | a migration decision aid — the site list and the states a converged gate would newly refuse. Nothing CI can observe, because it never fails |
| `check:knip` | no unused file or export in the workspace | `pnpm knip` reads a project; no file in this repository holds the rule (the ledger's `unassessed` class) | real workspace dead-code detection — this one is worth keeping on the external runner, not deleting |
| `check:tools-boundaries` | the layer boundaries of `tools/` | `depcruise --config .dependency-cruiser.tools.cjs tools`; the rule is a config plus a project walk (unassessed) | real boundary enforcement for `tools/` — keep on the external runner |
| `check:live-run-isolation` | a live run cannot reach another lane's profile or fixture root | it needs `%LOCALAPPDATA%\GameBuddy\stardew-profiles\native-local-stable` and a release bundle; off that machine it exits 1 from an uncaught `live_run_isolation_source_profile_config_missing`, which is red for absence, not for a rule | an operational preflight — it answers `is this machine set up`, which a gate population should not contain |
| `check:perf-budget` | the performance ratchet over the benchmark suite | it prints `perf_budget_skipped` and passes unless the baseline's recorded CPU identity is this machine's | a per-machine ratchet; its verdict is about a scheduler, so it belongs beside the machine, not in the proof ledger |
| `check:tavern-references` | every Tavern semantic reference resolves | it reads `design/references/tavern/st-semantic-references-v1.json`; `design/` here is the documents mount and carries no `references/` directory, and the file's own comment says neither tree has ever carried it | nothing today. If the registry ever lands, this and its suite are the only readers — resurrect rather than rewrite |
| `test:tavern-references` | the same resolution, asserted case by case | same absent reader as `check:tavern-references` | nothing today; the same resurrect-with-the-registry note applies |
| `test:all` | everything | an aggregate whose one member, `test:dialogue-web`, is itself unassessed | an alias. Its other members are proven or measured in their own records |
| `test:dialogue-web` | the web surface's suites | `pnpm --filter @gamebuddy/dialogue-web test:static` and friends: a project runner, no single file holds the rule (unassessed) | real frontend coverage — keep on the external runner |
| `test:stardew:core` | the Mod's core .NET suite | `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests` (unassessed) | real C# core coverage — keep |
| `test:stardew:integration` | the Mod's integration .NET suite | `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests` (unassessed) | real C# integration coverage — keep |
| `test:voice-protocol` | the voice sidecar's protocol conformance | `pnpm --dir vendor/pi-koe run test:protocol`: the rule lives in a vendored package (unassessed) | real protocol coverage — keep |
| `tools/check-stardew-actor-admissibility.mjs` | admissibility for every registered action, plus the algebra closure | it reads `integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json`, which nothing in this repository produces (the `contracts/` subtree holds only `generated/`, `projection/` and three action JSONs), so it dies on ENOENT; and no script or workflow runs the file at all | nothing today; it is also the second reader/claim divergence below, so deleting it removes an unfollowable claim rather than a check |
| `tools/check-stardew-hold-sufficiency.mjs` | hold sufficiency for the same registered actions | the same absent `contracts/actor-admissibility/actor-admissibility.v1.json`, and no script or workflow runs it | nothing today |
| `test:stardew-fixture-readiness` | the live fixture is ready to use | it waits on a live fixture root — a machine's profile directory, not a file in this repository | an operational preflight (`await` in its own filename says what it is), not a gate |

## Reads something other than it checks

| gate | the reader | the claim | the divergence |
| --- | --- | --- | --- |
| `check:architecture` | `package.json:34` | the architecture: `pnpm check:publint && pnpm report:clones && echo "[110] knip/module-graph/import-boundary gated by live WIP; see design/110 Task 5"` | two of the five things the name covers are measured (publint, clones); the three it most obviously claims — knip, the host module graph, the production import boundary — are a sentence printed by `echo`, which cannot fail. A reader of the gate list sees `check:architecture` and concludes the architecture is checked |

### Not in the 115: a proven gate whose aim and its fired assertion are different rules

`test:multiday-loop` is counted among the 230 proven, so it is not in the four class tables. Its proof is
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

These belong to the same column but sit outside the 115 — each is a proven gate whose proof exposed a
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
| `tools/check-stardew-actor-admissibility.mjs` | its own `notInAlgebra` / `staleInAlgebra` | advertised as "a QUERY, not a report to interpret", and exactly that: both are printed and never counted in `failed` (this gate is also in the deletion list for its absent population) |
| `test:gate-red-proofs` | two guards over the marker reader | removing the comment-line guard left the suite green — its case "a marker on a code line is not a marker" cannot tell which of the two guards held it, so the assertion is true and narrower than its name |

## Needs history

None. Not one of the 115 gates needs a pre-fix commit, and that is itself an answer to the question this
document was built for: the unproven half of the ledger is not waiting on archaeology. Every gate in it
either has an exit path that a live violation turns, or it cannot fire at all (the list above). The two
places history was genuinely the only honest proof — `check:release-live-evidence` and `test:gate-red-proofs`
— are already proven and are not in this population.

## Provable, not yet proven

Ninety-nine gates, each with the violation to inject. Where the target is the module the suite imports it is
named; where the injection is a fixture, a config or an environment, the artefact is named instead. Rows
marked `(attempted; did not fire)` are cases where this lane tried an injection that the suite did not catch —
they are still provable, but the first guess is recorded so nobody repeats it.

| gate | the violation to inject |
| --- | --- |
| `audit:stardew-action-seam-terminals` | a seam terminal the classifier does not name, in the surface the audit reads — imports `./stardew-branch-writeset.mjs` |
| `audit:stardew-native-local-runner-contract` | a runner-contract field its reader does not accept — imports `./audit-stardew-native-local-runner-contract.mjs` |
| `audit:stardew-state-coverage` | a state row whose provenance the audit cannot find — imports `./lib/stardew-decompile-root.mjs` |
| `check:dialogue-web-boundaries` | a forbidden import in `dialogue-web/src/main.tsx`; the rule is `.dependency-cruiser.dialogue-web.cjs` — imports `./components/ComposedReferenceGameApp` |
| `check:head-typecheck` | a type error in a host source |
| `check:host-module-graph` | a forbidden host import reachable from one of the four entry points; the rule is `.dependency-cruiser.host-production.cjs` — imports `./desktop-host-composition.js` |
| `check:host-production-import-boundary` | a production host import of a test/dev-only module — imports `./check-host-production-import-boundary.mjs` |
| `check:production-pack-load` | a module missing from a built generation in `host/dist` (the reader is the 991 MB artifact, not the checkout) — imports `./check-production-pack-load.mjs` |
| `check:publint` | a malformed published export, against a built package |
| `check:sandbox-acceptance` | a sandbox verdict the acceptance driver must refuse |
| `check:stardew-companion-production-admission` | an admission it must refuse — imports `./lib/stardew-companion-production-admission.mjs` |
| `check:stardew-gameplay-completeness` | a `--report` with an uncovered action family — imports `./check-stardew-gameplay-completeness.mjs` |
| `check:stardew-native-mechanism-review-register` | a mechanism row with no review verdict — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `check:stardew-native-multiplayer-sensitivity` | a sensitivity the register misses (register and decompile root are both present) — imports `./lib/stardew-native-multiplayer-sensitivity.mjs` |
| `check:stardew-native-normal-player-ingress-register` | an ingress path its register does not carry — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `check:stardew-native-pathfinder-source` | a pathfinder call shape its reader does not classify — imports `./check-stardew-native-pathfinder-source.mjs` |
| `check:stardew-native-source-closure` | an unresolved source symbol — imports `./lib/stardew-native-source-attestation.mjs` |
| `check:stardew-native-transition-ledger` | a ledger row with no mechanism (five inputs; the suite builds them) — imports `./lib/stardew-native-mechanism-review-register.mjs` |
| `check:tavern-release-prerequisites` | a live-gate result that is not the exact success contract (proved today at its suite, see below) — imports `./check-tavern-release-prerequisites.mjs` |
| `test:chat-conversational-quality-gate` | inject into `./check-chat-conversational-quality-gate.mjs` |
| `test:complexity-gate` | inject into `../lib/subprocess-output.mjs` |
| `test:csharp-compile` | a compile error in the Mod — the suite is red in this checkout today, so no baseline exists — imports `./check-csharp-compile.mjs` |
| `test:dialogue-web-boundaries` | a new production file in no golden zone — the suite is red in this checkout today |
| `test:frontend-turn-gate` | a `sendRefused` term the gate does not read — the suite is red in this checkout today — imports `./common.cjs` |
| `test:gameplay-capability-catalog` | an action the catalog omits — the suite is red in this checkout today — imports `./check-gameplay-capability-catalog.mjs` |
| `test:production-pack-load` | inject into `./check-production-pack-load.mjs` |
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
| `test:stardew-gameplay-completeness` | inject into `./check-stardew-gameplay-completeness.mjs` |
| `test:stardew-gameplay-surface-rules` | inject into `./lib/stardew-gameplay-surface-rules.mjs` |
| `test:stardew-gameplay-surface-selector` | inject into `./lib/stardew-gameplay-surface-selector.mjs` |
| `test:stardew-lifecycle-cold-session` | inject into `./run-stardew-lifecycle-cold-session.mjs` |
| `test:stardew-loop-closure` | its docblock's own falsifier: an anchor beyond the file's length — imports `./lib/stardew-decompile-root.mjs` |
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
| `test:stardew-native-mechanism-family-register` | inject into `./lib/stardew-native-mechanism-family-register.mjs` |
| `test:stardew-native-mechanism-review-register` | inject into `./lib/stardew-native-mechanism-review-register.mjs` |
| `test:stardew-native-multiplayer-sensitivity` | inject into `./lib/stardew-decompile-root.mjs` |
| `test:stardew-native-normal-player-ingress-register` | inject into `./lib/stardew-native-normal-player-ingress-control-slice.mjs` |
| `test:stardew-native-pathfinder-source` | inject into `./check-stardew-native-pathfinder-source.mjs` |
| `test:stardew-native-router-invocation-inventory` | inject into `./lib/stardew-native-router-invocation-inventory.mjs` |
| `test:stardew-native-source-closure` | inject into `./lib/stardew-native-source-closure.mjs` |
| `test:stardew-native-state-machine-family-register` | inject into `./lib/stardew-native-state-machine-family-register.mjs` |
| `test:stardew-native-tool-owner-slice` | a declaration mismatch the slice stops refusing (attempted; did not fire) — imports `./lib/stardew-native-tool-owner-slice.mjs` |
| `test:stardew-native-tool-update-dispatch-boundary` | inject into `./lib/stardew-native-tool-update-dispatch-boundary.mjs` |
| `test:stardew-native-transition-family-universe` | inject into `./lib/stardew-native-transition-family-universe.mjs` |
| `test:stardew-native-transition-ledger` | inject into `./lib/stardew-native-transition-ledger.mjs` |
| `test:stardew-native-virtual-member-invocation-register` | inject into `./lib/stardew-native-virtual-member-invocation-register.mjs` |
| `test:stardew-native-virtual-receiver-register` | inject into `./lib/stardew-native-virtual-receiver-register.mjs` |
| `test:stardew-player-command-equivalence-audit` | inject into `./lib/stardew-player-command-equivalence-audit.mjs` |
| `test:stardew-player-command-graph` | inject into `./lib/stardew-player-command-classification.mjs` |
| `test:stardew-player-reachable-exits` | inject into `../src/stardew-source-analysis-vocabulary.mjs` |
| `test:stardew-reachable-exits-reconciliation` | the artefact it reads |
| `test:stardew-receipt-attribution` | inject into `./check-stardew-receipt-attribution.mjs` |
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
| `test:tavern-release-prerequisites` | inject into `./check-tavern-release-prerequisites.mjs` |
| `test:test-store-teardown` | inject into `./check-test-store-teardown.mjs` |
| `test:tool-corpus` | a broken entry in its own corpus |
| `tools/check-chat-conversational-quality-gate.mjs` | an M0 that drifts across turns (proved today at its suite, see below) — imports `./check-chat-conversational-quality-gate.mjs` |

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

## What this batch registered

The twenty proofs in this batch (and the twenty before it) live as `red-proof:` markers in their own gate
files, and `tools/gate-red-proof-baseline.json` lost exactly those forty entries. Three further proofs were
made and deliberately not registered, because each one's marker file is also the sibling falsifier of a gate
in the tables above — one marker would close two gates and move the census by two:

| proved, held out | the line | what a marker there would also close |
| --- | --- | --- |
| `test:chat-conversational-quality-gate` | `✖ Prefix Bit-Stability: passes when M0 is 100% byte-for-byte identical across all turns` | `tools/check-chat-conversational-quality-gate.mjs` |
| `test:production-pack-load` | `✖ negative: transitive module broken in the loaded closure` | `check:production-pack-load` |
| `test:tavern-release-prerequisites` | `✖ Tavern prerequisite checker fails closed for malformed, timed-out, stderr, and nonzero live-gate results` | `check:tavern-release-prerequisites` |

They are the cheapest next move in the ledger: the injection and the line are already known, and closing both
halves with one honest marker is the correct reading of the audit's ownership rule.

Four suites cannot be given a baseline in this checkout today — `test:csharp-compile`,
`test:gameplay-capability-catalog`, `test:frontend-turn-gate`, `test:dialogue-web-boundaries` — because
another lane's in-flight work already makes them red for reasons that are not their own rules. They are in the
`provable` table with that stated on the row.
