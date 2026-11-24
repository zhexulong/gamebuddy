/**
 * The ladder's rung membership: which gates each pre-live rung runs, as DATA.
 *
 * WHY IT IS A MODULE OF ITS OWN. A rung's membership is one row per gate with the measurement that put it there, and
 * the tree publishes gates faster than the ladder stops growing: measured 2026-11-23, `tools/prelive.mjs` was 1720 lines
 * against the 1700-line `.mjs` ceiling in `tools/scripts/check-file-complexity-gate.mjs`, whose ratchet records any file
 * larger than the last recorded reading - so a one-line `L0_GATES` entry was refused by the ceiling rather than by the
 * schedule. What a rung DOES is code and stays in `tools/prelive.mjs`; what it RUNS is a table and lives here.
 *
 * DATA ONLY: no import, no function, no check. `tools/prelive.mjs` imports and re-exports the three lists below, so
 * `readSchedule`, `LADDER_RUNGS` and every consumer of the ladder module - `gates/meta/check-prelive-gate-registry.mjs`,
 * `tools/check-local-ci-parity.mjs`, `gates/meta/check-gate-populations.mjs` - read one declaration.
 */

/**
 * L0: the static gates that cost milliseconds, DELEGATED - each is a child process whose exit code is reported by
 * name. Reimplementing any of them here would give the same fact two spellings, and the copy would be the one that goes
 * stale.
 *
 * The last member is the registry (`gates/meta/check-prelive-gate-registry.mjs`): it derives the population of every gate in
 * the tree, reads the two lists below through `PRELUDE_RUNGS`, and fails naming any gate that neither runs here nor
 * declares where else it runs. It is in L0 because it costs milliseconds - and it must be, because a register nobody
 * runs is the defect it exists to catch.
 */
