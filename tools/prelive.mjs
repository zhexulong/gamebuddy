#!/usr/bin/env node
/**
 * The static half of the pre-live ladder: every reason a live run can die that is visible in the tree, in seconds,
 * naming the drifting member.
 *
 * WHY: five live runs died in one day from causes that were detectable before a single model token was spent - an
 * action whose runner exists but whose fixture scenario the Mod cannot arm, a mod bundle deployed into the Steam
 * install, and a runner that treated a warp in flight as a world that cannot be acted on. Each of those is a
 * cross-file linkage, so no single gate owned it. This one does, and it fails loudly here instead of in the game.
 *
 * RUNGS (each stops the ladder on red, so the first line of a failure is the cause):
 *   prep Mod export build  - `dotnet build <the export project> -c Release`, the one preparation the artefact gate in L0
 *                             needs: the producer it runs is a build output, and a checkout nobody has built has none, so
 *                             that gate blocks (exit 2) until it exists. The build runs only when something asks for it -
 *                             no build output at all, or an artefact input newer than the artefact, both read from the
 *                             gate's own declaration - because its inputs are the WHOLE Mod compile while the gate
 *                             re-derives from five files: a lane editing a handler otherwise pays a ~300 s compile for a
 *                             gate that then prints `not_re_derived:inputs_unchanged`. See `modExportBuildPreparation`.
 *                             `dotnet` absent is UNAVAILABLE here and the gate names what it could not run.
 *   L0  contract triad      - measured 2026-11-13 at 449f0fb0: 52.7 s over 38 gates, one child process each, every
 *                             exit code reported by name. The "5.3 s" this line carried was two orders of magnitude
 *                             stale, and the reason is visible in the same run: `check-harness-conformance` alone is
 *                             27.9 s (it spawns every gate whose default run prints a report) and `audit-totality`
 *                             8.9 s, so the rung's cost is two members rather than its thirty-eight. It ends with
 *                             `tools/check-prelive-gate-registry.mjs`, which
 *                             derives the population of every gate in the tree and fails when one of them neither runs
 *                             here nor names where else it runs - so a gate added to this list, or left out of it, is a
 *                             fact this rung states rather than a habit someone remembers.
 *   L0b action tree         - measured 2026-11-05: 37.8 s + 29.4 s = 67 s under a concurrent Host build, ~40 s on an
 *                             idle box. The two members that recompute the Stardew action inventory from
 *                             `ref/external/StardewValleyDecompiled` and `design/`: the inventory reconciliation suite and
 *                             the observation-gap report armed with `--fail-on-ungranted`. This is one of the two
 *                             expensive rungs (L2's compile is the other, measured 84 s) - `--skip-compile` drops L2's
 *                             half, and nothing yet drops this one, which is stated here rather than hidden. It is also
 *                             the rung that needs an input a bare checkout has not got: the observation-gap member
 *                             prints `observation_gap_skipped: needs ref/external/...` and is reported UNAVAILABLE -
 *                             counted, named, never green.
 *   L1  linkage closure     - action ids x runner map x tools-side scenario x Mod-side scenario, DERIVED not listed
 *   L1b deploy isolation    - the launcher's resolved deploy root must not be inside the game installation
 *   L2  compile + agreement - the Host test artifact builds, and every action population names the same ids
 *   L3  runner shape        - a one-shot `observeFresh({actionable:true})` may not be the basis of an assertion
 *   L4  action preflight    - only with `--action <id> --game`; delegates to `tools/preflight-live-run.mjs`
 *
 * USAGE:
 *   node tools/prelive.mjs --no-game                       # L0 + L0b + L1 + L1b + L2 + L3 (L0b and L2 are the slow rungs)
 *   node tools/prelive.mjs --no-game --skip-compile        # the same, without the Host build
 *   node tools/prelive.mjs --action <id>                    # the same, then `l4_skipped: needs --game`
 *   node tools/prelive.mjs --action <id> --game             # the same, then L4 for that action
 *
 * No game, no network, no model. Exit 1 on the first red rung.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTEFACT_PRODUCERS, inputsMovedSince } from "./check-generated-artifact-reproducibility.mjs";
import { containedChildEnvironment } from "./lib/crash-report-containment.mjs";
import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { fixtureActions, fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";
import { GATE_EXEMPT_PUBLISHED_ACTIONS } from "./lib/stardew-published-action-registry.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = path.join(REPO, "tools");

/** The launcher's default game installation (`tools/live-run/game/launch-ladder-live.mjs`). */
export const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";

/**
 * L0: the static gates that cost milliseconds, DELEGATED - each is a child process whose exit code is reported by
 * name. Reimplementing any of them here would give the same fact two spellings, and the copy would be the one that goes
 * stale.
 *
 * The last member is the registry (`tools/check-prelive-gate-registry.mjs`): it derives the population of every gate in
 * the tree, reads the two lists below through `PRELUDE_RUNGS`, and fails naming any gate that neither runs here nor
 * declares where else it runs. It is in L0 because it costs milliseconds - and it must be, because a register nobody
 * runs is the defect it exists to catch.
 */
export const L0_GATES = Object.freeze([
  "tools/check-catalog-fact-ownership.mjs",
  "tools/audit-stardew-discovery-channels.mjs",
  // The consumer side of the same question: discovery asks whether the chain from the Mod to the tool description is
  // complete, and this one asks whether the model can ASK about the family at all - a description that names a family
  // consumes it while a full `observe` stays the only way to read its values.
  "tools/check-stardew-observation-consumers.mjs",
  // The prose half of the same question: the consumer gate asks whether the model can ASK about a published family,
  // and this one asks whether what the Mod publishes ever reaches the text she reads. Measured 2026-11-11:
  // `wateringCanFacts` was published with `water 36/40` in every observation of a run whose companion shook the can and
  // said `壶空了正好`, because no prose rendered the field and nothing asked whether one did. Milliseconds, five reads.
  "tools/check-snapshot-field-rendering.mjs",
  // The crop row's own gate: every field the engine's `Data/Crops` answer projects must be reachable from a snapshot
  // crop row or carry a stated reason, and the four copies of the row contract (Mod record, Host type, Host validator,
  // schema) must name the same keys. Milliseconds, source-only.
  "tools/check-stardew-crop-row-derivation.mjs",
  // NOT `audit-totality-head.mjs`: it is a module, not a command - it exports its classes and has no entry point,
  // so as a rung it exited 0 having examined nothing, which is how four blocking findings stayed invisible. The
  // module and its test still exist and are still exercised; the rung below runs the full audit, which has a CLI.
  "tools/check-stardew-fixture-action-coverage.mjs",
  "tools/check-harness-conformance.mjs",
  "tools/check-stardew-task-action-coverage.mjs",
  // The other half of the same question: the coverage gate asks whether a rotation task NAMES an action, this one asks
  // whether the world that receives the day actually publishes the family the action addresses. Measured 2026-11-09:
  // `tend_the_animals` was rotated into a world whose coop had been switched off, and every gate stayed green.
  "tools/check-stardew-multiday-task-families.mjs",
  "tools/check-game-context-pressure.mjs",
  "tools/check-live-run-verdict-guards.mjs",
  "tools/check-failure-reason-codes.mjs",
  // The receipt's own provenance: every field whose name claims a physical transition (before/after/*_removed/delta)
  // must be computed from a value read in that execution, never a literal. Measured 2026-11-10: `till_soil` wrote
  // `before = "none"` without reading the tile, and `pickup_item` reported a chunk removal it had disproved.
  "tools/audit-stardew-receipt-transition-fields.mjs",
  // The type-level sibling of the totality question: a `switch` over a union must hand its impossible case to
  // `assertNever`, or a new member compiles and quietly answers with the fallback. Population is derived from
  // `dialogue-web/tsconfig.json`'s own `include`, so a new source file joins without an edit here. Authored
  // outside this lane and left untracked; wired here because a gate that runs in no rung cannot fail.
  "tools/check-switch-exhaustiveness.mjs",
  // The promotion pair. `check-stardew-action-promotion` already ran on every push in CI; the ladder runs it too
  // because it is the gate a lane reads as "may this action be visible to the Agent", and reading it 100 ms before a
  // live run is cheaper than discovering its verdict after one. Its sibling asks the other half of the question the
  // promotion tool's own header states ("a hand-written promotion row is not a row"): the catalog rung, the gate
  // row, the runner entry and the fixture scenario must already agree, so a hand edit that moves two of the four
  // names the half-write here instead of surfacing as a symptom three gates away.
  "tools/check-stardew-action-promotion.mjs",
  // The physical half of the same question: the promotion gate refuses a postcondition that names no engine fact, and
  // this one asks whether anything is ever MEASURED - the succeeded receipt must carry a before/after of the declared
  // member, in the Mod's handler or in the Host's completion-evidence contract. It reads the real handler source and
  // the real Host switch, so it costs a file read rather than a live run.
  "tools/check-stardew-postcondition-delta.mjs",
  "tools/check-stardew-promotion-parity.mjs",
  // The refusal-detail state set: one fact owned by the Mod's `MayCarryRefusalDetail`, projected by
  // `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES`. Measured 2026-11-11: the Host half of `15a3c57c` was never written, one
  // refused status frame closed the bridge, and the run's 7th turn was lost. Milliseconds, two file reads.
  "tools/check-refusal-detail-state-parity.mjs",
  // The field-level sibling of the two above, and the wider half of the same incident class: every field the Mod puts on
  // a frame it SENDS must be a name the Host's validators accept for that frame, and every field the Host declares on a
  // request must be readable by the Mod. Frames come from the Mod's own framing calls and fields from the C# declarations,
  // so a payload that grows a key is named here instead of closing the transport on the next live run. It blocks (exit 2)
  // on a frame it cannot pair instead of reporting a pass over the population it happened to measure, names the frames an
  // existing gate already owns (`snapshot`, `execution_receipt`) rather than checking them twice, and carries exactly one
  // frame exemption (`body_node_admission_grant`) with the owner who owes the pairing. Milliseconds, six file reads.
  "tools/check-cross-language-wire-parity.mjs",
  "integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs",
  "integrations/stardew/action-development/tests/action-projection-parity-drift.test.mjs",
  // The vendored patch set. `vendor/magic-context` is a pin we do not own, and the SillyTavern preset seam
  // lives in it as a patch file: when upstream moves a line the patch stops applying and the seam is simply
  // gone, with no compile error to notice it. Measured 1.0 s here (it copies the touched files into a temp
  // `git init` and applies there, never into `vendor/`), so it runs on the ladder rather than in a document -
  // the same reason the totality audit is in this rung.
  "tools/check-vendor-patches-apply.mjs",
  // The plan's own legality, as a FIXPOINT over two of our rules rather than either one: every body-yielding action (the
  // compiler's exported declaration) crossed with every published action (the emitted surface) must either compile into a
  // program carrying both steps, or be refused with a remedy that compiles when written. Round42 spent four programs on
  // `talk_to_npc` -> `shop_purchase` and bought nothing; this rung costs a pure compilation per pair and names the pair,
  // the code and what would have to change. It imports the compiler and drives it, so it reads the product's own admission
  // and refusal functions instead of a fifth parser of plan vocabulary.
  "tools/check-plan-legal-fixpoint.mjs",
  // One number, two parties: the deadline a gate runner writes onto `execution_request` and the window the Mod admits.
  // Measured 2026-11-10: `fish_here` publishes 60 s, its runner wrote 120 s, and the action's first live slice came back
  // `bridge_rejected:invalid_deadline` after a game launch. Reads the Mod's own export (`action-deadline-windows.v1.json`)
  // against every runner's declared window, one file read per member, so it belongs in this rung rather than after a
  // launch: it is the check that would have refused the run in milliseconds.
  "tools/check-action-deadline-agreement.mjs",
  // The shipped persona prose is the product's identity, and nothing in this tree said so: two lanes rewrote
  // `default-companion/card.json` and `amber-deepseek-v4.1.json` inside one hour (2026-11-10), the second after the
  // first rewrite had been restored and the boundary stated in bold. This rung is the refusal - the working tree
  // against `HEAD`, so a rewrite is red before it is staged, and a change needs `[persona]` plus a line in
  // `assets/tavern/presets/PERSONA-REVISION.md` in the same commit. 2.0 s here (three git spawns, batched), and it
  // names the drifting field rather than a file.
  "tools/check-persona-prose.mjs",
  // The Game floor's own composition, classified rule by rule: FLOOR (what she must never do), CHANNEL (how to operate
  // the surface) or FORM (how long a turn is, how many beats it carries - the card's, so a FORM rule is deleted). It runs
  // here because its defect is invisible everywhere else: the rule it was built for (`Speak before you act ... never run
  // tools in total silence`) was reviewed, shipped, and answered with 132 bubbles over 93 prompt turns - 90 of them
  // standalone speech with no tool call - before anyone asked what KIND of rule it was. Pure file reads, milliseconds.
  "tools/check-game-surface-conduct-classes.mjs",
  // The FULL totality audit, because the place that could fail on its findings never did: CI runs it on every push with
  // `continue-on-error: true`, only so `--verbose` can be uploaded as an artifact, so a blocking finding reached nobody
  // - and this rung ran `audit-totality-head.mjs` above instead, whose entry guard is missing, so it exits 0 having
  // walked nothing. Measured 30.3 s inside the rung (92.4 s on a cold first run: the four classes it delegates spawn
  // `tsx` suites from `dialogue-web`), which is the most expensive member of this rung and the reason the number is
  // written here rather than left as a surprise: the run that put it in the ladder found four blocking findings - one
  // bounds pair and three ceilings a player could meet as a generic failure - and no other gate in any rung reports
  // that class.
  "tools/audit-totality.mjs",
  // Cognitive complexity per FUNCTION and per CLASS-with-its-partials-merged, plus class size across partials, as a
  // ratchet over `tools/cognitive-complexity-baseline.json`. It belongs on the ladder because the ladder is what
  // a lane reads before trusting the tree, and a per-file measure cannot see `ExecutionManager`: 46
  // `farmhandexecutioncontroller*.cs` files holding one class declared 47 times, 4,771 complexity and 28,097 lines.
  // Measured 2026-11-13: 4.0-6.2 s here, of which Biome over `host/src` is ~1.8 s and 564 C# files through
  // tree-sitter is the rest, so the number is written down rather than left as a surprise in a rung whose name says
  // milliseconds. It reads the two source trees the rungs already cover; nothing it needs comes from a game install.
  "tools/check-cognitive-complexity.mjs",
  // The duplication rule, for which this tree had a REPORT and no gate: `jscpd` was installed, configured with
  // `exitCode: 0`, never tokenised the C# Mod, and no rung ran it. It fails on one block of >= 40 tokens at >= 3 sites
  // whatever share of the tree that is, because a percentage is what let the eight-step admission pipeline repeated
  // under 24 method names in `integrations/stardew/farmhandexecutioncontroller.*.cs` read as "10.9% duplicated" and
  // therefore fine. ~1 s warm (4.3 s on a cold file cache), one child process, no network, no game.
  "tools/check-code-duplication.mjs",
  // A terminal commit is ONE place: `ExecutionManager.RememberTerminal`. Measured here: `sites examined 917 · through the
  // seam 917 · exempt 6 · families 46`, 0.1 s. No rung read this population before, so the hand-rolled
  // `this.Remember(receipt); this.AddTrace(receipt);` this gate exists for could re-enter the tree with every other gate
  // green - and each of the four facts the seam guarantees (the bound action identity, the published fact, the trace
  // revision, the `body_idle`) has already been dropped by a copy at least once.
  "tools/check-terminal-commit-single-entry.mjs",
  // The third act of that seam, which nothing measured: a store-and-publish pair that says nothing about the body being
  // free again. It reuses the scan above (one file), and prints the 910 seam calls standing outside its own population
  // rather than folding them into a pass. Measured here: `sites examined 7 · silent 1`, one exemption in the ratchet, 0.1 s.
  "tools/check-terminal-idle-publication.mjs",
  // The Host test corpus read as SOURCE rather than run: an assertion that matches two code tokens across literal
  // whitespace measures where the formatter put the line breaks, and a reformat turns it red with the product unchanged
  // (measured 2026-11-12, `contained-game-runtime.internal.test.ts:205`). Measured here: `matches examined 142 · through
  // the shape reader 142 · through raw text 0`, 400 test files, 0.9 s through the workspace's `typescript`.
  "tools/check-source-shape-readers.mjs",
  // The hang the corpus can write that no assertion sees: an `await` on a promise a listener settles, with no deadline.
  // Measured 2026-11-12: one such await ran a suite to its 600 s budget while the other thirty tests in the same file
  // summed 391 ms, and a hang reports nothing. Measured here: `awaits examined 12 · with a deadline 12`, 426 test files,
  // 1.2 s.
  "tools/check-test-await-deadlines.mjs",
  // The third reading of the same corpus, and the one that was switched off for two days because it could not tell a
  // fixture from a population: a test that freezes a product's size with a literal (`Object.keys(TABLE).length === 12`)
  // fails when the product grows, and the failure names a number instead of the member. Measured here 2026-11-13:
  // `examined 983 sites 110 findings 0 baseline 95 unread 1`, residual by shape `6 declaration_site · 35 call_result ·
  // 69 unresolved`, with 1099 counts set aside as the test's own construction and 23 as text. The judgement is the
  // counted value's provenance, and the 110 survivors are recorded in `tools/derived-population-baseline.json` under a
  // ratchet that fails on a new site AND on a stale entry, so this rung cannot drift back to `violations 1222`.
  "tools/check-derived-population.mjs",
  // The leak, measured: 787 Node crash reports in the repository root, 238 of them carrying a plaintext credential,
  // because `NODE_OPTIONS` on this machine fires a report into every dying child's cwd. The `.gitignore` entry that
  // covered the root is not containment - this gate reads the disk at any depth and names the variable, never the
  // value. Milliseconds here after the walk's concurrency: 591 ms for 113,061 files.
  "tools/check-crash-report-containment.mjs",
  // A gate that cannot tell "I measured nothing" from "I measured and found nothing" is the class behind every false
  // reading this tree published this month: `check:publint` passed having read no publint message, the soil-itm canary
  // reported a pass over five skips, and the wire parity gate printed six frames it could not pair BELOW a `passed`
  // verdict. Each was fixed on its own and nothing asked the question of the next gate. This one asks it of every gate
  // in the derivation (342 today, 55 of them recorded silent in `tools/gate-population-baseline.json`) by reading each
  // gate's own report contract - milliseconds, no child process - so a new gate that says nothing about its population
  // is red here instead of green in a rung.
  "tools/check-gate-populations.mjs",
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
  "tools/check-generated-artifact-reproducibility.mjs",
  // The discovery half nothing measured: every family that drops a subject on a state the hold vocabulary names must
  // publish the reason it withheld it. Measured here 2026-11-13 at 449f0fb0: `discoveries 87, with exclusions 16,
  // filters without a reason 5 (filed 5)`, 0.3 s, worktree only - and it already answers `examined 0` with
  // `stardew_discovery_exclusions_skipped:`, which is the dialect this rung reads as UNAVAILABLE.
  "tools/check-stardew-discovery-exclusions.mjs",
  "tools/check-prelive-gate-registry.mjs",
  // The five instance family of one two days: a thing the companion can SAY that one layer accepts and the next refuses or
  // silently reinterprets - `charge` on the wire but not in the tool schema, `sweep_scythe` in three surfaces and no mount,
  // `for_each` sources, an emote the prompt named and nothing mounted, a `refusalDetail` the Mod sent and the Host refused.
  // Each was found by a human noticing; the two pairs that got a gate were the ones someone was looking at. This one is the
  // matrix: the catalog crossed with the six surfaces that must carry each action, from each surface's own authority, with
  // every silent omission named and every unreadable reading blocked instead of green. Measured here: `actions examined 106 ·
  // surfaces 6 · pairs checked 307`, 0.1 s of file reads and no child process.
  "tools/check-action-surface-parity.mjs",
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
  "tools/check-stardew-observation-gap.mjs",
  // The hold algebra over `ActorWorldFacts`: every member has a row, publishes the kind `WorldModel.Classify` decides,
  // resolves in the engine, releases where the row says, and every `canMove = false` write is accompanied by a holding
  // write of a declared read or carries an adjudicated residual row. Green here 2026-11-13 at 449f0fb0: `examined 15`,
  // IFACE-1 16 reads resolved, IFACE-2 `scanned 948 files: 58 writes of the move flag, 42 accompanied, 16 orphans, 4
  // unparsed`, 1.5 s. It absorbed `check-stardew-hold-sufficiency`'s CLI, whose whole measurement was its IFACE-2.
  "tools/check-stardew-actor-admissibility.mjs",
  // The reach-bound half: a numeric bound in an admission predicate must be the engine's number, or sit in an expiring
  // `STATED_DEBT` row. Green here 2026-11-13 at 449f0fb0: `constants examined 72 · engine-cited 68 · debt 4 · invented
  // 0`, 0.6 s. This is the class behind the round-42 shop refusal - a reach our predicate invented - and it is the only
  // gate in the tree that compares our number against the engine's by reading the engine's line.
  "tools/check-stardew-invented-gates.mjs",
]);