export const L0_GATES = Object.freeze([
  "gates/product/check-catalog-fact-ownership.mjs",
  "gates/stardew/audit-stardew-discovery-channels.mjs",
  // The consumer side of the same question: discovery asks whether the chain from the Mod to the tool description is
  // complete, and this one asks whether the model can ASK about the family at all - a description that names a family
  // consumes it while a full `observe` stays the only way to read its values.
  "gates/stardew/check-stardew-observation-consumers.mjs",
  // The prose half of the same question: the consumer gate asks whether the model can ASK about a published family,
  // and this one asks whether what the Mod publishes ever reaches the text she reads. Measured 2026-11-11:
  // `wateringCanFacts` was published with `water 36/40` in every observation of a run whose companion shook the can and
  // said `壶空了正好`, because no prose rendered the field and nothing asked whether one did. Milliseconds, five reads.
  "gates/product/check-snapshot-field-rendering.mjs",
  "gates/product/check-state-sentences.mjs",
  // The crop row's own gate: every field the engine's `Data/Crops` answer projects must be reachable from a snapshot
  // crop row or carry a stated reason, and the four copies of the row contract (Mod record, Host type, Host validator,
  // schema) must name the same keys. Milliseconds, source-only.
  "gates/stardew/check-stardew-crop-row-derivation.mjs",
  // NOT `audit-totality-head.mjs`: it is a module, not a command - it exports its classes and has no entry point,
  // so as a rung it exited 0 having examined nothing, which is how four blocking findings stayed invisible. The
  // module and its test still exist and are still exercised; the rung below runs the full audit, which has a CLI.
  "gates/stardew/check-stardew-fixture-action-coverage.mjs",
  "gates/meta/check-harness-conformance.mjs",
  "gates/stardew/check-stardew-task-action-coverage.mjs",
  // The other half of the same question: the coverage gate asks whether a rotation task NAMES an action, this one asks
  // whether the world that receives the day actually publishes the family the action addresses. Measured 2026-11-09:
  // `tend_the_animals` was rotated into a world whose coop had been switched off, and every gate stayed green.
  "gates/stardew/check-stardew-multiday-task-families.mjs",
  "gates/product/check-game-context-pressure.mjs",
  "gates/data/check-live-run-verdict-guards.mjs",
  "gates/product/check-failure-reason-codes.mjs",
  // The receipt's own provenance: every field whose name claims a physical transition (before/after/*_removed/delta)
  // must be computed from a value read in that execution, never a literal. Measured 2026-11-10: `till_soil` wrote
  // `before = "none"` without reading the tile, and `pickup_item` reported a chunk removal it had disproved.
  "gates/stardew/audit-stardew-receipt-transition-fields.mjs",
  // The type-level sibling of the totality question: a `switch` over a union must hand its impossible case to
  // `assertNever`, or a new member compiles and quietly answers with the fallback. Population is derived from
  // `dialogue-web/tsconfig.json`'s own `include`, so a new source file joins without an edit here. Authored
  // outside this lane and left untracked; wired here because a gate that runs in no rung cannot fail.
  "gates/arch/check-switch-exhaustiveness.mjs",
  // The other end of the same question, and the one three lanes were bitten by in a single night: a fact that crosses a
  // process or a package boundary is declared on both sides, and only one of the two spellings is under the compiler's
  // eye. The ack keys (nine in the launcher, eleven in the writer) killed every composed launch while every test was
  // green, and two game resolutions reached the panel as generic states because the fact they carried had no arm on the
  // consuming side. This one derives the vocabulary population from the sources and names each fact that has two ends,
  // so it costs ~2 s of file reads and no compile - cheap enough to run before a live run, which is the only place the
  // drift it catches would otherwise surface.
  "tools/check-fact-seams.mjs",
  // The destructive press, as a population rather than a habit. Five lanes each armed one control by hand (her
  // whole record, the connection that IS the credential, a reply, a world-book entry) and the sixth - the
  // companion's performance directive - stayed bare until this gate was written: a derived population of every
  // call whose name (or request field) destroys something on a durable Host route, each either behind
  // `useArmedConfirmation` or declared with the module that arms it and an expiry. 1.1 s measured here over the
  // workspace's own TypeScript program (the same parse `check-switch-exhaustiveness` already pays for), and it prints
  // `examined 6 · armed 3 · exempt 3` rather than a verdict over nothing.
  "tools/check-armed-destructive-actions.mjs",
  // The promotion pair. `check-stardew-action-promotion` already ran on every push in CI; the ladder runs it too
  // because it is the gate a lane reads as "may this action be visible to the Agent", and reading it 100 ms before a
  // live run is cheaper than discovering its verdict after one. Its sibling asks the other half of the question the
  // promotion tool's own header states ("a hand-written promotion row is not a row"): the catalog rung, the gate
  // row, the runner entry and the fixture scenario must already agree, so a hand edit that moves two of the four
  // names the half-write here instead of surfacing as a symptom three gates away.
  "gates/stardew/check-stardew-action-promotion.mjs",
  // The physical half of the same question: the promotion gate refuses a postcondition that names no engine fact, and
  // this one asks whether anything is ever MEASURED - the succeeded receipt must carry a before/after of the declared
  // member, in the Mod's handler or in the Host's completion-evidence contract. It reads the real handler source and
  // the real Host switch, so it costs a file read rather than a live run.
  "gates/stardew/check-stardew-postcondition-delta.mjs",
  "gates/stardew/check-stardew-promotion-parity.mjs",
  // The refusal-detail state set: one fact owned by the Mod's `MayCarryRefusalDetail`, projected by
  // `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES`. Measured 2026-11-11: the Host half of `15a3c57c` was never written, one
  // refused status frame closed the bridge, and the run's 7th turn was lost. Milliseconds, two file reads.
  "gates/product/check-refusal-detail-state-parity.mjs",
  // The field-level sibling of the two above, and the wider half of the same incident class: every field the Mod puts on
  // a frame it SENDS must be a name the Host's validators accept for that frame, and every field the Host declares on a
  // request must be readable by the Mod. Frames come from the Mod's own framing calls and fields from the C# declarations,
  // so a payload that grows a key is named here instead of closing the transport on the next live run. It blocks (exit 2)
  // on a frame it cannot pair instead of reporting a pass over the population it happened to measure, names the frames an
  // existing gate already owns (`snapshot`, `execution_receipt`) rather than checking them twice, and carries exactly one
  // frame exemption (`body_node_admission_grant`) with the owner who owes the pairing. Milliseconds, six file reads.
  "gates/product/check-cross-language-wire-parity.mjs",
  "integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs",
  "integrations/stardew/action-development/tests/action-projection-parity-drift.test.mjs",
  // The vendored patch set. `vendor/magic-context` is a pin we do not own, and the SillyTavern preset seam
  // lives in it as a patch file: when upstream moves a line the patch stops applying and the seam is simply
  // gone, with no compile error to notice it. Measured 1.0 s here (it copies the touched files into a temp
  // `git init` and applies there, never into `vendor/`), so it runs on the ladder rather than in a document -
  // the same reason the totality audit is in this rung.
  "gates/arch/check-vendor-patches-apply.mjs",
  // The plan's own legality, as a FIXPOINT over two of our rules rather than either one: every body-yielding action (the
  // compiler's exported declaration) crossed with every published action (the emitted surface) must either compile into a
  // program carrying both steps, or be refused with a remedy that compiles when written. Round42 spent four programs on
  // `talk_to_npc` -> `shop_purchase` and bought nothing; this rung costs a pure compilation per pair and names the pair,
  // the code and what would have to change. It imports the compiler and drives it, so it reads the product's own admission
  // and refusal functions instead of a fifth parser of plan vocabulary.
  "gates/product/check-plan-legal-fixpoint.mjs",
  // One number, two parties: the deadline a gate runner writes onto `execution_request` and the window the Mod admits.
  // Measured 2026-11-10: `fish_here` publishes 60 s, its runner wrote 120 s, and the action's first live slice came back
  // `bridge_rejected:invalid_deadline` after a game launch. Reads the Mod's own export (`action-deadline-windows.v1.json`)
  // against every runner's declared window, one file read per member, so it belongs in this rung rather than after a
  // launch: it is the check that would have refused the run in milliseconds.
  "gates/stardew/check-action-deadline-agreement.mjs",
  // The shipped persona prose is the product's identity, and nothing in this tree said so: two lanes rewrote
  // `default-companion/card.json` and `amber-deepseek-v4.1.json` inside one hour (2026-11-10), the second after the
  // first rewrite had been restored and the boundary stated in bold. This rung is the refusal - the working tree
  // against `HEAD`, so a rewrite is red before it is staged, and a change needs `[persona]` plus a line in
  // `assets/tavern/presets/PERSONA-REVISION.md` in the same commit. 2.0 s here (three git spawns, batched), and it
  // names the drifting field rather than a file.
  "gates/product/check-persona-prose.mjs",
  // Where a delivered line's CEILING comes from. The delivery cut every turn's speech at 80 characters - 77 with the
  // reaction sound - while the presentation transport carries 4,000 and the bubble clamps its own two lines with `…`;
  // measured on `round62` (90 turns carried text, 70 delivered a bubble), 18 turns lost their tails for it: 533 characters,
  // 26 whole sentences. Nothing read where the number came from, and the floor restated it, so the two agreed with each
  // other and neither agreed with the wire. This rung reads the bound, its three producers and the bubble's clamp, and
  // fails when a bound states a literal instead of resolving to the transport's declaration. Pure file reads.
  "gates/product/check-delivery-truncation-bound.mjs",
  // The FULL totality audit, because the place that could fail on its findings never did: CI runs it on every push with
  // `continue-on-error: true`, only so `--verbose` can be uploaded as an artifact, so a blocking finding reached nobody
  // - and this rung ran `audit-totality-head.mjs` above instead, whose entry guard is missing, so it exits 0 having
  // walked nothing. Measured 30.3 s inside the rung (92.4 s on a cold first run: the four classes it delegates spawn
  // `tsx` suites from `dialogue-web`), which is the most expensive member of this rung and the reason the number is
  // written here rather than left as a surprise: the run that put it in the ladder found four blocking findings - one
  // bounds pair and three ceilings a player could meet as a generic failure - and no other gate in any rung reports
  // that class.
  "gates/meta/audit-totality.mjs",
  // Cognitive complexity per FUNCTION and per CLASS-with-its-partials-merged, plus class size across partials, as a
  // ratchet over `tools/cognitive-complexity-baseline.json`. It belongs on the ladder because the ladder is what
  // a lane reads before trusting the tree, and a per-file measure cannot see `ExecutionManager`: 46
  // `farmhandexecutioncontroller*.cs` files holding one class declared 47 times, 4,771 complexity and 28,097 lines.
  // Measured 2026-11-13: 4.0-6.2 s here, of which Biome over `host/src` is ~1.8 s and 564 C# files through
  // tree-sitter is the rest, so the number is written down rather than left as a surprise in a rung whose name says
  // milliseconds. It reads the two source trees the rungs already cover; nothing it needs comes from a game install.
  "gates/arch/check-cognitive-complexity.mjs",
  // The duplication rule, for which this tree had a REPORT and no gate: `jscpd` was installed, configured with
  // `exitCode: 0`, never tokenised the C# Mod, and no rung ran it. It fails on one block of >= 40 tokens at >= 3 sites
  // whatever share of the tree that is, because a percentage is what let the eight-step admission pipeline repeated
  // under 24 method names in `integrations/stardew/farmhandexecutioncontroller.*.cs` read as "10.9% duplicated" and
  // therefore fine. ~1 s warm (4.3 s on a cold file cache), one child process, no network, no game.
  "gates/arch/check-code-duplication.mjs",
  // A terminal commit is ONE place: `ExecutionManager.RememberTerminal`. Measured here: `sites examined 917 · through the
  // seam 917 · exempt 6 · families 46`, 0.1 s. No rung read this population before, so the hand-rolled
  // `this.Remember(receipt); this.AddTrace(receipt);` this gate exists for could re-enter the tree with every other gate
  // green - and each of the four facts the seam guarantees (the bound action identity, the published fact, the trace
  // revision, the `body_idle`) has already been dropped by a copy at least once.
  "gates/stardew/check-terminal-commit-single-entry.mjs",
  // The third act of that seam, which nothing measured: a store-and-publish pair that says nothing about the body being
  // free again. It reuses the scan above (one file), and prints the 910 seam calls standing outside its own population
  // rather than folding them into a pass. Measured here: `sites examined 7 · silent 1`, one exemption in the ratchet, 0.1 s.
  "gates/stardew/check-terminal-idle-publication.mjs",
  // The four process-wide facts no compiler can hold, and the readings that make each one a population rather than a
  // habit: production `process.env`/`process.chdir` writes must be save/restore pairs (14 env writes and 2 chdir moves
  // measured, all restored) with `process.on` paired by a removal; module-scope strong collections need a drain or a
  // declared row (235 collection initialisers over 3790 declarations, 100 mutated); a writable `new DatabaseSync` must be
  // opened by one of three named containers that put `busy_timeout` in force before their first `prepare(` (9 production
  // connections); and a `work: () => T` section helper must refuse a thenable, because the signature cannot (`28`
  // helpers, 22 awaiting and 6 synchronous, 165 `async` call sites all held). 2.5 s over 854 Host files through one parse
  // cache - cheap enough for this rung, and it refuses a zero population for each of the four.
  "gates/arch/check-concurrency-hygiene.mjs",
  // The Host test corpus read as SOURCE rather than run: an assertion that matches two code tokens across literal
  // whitespace measures where the formatter put the line breaks, and a reformat turns it red with the product unchanged
  // (measured 2026-11-12, `contained-game-runtime.internal.test.ts:205`). Measured here: `matches examined 142 · through
  // the shape reader 142 · through raw text 0`, 400 test files, 0.9 s through the workspace's `typescript`.
  "gates/arch/check-source-shape-readers.mjs",
  // The hang the corpus can write that no assertion sees: an `await` on a promise a listener settles, with no deadline.
  // Measured 2026-11-12: one such await ran a suite to its 600 s budget while the other thirty tests in the same file
  // summed 391 ms, and a hang reports nothing. Measured here: `awaits examined 12 · with a deadline 12`, 426 test files,
  // 1.2 s.
  "gates/data/check-test-await-deadlines.mjs",
  // The third reading of the same corpus, and the one that was switched off for two days because it could not tell a
  // fixture from a population: a test that freezes a product's size with a literal (`Object.keys(TABLE).length === 12`)
  // fails when the product grows, and the failure names a number instead of the member. Measured here 2026-11-13:
  // `examined 983 sites 110 findings 0 baseline 95 unread 1`, residual by shape `6 declaration_site · 35 call_result ·
  // 69 unresolved`, with 1099 counts set aside as the test's own construction and 23 as text. The judgement is the
  // counted value's provenance, and the 110 survivors are recorded in `tools/derived-population-baseline.json` under a
  // ratchet that fails on a new site AND on a stale entry, so this rung cannot drift back to `violations 1222`.
  "gates/data/check-derived-population.mjs",
  // The leak, measured: 787 Node crash reports in the repository root, 238 of them carrying a plaintext credential,
  // because `NODE_OPTIONS` on this machine fires a report into every dying child's cwd. The `.gitignore` entry that
  // covered the root is not containment - this gate reads the disk at any depth and names the variable, never the
  // value. Milliseconds here after the walk's concurrency: 591 ms for 113,061 files.
  "gates/data/check-crash-report-containment.mjs",
  // A gate that cannot tell "I measured nothing" from "I measured and found nothing" is the class behind every false
  // reading this tree published this month: `check:publint` passed having read no publint message, the soil-itm canary
  // reported a pass over five skips, and the wire parity gate printed six frames it could not pair BELOW a `passed`
  // verdict. Each was fixed on its own and nothing asked the question of the next gate. This one asks it of every gate
  // in the derivation (342 today, 55 of them recorded silent in `tools/gate-population-baseline.json`) by reading each
  // gate's own report contract - milliseconds, no child process - so a new gate that says nothing about its population
  // is red here instead of green in a rung.
  "gates/meta/check-gate-populations.mjs",
  // The artefact census: every file in the tree that SAYS it is generated, paired with the tool or Mod export that emits
  // it, re-derived into a temp path and compared byte for byte. Measured 2026-11-13 before it was wired: the projection
  // producer reproduces its 180 614 bytes in 88 ms, the Mod export DLL reproduces all three of its artefacts in 600 ms,
  // and the register's derive tool reproduces its 81 835 bytes in 262 ms inside the sandbox. Items whose declared inputs
  // have not moved are not re-derived (`not_re_derived:inputs_unchanged`) and are still named in the population; the one
  // artefact whose only writer is an xunit export test is its own bucket (`declared_by_test`), never a pass. This rung
  // exists because three files were found stale in two days and each time the reader diffed a hundred kilobytes by hand:
  // a hand-edited register its derive tool refused, a surface regenerated while a declaration lagged, and a projection
  // that drifted by three lines whose only signal was `180614 !== 180548`. Measured 0.7 s here (three `dotnet`
  // invocations and one sandboxed derive), so it runs on the ladder rather than in a document a lane reads afterwards.
  "gates/data/check-generated-artifact-reproducibility.mjs",
  // The discovery half nothing measured: every family that drops a subject on a state the hold vocabulary names must
  // publish the reason it withheld it. Measured here 2026-11-13 at 449f0fb0: `discoveries 87, with exclusions 16,
  // filters without a reason 5 (filed 5)`, 0.3 s, worktree only - and it already answers `examined 0` with
  // `stardew_discovery_exclusions_skipped:`, which is the dialect this rung reads as UNAVAILABLE.
  "gates/stardew/check-stardew-discovery-exclusions.mjs",
  "gates/meta/check-prelive-gate-registry.mjs",
  // The five instance family of one two days: a thing the companion can SAY that one layer accepts and the next refuses or
  // silently reinterprets - `charge` on the wire but not in the tool schema, `sweep_scythe` in three surfaces and no mount,
  // `for_each` sources, an emote the prompt named and nothing mounted, a `refusalDetail` the Mod sent and the Host refused.
  // Each was found by a human noticing; the two pairs that got a gate were the ones someone was looking at. This one is the
  // matrix: the catalog crossed with the six surfaces that must carry each action, from each surface's own authority, with
  // every silent omission named and every unreadable reading blocked instead of green. Measured here: `actions examined 106 ·
  // surfaces 6 · pairs checked 307`, 0.1 s of file reads and no child process.
  "gates/stardew/check-action-surface-parity.mjs",
  // The bounds half of that matrix, and the one nothing read: a hand-written tool schema states a whole-number range for
  // an action argument, the Mod publishes the range it accepts, and the two are two authorities unless something compares
  // them. Measured where the missing comparison already cost a live coordinate: the Host learned `x`/`y`'s floor by
  // PROBING its own predicate, answered `0..1000`, and refused `-1` - the only tile an edge exit names
  // (`FarmhandWarpCoordinateRange.MinimumSourceCoordinate`, `Town`'s own `-1 53 BusStop`). Measured here 2026-11-24:
  // `arguments examined 197 · declared-only 56 · hand-written-only 0 · disagreeing 0 · agreed 141 · unreadable 0`, 0.2 s
  // (one TypeScript parse of `host/src/game-tools.ts`), and red on both injected shapes - the walk-target constant on a
  // warp source, and a bound the declaration does not state.
  "gates/stardew/check-action-argument-bound-parity.mjs",
  // The artifact is not the wire, and nothing ran the reader the package already owns: measured 2026-11-25, the Mod
  // published a 595-character argument sentence, the Host refused that ONE descriptor and with it the WHOLE hello_ack
  // registration list, and the artifact reader had been refusing that artifact all along (`invalid_action`) - no rung
  // ran it, so nothing noticed until a live run died at the attach.
  "gates/stardew/check-action-surface-artifact.mjs",
  // NOT listed again here: `tools/check-armed-destructive-actions.mjs` is already three members up, with the
  // measurement that put it in this rung. A second entry is a gate that runs twice - `rung_member_duplicated`.
  // One declaration for the Mod bundle: the project's own outputs (`<AssemblyName>`, each `<ProjectReference>`'s
  // assembly, the `<None Update>` copies and the dependency file) cross-checked against
  // `integrations/stardew/bundle.manifest.json`, which is what the Host deploys. Measured 2026-11-21: `declarations
  // examined 4 · manifest entries 4 · built outputs examined 2 · findings 0`, 60 ms, no install, no build and no game -
  // a renamed output that only this gate compares otherwise surfaces as a deployed Mod SMAPI will not load, at the end
  // of a 150 s launch that names nothing.
  "gates/stardew/check-stardew-bundle-manifest.mjs",
]);