/**
 * The gate rungs as data. `tools/check-prelive-gate-registry.mjs` imports THIS, not a regex over this file: the ladder's
 * own declaration is the authority for what prelive runs, so wiring a gate is one edit in one place.
 */
export const PRELUDE_RUNGS = Object.freeze([
  { id: "l0", gates: L0_GATES },
  { id: "l0b", gates: L0B_GATES },
]);

/**
 * How a gate says it measured nothing, in the convention `tools/check-ci-coverage.mjs` already counts: a whole line whose
 * marker ends in `_skipped`. A gate that prints one has exited cleanly without comparing anything, so this ladder reports
 * it UNAVAILABLE and counts it apart from the gates that passed. The rule is the marker, not a list of gate names.
 */
export const NOT_MEASURED_MARKER = /^[a-z][a-z0-9_]*_skipped:/mu;

const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const MOD_CONFIG = "integrations/stardew/ModConfig.cs";
const ACTION_REGISTRY = "host/src/action-registry.ts";
/** The body of `npm run build:test` in `host/package.json`; run from `host/`, which is that script's cwd. */
const HOST_TEST_ARTIFACT_BUILD = "scripts/build-test-artifact.mjs";
const HOST_TYPESCRIPT_ENTRY = "host/node_modules/typescript/lib/tsc.js";
const HARNESS_LIB = "tools/lib/stardew-native-smoke-harness-v1.mjs";
const BASELINE = "tools/prelive-l3-baseline.json";

/**
 * L1 rule (e): a runner key that legitimately resolves to NO fixture scenario, with the reason. Silence is not
 * allowed - an empty scenario is indistinguishable from a missing branch, so every empty has to be argued here.
 */
export const NO_SCENARIO_REASON = Object.freeze({
  // `move_placed_furniture` left this table when its promotion gave it a scenario: the freshRow witness
  // (`placed_furniture_picked_up`) now comes from a fixture that places the piece itself, so the ordinary-world
  // reason stopped being true. The gate that says so is `rule a` itself, which is why this entry is gone rather
  // than reworded.
  scene_reachable_probe:
    "its only action is read-only `observe_scene`; the probe measures reachability of the ordinary world from the " +
    "actor's own start tile and provisions no fixture fact",
});

/** Fields a snapshot carries that no actionability fence can falsify: asserting only these is not the defect. */
const ACTIONABILITY_INDEPENDENT_FIELDS = Object.freeze(["capabilities"]);

const RULE_LABELS = Object.freeze({
  "a:no_scenario_undeclared": "rule a - runner has no tools-side scenario and no declared noScenarioReason",
  "b:scenario_not_in_KnownFixtureScenarios": "rule b - scenario is absent from ModConfig.KnownFixtureScenarios",
  "c:no_mod_dispatch_block": 'rule c - no `FixtureScenario == "<id>"` dispatch block in ModEntry.Fixtures*.cs',
  "d:runner_file_missing": "rule d - the runner file named by the map does not exist",
});

//
// L0 - contract triad
//

/**
 * The command to run for one gate. A gate that has moved is discovered from `package.json` scripts starting with
 * `check:`/`audit:` and covering the same topic, and the DISCOVERED command is printed, so a missing gate can never
 * read as a pass.
 */
export function resolveGateCommand(gatePath, { exists = fs.existsSync, scripts = readScripts() } = {}) {
  if (exists(path.join(REPO, gatePath))) return { command: `node ${gatePath}`, discovered: false };
  const topic = /^(?:check|audit)(?:-stardew)?-([a-z0-9]+)/.exec(path.basename(gatePath))?.[1] ?? null;
  const candidates = Object.entries(scripts)
    .filter(([name, value]) => (name.startsWith("check:") || name.startsWith("audit:")) && typeof value === "string")
    .filter(([, value]) => topic !== null && value.includes(topic))
    .map(([, value]) => value.trim())
    .filter((value) => value.startsWith("node tools/"));
  const found = candidates[0] ?? null;
  return found === null ? { command: null, discovered: true, topic } : { command: found, discovered: true, topic };
}

function readScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * The generated artefacts whose producer is a BUILD OUTPUT, and the one build they share - both read from the gate's own
 * declaration rather than spelled again here: `tools/check-generated-artifact-reproducibility.mjs` owns which artefacts
 * need the Mod export assembly, which project emits it and how that project is built.
 */
const BUILD_OUTPUT_ARTEFACTS = Object.freeze(ARTEFACT_PRODUCERS.filter((entry) => entry.resolve !== undefined));
const MOD_EXPORT = BUILD_OUTPUT_ARTEFACTS[0]?.resolve ?? null;
const MOD_EXPORT_BUILD_TIMEOUT_MS = 5 * 60_000;

/** The first MSBuild diagnostic in a build's output, verbatim: the summary line names a count, not a cause. */
function firstBuildError(output) {
  const lines = output.split("\n").map((line) => line.trimEnd());
  return (
    lines.find((line) => /:\s*error\s/u.test(line)) ??
    lines.find((line) => line.trim() !== "") ??
    "(the build printed nothing)"
  );
}

/**
 * Whether the tree holds a build output at all: any `<name>` under the project's `bin/`, in whichever configuration and
 * framework a lane built it. Existence only - the staleness question below is the gate's, and this is the one case the
 * gate cannot answer, because a tree with no assembly has nothing for it to compare and it blocks `missing_built_assembly`.
 */
function builtAssemblyPresent(root, resolution) {
  const bin = path.join(root, resolution.directory, "bin");
  if (!fs.existsSync(bin)) return false;
  return fs.readdirSync(bin, { recursive: true }).some((entry) => path.basename(String(entry)) === resolution.name);
}

/**
 * Whether the Mod export build is needed at all, and if so what asked for it.
 *
 * MEASURED, not imagined: on a tree whose Mod sources have moved, `dotnet build` compiles the whole Core project - 300 s
 * against the rest of the ladder's ~49 s, and the rung every lane runs constantly cannot spend it. MSBuild's own up-to-date
 * check is not that skip: its inputs are the entire Mod compile, while the artefacts that need this build are re-derived
 * from the five files the gate declares, so a lane editing a handler paid a full compile for a gate that then printed
 * `not_re_derived:inputs_unchanged`.
 *
 * So the decision reuses the reading the gate already makes - `inputsMovedSince` against each artefact that needs the
 * assembly, which is the same comparison that decides whether the gate re-derives - and adds the one case it cannot see: a
 * tree with no build output, where the gate blocks `missing_built_assembly` and the whole preparation exists.
 */
export function modExportBuildPreparation({
  root = REPO,
  artefacts = BUILD_OUTPUT_ARTEFACTS,
  moved = inputsMovedSince,
  present = builtAssemblyPresent,
} = {}) {
  if (MOD_EXPORT === null) return { needed: false, reason: "no artefact declares a build output" };
  if (!present(root, MOD_EXPORT)) return { needed: true, reason: "no_built_assembly" };
  for (const entry of artefacts) {
    const staleness = moved({ root, entry, artefact: entry.artefact });
    if (staleness.moved) return { needed: true, reason: `${entry.artefact}:${staleness.reason}` };
  }
  return { needed: false, reason: `inputs unchanged since ${artefacts.map((entry) => entry.artefact).join(", ")}` };
}

/**
 * The Mod export build, as the gate's own `build` field spells it: `dotnet build <project> -c Release`.
 *
 * An absent `dotnet` is `unavailable`, not a failure - the gate below states what it could not run, so the verdict keeps
 * one owner.
 */
export function buildModExportAssembly({
  run = (executable, args, options) => spawnSync(executable, args, options),
  timeoutMs = MOD_EXPORT_BUILD_TIMEOUT_MS,
  project = MOD_EXPORT?.project,
} = {}) {
  const startedAt = Date.now();
  const outcome = run("dotnet", ["build", project, "-c", "Release", "--nologo", "-v", "quiet"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: timeoutMs,
    env: containedChildEnvironment(),
  });
  const ms = Date.now() - startedAt;
  if (outcome.error?.code === "ENOENT")
    return { status: "unavailable", ms, reason: "`dotnet` is not on PATH in this shell" };
  if (outcome.error?.code === "ETIMEDOUT")
    return { status: "failed", ms, firstError: `mod_export_build_timeout:${timeoutMs}ms` };
  if (outcome.status === 0) return { status: "passed", ms };
  return { status: "failed", ms, firstError: firstBuildError(`${outcome.stdout ?? ""}${outcome.stderr ?? ""}`) };
}

/**
 * The preparation as a rung: a red build stops the ladder here, because a Mod that does not compile is a cause no gate
 * below can state better. `unavailable` passes with its reason printed, and the artefact gate says the rest; a build that
 * nothing needs is not run, and the rung says what asked for it every time it does run.
 */
export function modExportBuildRung({ prepare = modExportBuildPreparation, build = buildModExportAssembly } = {}) {
  const preparation = prepare();
  if (!preparation.needed)
    return { id: "prep", status: "passed", build: { status: "not_needed", ms: 0, ...preparation } };
  const outcome = build();
  return { id: "prep", status: outcome.status === "failed" ? "failed" : "passed", build: outcome };
}

/**
 * Run one gate rung and report each exit code by name with its own wall time. All of them run (a gate that is red
 * must not hide the three that are also red), and the rung verdict is red when any is.
 *
 * `not_measured` has TWO dialects and they are the same fact: exit 0 with a `*_skipped:` marker (a gate that returns
 * quietly), or exit 2 with one, because 2 is this repository's blocked code for "I could not measure this"
 * (`tools/lib/blocked-input-report.mjs`, `check-stardew-actor-admissibility`, `check-stardew-invented-gates`). Accepting
 * only the first would have made an absent mount red the rung, and would have forced those gates to answer 0 when a
 * person runs them by hand - the reading this ladder exists to stop. Any other non-zero exit is `failed`, marker or no
 * marker, so `check-plan-legal-fixpoint`'s `plan_fixpoint_history_skipped:` beside exit 1 stays a failure.
 */
export function runGateRung({
  id = "l0",
  gates = L0_GATES,
  resolveCommand = resolveGateCommand,
  run = (command) =>
    spawnSync(process.execPath, [command.replace(/^node\s+/, "")], {
      cwd: REPO,
      encoding: "utf8",
      env: containedChildEnvironment(),
    }),
} = {}) {
  const results = gates.map((gate) => {
    const resolved = resolveCommand(gate);
    if (resolved.command === null) {
      return {
        gate,
        command: null,
        exitCode: null,
        missing: true,
        ms: 0,
        discovered: resolved.discovered,
        outcome: "failed",
        summary: "(no command found for this gate)",
      };
    }
    const startedAt = Date.now();
    const outcome = run(resolved.command);
    const stdout = outcome.stdout ?? "";
    const exitCode = typeof outcome.status === "number" ? outcome.status : 1;
    return {
      gate,
      command: resolved.command,
      exitCode,
      missing: false,
      discovered: resolved.discovered,
      ms: Date.now() - startedAt,
      stdout,
      stderr: outcome.stderr ?? "",
      outcome:
        exitCode === 0
          ? NOT_MEASURED_MARKER.test(stdout)
            ? "not_measured"
            : "passed"
          : exitCode === 2 && NOT_MEASURED_MARKER.test(stdout)
            ? "not_measured"
            : "failed",
      summary: firstOutputLine(stdout),
    };
  });
  const red = results.filter((entry) => entry.outcome === "failed");
  const unavailable = results.filter((entry) => entry.outcome === "not_measured");
  return { id, status: red.length === 0 ? "passed" : "failed", gates: results, red, unavailable };
}

/** The first line of what a gate printed, so a green rung still says what it measured. Capped: some gates print JSON. */
function firstOutputLine(stdout) {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) return "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

//
// L1 - linkage closure
//

/**
 * The four authorities, cross-checked. Every rule reports the ACTION by name plus the scenario, so a reader knows
 * which member drifted without opening the file.
 *
 * `resolveScenario(action)` is the tools-side authority (`fixtureScenario(fixtureActions(action), action)` in
 * production), so the test can drive a fabricated mapping through the same rules.
 */
export function checkLinkageClosure({
  runnerMap,
  resolveScenario,
  knownScenarios,
  dispatchScenarios,
  noScenarioReason = NO_SCENARIO_REASON,
  fileExists,
}) {
  const violations = [];
  const actions = Object.keys(runnerMap).sort();
  let linked = 0;
  for (const action of actions) {
    const runner = runnerMap[action];
    const scenario = resolveScenario(action);
    const failed = [];
    if (scenario === "" || scenario === undefined || scenario === null) {
      if (typeof noScenarioReason[action] !== "string" || noScenarioReason[action].trim() === "") {
        failed.push("a:no_scenario_undeclared");
      }
    } else {
      if (!knownScenarios.has(scenario)) failed.push("b:scenario_not_in_KnownFixtureScenarios");
      if (!dispatchScenarios.has(scenario)) failed.push("c:no_mod_dispatch_block");
    }
    if (!fileExists(runner)) failed.push("d:runner_file_missing");
    if (failed.length === 0) linked++;
    else violations.push({ action, scenario: scenario ?? "", runner, failed });
  }
  // A reason for an action that needs none is the same drift from the other side: it silently excuses a scenario
  // that has since appeared, and it would excuse the next one written for the same key.
  const staleReasons = Object.keys(noScenarioReason).filter((action) => {
    if (!(action in runnerMap)) return true;
    const scenario = resolveScenario(action);
    return scenario !== "" && scenario !== undefined && scenario !== null;
  });
  return {
    id: "l1",
    status: violations.length === 0 && staleReasons.length === 0 ? "passed" : "failed",
    total: actions.length,
    linked,
    violations,
    staleReasons,
  };
}