/**
 * L0b: everything that recomputes the Stardew action inventory from the decompiled tree, which is the expensive input
 * and the one a bare checkout has not got. ~40 s for the first two, and all four are measurements the ladder previously
 * did not make at all: the projection drift tests are pure recomputation of checked-in artifacts, the observation-gap
 * report's `--fail-on-ungranted` flag was written and never armed, and the other two decide the hold algebra and the
 * reach constants against the engine's own source.
 *
 * The input is the reason this is a rung of its own: `ref/external/StardewValleyDecompiled` is a gitignored mount, so
 * each member must say it measured nothing on a checkout that has not got it - `*_skipped:` on stdout, exit 2 (this
 * repository's blocked code), which `runGateRung` reports as UNAVAILABLE rather than red.
 */
export const L0B_GATES = Object.freeze([
  "integrations/stardew/action-development/tests/stardew-action-inventory-reconciliation.test.mjs",
  "gates/stardew/check-stardew-observation-gap.mjs",
  // The hold algebra over `ActorWorldFacts`: every member has a row, publishes the kind `WorldModel.Classify` decides,
  // resolves in the engine, releases where the row says, and every `canMove = false` write is accompanied by a holding
  // write of a declared read or carries an adjudicated residual row. Green here 2026-11-13 at 449f0fb0: `examined 15`,
  // IFACE-1 16 reads resolved, IFACE-2 `scanned 948 files: 58 writes of the move flag, 42 accompanied, 16 orphans, 4
  // unparsed`, 1.5 s. It absorbed `check-stardew-hold-sufficiency`'s CLI, whose whole measurement was its IFACE-2.
  "gates/stardew/check-stardew-actor-admissibility.mjs",
  // The reach-bound half: a numeric bound in an admission predicate must be the engine's number, or sit in an expiring
  // `STATED_DEBT` row. Green here 2026-11-13 at 449f0fb0: `constants examined 72 · engine-cited 68 · debt 4 · invented
  // 0`, 0.6 s. This is the class behind the round-42 shop refusal - a reach our predicate invented - and it is the only
  // gate in the tree that compares our number against the engine's by reading the engine's line.
  "gates/stardew/check-stardew-invented-gates.mjs",
]);

/**
 * The gate rungs as data. `gates/meta/check-prelive-gate-registry.mjs` imports THIS, not a regex over this file: the ladder's
 * own declaration is the authority for what prelive runs, so wiring a gate is one edit in one place.
 */
export const PRELUDE_RUNGS = Object.freeze([
  { id: "l0", gates: L0_GATES },
  { id: "l0b", gates: L0B_GATES },
]);