/** The Mod-side dispatch blocks: both legacy `if` checks and table rows across the `ModEntry.Fixtures*.cs` partials. */
export function parseModDispatchScenarios(source) {
  const scenarios = new Set();
  for (const match of source.matchAll(/FixtureScenario (?:==|is) "([^"]+)"/g)) scenarios.add(match[1]);
  for (const match of source.matchAll(/NativeLocalFixtureScenarioRow\.\w+\("([^"]+)"/g)) scenarios.add(match[1]);
  return scenarios;
}

function parseArrayInitializer(source, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let index = openBraceIndex; index < source.length; index++) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error("known_fixture_scenarios_block_unterminated");
  const scenarios = new Set();
  for (const match of blankComments(source.slice(openBraceIndex, end)).matchAll(/"([^"]*)"/g)) {
    if (match[1].length > 0) scenarios.add(match[1]);
  }
  return scenarios;
}

/**
 * `ModConfig.KnownFixtureScenarios` as a set. The initializer is brace-matched, and comments are blanked first: the
 * list is documented inline, and a quoted word inside a comment otherwise parses as a scenario name.
 */
export function parseKnownFixtureScenarios(source) {
  const directIndex = source.indexOf("KnownFixtureScenarios = new[]");
  if (directIndex >= 0) {
    const open = source.indexOf("{", directIndex);
    return parseArrayInitializer(source, open);
  }

  const match = source.match(/KnownFixtureScenarios\s*=\s*([^;]+);/);
  if (match) {
    const expr = match[1];
    const identifiers = expr.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
    const scenarios = new Set();
    let foundAny = false;
    for (const id of identifiers) {
      if (id === "Concat" || id === "ToArray") continue;
      const idDecl = new RegExp(`\\b${id}\\s*=\\s*new\\[\\]`);
      const declMatch = idDecl.exec(source);
      if (declMatch) {
        foundAny = true;
        const open = source.indexOf("{", declMatch.index);
        for (const item of parseArrayInitializer(source, open)) {
          scenarios.add(item);
        }
      }
    }
    if (foundAny) return scenarios;
  }

  throw new Error("known_fixture_scenarios_block_missing");
}

//
// L1b - deploy isolation
//

/**
 * Is `deployRoot` inside `gameInstall`? Case-insensitive and separator-normalised, because this is Windows and both
 * spellings of the same directory appear in the tree.
 */
export function isInside(deployRoot, gameInstall) {
  const normalise = (value) => path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const deploy = normalise(deployRoot);
  const game = normalise(gameInstall);
  return deploy === game || deploy.startsWith(`${game}/`);
}

/**
 * The deploy root must not be inside the Steam install. This family breached twice in one day (0ee9b288, da2902d4 -
 * both wrote the mod bundle into the install), and Steam reports the install as modified when we do it.
 */
export function checkDeployIsolation({ deployRoot, gameInstall, allowGameMods = false }) {
  const inside = isInside(deployRoot, gameInstall);
  return {
    id: "l1b",
    status: inside && !allowGameMods ? "failed" : "passed",
    deployRoot: path.resolve(deployRoot),
    gameInstall: path.resolve(gameInstall),
    insideGameInstall: inside,
    allowGameMods,
    message: inside
      ? `${path.resolve(deployRoot)} is inside the game installation ${path.resolve(gameInstall)}`
      : `${path.resolve(deployRoot)} is outside the game installation ${path.resolve(gameInstall)}`,
  };
}

//
// L2 - compile and population agreement
//

// L2's two halves exist because they failed in the same afternoon, one after the other: a coding lane shipped four
// actions with `STARDEW_ACTION_TOOL_NAMES` entries, `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` membership and
// `isModDescriptorComplete` arms, and no `actionAdapter(...)` entries. `StardewActionId` is derived from the adapter
// list, so the Host artifact could not be built at all - from a commit whose C# tests were green. The population half
// names the four ids in milliseconds; the compile half is what says a green test suite is not a compilation. Neither
// half restates a rule the other owns: agreement is about which ids are named where, compiling is about whether the
// tree is TypeScript at all.

/** The block between `anchor`'s opening brace and its matching brace, comments already blanked by the caller. */
function braceBlock(source, anchor) {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`prelive_block_missing:${anchor}`);
  const open = source.indexOf("{", start + anchor.length - 1);
  if (open < 0) throw new Error(`prelive_block_unterminated:${anchor}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`prelive_block_unterminated:${anchor}`);
}

/** The quoted strings of the array literal that follows `anchor`, in source order. */
function quotedArray(source, anchor) {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`prelive_block_missing:${anchor}`);
  const open = source.indexOf("[", start + anchor.length - 1);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) throw new Error(`prelive_block_unterminated:${anchor}`);
  return [...source.slice(open, close).matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]);
}

/**
 * Every population the Host spells by hand, parsed from the one file that spells them. `actionAdapter` entries are the
 * authority: `StardewActionId` is derived from that list, so each satellite below can name an action this build cannot
 * carry - and only one of those satellites is visible to the compiler.
 */
export function parseActionPopulations(source) {
  const plain = blankComments(source);
  const adapters = [...plain.matchAll(/actionAdapter\(\s*"([a-z0-9_]+)"/gu)].map((match) => match[1]);
  const toolNames = [...braceBlock(plain, "STARDEW_ACTION_TOOL_NAMES = ").matchAll(/^\s*([a-z0-9_]+):/gmu)].map(
    (match) => match[1],
  );
  const descriptorDerived = quotedArray(plain, "STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS = Object.freeze(");
  // The descriptor arms are the requirement table's ROWS: one admission rule per capability, keyed by its action id.
  // This used to be parsed out of `isModDescriptorComplete` as `actionId === "<id>"` comparisons, and it fell from 47
  // to 0 the moment that chain became a table - silently, because an empty population agrees with everything. The
  // zero-population guard below is what makes that fall loud instead.
  const table = braceBlock(plain, "MOD_DESCRIPTOR_REQUIREMENTS = Object.freeze(");
  const descriptorValidators = [...table.matchAll(/^\s*([a-z0-9_]+): \[/gmu)].map((match) => match[1]);
  return { adapters, toolNames, descriptorDerived, descriptorValidators };
}

/** One difference direction, named so a bare `direction: id` line says which two populations disagree. */
export const POPULATION_LABELS = Object.freeze({
  map_without_adapter:
    "STARDEW_ACTION_TOOL_NAMES has a key with no actionAdapter(...) entry, and StardewActionId derives from the adapters",
  adapter_without_map: "an actionAdapter(...) entry has no STARDEW_ACTION_TOOL_NAMES key, so no Host tool mounts it",
  descriptor_derived_without_adapter:
    "STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS lists it, but no actionAdapter(...) entry carries it",
  descriptor_validator_without_adapter:
    "MOD_DESCRIPTOR_REQUIREMENTS has a row for it, but no actionAdapter(...) entry carries it",
  published_without_adapter: "the Mod publishes it as an execution action, but no actionAdapter(...) entry carries it",
});

/** Every population against the adapter list, each difference carrying its direction and the member by name. */
export function checkPopulationAgreement({ adapters, toolNames, descriptorDerived, descriptorValidators, published }) {
  const populations = { adapters, toolNames, descriptorDerived, descriptorValidators, published };
  // A population that measured NOTHING agrees with every other population: all five directions below report no
  // difference and the rung reads green while examining nothing. Measured 2026-11-13: `descriptorValidators` fell
  // from 47 to 0 when the arm chain it was parsed out of became a declaration, and this rung stayed green. So zero
  // is `blocked` and names the direction, in the same spirit as a gate refusing to pass on `examined 0`.
  const emptyPopulations = Object.entries(populations)
    .filter(([, ids]) => ids.length === 0)
    .map(([name]) => name);
  const adapterIds = new Set(adapters);
  const names = new Set(toolNames);
  const difference = (direction, ids, members) =>
    [...new Set(ids)]
      .filter((actionId) => !members.has(actionId))
      .sort()
      .map((actionId) => ({ direction, actionId }));
  const differences = [
    ...difference("map_without_adapter", toolNames, adapterIds),
    ...difference("adapter_without_map", adapters, names),
    ...difference("descriptor_derived_without_adapter", descriptorDerived, adapterIds),
    ...difference("descriptor_validator_without_adapter", descriptorValidators, adapterIds),
    ...difference("published_without_adapter", published, adapterIds),
  ];
  // A disagreement is `failed`, but a population that measured nothing outranks it: the disagreement itself would be
  // a verdict about a scan that never happened.
  let status = "passed";
  if (differences.length > 0) status = "failed";
  if (emptyPopulations.length > 0) status = "blocked";
  return {
    status,
    counts: {
      adapters: adapterIds.size,
      toolNames: names.size,
      descriptorDerived: new Set(descriptorDerived).size,
      descriptorValidators: new Set(descriptorValidators).size,
      publishedExecution: new Set(published).size,
    },
    emptyPopulations,
    differences,
  };
}

/**
 * The first TypeScript diagnostic in a build's output, verbatim. A compiler failure is one line that names a file, a
 * position and a code; printing the summary instead is how "the artifact could not be built" reaches a reader as a
 * count instead of a cause.
 */
export function firstTypeScriptError(output) {
  const lines = output.split("\n").map((line) => line.trimEnd());
  return (
    lines.find((line) => /(?:^|\s)error TS\d+/u.test(line)) ??
    lines.find((line) => line.trim() !== "") ??
    "(the build printed nothing)"
  );
}

const HOST_DIR = path.join(REPO, "host");
const COMPILE_TIMEOUT_MS = 10 * 60_000;

/**
 * `npm run build:test`, as the script runs it: the same entry, the same cwd, no npm in the middle. Its wall time is
 * reported because it is the rung's whole cost, and on failure only the first diagnostic is kept.
 */
export function compileHostTestArtifact({
  run = (executable, args, options) => spawnSync(executable, args, options),
  timeoutMs = COMPILE_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  const outcome = run(process.execPath, [HOST_TEST_ARTIFACT_BUILD], {
    cwd: HOST_DIR,
    encoding: "utf8",
    timeout: timeoutMs,
    env: containedChildEnvironment(),
  });
  const ms = Date.now() - startedAt;
  if (outcome.error?.code === "ETIMEDOUT")
    return { status: "failed", ms, firstError: `host_test_artifact_build_timeout:${timeoutMs}ms` };
  if (outcome.status === 0) return { status: "passed", ms };
  return { status: "failed", ms, firstError: firstTypeScriptError(`${outcome.stdout ?? ""}${outcome.stderr ?? ""}`) };
}

/**
 * L2. Agreement is checked first because it costs milliseconds and names the drifting member; compiling comes after
 * because it costs a minute and can only say which line stopped it. A red agreement skips the build, and `--skip-compile`
 * skips it on request - both are reported as skipped, never as passed.
 */
export function actionRegistryRung({
  skipCompile = false,
  source = () => read(ACTION_REGISTRY),
  publishedIds = () =>
    JSON.parse(read(SURFACE))
      .actions.filter((action) => action.kind === "execution")
      .map((action) => action.actionId),
  compile = compileHostTestArtifact,
  exists = (relative) => fs.existsSync(path.join(REPO, relative)),
} = {}) {
  const populations = parseActionPopulations(source());
  const population = checkPopulationAgreement({ ...populations, published: publishedIds() });
  if (population.status !== "passed")
    return { id: "l2", status: "failed", population, compile: { status: "skipped", reason: "population_red" } };
  if (skipCompile)
    return { id: "l2", status: "passed", population, compile: { status: "skipped", reason: "--skip-compile" } };
  if (!(exists(HOST_TYPESCRIPT_ENTRY) && exists(`host/${HOST_TEST_ARTIFACT_BUILD}`)))
    return {
      id: "l2",
      status: "passed",
      population,
      compile: {
        status: "unavailable",
        reason: `${HOST_TYPESCRIPT_ENTRY} or host/${HOST_TEST_ARTIFACT_BUILD} is missing`,
      },
    };
  const compiled = compile();
  return { id: "l2", status: compiled.status === "passed" ? "passed" : "failed", population, compile: compiled };
}

//
// L3 - runner shape
//

/** Blank comments out while preserving every offset and newline, so a line number stays true. */
export function blankComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index++;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      out += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        out += source[index] === "\n" ? "\n" : " ";
        index++;
      }
      out += "  ";
      index += 2;
      continue;
    }
    out += source[index];
    index++;
  }
  return out;
}

/** Every `<name>(` call site, with its paren-balanced argument text and its 1-based line. */
export function callSites(source, name) {
  const sites = [];
  const needle = `${name}(`;
  let index = source.indexOf(needle);
  while (index >= 0) {
    let depth = 0;
    let end = -1;
    for (let cursor = index + needle.length - 1; cursor < source.length; cursor++) {
      if (source[cursor] === "(") depth++;
      else if (source[cursor] === ")") {
        depth--;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    sites.push({
      start: index,
      end,
      args: source.slice(index + needle.length, end - 1),
      line: source.slice(0, index).split("\n").length,
    });
    index = source.indexOf(needle, end);
  }
  return sites;
}

/** The statement that follows a call site, collapsed to one line. Empty when the call ends a block. */
export function nextStatement(source, end) {
  let cursor = end;
  while (cursor < source.length && /[\s;]/.test(source[cursor])) cursor++;
  if (cursor >= source.length || source[cursor] === "}" || source[cursor] === ")") return "";
  let depth = 0;
  let out = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "(" || character === "{" || character === "[") depth++;
    else if (character === ")" || character === "}" || character === "]") depth--;
    if (character === ";" && depth <= 0) break;
    out += character;
    cursor++;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The body of `function <name>(...) { ... }` in one source, or null. */
export function functionBody(source, name) {
  const head = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, "u").exec(source);
  if (head === null) return null;
  const paramsStart = head.index + head[0].length;
  let depth = 1;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")") {
      depth--;
      if (depth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  if (paramsEnd < 0) return null;
  const brace = source.indexOf("{", paramsEnd);
  if (brace < 0) return null;
  depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return { params: source.slice(paramsStart, paramsEnd), body: source.slice(brace, index + 1) };
    }
  }
  return null;
}

function memberFields(text, binding) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`\\b${escaped}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, "gu"))].map(
    (match) => match[1],
  );
}

/**
 * What one assertion statement READS. This is the whole exemption and it is deliberately not a name test: a call
 * site is exempt only when every field it can touch is actionability-independent (`snapshot.capabilities`, which no
 * warp can falsify). An unresolved callee is treated as reading the whole snapshot, so reusing
 * `assertRequiredCapabilities` for a world assertion cannot smuggle itself through.
 */
export function snapshotReadClassification({ statement, binding, lookup }) {
  const fields = [];
  const wholeSnapshots = [];
  for (const match of statement.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1];
    if (["if", "for", "while", "switch", "catch", "return", "function", "typeof", "new"].includes(name)) continue;
    const args = callSites(statement, name)[0]?.args ?? "";
    if (!new RegExp(`(^|[^\\w$.])${binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*($|[,)])`, "u").test(args))
      continue;
    const resolved = lookup(name);
    if (resolved === null) {
      wholeSnapshots.push(name);
      continue;
    }
    fields.push(...memberFields(resolved.body, firstParamName(resolved)));
  }
  fields.push(...memberFields(statement, binding));
  return { fields: [...new Set(fields)], wholeSnapshots };
}

function firstParamName(body) {
  return (/([A-Za-z_$][\w$]*)/.exec(body.params ?? "") ?? [null, null])[1];
}

/**
 * L3 rules (a) and (b).
 *
 * (a) A runner may not base an assertion on ONE-SHOT `observeFresh({ actionable: true })`. A warp in flight is not a
 *     world that cannot be acted on, and treating it as one cost a live run. The wait helper (`waitForActionable`)
 *     is what distinguishes "not yet" from "not possible".
 * (b) The runner must be reachable from a resolver declaration, or carry an inline opt-out stating why it is auxiliary.
 *     "A resolver declaration" is the union `tools/resolve-stardew-action-gate-runner.mjs` reads: the published gate
 *     table, the experimental/harness map, and the published-action gate exemptions.
 *
 *     This rule first read only the two descriptor maps, and the exemption list - which declares the runner that covers
 *     a published action the descriptor shape cannot carry (`navigate_to_destination`) - went unseen, so a resolvable
 *     gate was reported unreachable. The defect was the ladder's boundary, not the runner.
 *
 * A violation is (file, line, fact) where `fact` is the world fact the assertion reads. Rule (a) sites, and the rule-(b)
 * sites whose file no resolver declaration names, are listed in `tools/prelive-l3-baseline.json`; that baseline is a ratchet - an unlisted site is red, and a listed site that no
 * longer violates is red too, so the number can only go down. The baseline records HOW each site was classified, so
 * the classification can be checked rather than trusted.
 */
export function checkRunnerShape({ runners, harnessSource, baseline, reachableRunners = new Set() }) {
  const violations = [];
  const known = [];
  const baselineSites = baseline?.knownSites ?? [];
  const checked = runners.length;
  const knownRunners = new Set();
  for (const runner of runners) {
    const source = blankComments(runner.source);
    const optOuts = optOutRules(runner.source);
    const shapeViolations = runnerShapeViolations({
      file: runner.file,
      source,
      harnessSource,
      reachable: reachableRunners.size === 0 || reachableRunners.has(runner.file),
    });
    const emitted = shapeViolations.filter((entry) => !optOuts.has(entry.rule.slice(0, 1)));
    for (const entry of emitted) {
      const site = baselineSites.find((candidate) => candidate.file === entry.file && candidate.fact === entry.fact);
      if (site === undefined) violations.push({ ...entry, baselined: false });
      else {
        site.seen = (site.seen ?? 0) + 1;
        known.push(entry);
        knownRunners.add(entry.file);
        if ((site.seen ?? 0) > (site.count ?? 1)) violations.push({ ...entry, baselined: true });
      }
    }
  }
  for (const site of baselineSites) {
    if ((site.seen ?? 0) === 0 || (site.seen ?? 0) < (site.count ?? 1))
      violations.push({ rule: "baseline_stale", file: site.file, fact: site.fact, line: 0, baselined: true });
  }
  return {
    id: "l3",
    status: violations.length === 0 ? "passed" : "failed",
    checked,
    knownRunners: knownRunners.size,
    knownSites: known.length,
    violations,
  };
}

/**
 * The per-file opt-out: `// prelive-l3-opt-out <a|b>: <reason>`. A marker with no reason is not an opt-out - the
 * reason is the whole point - so it is ignored and the violation stands.
 */
export function optOutRules(source) {
  const reasons = new Map();
  for (const match of source.matchAll(/prelive-l3-opt-out\s+([ab])\s*:\s*(\S[^\n]*)/gu))
    reasons.set(match[1], match[2].trim());
  return reasons;
}

/** The variable an `observeFresh(...)` call is bound to, whether by declaration or by plain assignment. */
export function observationBinding(source, callStart) {
  const lineStart = source.lastIndexOf("\n", callStart) + 1;
  return /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/u.exec(
    source.slice(lineStart, callStart),
  )?.[1];
}

function runnerShapeViolations({ file, source, harnessSource, reachable }) {
  const violations = [];
  if (!reachable) violations.push({ rule: "b:unreachable_runner", file, line: 0, fact: "not in the descriptor map" });
  if (/waitForActionable\s*\(/.test(source)) return violations;
  for (const site of callSites(source, "observeFresh")) {
    if (!/actionable\s*:\s*true/.test(site.args)) continue;
    const statement = nextStatement(source, site.end);
    if (statement === "" || !/throw|(^|[^.\w])(assert|require|expect)[\w$]*\s*\(/u.test(statement)) continue;
    const binding = observationBinding(source, site.start);
    if (binding === undefined) {
      violations.push({
        rule: "a:inline_observation",
        file,
        line: site.line,
        fact: "inline observation cannot be classified",
      });
      continue;
    }
    const lookup = (name) => functionBody(source, name) ?? functionBody(harnessSource, name);
    const { fields, wholeSnapshots } = snapshotReadClassification({ statement, binding, lookup });
    const worldFields = fields.filter((field) => !ACTIONABILITY_INDEPENDENT_FIELDS.includes(field));
    if (wholeSnapshots.length > 0) {
      violations.push({
        rule: "a:whole_snapshot_assertion",
        file,
        line: site.line,
        fact: `whole_snapshot:${wholeSnapshots[0]}`,
      });
      continue;
    }
    if (worldFields.length === 0) continue;
    violations.push({ rule: "a:one_shot_actionable_assertion", file, line: site.line, fact: worldFields[0] });
  }
  return violations;
}

//
// CLI
//

const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

function runnerFiles(directory = TOOLS) {
  return fs
    .readdirSync(directory)
    .filter((name) => /^run-stardew-native-local-player-.*-smoke\.mjs$/u.test(name))
    .sort();
}

export function reachableRunnerNames({
  experimentalRunners = STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  publishedGates = STARDEW_PUBLISHED_ACTION_GATES,
  gateExemptions = GATE_EXEMPT_PUBLISHED_ACTIONS,
} = {}) {
  const names = new Set(Object.values(experimentalRunners));
  for (const gate of publishedGates) if (gate?.runner) names.add(gate.runner);
  for (const exempt of gateExemptions) if (exempt?.runner) names.add(exempt.runner);
  return names;
}

export function linkageRung() {
  const surface = JSON.parse(read(SURFACE));
  const known = parseKnownFixtureScenarios(read(MOD_CONFIG));
  const dispatch = parseModDispatchScenarios(
    fs
      .readdirSync(path.join(REPO, "integrations/stardew"))
      .filter((name) => /^ModEntry\.Fixtures.*\.cs$/u.test(name))
      .map((name) => read(`integrations/stardew/${name}`))
      .join("\n"),
  );
  const report = checkLinkageClosure({
    runnerMap: STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
    resolveScenario: (action) => fixtureScenario(fixtureActions(action) ?? [], action),
    knownScenarios: known,
    dispatchScenarios: dispatch,
    fileExists: (runner) => fs.existsSync(path.join(TOOLS, runner)),
  });
  return {
    ...report,
    surfaceActions: surface.actions.length,
    knownScenarios: known.size,
    dispatchScenarios: dispatch.size,
  };
}

export function deployRung({ env = process.env, modsPath = null, gameInstall = null, allowGameMods = false } = {}) {
  const roots = resolveStardewFixtureRoots({ env });
  const deployRoot = path.resolve(
    modsPath ?? nonEmpty(env.GAMEBUDDY_STARDEW_MODS_DIR) ?? path.join(roots.fixturesRoot, "mods"),
  );
  const gameRoot = path.resolve(gameInstall ?? nonEmpty(env.GAMEBUDDY_STARDEW_GAME_DIR) ?? DEFAULT_GAME_INSTALL);
  return checkDeployIsolation({ deployRoot, gameInstall: gameRoot, allowGameMods });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function shapeRung({ directory = TOOLS } = {}) {
  const files = runnerFiles(directory);
  const baselinePath = path.join(REPO, BASELINE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { knownSites: [] };
  return checkRunnerShape({
    runners: files.map((file) => ({ file, source: fs.readFileSync(path.join(directory, file), "utf8") })),
    harnessSource: read(HARNESS_LIB),
    baseline,
    reachableRunners: reachableRunnerNames(),
  });
}

/**
 * L4: the action's own live preflight, DELEGATED - `tools/preflight-live-run.mjs` already owns every reason a live run
 * fails before it starts. The ladder's job is to reach it for one named action, not to restate its checks.
 */
export function actionRung({ action, deployRoot, run = defaultRun }) {
  const command = `node tools/preflight-live-run.mjs --mods-path ${deployRoot} --action ${action}`;
  const outcome = run(command);
  return { id: "l4", status: outcome.status === 0 ? "passed" : "failed", command, exitCode: outcome.status };
}

function defaultRun(command) {
  const [executable, ...rest] = command.split(" ");
  return spawnSync(executable === "node" ? process.execPath : executable, rest, { cwd: REPO, encoding: "utf8" });
}

export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
  };
  return {
    noGame: argv.includes("--no-game"),
    game: argv.includes("--game"),
    skipCompile: argv.includes("--skip-compile"),
    action: value("--action"),
    modsPath: value("--mods-path"),
    gameInstall: value("--game-install"),
    allowGameMods: argv.includes("--allow-game-mods"),
  };
}

/**
 * The ladder as data: rungs run in order and the first red stops it, so a failure is never a later consequence of
 * an earlier one.
 */
export function runLadder({ rungs, stopOnFirstRed = true }) {
  const ran = [];
  for (const rung of rungs) {
    const report = rung();
    ran.push(report);
    if (stopOnFirstRed && report.status !== "passed") break;
  }
  const firstRed = ran.find((report) => report.status !== "passed") ?? null;
  return { status: firstRed === null ? "passed" : "failed", rungs: ran, firstRed };
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.noGame && options.action === null) {
    process.stderr.write("usage: node tools/prelive.mjs --no-game | --action <id> [--game] [--skip-compile]\n");
    process.exitCode = 2;
    return;
  }
  const startedAt = Date.now();
  // The action is an ARGUMENT, not a rung: an action that no authority publishes is refused before anything runs, so
  // `--action open_geode` names its own gap instead of disappearing behind an unrelated red rung.
  if (options.action !== null && !knownAction(options.action)) {
    process.stderr.write(`unknown_action:${options.action} (neither a published action id nor a runner-map key)\n`);
    process.exitCode = 2;
    return;
  }
  const deploy = deployRung(options);
  const ladder = runLadder({
    rungs: [
      () => modExportBuildRung(),
      ...PRELUDE_RUNGS.map((rung) => () => runGateRung({ id: rung.id, gates: rung.gates })),
      () => linkageRung(),
      () => deploy,
      () => actionRegistryRung({ skipCompile: options.skipCompile }),
      () => shapeRung(),
      ...(options.action === null || !options.game
        ? []
        : [() => actionRung({ action: options.action, deployRoot: deploy.deployRoot })]),
    ],
  });
  const notice = options.action !== null && !options.game ? "l4_skipped: needs --game" : null;
  process.stdout.write(format(ladder, { elapsedMs: Date.now() - startedAt, options, notice }));
  if (ladder.status !== "passed") process.exitCode = 1;
}

/** Is this action id published by the surface, or a runner-map key (a lane key such as `fridge_store`)? */
function knownAction(action) {
  const published = JSON.parse(read(SURFACE)).actions.some((entry) => entry.actionId === action);
  return published || action in STARDEW_EXPERIMENTAL_ACTION_RUNNERS;
}

/** L2's own lines: what the populations disagree on, then what the build said, each naming its own fact. */
function populationRungLines(rung) {
  const lines = [];
  const counts = rung.population.counts;
  lines.push(
    `  l2: population agreement ${rung.population.status} (adapters=${counts.adapters}, toolNames=${counts.toolNames}, descriptorDerived=${counts.descriptorDerived}, descriptorValidators=${counts.descriptorValidators}, publishedExecution=${counts.publishedExecution})`,
  );
  for (const entry of rung.population.differences) lines.push(`    ${entry.direction}: ${entry.actionId}`);
  for (const direction of new Set(rung.population.differences.map((entry) => entry.direction)))
    lines.push(`    ${direction} means ${POPULATION_LABELS[direction]}`);
  // Named, because a zero here is a population that measured nothing rather than a population that agrees.
  for (const name of rung.population.emptyPopulations)
    lines.push(`    empty_population: ${name} measured nothing, so it cannot agree with anything`);
  const compile = rung.compile;
  if (compile.status === "passed")
    lines.push(`  l2: compile passed (host/${HOST_TEST_ARTIFACT_BUILD}) in ${compile.ms}ms`);
  else if (compile.status === "skipped")
    lines.push(
      compile.reason === "population_red"
        ? `  l2: compile skipped: population agreement is ${rung.population.status}, so the build would only restate it`
        : `  l2: compile skipped (${compile.reason}): only population agreement was checked`,
    );
  else if (compile.status === "unavailable")
    lines.push(
      `  l2: compile UNAVAILABLE: ${compile.reason} - the Host artifact was NOT compiled here, so a green suite below proves nothing about it`,
    );
  else {
    lines.push(`  l2: compile failed in ${compile.ms}ms - a green test suite is not a compilation`);
    lines.push(`      | ${compile.firstError}`);
  }
  lines.push(`  l2: ${rung.status}`);
  return lines;
}

/** The report, as text: every rung's counts plus the member each violation names. */
export function format(ladder, { elapsedMs, options, notice }) {
  const lines = [`prelive: static ladder${options.noGame ? " (--no-game)" : ""}`];
  let unavailable = 0;
  for (const rung of ladder.rungs) {
    if (rung.id === "prep") {
      const build = rung.build;
      if (build.status === "passed") lines.push(`  prep: Mod export build passed (dotnet -c Release) in ${build.ms}ms`);
      else if (build.status === "not_needed")
        lines.push(`  prep: Mod export build not needed (${build.reason}) - nothing it produces is re-derived`);
      else if (build.status === "unavailable")
        lines.push(
          `  prep: Mod export build UNAVAILABLE: ${build.reason} - the artefact gate in L0 names what it could not run`,
        );
      else {
        lines.push(
          `  prep: Mod export build failed in ${build.ms}ms - a Mod that does not compile is the cause, not a symptom`,
        );
        lines.push(`      | ${build.firstError}`);
      }
    } else if (rung.id === "l0" || rung.id === "l0b") {
      for (const gate of rung.gates) {
        const where = gate.discovered ? " (discovered, not at the expected path)" : "";
        const outcome = gate.missing ? "missing" : `exit=${gate.exitCode}`;
        lines.push(`  ${rung.id} ${path.basename(gate.gate)} ${outcome} ${gate.ms}ms${where}`);
        lines.push(`     command: ${gate.command ?? "(none found)"}`);
        if (gate.summary !== "") lines.push(`     | ${gate.summary}`);
      }
      unavailable += rung.unavailable.length;
      lines.push(
        `  ${rung.id}: ${rung.status} (${rung.gates.length} gates, ${rung.red.length} red, ${rung.unavailable.length} UNAVAILABLE)`,
      );
      for (const gate of rung.unavailable) {
        lines.push(`    UNAVAILABLE: ${gate.gate} exit=0 but it printed a skip marker, so it measured nothing`);
        for (const line of `${gate.stdout ?? ""}${gate.stderr ?? ""}`
          .split("\n")
          .filter((entry) => entry.trim() !== "")
          .slice(0, 5))
          lines.push(`      | ${line.trimEnd()}`);
      }
      for (const gate of rung.red) {
        lines.push(`    red: ${gate.gate} exit=${gate.exitCode ?? "missing"}`);
        // The gate's own words, not a summary: the member it names is the whole point of running it here.
        for (const line of `${gate.stdout ?? ""}${gate.stderr ?? ""}`
          .split("\n")
          .filter((entry) => entry.trim() !== "")
          .slice(0, 20))
          lines.push(`      | ${line.trimEnd()}`);
      }
    } else if (rung.id === "l1") {
      const counts =
        rung.surfaceActions === undefined
          ? ""
          : ` (surface=${rung.surfaceActions} actions, KnownFixtureScenarios=${rung.knownScenarios}, mod_dispatch=${rung.dispatchScenarios})`;
      lines.push(`  l1: linked ${rung.linked} of ${rung.total}${counts}`);
      for (const entry of rung.violations)
        lines.push(
          `    ${entry.action} scenario=${entry.scenario || "(none)"} failed ${entry.failed.join(",")} :: ${entry.failed.map((code) => RULE_LABELS[code] ?? code).join(" | ")}`,
        );
      for (const action of rung.staleReasons)
        lines.push(`    noScenarioReason is stale: ${action} now resolves to a scenario; remove the entry`);
      lines.push(`  l1: ${rung.status}`);
    } else if (rung.id === "l1b") {
      lines.push(`  l1b: deployRoot=${rung.deployRoot}`);
      lines.push(`  l1b: gameInstall=${rung.gameInstall}`);
      lines.push(`  l1b: ${rung.status} - ${rung.message}`);
    } else if (rung.id === "l2") {
      lines.push(...populationRungLines(rung));
    } else if (rung.id === "l3") {
      lines.push(`  l3: shape checked ${rung.checked} runners; known ${rung.knownRunners} of ${rung.checked}`);
      for (const entry of rung.violations)
        lines.push(
          `    ${entry.file}:${entry.line} ${entry.rule} asserts ${entry.fact}${entry.baselined ? " (listed in the baseline but no longer matches it)" : ""}`,
        );
      lines.push(`  l3: ${rung.status}`);
    } else if (rung.id === "l4") {
      lines.push(`  l4: ${rung.status} (exit=${rung.exitCode}) command: ${rung.command}`);
    }
  }
  // An invocation fact, not a rung outcome: it is printed even when an earlier rung is red, because it says what this
  // run did NOT check.
  if (notice !== null) lines.push(`  ${notice}`);
  lines.push(
    `prelive: ${ladder.status}${ladder.firstRed === null ? "" : ` (stopped at ${ladder.firstRed.id})`} in ${elapsedMs}ms` +
      `${unavailable === 0 ? "" : ` (${unavailable} gate(s) UNAVAILABLE: measured nothing here, counted apart from the pass)`}`,
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) main(process.argv.slice(2));
