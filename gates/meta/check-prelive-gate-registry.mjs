#!/usr/bin/env node
/**
 * The prelive gate register: every gate in this tree either runs in the ladder, or names where else it runs.
 *
 * WHY. `tools/prelive.mjs` L0 ran a hand-picked subset of the tree's gates. A gate outside that subset was not
 * exempted, it was invisible: the projection producers and a seam's stale method verdict both sat behind gates that
 * nothing ran before a live run, and both were found by a live run. A hand-picked list can only name what its author
 * remembered, and it fails open the moment a gate is added - so this gate derives the population and makes the
 * omission a failure instead of a silence.
 *
 * POPULATION (derived from the filesystem on every run; `population=NN` is printed):
 *   1. `tools/check-*.mjs` and `tools/audit-*.mjs`, excluding `*.test.mjs`. A gate is a standalone command; a
 *      `check-x.test.mjs` is that gate's falsifier suite, and its population is owned by
 *      `tools/run-tool-test-corpus.mjs`, which derives the `test:*` scripts out of package.json and that CI runs. Two
 *      registers for one population would be two authorities for it.
 *   2. `integrations/stardew/action-development/tests/*-drift.test.mjs` and `*-reconciliation.test.mjs`. The naming
 *      convention is the derivation: `-drift` and `-reconciliation` are the tests that recompute a checked-in authority
 *      and compare, so they guard the tree rather than a unit. A tree-guarding test named otherwise stays out of scope,
 *      and this line is where that limit is stated rather than hidden.
 *
 * WIRED is not parsed out of `tools/prelive.mjs` as text and not restated here: it is IMPORTED from that file's
 * `PRELUDE_RUNGS`. The ladder's own declaration is the authority for what the ladder runs, so a gate is wired the
 * moment it is in a rung, and `wired N of M` cannot disagree with what actually ran.
 *
 * EXEMPTIONS. Every other population member must appear in the table below with `{ path, reason, runsIn }`:
 *   `reason` starts with a class from `REASON_CLASSES` and then says the concrete thing - which input prelive has not
 *            got, which argument the gate needs, which measurement is red at HEAD. A reason too short to name anything
 *            is a finding, not an exemption.
 *   `runsIn` is one of `pnpm <script>` (the script must exist and name this gate's path), `suite:<script>` (the script
 *            runs a `node --test` suite, and one of the test files it runs names this gate - the form a gate whose rule
 *            lives in its own falsifier needs), `hook:<file>` (a git hook runs the named file, and that file spawns this
 *            gate), `ci:<workflow>` (that workflow must name the path), or `on-demand` (no scheduled home at all -
 *            printed under `no_scheduled_home`, so the gates nothing runs are a line of output rather than an
 *            assumption).
 *            An `on-demand` row ALSO states `expires`: the condition under which the row dies. A row that names where
 *            it runs expires mechanically - the script, the suite, the hook or the workflow has to keep naming the gate
 *            or the row reds - so it needs no second date. A row with nothing to re-check would otherwise be a silence
 *            kept forever, so it has to say what would end it, which is the rule `tools/check-armed-destructive-actions.mjs`
 *            applies to its own exemption table.
 *            An `elsewhere` exemption additionally asserts that the script runs on every push, and that assertion is
 *            checked against `gates/meta/check-ci-coverage.mjs`, which owns the fact. An `unrun` exemption asserts the
 *            opposite - that nothing names the gate or its falsifier anywhere - and is checked against both
 *            `package.json` tables and every workflow, so the row expires the day someone wires the gate.
 *
 * GATES NO SCAN REACHES. `UNSCANNED_GATES` declares the gate files whose directory is not a published gate directory:
 * `tools/scripts/check-lockfile-freeze.mjs` (runs from the `pre-commit` hook) and
 * `tools/live-run/chat/check-post-history-instructions-live.mjs` (typed by hand). They are members of the population
 * the register judges - `outside_the_scan=` prints them apart from the scanned members - because a gate that no
 * derivation reaches is invisible to every census at once, which is the defect this register exists to prevent. Each
 * row is an exemption like any other, and `unscanned_but_scanned` retires it the moment a scan reaches the path.
 *
 * The table is validated in both directions, so it cannot rot into a list nobody looked at:
 *   - a population member neither wired nor exempt is `gate_forgotten`, and the message names the FILE;
 *   - an exemption for a gate that prelive now runs is `exempt_but_wired` - the reason has been overtaken;
 *   - an exemption for a path that is no longer a gate is `exempt_not_a_gate`;
 *   - a class outside `REASON_CLASSES`, or a reason too short to name anything, is `exempt_unreasoned`;
 *   - a `runsIn` that does not resolve to a script/workflow naming the gate is `exempt_runs_in_dangling`;
 *   - an `elsewhere` exemption whose script `gates/meta/check-ci-coverage.mjs` registers as running in no workflow is
 *     `exempt_elsewhere_not_in_ci`;
 *   - an entry carrying no `runsIn` at all is `exempt_runs_in_missing`. It used to reach the `elsewhere` assertion and
 *     crash there (`Cannot read properties of undefined (reading 'startsWith')`), and a gate that dies on a stack
 *     trace has named nothing - the same defect as a register that passes on an empty population. A missing `reason`
 *     is `exempt_unreasoned` for the same reason rather than a second crash;
 *   - an `on-demand` row with no `expires`, or one too short to name a condition, is `exempt_expiry_unreasoned`: a row
 *     that says nothing runs this gate and never says what would end that is the silence this register exists to
 *     remove, moved into the table;
 *   - an `unrun` entry that a script or a workflow does name is `exempt_unrun_but_named`: the row says nothing runs the
 *     gate, and something started to;
 *   - a declared unscanned gate that a population scan now reaches is `unscanned_but_scanned`, and one that is not on
 *     disk is `unscanned_gate_missing`.
 *
 * WHICH `package.json`. `runsIn` is resolved against the scripts `HEAD` has AND the scripts on disk: a script
 * committed through a private index is in `HEAD` and absent from the worktree copy, and reading only the worktree
 * called a gate that runs `exempt_runs_in_unknown_script` - a passing gate reported unreachable because of a stale
 * local file (measured 2026-11-09: `tools/check-preset-macros.mjs` on `check:preset-macros`). So the two trees are
 * read, a script either of them has is a script that runs, and the disagreement between them is printed
 * (`scripts_read=` / `package_json_trees_disagree=`) rather than left to decide a verdict silently.
 *
 * `wired N of M; exempt K` is the verdict line; `node gates/meta/check-prelive-gate-registry.mjs` exits 1 on any finding.
 *
 * red-proof: inject  with the `elsewhere`-claims-must-run-in-CI check disabled, the falsifier failed on
 *   "an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason"
 * red-proof: inject  an exemption carrying a `reason` and no `runsIn` -> the register threw `TypeError: Cannot read
 *   properties of undefined (reading 'startsWith')` at its `elsewhere` assertion, naming no gate at all, instead of
 *   `exempt_runs_in_missing`
 * red-proof: inject  resolving `runsIn` against the worktree's script table alone -> `exempt_runs_in_unknown_script`
 *   for a script `HEAD` declares, i.e. a passing gate called unreachable because of a stale local file
 * red-proof: inject  reading `HEAD`'s script table from the file on disk -> `{}` where the commit's table was
 *   expected, and the disagreement between the two trees went unprinted
 * red-proof: inject  accepting a `suite:` row on the gate's own path alone, the rule the class was unusable under ->
 *   "a suite: row is wired by the suite's own case, and a suite that never names the gate is red" failed, and so did
 *   both real-tree cases: seven rows whose suite names `<gate>.test.mjs` clear nothing
 * red-proof: inject  never re-checking the `unrun` claim -> "an unrun row states that nothing runs the gate, and
 *   reddens the moment anything names it" failed on the script that names it
 * red-proof: inject  not recognising `hook:` at all -> "a hook: row is checked against the hook file that spawns the
 *   gate" failed with `exempt_runs_in_unrecognised`, and the real tree with the lockfile row unverifiable
 * red-proof: inject  never retiring an unscanned row -> "a declared unscanned gate is a population member, and the row
 *   retires once a scan reaches it" failed on the path a scan does reach
 * red-proof: inject  deleting the `expires` requirement -> "a row with no scheduled home states what would end it, and
 *   a row with a home needs none" failed on the real tree's on-demand rows, which carry no `expires` at all
 * red-proof: inject  requiring `expires` on EVERY row, not just the ones with no scheduled home -> the same case's
 *   homed row went red with `exempt_expiry_unreasoned` though its `pnpm` script re-checks it on every run
 * red-proof: inject  a reason class no row uses -> "every declared reason class has a meaning, every exemption uses one,
 *   and no class sits unused" named the class, which is the defect `suite` itself was
 */

export const gateDeclaration = {
  id: "check-prelive-gate-registry",
  domain: "meta",
  tier: "l2",
  kind: "ratchet",
};

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCiCoverage } from "./check-ci-coverage.mjs";
import { isGateFile, isGateName, GATE_DIRECTORIES } from "../registry.mjs";
import { PRELUDE_RUNGS } from "../../tools/prelive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STARDEW_TESTS = "integrations/stardew/action-development/tests";
const WORKFLOW_DIR = ".github/workflows";

/**
 * The derivation, as data: one entry per scan, each with what it includes and what it deliberately leaves out.
 *
 * The gate scans are `GATE_DIRECTORIES` - the registry's own list, IMPORTED rather than restated - so a domain that
 * files its gates in `gates/<domain>/` is scanned without this file learning a new directory, and a domain
 * directory that does not exist yet is skipped by `derivePopulation` rather than throwing. Before this, the list was
 * the single entry `{ dir: "tools" }`: measured on the `meta` pilot, filing 14 gates under `gates/meta/` took
 * this register from 152 members to 138 while the gate still passed.
 *
 * Each `include` is the registry's own name rule, not a regex restated here. A `.test.mjs` and a `.mutation.mjs` are the
 * gate's falsifiers, not gates - counting them asks the red-proof census for a proof of the proof.
 */
export const POPULATION_SCAN = Object.freeze([
  ...GATE_DIRECTORIES.map((dir) => ({ dir, include: (name) => isGateFile(`${dir}/${name}`) })),
  { dir: STARDEW_TESTS, include: (name) => /(?:-drift|-reconciliation)\.test\.mjs$/u.test(name) },
]);

/** The directory a repo-relative path is filed in, and its file name: the two halves a scan is asked about. */
const directoryOf = (path) =>
  String(path)
    .replace(/\\/gu, "/")
    .replace(/\/[^/]*$/u, "");
const basenameOf = (path) => String(path).replace(/\\/gu, "/").replace(/^.*\//u, "");

/** Does a scan reach this path? Asked of the scans themselves, so a published directory needs no edit in two places. */
export function inAPopulationScan(path) {
  const directory = directoryOf(path);
  const name = basenameOf(path);
  return POPULATION_SCAN.some((scan) => scan.dir === directory && scan.include(name));
}

/**
 * Gate files no scan reaches, because their directory is not one this repository publishes as a gate directory.
 *
 * WHY THIS EXISTS. The derivation is a scan of `GATE_DIRECTORIES`, and two directories hold a command-shaped gate that
 * the tree never published: `tools/scripts/` (where the `check:*` ratchets live beside the pre-commit machinery) and
 * `tools/live-run/chat/` (the live Chat harness). A gate there is invisible to this register AND to
 * `tools/lib/gate-population.mjs` whenever its only launcher is not a `pnpm` script - measured 2026-11-15: the
 * lockfile-freeze gate runs only from the `pre-commit` hook, and the post-history gate is typed by hand, so nothing
 * derived either of them and neither appeared in any population. That is a gate that can stop running with no symptom.
 *
 * WHY PER FILE AND NOT A DIRECTORY. `tools/live-run/chat/` also holds `audit-trace.mjs`, which the name rule calls a
 * gate and which is a library (the chat audit contract, no command). Publishing the directory would make a library a
 * gate; a declared row names the command and its trigger instead. Each row is an exemption like any other, so it is
 * checked the same way - and `unscanned_but_scanned` retires the row the moment a scan reaches the path.
 */
export const UNSCANNED_GATES = Object.freeze([
  {
    path: "tools/live-run/chat/check-post-history-instructions-live.mjs",
    reason:
      "unrun: no package.json script names it or its falsifier and no workflow step does, so an operator types it by " +
      "hand - and no offline rung could run it anyway, because it needs two real Chat turns against a provider with the " +
      "card's post_history_instructions edited between them",
    runsIn: "on-demand",
    expires:
      "expires when a Chat live run with the card's post_history_instructions edited between two turns can be assembled " +
      "offline, which would let a rung read the pair the gate compares",
  },
  {
    path: "tools/scripts/check-lockfile-freeze.mjs",
    reason:
      "fixup: fires only when the commit itself changes a lockfile, so it reads git state rather than the tree; the " +
      "repository's pre-commit hook (core.hooksPath=tools/git-hooks) runs tools/scripts/pre-commit.mjs, which spawns it",
    runsIn: "hook:tools/scripts/pre-commit.mjs",
  },
]);

/** Why a gate in the population does not run in prelive, as closed classes so the count is a measurement. */
export const REASON_CLASSES = Object.freeze({
  elsewhere:
    "runs on every push in the CI gates job through a pnpm script; prelive would be a second copy of a gate that " +
    "already has a home, and the ladder's budget is the ~53 s L0 plus the ~40 s L0b it already spends (measured " +
    "2026-11-13 at 449f0fb0)",
  environment:
    "needs an input this checkout has not got (the decompiled tree, a game install, a built generation, a live DB, the " +
    "design mount) - prelive runs install-free and offline",
  arguments:
    "requires caller-supplied inputs (a run directory, a transcript, a ladder result), so it is a per-run verifier " +
    "with nothing to verify before a run exists",
  installed: "needs a build output or an external toolchain that the ladder does not assemble",
  report: "measures and prints while exiting 0, so a rung would call it green while it reports a disagreement",
  fixup: "reads or repairs git/worktree state rather than the tree",
  debt: "measured red at HEAD; adopting it needs the fix, not the wiring",
  suite:
    "its measurements are made by the named node --test suite, which runs a test file that imports this gate - the " +
    "gate file itself has no run of its own, so its verdict on the real tree has never been produced",
  unrun:
    "nothing runs this gate: no package.json script names it or its falsifier and no workflow step does, so its verdict " +
    "on the real tree has never been produced; the row makes that absence a printed line, and it reddens the moment " +
    "anything names the file",
});

/**
 * Every population member that does not run in prelive, in path order. `elsewhere` entries are the bulk on purpose:
 * they are the gates that already run on every push, and the register's job is to say so rather than to duplicate them.
 */
export const EXEMPTIONS = Object.freeze([
  {
    path: "gates/product/check-viewport-population.mjs",
    reason:
      "elsewhere: static scan of the first-viewport population, runs on every push in the CI gates job through `check:viewport-population`",
    runsIn: "pnpm check:viewport-population",
  },
  {
    path: "tools/check-live-run-closures.mjs",
    reason:
      "arguments: it reconciles the run directories under a live-run root (`--root DIR`, default `.live-runs`) - every one of" +
      " them is a run that has already happened - so before any run exists there is nothing for it to examine, and it says so" +
      " with `run_closures_not_measured` (exit 2) rather than passing on an empty population. Its rule and its falsifiers live" +
      " in `tools/check-live-run-closures.test.mjs`, whose fixtures are real run directories including round67's own shape (a" +
      " launch receipt with no closure, named and red); the record it reads is written by the ladder launcher on every exit," +
      " and `tools/live-run/round-verdict.mjs` prints the same reading as its first row",
    runsIn: "suite:test:live-run-closures",
  },
  {
    path: "gates/data/check-presentation-delivery-account.mjs",
    reason:
      "arguments: it reconciles ONE finished run's bundle - `--run-dir DIR` or the newest under `.live-runs` - so before a" +
      " run exists there is nothing for it to examine, and it says so with `delivery_account_not_measured` (exit 2) rather" +
      " than passing on an empty population. Its verdict is also an arm of every run's own rung in the runner" +
      " (`deliveryAccountClause`), which is what keeps a bundle whose pieces and account disagree from being published as" +
      " passed without anyone remembering to run this entry",
    runsIn: "on-demand",
    expires:
      "expires when the runner publishes the delivery account itself, so a checkout holds a bundle to reconcile without " +
      "a caller passing --run-dir",
  },
  {
    path: "gates/product/audit-chat-live-run.mjs",
    reason:
      "arguments: requires `--audit <chat-run-dir>` pointing at an existing Chat live-run directory (same entry as " +
      "gates/meta/check-ci-coverage.mjs's register), so there is nothing to verify before a run exists",
    runsIn: "pnpm audit:chat-live-run",
  },
  {
    path: "tools/audit-gate-inputs.mjs",
    reason:
      "elsewhere: derives each gate's own input population from the paths its code reads, following its relative " +
      "imports - a static reading of the gate files, so it needs no install, no build and no run; it runs on every " +
      "push in the CI gates job through `pnpm audit:gate-inputs`",
    runsIn: "pnpm audit:gate-inputs",
  },
  {
    path: "gates/meta/audit-gate-red-proofs.mjs",
    reason: "elsewhere: static gate-red-proof audit, runs on every push in the CI gates job",
    runsIn: "pnpm audit:gate-red-proofs",
  },
  {
    path: "gates/product/check-release-generation-self-contained.mjs",
    reason:
      "elsewhere: reads the generation `host/dist/current.json` points at and the modules `production-artifact.config.json` " +
      "declares; runs in the CI `gates` job, where it reports `not_measured` when no generation is on disk, and in " +
      "`release-windows.yml` immediately after the generation is assembled, which is the only place one exists",
    runsIn: "pnpm check:release-generation-self-contained",
  },
  {
    path: "gates/arch/check-vendored-bundle-leaks.mjs",
    reason:
      "elsewhere: reads every `dist` under `vendor/`, i.e. bundles a submodule builds; runs in the CI `gates` job " +
      "after `pnpm build:magic-context`, so it needs an install and a vendor build the rungs before launch do not have",
    runsIn: "pnpm check:vendored-bundle-leaks",
  },
  {
    path: "gates/product/check-preset-macros.mjs",
    runsIn: "pnpm check:preset-macros",
    reason:
      "elsewhere: reads a SillyTavern preset document and asks whether every macro it spells is declared in PRESET_MACROS, which is a judgement about a source file that exists before any install or build." +
      " It runs through its `pnpm check:` script in the derived gate corpus, not in a prelive rung.",
  },
  {
    path: "gates/product/check-preset-round-trip.mjs",
    runsIn: "pnpm check:preset-round-trip",
    reason:
      "elsewhere: imports a preset, exports it and re-imports it to prove nothing was dropped on the way through the store, which needs no rung and no environment." +
      " It runs through its `pnpm check:` script in the derived gate corpus, not in a prelive rung.",
  },
  {
    path: "gates/arch/check-vendor-build-artifacts.mjs",
    reason:
      "elsewhere: asks whether the files the workspace's `file:` dependencies promise exist, so it must run AFTER " +
      "`vendor/magic-context` and `vendor/pi-koe` are built and BEFORE the install that imports them; that seam is " +
      "the `host` and `gates` CI jobs, not a prelive rung (a rung that ran it before the build would only measure " +
      "an unbuilt checkout)",
    runsIn: "pnpm check:vendor-build-artifacts",
  },
  {
    path: "gates/meta/check-workflow-expressions.mjs",
    reason:
      "elsewhere: reads `.github/workflows/*.yml`; runs in the CI `gates` job, and a prelive rung that examined them " +
      "would be checking the same files twice on a machine that has no workflows of its own",
    runsIn: "pnpm check:workflow-expressions",
  },
  {
    path: "gates/product/check-configuration-surfaces.mjs",
    reason:
      "elsewhere: reads the Type.Union of OperationId in host/src/tavern/browser-contract/index.ts and every .tsx/.ts in " +
      "dialogue-web, and its default run is report-only (exit 0 unless --fail) - measured 2026-11-09: examined 58, " +
      "violations 0. A rung that ran it without --fail would call it green whatever it found, and the contrast/persona " +
      "rungs already read the same dialogue-web sources",
    runsIn: "pnpm check:configuration-surfaces",
  },
  {
    path: "gates/product/check-frontend-reads-have-producers.mjs",
    runsIn: "pnpm check:frontend-reads-have-producers",
    reason:
      "elsewhere: compares every `/api/` route literal in `dialogue-web/src` against the routes `host/src` registers in a " +
      "descriptor `path:` or an exact `pathname ===`, so it judges two source trees that exist before any install or build. " +
      "It exits 1 on a read with no producer, which makes a prelive rung a second copy of a gate the derived CI gates job " +
      "already runs. Measured 2026-11-10 at HEAD f383b9bb: `examined 101 frontend route literal(s) and 76 host route(s)`, " +
      "three reads with no producer - `/api/tavern/v1/presets` and `/api/tavern/v1/settings/ui-language` (stub_only: their " +
      "only other mention was a Playwright stub) and `/api/tavern/v1/world-info/export` (named nowhere else at all).",
  },
  {
    path: "tools/audit-hotspots.mjs",
    reason:
      "report: it is a churn x size ranking and says so in its own header (`--why-not-a-gate` prints the measurement " +
      "that refused to become a gate), so it exits 0 over every ranking it prints; its `hotspots:` script is in neither " +
      "the `check:`/`audit:` namespace the CI gates job derives nor the ladder's, and its falsifiers run in " +
      "`test:hotspots` on every push · measured files examined 3530, with a revision in the window 2849 at 2f815e6c",
    runsIn: "suite:test:hotspots",
  },
  {
    path: "gates/product/audit-preset-macro-frequency.mjs",
    reason:
      "environment: the population is presets, and the only real ones in this tree live in the design/library mount - " +
      "`ref/` supplies the SillyTavern checkout whose `default/content/presets/openai/Default.json` is the single " +
      "member, so a checkout without that mount reads zero presets and the census BLOCKS with " +
      "`preset_macro_frequency_no_presets` by design rather than passing; measured 2026-11-09 with the mount: " +
      "`examined 1 preset file(s), 4 macro occurrences` (char 3, user 1, and neither `{{if}}` nor `{{random}}`), 1087 " +
      "json document(s) read and 1033 rejected by the preset shape",
    runsIn: "suite:test:tools-lib",
  },
  {
    path: "gates/data/audit-run-reading-shape.mjs",
    reason:
      "elsewhere: static scan of the analysis scripts for a count that never reached tools/lib/reading.mjs, so it " +
      "needs no game, no run and no artifact; runs on every push in the CI gates job",
    runsIn: "pnpm audit:run-reading-shape",
  },
  {
    path: "gates/stardew/audit-stardew-action-admission-ledger.mjs",
    reason:
      "report: re-derives the ledger of design/architecture/stardew-action-execution-kernel.md and prints the drift " +
      "to stderr while exiting 0 (measured 2026-11-05: `requestHandlers: document says 42, source has 95`), so a rung " +
      "would report it green while it is reporting a disagreement · measured 12 ledger rows re-derived, drift printed " +
      "(requestHandlers document 42 vs source 103, revisionIncrements 74 vs 70, executionIds 45 vs 9) at 95dd6efe",
    runsIn: "on-demand",
    expires:
      "expires when the ledger's numbers are re-derived by a gate that COMPARES them instead of a report that prints the " +
      "drift, so a verdict can read it",
  },
  {
    path: "gates/stardew/audit-stardew-admission-fork-delta.mjs",
    reason:
      "report: static audit of the forked admission sites - a migration decision aid that prints the delta and " +
      "exits 0, so it is a report rather than a gate and the register removed its `audit:` script for exactly that " +
      "reason, because a gate that cannot fail occupies a covered position while measuring nothing; its rule is still " +
      "exercised by `test:stardew-admission-fork-delta` · measured examined 50 file(s), forked 0 at 2f815e6c",
    runsIn: "suite:test:stardew-admission-fork-delta",
  },
  {
    path: "gates/stardew/audit-stardew-open-ground-claims.mjs",
    reason:
      "elsewhere: a static census over the Mod's runtime sources for members whose only walking answer is " +
      "`GameLocation.isTilePassable`, plus the assertion that the one predicate it accepts in corroboration " +
      "(`StardewBodyController.IsPlannerAdmissibleTile`) still performs `isCollidingPosition`; it runs on every push in " +
      "the CI gates job through the derived `audit:*` set. Measured 2026-11-10 at HEAD: `examined 3 call sites, 0 lies, " +
      "3 corroborated` - the fence tile's own placement ground, the engine's `onlyNeedsToBePassable` buildable arm and " +
      "one refusal's published evidence, each beside the body's answer in the same member. It is red when a member " +
      "answers walking from the map alone, or when the predicate it corroborates through is gutted. The sixteen members " +
      "this entry used to report are gone: they now answer through the one predicate, and the reason that used to say " +
      '"measured red at HEAD - 16 lies" expired with the corroboration test that demanded the literal spelling',
    runsIn: "pnpm audit:stardew-open-ground-claims",
  },
  {
    path: "gates/stardew/audit-stardew-clearing-vocabulary.mjs",
    reason:
      "suite: nothing runs this file as a gate; the vocabulary its own scan reports over `TileOccupantKind` is exercised " +
      "by `tools/audit-stardew-clearing-vocabulary.test.mjs`, a member of `suite:stardew-tooling` that ci.yml runs on " +
      "every push, so the row changed class the day that suite started naming the falsifier. " +
      "`tools/check-code-duplication.mjs` names the gate as a subject, which is friction in a baseline and not a run",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/stardew/audit-stardew-decision-closure.mjs",
    reason: "elsewhere: static decision-closure audit over the action surface, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-decision-closure",
  },
  {
    path: "gates/stardew/audit-stardew-handler-actor-guard.mjs",
    reason:
      "arguments: reads `integrations/stardew/` out of a git revision (`git ls-tree -r <rev>`, `git show <rev>:<file>`), " +
      "so it measures a commit's tree, not the worktree the ladder is about to run",
    runsIn: "on-demand",
    expires:
      "expires when it reads the worktree instead of a git revision, so a rung can judge the tree it is about to run",
  },
  {
    path: "gates/stardew/audit-stardew-native-local-runner-contract.mjs",
    reason: "elsewhere: static audit of the native-local runners' two habits, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-native-local-runner-contract",
  },
  {
    path: "gates/stardew/audit-stardew-nogame-subset.mjs",
    reason:
      "environment: reads the decompiled tree under ref/external/StardewValleyDecompiled to decide which " +
      "Integration.Tests files can run without a game",
    runsIn: "ci:.github/workflows/ci.yml",
  },
  {
    path: "gates/stardew/audit-stardew-scene-kind-projection.mjs",
    reason: "elsewhere: static nine-hop projection audit for `observe_scene`, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-scene-kind-projection",
  },
  {
    path: "gates/stardew/audit-stardew-state-coverage.mjs",
    reason: "elsewhere: static state-coverage audit over the Mod and the snapshot families, runs on every push",
    runsIn: "pnpm audit:stardew-state-coverage",
  },
  {
    path: "gates/stardew/audit-stardew-test-shape.mjs",
    reason: "elsewhere: static audit of source-shape pins in the C# test projects, runs on every push",
    runsIn: "pnpm audit:stardew-test-shape",
  },
  {
    path: "gates/stardew/check-action-coverage.mjs",
    reason:
      "report: counts dispatches out of `.live-runs/game-ladder` artifacts and exits 0 by design until someone puts a " +
      "number on what well-covered means (`--fail-under`), so there is nothing to fail before a run exists, and no " +
      "script gives it a rung · measured " +
      "published actions 106, succeeded at least once 40, attempted 46, never attempted 60 at 95dd6efe",
    runsIn: "suite:suite:tools-utilities",
  },
  {
    path: "gates/data/check-assertion-hooks.mjs",
    reason:
      "elsewhere: static scan of assertion hooks, runs on every push in the CI gates job through `check:assertion-hooks`",
    runsIn: "pnpm check:assertion-hooks",
  },
  {
    path: "gates/data/check-assertion-substance.mjs",
    reason: "elsewhere: static surface-journey assertion scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:assertion-substance",
  },
  {
    path: "gates/data/check-baseline-paths.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-baseline-paths.test.mjs`, inside `test:baseline-paths`, a member of the tool-test corpus that ci.yml runs on every push",
    runsIn: "suite:test:baseline-paths",
  },
  {
    path: "gates/stardew/check-body-owner-hold-bounds.mjs",
    reason:
      "suite: nothing runs this file as a gate - no package.json script names it or its falsifier - so its rule is " +
      "exercised by `tools/check-body-owner-hold-bounds.test.mjs`, a member of `suite:stardew-tooling` that ci.yml runs " +
      "on every push; the verdict its own default run would produce on the real tree has never been produced",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/arch/check-build-artifact-producers.mjs",
    reason: "elsewhere: static scan of every documented artifact path against its producer, runs on every push",
    runsIn: "pnpm check:build-artifact-producers",
  },
  {
    path: "gates/product/check-chat-conversational-quality-gate.mjs",
    reason:
      "environment: needs the Host's live DB (`--require-db`) and a synthetic transcript fixture, which the smoke " +
      "script supplies and the ladder does not have",
    runsIn: "pnpm smoke:chat-conversational-quality-gate",
  },
  {
    path: "gates/product/check-browser-state-projection-fields.mjs",
    reason:
      "elsewhere: static scan of the fields the browser projection declares, runs on every push in the CI gates job through `check:browser-state-projection-fields`",
    runsIn: "pnpm check:browser-state-projection-fields",
  },
  {
    path: "gates/meta/check-ci-dead-conditions.mjs",
    reason:
      "elsewhere: reads every workflow's `if:` expressions against every writer of the variables they name, runs " +
      "on every push in the CI gates job",
    runsIn: "pnpm check:ci-dead-conditions",
  },
  {
    path: "gates/meta/check-ci-coverage.mjs",
    reason:
      "elsewhere: it IS the CI gate that runs in ci.yml's gates job (`--run`), and it registers the gates a checkout " +
      "does not run - this register consumes it for exactly that fact",
    runsIn: "ci:.github/workflows/ci.yml",
  },
  {
    path: "gates/arch/check-class-name-declarations.mjs",
    reason: "elsewhere: static scan for undeclared class names, runs on every push in the CI gates job",
    runsIn: "pnpm check:class-name-declarations",
  },
  {
    path: "gates/meta/check-commit-staging.mjs",
    reason:
      "fixup: a committer's preflight over the staged set against the paths the commit names, so it describes a " +
      "commit in flight; bare mode says it cannot see the commit's intent and exits 0",
    runsIn: "on-demand",
    expires:
      "expires when a git hook owns the staged-set comparison, because the row describes a commit in flight and no " +
      "tree-level home can exist for it",
  },
  {
    path: "gates/product/check-contrast-tokens.mjs",
    reason:
      "elsewhere: measures every declared token pair in dialogue-web/src/style.css against AA, per theme, and runs on " +
      "every push in the CI gates job through `pnpm check:contrast-tokens --fail`; it used to have no script at all, " +
      "so it exited 0 over every pair it measured and no command invoked it - a token edit below AA blocked nothing",
    runsIn: "pnpm check:contrast-tokens",
  },
  {
    path: "gates/data/check-crab-pot-output-fixture-contract.mjs",
    reason:
      "arguments: requires `--contract <path>` to a provenance contract; without it the gate exits 1 with its own " +
      "usage line, so bare running is not a reading of the tree",
    runsIn: "suite:suite:tools-utilities",
  },
  {
    path: "gates/arch/check-child-output-parsing.mjs",
    reason:
      "debt: measured red at HEAD — 3 sites hand-parse subprocess output and all three are files another lane holds " +
      "uncommitted (`tools/sandbox/sandbox-bus.mjs`, `tools/scripts/check-workspace-debris.mjs`), " +
      "so adopting it needs their fix, not the wiring · measured examined 135 files, violations 47, exit 1 at 449f0fb0",
    runsIn: "suite:test:child-output-parsing",
  },
  {
    path: "gates/meta/check-gate-population-agreement.mjs",
    reason:
      "elsewhere: reads the four gate populations (check-ci-coverage, check-prelive-gate-registry, the red-proof census " +
      "and the tool-test corpus) plus the workflows and the registers, and needs no game or network, so it runs on every " +
      "push in the CI gates job rather than duplicating a full run inside the ladder",
    runsIn: "pnpm check:gate-population-agreement",
  },
  {
    path: "gates/arch/check-head-self-contained.mjs",
    reason:
      "elsewhere: reads the commit's own module graph (`git ls-tree HEAD`, not the index), runs on every push in " +
      "the CI gates job",
    runsIn: "pnpm check:head-self-contained",
  },
  {
    path: "gates/product/check-credential-export-isolation.mjs",
    reason: "elsewhere: static scan that no long-lived credential reaches an artifact, runs on every push",
    runsIn: "pnpm check:credential-export-isolation",
  },
  {
    path: "gates/stardew/check-csharp-compile.mjs",
    reason: "elsewhere: compiles the committed C# projects, which ci.yml runs as its own step",
    runsIn: "pnpm check:csharp-compile",
  },
  {
    path: "gates/data/check-cross-language-value-reads.mjs",
    reason:
      "suite: nothing runs this file as a gate - no package.json script names it or its falsifier - so its rule is " +
      "exercised by `tools/check-cross-language-value-reads.test.mjs`, a member of `suite:stardew-tooling` that ci.yml " +
      "runs on every push; the verdict its own default run would produce on the real tree has never been produced, and " +
      "that run currently dies in `node:fs` (gates/meta/check-harness-conformance.mjs reports it as " +
      "`falsifier_signature_missing`)",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/stardew/check-deadline-ceiling-declaration.mjs",
    reason:
      "elsewhere: static comparison of the two Host files that size a deadline against the Mod's own " +
      "`action-deadline-windows.v1.json` - `game-tools.ts`'s watchdog clamp and `protocol.ts`'s admission - so it needs " +
      "no install, no build and no run; it runs on every push in the CI gates job through " +
      "`pnpm check:deadline-ceiling-declaration`",
    runsIn: "pnpm check:deadline-ceiling-declaration",
  },
  {
    path: "gates/product/check-declared-deleted-facts.mjs",
    reason:
      "arguments: its `check:declared-deleted-facts` script passes `--log <a recorded run's fact log> --expect " +
      "accepted=46,...`, so its reading is of a run that has already happened and there is nothing to count before one " +
      "exists; it also reads `design/fact-authority.md`, and its rule is exercised by `test:declared-deleted-facts`, " +
      "which ci.yml runs on every push",
    runsIn: "suite:test:declared-deleted-facts",
  },
  {
    path: "gates/product/check-description-plan-vocabulary.mjs",
    reason:
      "elsewhere: static scan of the two strings that teach plan syntax - the bridge schema's `tileAreaRow.occupantKind` " +
      "and `stardew_observe`'s own text - against the vocabulary the compiler still accepts, so it needs no install and " +
      "no run; it runs on every push in the CI gates job through `pnpm check:description-plan-vocabulary`",
    runsIn: "pnpm check:description-plan-vocabulary",
  },
  {
    path: "gates/arch/check-dependency-audit.mjs",
    reason: "elsewhere: validates the recorded advisory dispositions, runs on every push in the CI gates job",
    runsIn: "pnpm check:dependency-audit",
  },
  {
    path: "gates/arch/check-dependency-risk.mjs",
    reason: "elsewhere: validates the frozen risk snapshot and lock hashes, runs on every push",
    runsIn: "pnpm check:dependency-risk",
  },
  {
    path: "gates/meta/check-diff.mjs",
    reason:
      "fixup: `git diff --check` over the worktree, so it reads uncommitted whitespace rather than the tree's contents",
    runsIn: "pnpm check:diff",
  },
  {
    path: "gates/arch/check-dotnet-target-and-language.mjs",
    reason:
      "elsewhere: the framework it names as the replacement is now the one every project targets - measured at 2026-11-16, " +
      "projects examined 30, supported 16, forced by an external constraint 12, declared 2, unsupported 0 - so a rung would " +
      "add a reading with no work left in it; the gate reddens on its own the day a framework leaves support",
    runsIn: "pnpm check:dotnet-target-and-language",
  },
  {
    path: "gates/product/check-dist-runtime-exports.mjs",
    reason:
      "installed: imports `vendor/magic-context/packages/pi-plugin/dist` (a build output), which nothing in the " +
      "ladder assembles · measured 0 violations, every dist runtime export matching the Host contract, exit 0 with the " +
      "dist present at 449f0fb0",
    runsIn: "on-demand",
    expires:
      "expires when the ladder assembles vendor/magic-context/packages/pi-plugin/dist, the build output this gate imports",
  },
  {
    path: "gates/product/check-draft-declaration-coverage.mjs",
    reason: "elsewhere: static draft-surface coverage scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:draft-declaration-coverage",
  },
  {
    path: "gates/arch/check-duplicated-authority.mjs",
    reason: "elsewhere: static duplicated-authority scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:duplicated-authority",
  },
  {
    path: "gates/stardew/check-engine-affordance-census.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-engine-affordance-census.test.mjs`, inside `test:engine-affordance-census`, a member of the tool-test corpus that ci.yml runs on every push; the file's own only launcher is `census:engine-affordances`, a prefix neither the gate namespace nor the corpus derives",
    runsIn: "suite:test:engine-affordance-census",
  },
  {
    path: "gates/arch/check-error-identity-classification.mjs",
    reason: "elsewhere: static scan for failure classification by message text, runs on every push",
    runsIn: "pnpm check:error-identity-classification",
  },
  {
    path: "gates/data/check-evidence-bundle.mjs",
    reason: "elsewhere: validates the documented evidence-bundle shape, runs on every push in the CI gates job",
    runsIn: "pnpm check:evidence-bundle",
  },
  {
    path: "gates/product/check-fact-authority.mjs",
    reason:
      "environment: it reads `design/fact-authority.md` - the mount declaring which traces are not facts - beside the " +
      "Mod's sources, so a checkout without that mount has nothing to judge; its rule is exercised by " +
      "`tools/check-fact-authority.test.mjs`, a member of `test:fact-authority` that ci.yml runs on every push",
    runsIn: "suite:test:fact-authority",
  },
  {
    path: "gates/product/check-fail-closed-forward-path.mjs",
    reason:
      "elsewhere: reads every refusal the two browser contracts declare and the step its own sentence owes " +
      "the player, runs on every push in the CI gates job",
    runsIn: "pnpm check:fail-closed-forward-path",
  },
  {
    path: "gates/product/check-game-historian-rubric.mjs",
    reason: "elsewhere: static rubric gate over the historian prompt, runs on every push in the CI gates job",
    runsIn: "pnpm check:game-historian-rubric",
  },
  {
    path: "gates/stardew/check-gameplay-capability-catalog.mjs",
    reason: "environment: reads design/gameplay-capability-catalog.json from the design/ mount",
    runsIn: "pnpm check:gameplay-capability-catalog",
  },
  {
    path: "tools/check-hand-written-schema-constants.mjs",
    reason:
      "elsewhere: static scan of the Game Action tool schemas written inline in `host/src/game-tools.ts` for a bound a " +
      "shared constant already owns - two source files that exist before any install or build - so it runs on every push " +
      "in the CI gates job through `pnpm check:hand-written-schema-constants`",
    runsIn: "pnpm check:hand-written-schema-constants",
  },
  {
    path: "gates/meta/check-gate-premises.mjs",
    reason:
      "elsewhere: static gate over the inputs each source gate DECLARES - it reads the gate files, the modules they " +
      "spawn or import, and a stat of every derived path, so it runs in the derived CI gates job on every push; its " +
      "own suite replays the deletion commit (`213cde50`) that left two gates red on a file that was already gone",
    runsIn: "pnpm check:gate-premises",
  },
  {
    path: "gates/arch/check-head-typecheck.mjs",
    reason: "elsewhere: typechecks HEAD through the installed workspace, runs on every push as its own step",
    runsIn: "pnpm check:head-typecheck",
  },
  {
    path: "gates/product/check-host-diagnostic-output.mjs",
    reason: "elsewhere: static scan of Host diagnostic output shape, runs on every push",
    runsIn: "pnpm check:host-diagnostic-output",
  },
  {
    path: "gates/product/check-host-game-physical-seam.mjs",
    reason: "elsewhere: static scan of the Host/Game physical seam, runs on every push in the CI gates job",
    runsIn: "pnpm check:host-game-physical-seam",
  },
  {
    path: "gates/product/check-host-production-import-boundary.mjs",
    reason: "elsewhere: static import-boundary scan over host/src, runs on every push in the CI gates job",
    runsIn: "pnpm check:host-production-import-boundary",
  },
  {
    path: "gates/arch/check-host-source-directories.mjs",
    reason:
      "elsewhere: static scan of `host/src` directories and the modules they quote, install-free, and it lands in the " +
      "derived CI gates job by being named `check:*`",
    runsIn: "pnpm check:host-source-directories",
  },
  {
    path: "gates/product/check-host-windows-test-preflight.mjs",
    reason: "elsewhere: static preflight over the Windows Host test entry, runs on every push",
    runsIn: "pnpm check:host-windows-test-preflight",
  },
  {
    path: "gates/product/check-inventory-row-field-rendering.mjs",
    reason:
      "elsewhere: static scan of inventory-row field rendering, runs on every push in the CI gates job through `check:inventory-row-field-rendering`",
    runsIn: "pnpm check:inventory-row-field-rendering",
  },
  {
    path: "gates/data/check-live-run-failure-dump.mjs",
    reason: "elsewhere: static scan of the live-run failure dump, runs on every push in the CI gates job",
    runsIn: "pnpm check:live-run-failure-dump",
  },
  {
    path: "gates/data/check-live-run-isolation.mjs",
    reason:
      "environment: builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam " +
      "install (measured exit 1 with live_run_isolation_source_profile_config_missing on a bare tree)",
    runsIn: "pnpm check:live-run-isolation",
  },
  {
    path: "gates/data/check-live-run-multiday-baseline.mjs",
    reason: "elsewhere: static comparison against the recorded multi-day baseline, runs on every push",
    runsIn: "pnpm check:live-run-multiday-baseline",
  },
  {
    path: "gates/product/check-live-run-preset-surface.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/live-run/core/persona.test.mjs`, inside `suite:live-run-harness`, a member of the tool-test corpus that ci.yml runs on every push",
    runsIn: "suite:suite:live-run-harness",
  },
  {
    path: "gates/data/check-live-run-silence.mjs",
    reason: "elsewhere: static scan for silent live-run outcomes, runs on every push in the CI gates job",
    runsIn: "pnpm check:live-run-silence",
  },
  {
    path: "gates/data/check-live-run-speech.mjs",
    reason:
      "elsewhere: reads the card's declared conduct against a finished run's own `result.json` bubbles, and its " +
      "`check:live-run-speech` script passes `--rules`, which judges the conduct the card declares without a run - that " +
      "script runs on every push in the CI gates job, where a rung would have no run directory to read",
    runsIn: "pnpm check:live-run-speech",
  },
  {
    path: "tools/check-local-ci-parity.mjs",
    reason:
      "elsewhere: subtracts `tools/prelive.mjs`'s own `PRELUDE_RUNGS` and `LADDER_RUNGS` from the workflows' steps, so " +
      "it reads the ladder's declaration and the CI files and needs neither install nor run; ci.yml runs it as its own " +
      "step (`pnpm check:local-ci-parity`), and a rung inside the ladder it judges would be the ladder grading itself",
    runsIn: "pnpm check:local-ci-parity",
  },
  {
    path: "tools/check-loose-assertions.mjs",
    reason:
      "elsewhere: reads the journey specs for the `expect` calls no test reaches - the slices before a file's first " +
      "`test(`, the module-level ones and the helpers nothing calls - which is a static reading of " +
      "`dialogue-web/tests`, so it runs on every push in the CI gates job through `pnpm check:loose-assertions`",
    runsIn: "pnpm check:loose-assertions",
  },
  {
    path: "gates/stardew/check-native-local-runner-scaffold.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-native-local-runner-scaffold.test.mjs`, inside `test:stardew-native-local-runner-scaffold`, a member of the tool-test corpus that ci.yml runs on every push",
    runsIn: "suite:test:stardew-native-local-runner-scaffold",
  },
  {
    path: "gates/arch/check-parser-agreement.mjs",
    reason: "elsewhere: static parser-agreement scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:parser-agreement",
  },
  {
    path: "gates/data/check-perf-budget.mjs",
    reason: "elsewhere: re-measures recorded budgets, runs on every push in the CI gates job",
    runsIn: "pnpm check:perf-budget",
  },
  {
    path: "gates/data/check-perf-scaling.mjs",
    reason:
      "installed: drives the bench suite as size pairs in child processes, which needs a built `host/dist-test` · " +
      "measured findings 6 over 6 files and 0 pairs, both benches refusing `live_run_artifact_stale` at 95dd6efe",
    runsIn: "pnpm check:perf-scaling",
  },
  {
    path: "gates/product/check-persona-example-behaviours.mjs",
    reason:
      "elsewhere: static scan of the card's shipped examples against the sentence that permits or forbids each " +
      "behaviour - the defect behind it was one clause deleted from `system_prompt` while every example still performed " +
      "it - so it reads committed documents and runs on every push through `pnpm check:persona-example-behaviours`",
    runsIn: "pnpm check:persona-example-behaviours",
  },
  {
    path: "gates/product/check-planner-guidance-observation-tools.mjs",
    reason:
      "elsewhere: reads two source declarations - the observation tools the adapter mounts, and the text `stardew_plan_work` " +
      "hands the model - so it needs no install, no build and no run, and it runs on every push in the derived CI gates job " +
      "through `pnpm check:planner-guidance-observation-tools`; a prelive rung would be a second copy of that reading. " +
      "Measured at HEAD: `observation tools examined 9 · named 3 · with a reason 6`",
    runsIn: "pnpm check:planner-guidance-observation-tools",
  },
  {
    path: "gates/stardew/check-policy-change-is-learned-by-polling.mjs",
    reason:
      "elsewhere: static scan of the Mod's sources for a running world learning an action-policy change by re-reading " +
      "`config.json` instead of from a message, so it needs no install, no build and no game; it runs on every push in " +
      "the CI gates job through `pnpm check:policy-change-is-learned-by-polling`",
    runsIn: "pnpm check:policy-change-is-learned-by-polling",
  },
  {
    path: "gates/product/check-production-pack-load.mjs",
    reason:
      "environment: measured pointer_missing on host/dist/current.json, a generation only the release lane builds",
    runsIn: "pnpm check:production-pack-load",
  },
  {
    path: "gates/arch/check-publint.mjs",
    reason: "elsewhere: package-format gate over the built packages, runs as its own step on every push",
    runsIn: "pnpm check:publint",
  },
  {
    path: "gates/meta/check-red-proof-markers.mjs",
    reason:
      "elsewhere: a static scan of the tracked files that hold the red-proof marker for a U+00D7 where the marker's " +
      "glyph belongs, so it needs no install, no build and no run; it runs on every push in the derived CI gates job " +
      "through `pnpm check:red-proof-markers`. What it reports today is carried in `tools/baselines/red-proof-markers.json` " +
      "because it is owed to the lanes that own those files, and an entry whose line is repaired reds the gate until it is " +
      "deleted, so the record cannot outlive the damage · measured examined 116 file(s), corrupted 110 marker line(s) in 6 " +
      "file(s), baselined 110, violations 0, stale 0",
    runsIn: "pnpm check:red-proof-markers",
  },
  {
    path: "gates/arch/check-rederivation-parity.mjs",
    reason:
      "debt: it is red at HEAD on the two declared re-derivations whose parity test does not exist " +
      "(`MeleeWeapon.getAreaOfEffect`'s arc, whose 4096-position claim is prose, and " +
      "`GameLocation.getFishFromLocationData`'s row filter, whose parity is a live-run claim), and a rung that ran it " +
      "would stop a prelive run on exactly the state this register exists to report; its falsifier suite does run in " +
      "the derived corpus, green, through `test:rederivation-parity`. What would make it schedulable is the two parity " +
      "tests, not the wiring · measured rederivations examined 4 · with a parity test 2 · engine members 4 · " +
      "without parity 2 · call sites examined 1 at 1b906910",
    runsIn: "suite:test:rederivation-parity",
  },
  {
    path: "gates/product/check-refusal-action-names.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule - the 2679 refusal codes its scan reports, cited by `<c>` doc " +
      "comments in `integrations/stardew/**` where the product names the gate - is exercised by " +
      "`tools/check-refusal-action-names.test.mjs`, a member of `suite:stardew-tooling` that ci.yml runs on every push",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/product/check-refusal-informativeness.mjs",
    reason:
      "debt: measured red at HEAD (exit 1, `unclassified_reason_code " +
      "remove_placed_item_furniture_move_unsupported - no declared family matches it`), so wiring it into a rung " +
      "would only stop the ladder on a defect this register is meant to report · measured 29 unclassified_reason_code " +
      "findings at 449f0fb0",
    runsIn: "on-demand",
    expires:
      "expires with the gate's own debt: when the 29 unclassified_reason_code findings at 449f0fb0 are zero it belongs " +
      "in a rung, and the row is deleted with its adoption",
  },
  {
    path: "gates/data/check-release-live-evidence.mjs",
    reason:
      "elsewhere: runs in the protected release lane, where the evidence it reads is the release claim - " +
      "release-windows.yml invokes it by path on tag pushes (not every push, which is why runsIn names that workflow " +
      "rather than a pnpm script). prelive would be the wrong home for it: the ladder asks whether a live run can " +
      "start, and this gate asks whether the last committed live evidence still describes this tree",
    runsIn: "ci:.github/workflows/release-windows.yml",
  },
  {
    path: "gates/data/check-run-walking.mjs",
    reason:
      "arguments: its `check:run-walking` script takes `--log <a recorded run's log> --expect walked=647,...`, so it " +
      "reads a run that has already happened; its rule is exercised by `test:run-walking`, which ci.yml runs on every push",
    runsIn: "suite:test:run-walking",
  },
  {
    path: "gates/arch/check-scope-references.mjs",
    reason:
      "debt: measured red at HEAD on scope references · measured 6 findings (5 out_of_scope_reference, 1 " +
      "read_before_declaration) over 1086 files at 95dd6efe",
    runsIn: "pnpm check:scope-references",
  },
  {
    path: "gates/arch/check-silent-failure.mjs",
    reason: "elsewhere: static silent-failure scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:silent-failure",
  },
  {
    path: "gates/meta/check-spec-reachability.mjs",
    reason: "elsewhere: derives which tools/ suites a checkout runs, and runs on every push in the CI gates job",
    runsIn: "pnpm check:spec-reachability",
  },
  {
    path: "tools/check-spec-waiver-comments.mjs",
    reason:
      "elsewhere: classifies the journey comments that encode a capability the product denies as waivers, and reads " +
      "each declared waiver's expiry out of the product's own source - no install, no build and no run - so it runs " +
      "on every push in the CI gates job through `pnpm check:spec-waiver-comments`",
    runsIn: "pnpm check:spec-waiver-comments",
  },
  {
    path: "gates/product/check-stale-line-age.mjs",
    reason:
      "elsewhere: static scan for the state line that prints a value without its age - the defect was `<world-state>` " +
      "showing a seed count she had already spent - so it reads the Host's prompt assembly rather than a run, and runs " +
      "on every push in the CI gates job through `pnpm check:stale-line-age`",
    runsIn: "pnpm check:stale-line-age",
  },
  {
    path: "gates/stardew/check-stardew-companion-production-admission.mjs",
    reason:
      "arguments: reports admission_cli_required_flag_missing without a caller's evidence paths (same entry as " +
      "gates/meta/check-ci-coverage.mjs's register)",
    runsIn: "pnpm check:stardew-companion-production-admission",
  },
  {
    path: "gates/stardew/check-stardew-dialogue-autonomy.mjs",
    reason:
      "arguments: takes `<ladder-result.json> [--session <file>]` and judges one run's autonomy, so there must be a " +
      "run first",
    runsIn: "suite:test:stardew-dialogue-autonomy",
  },
  {
    path: "gates/stardew/check-stardew-dialogue-stream.mjs",
    reason: "arguments: takes `<result.json> [--expect-speaker] [--session]` and judges one run's dialogue stream",
    runsIn: "suite:test:stardew-dialogue-stream",
  },
  {
    path: "gates/stardew/check-stardew-discovery-collection-coverage.mjs",
    reason: "elsewhere: static discovery-collection coverage gate, runs on every push as its own step",
    runsIn: "pnpm check:stardew-discovery-collection-coverage",
  },
  {
    path: "gates/stardew/check-stardew-execution-receipt-field-parity.mjs",
    reason: "elsewhere: static receipt-field parity gate, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-execution-receipt-field-parity",
  },
  {
    path: "gates/stardew/check-stardew-execution-terminal-uniqueness.mjs",
    reason:
      "arguments: requires `--artifact <path>` pointing at one FINISHED run's receipt reading (the frames its fact" +
      " listeners emitted, and the answers its caller received), so there is nothing to compare before a run exists;" +
      " measured 2026-11-08 on a recorded run it examines 159 terminal frames and reports `duplicated: 0`, because the" +
      " Mod publishes each receipt once and the duplicate this gate exists for was the client counting the answer" +
      " beside the push",
    runsIn: "pnpm check:stardew-execution-terminal-uniqueness",
  },
  {
    path: "gates/stardew/check-stardew-family-size.mjs",
    reason:
      "elsewhere: static scan of the action family sizes, runs on every push in the CI gates job through `check:stardew-family-size`",
    runsIn: "pnpm check:stardew-family-size",
  },
  {
    path: "gates/stardew/check-stardew-game-thread-affinity.mjs",
    reason:
      "elsewhere: static scan of the Mod's sources for a `StardewValley` entity read or written from a thread that is " +
      "not the game loop, so it needs no game, no build and no SMAPI; it runs on every push in the CI gates job through " +
      "`pnpm check:stardew-game-thread-affinity`",
    runsIn: "pnpm check:stardew-game-thread-affinity",
  },
  {
    path: "gates/stardew/check-stardew-fixture-scenario-wiring.mjs",
    reason: "elsewhere: static fixture-scenario wiring gate, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-fixture-scenario-wiring",
  },
  {
    path: "gates/stardew/check-stardew-gameplay-completeness.mjs",
    reason: "arguments: requires `--report <direct-inspector-report.json>`, a report a live lane produces",
    runsIn: "pnpm check:stardew-gameplay-completeness",
  },
  {
    path: "gates/stardew/check-stardew-lifecycle-pins.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-stardew-lifecycle-pins.test.mjs`, inside `test:stardew-lifecycle-pins`, a member of the tool-test corpus that ci.yml runs on every push",
    runsIn: "suite:test:stardew-lifecycle-pins",
  },
  {
    path: "gates/stardew/check-stardew-live-runner-coverage.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-stardew-live-runner-coverage.test.mjs`, inside `test:stardew-live-runner-coverage`, a member of the tool-test corpus that ci.yml runs on every push",
    runsIn: "suite:test:stardew-live-runner-coverage",
  },
  {
    path: "gates/stardew/check-stardew-task-gap-reasons.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-stardew-task-gap-reasons.test.mjs`, inside `test:stardew-task-gap-reasons`, a member of the tool-test corpus that ci.yml runs on every push. Its tier is l2 because the population it reads - `tools/lib/task-purpose.mjs` - imports the built `host/dist-test` adapter, and the ladder's L0 rung runs before that artifact is assembled",
    runsIn: "suite:test:stardew-task-gap-reasons",
  },
  {
    path: "gates/stardew/check-stardew-instance-property-coverage.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule is exercised by `tools/check-stardew-observation-gap.test.mjs`, inside `test:stardew-observation-gap`, a member of the tool-test corpus that ci.yml runs on every push, which is `tools/check-stardew-observation-gap.mjs`'s own falsifier",
    runsIn: "suite:test:stardew-observation-gap",
  },
  {
    path: "gates/stardew/check-stardew-loop-closure.mjs",
    reason:
      "environment: measured stardew_decompile_root_missing; it counts call sites in ref/external/StardewValleyDecompiled",
    runsIn: "pnpm check:stardew-loop-closure",
  },
  {
    path: "gates/stardew/check-stardew-mod-folder-name.mjs",
    reason: "elsewhere: static three-file scan of the deployed folder name, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-mod-folder-name",
  },
  {
    path: "gates/stardew/check-stardew-native-mechanism-review-register.mjs",
    reason: "arguments: requires `--mechanism-report`, `--register` and `--source-root`",
    runsIn: "pnpm check:stardew-native-mechanism-review-register",
  },
  {
    path: "gates/stardew/check-stardew-native-multiplayer-sensitivity.mjs",
    reason:
      "environment: reads the gitignored decompiled tree; its own script passes " +
      "`--source-root ref/external/StardewValleyDecompiled/Stardew Valley`",
    runsIn: "pnpm check:stardew-native-multiplayer-sensitivity",
  },
  {
    path: "gates/stardew/check-stardew-native-normal-player-ingress-register.mjs",
    reason: "arguments: requires `--register`, `--mechanism-report` and `--source-root`",
    runsIn: "pnpm check:stardew-native-normal-player-ingress-register",
  },
  {
    path: "gates/stardew/check-stardew-native-notice-coverage.mjs",
    reason: "environment: counts call sites in the gitignored decompiled tree, which a checkout reports as 0 files",
    runsIn: "pnpm check:stardew-native-notice-coverage",
  },
  {
    path: "gates/stardew/check-stardew-native-pathfinder-source.mjs",
    reason: "elsewhere: static pathfinder-source gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-native-pathfinder-source",
  },
  {
    path: "gates/stardew/check-stardew-native-router-exit-classifier.mjs",
    reason: "arguments: requires `--inventory` and `--classifier`",
    runsIn: "pnpm check:stardew-native-router-exit-classifier",
  },
  {
    path: "gates/stardew/check-stardew-native-source-closure.mjs",
    reason: "arguments: requires a certificate, universe, boundary model, source root, assembly and content manifest",
    runsIn: "pnpm check:stardew-native-source-closure",
  },
  {
    path: "gates/stardew/check-stardew-native-transition-ledger.mjs",
    reason: "arguments: requires a ledger, mechanism report, review register, scope manifest and source root",
    runsIn: "pnpm check:stardew-native-transition-ledger",
  },
  {
    path: "gates/stardew/check-stardew-receipt-attribution.mjs",
    reason: "elsewhere: static receipt-attribution gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-receipt-attribution",
  },
  {
    path: "gates/stardew/check-stardew-shop-purchase-pays-for-goods.mjs",
    reason:
      "suite: nothing runs this file as a gate; its rule - the receipt fixture it reads, and the invariant the Mod's shop " +
      "handlers cite in `<c>` comments - is exercised by `tools/check-stardew-shop-purchase-pays-for-goods.test.mjs`, a " +
      "member of `suite:stardew-tooling` that ci.yml runs on every push",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/stardew/check-stardew-snapshot-family-bounds.mjs",
    reason:
      "debt: measured red at HEAD (exit 1, 1 finding) on the Mod's bounded target arrays against the Host's caps, so " +
      "wiring it would stop the ladder on a disagreement between two hand-written sides · measured exit 1 with ZERO " +
      "families derived: `construction_arity_mismatch` (118 arguments against 120 parameters), so no cap is compared " +
      "at all at 449f0fb0",
    runsIn: "on-demand",
    expires:
      "expires when `construction_arity_mismatch` is gone and the gate derives families to compare, so its verdict stops " +
      "being about a parse failure",
  },
  {
    path: "gates/stardew/check-stardew-tick-handler-allocation.mjs",
    reason:
      "elsewhere: static scan of the handlers the Mod registers on the game loop's tick for an allocation per frame - a " +
      "cost no test catches because the result is correct - so it needs no game and no build; it runs on every push in " +
      "the CI gates job through `pnpm check:stardew-tick-handler-allocation`",
    runsIn: "pnpm check:stardew-tick-handler-allocation",
  },
  {
    path: "gates/stardew/check-stardew-tool-family-stamina-evidence.mjs",
    reason: "elsewhere: static stamina-evidence gate over the tool families, runs on every push",
    runsIn: "pnpm check:stardew-tool-family-stamina-evidence",
  },
  {
    path: "gates/stardew/check-stardew-wia-agent-loop.mjs",
    reason:
      "arguments: judges ONE ladder-6 run from its result/session artifacts, so it is a post-run verdict with " +
      "nothing to read before the run; its rule is exercised by `tools/check-stardew-wia-agent-loop.test.mjs`, a member " +
      "of `suite:stardew-tooling` that ci.yml runs on every push",
    runsIn: "suite:suite:stardew-tooling",
  },
  {
    path: "gates/data/check-stub-subject-collision.mjs",
    reason: "elsewhere: static stub-subject collision report over the surface journeys, runs on every push",
    runsIn: "pnpm check:stub-subject-collision",
  },
  {
    path: "gates/product/check-surface-journeys.mjs",
    reason: "elsewhere: static surface-journey coverage gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:surface-journeys",
  },
  {
    path: "gates/product/check-tavern-release-prerequisites.mjs",
    reason: "environment: needs live provider turns and an assembled generation; it exits 2 (blocked) without them",
    runsIn: "pnpm check:tavern-release-prerequisites",
  },
  {
    path: "gates/data/check-test-store-teardown.mjs",
    reason: "elsewhere: static scan for unclosed test stores, runs on every push as its own step",
    runsIn: "pnpm check:test-store-teardown",
  },
  {
    path: "gates/data/check-text-hygiene.mjs",
    reason:
      "debt: measured red at HEAD - committed files are missing a final newline or carry trailing whitespace · " +
      "measured files examined 3472, violations 201, verdict blocked at 95dd6efe",
    runsIn: "pnpm check:text-hygiene",
  },
  {
    path: "gates/arch/check-unreported-catch.mjs",
    reason: "elsewhere: static scan of catch clauses through the workspace's TypeScript compiler, runs on every push",
    runsIn: "pnpm check:unreported-catch",
  },
  {
    path: `${STARDEW_TESTS}/stardew-reachable-exit-reconciliation.test.mjs`,
    reason:
      "environment: recomputes the reachable-exit inventory from ref/external/StardewValleyDecompiled, which a " +
      "checkout has not got; its own suite owns the run",
    runsIn: "suite:test:stardew-reachable-exits-reconciliation",
  },
]);

/** `<dir>/<file>` for every population member, derived from `POPULATION_SCAN`. A declared directory the tree has not
 * got yet is an empty scan, not a crash: only `gates/meta/` exists while the other domains are still unfiled. */
export function derivePopulation({
  list = (dir) => (existsSync(resolve(ROOT, dir)) ? readdirSync(resolve(ROOT, dir)) : []),
} = {}) {
  const members = [];
  for (const scan of POPULATION_SCAN) {
    for (const name of list(scan.dir).sort()) if (scan.include(name)) members.push(`${scan.dir}/${name}`);
  }
  return members;
}

/** The gates each rung runs, from the ladder's own declaration: `Map<path, rungId>`. */
export function preludeGatePaths({ rungs = PRELUDE_RUNGS } = {}) {
  const paths = new Map();
  for (const rung of rungs) for (const gate of rung.gates) paths.set(gate, rung.id);
  return paths;
}

/**
 * Does `runsIn` actually lead to this gate? Every claim form is checked against the file it names, so an exemption
 * cannot outlive the script that stopped running it.
 *
 * A script is read from both `package.json` trees - `HEAD`'s and the worktree's - because a script either of them has
 * is a script that runs somewhere, and a worktree copy that has not caught up is not evidence about the commit.
 *
 * `suite:` and `hook:` are the two forms whose file does not name the gate by path:
 *   `suite:<script>`  the script runs `node --test` over test files, and the claim is that this gate's own case is in
 *                     one of them. A falsifier names `<gate>.test.mjs`, so the path is not a substring of the command;
 *                     the test files the command runs are read instead, and one of them has to name the gate. That is
 *                     the claim being checked - not "some suite exists", which any script with a test file would pass.
 *   `hook:<file>`     a git hook runs the named file, and the named file runs the gate. `core.hooksPath` in this
 *                     repository is `tools/git-hooks`, whose pre-commit hook runs `tools/scripts/pre-commit.mjs`; the
 *                     row names the file that spawns the gate, and that file's text has to name it.
 */
export function verifyRunsIn(entry, { scripts, headScripts = {}, workflow, read = readText }) {
  if (entry.runsIn === "on-demand") return null;
  const fromPnpm = /^pnpm (\S+)$/u.exec(entry.runsIn);
  const fromSuite = /^suite:(\S+)$/u.exec(entry.runsIn);
  if (fromPnpm !== null || fromSuite !== null) {
    const name = fromPnpm?.[1] ?? fromSuite?.[1];
    const head = headScripts ?? {};
    const commands = [scripts[name], head[name]].filter((command) => typeof command === "string");
    const readings = [
      typeof scripts[name] === "string" ? `worktree ${name} runs: ${scripts[name]}` : null,
      typeof head[name] === "string" ? `HEAD ${name} runs: ${head[name]}` : null,
    ].filter((reading) => reading !== null);
    if (readings.length === 0)
      return {
        code: "exempt_runs_in_unknown_script",
        detail: `${name} is in neither the worktree nor HEAD's package.json`,
      };
    if (readings.some((reading) => reading.includes(entry.path))) return null;
    if (fromSuite !== null)
      for (const file of commands.flatMap(testFilesOf))
        if ((read(file) ?? "").includes(basenameOf(entry.path))) return null;
    return { code: "exempt_runs_in_script_does_not_name_the_gate", detail: readings.join("; ") };
  }
  const fromHook = /^hook:(\S+)$/u.exec(entry.runsIn);
  if (fromHook !== null) {
    const text = read(fromHook[1]);
    if (text === null) return { code: "exempt_runs_in_unknown_hook", detail: fromHook[1] };
    if (!text.includes(entry.path)) return { code: "exempt_runs_in_hook_does_not_name_the_gate", detail: fromHook[1] };
    return null;
  }
  const fromWorkflow = /^ci:(\S+)$/u.exec(entry.runsIn);
  if (fromWorkflow !== null) {
    const text = workflow(fromWorkflow[1]);
    if (text === null) return { code: "exempt_runs_in_unknown_workflow", detail: fromWorkflow[1] };
    if (!text.includes(entry.path))
      return { code: "exempt_runs_in_workflow_does_not_name_the_gate", detail: fromWorkflow[1] };
    return null;
  }
  return { code: "exempt_runs_in_unrecognised", detail: entry.runsIn };
}

/** The test files a script command runs: the only tokens `node --test` can be given that name a case. */
function testFilesOf(command) {
  return command
    .split(/\s+/u)
    .map((token) => token.replace(/^["']|["']$/gu, ""))
    .filter((token) => /\.test\.(?:mjs|ts)$/u.test(token));
}

/** Reason classes that assert the gate runs on every push; that claim is checked against the CI coverage gate. */
const RUNS_ON_EVERY_PUSH = "elsewhere";

/** The class that says nothing runs the gate; the claim is checked the same way, in the opposite direction. */
const NOTHING_RUNS_IT = "unrun";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Does this text name the gate, or the falsifier that lives beside it?
 *
 * The stem is what a caller writes: `tools/check-x.mjs`, `tools/check-x.test.mjs` and `tools/check-x.mutation.mjs` are
 * one gate and its two falsifier shapes, so three spellings of "names this gate" would be three places to forget one.
 */
export function namesGate(text, path) {
  const stem = String(path).replace(/\.mjs$/u, "");
  return new RegExp(`${escapeRegExp(stem)}(?:\\.(?:test|mutation))?\\.mjs`, "u").test(text);
}

/** The scripts in these `package.json` tables whose command names the gate, as `worktree <name>` / `HEAD <name>`. */
function entriesNaming(path, tables) {
  return tables.flatMap((table, index) =>
    Object.entries(table ?? {})
      .filter(([, command]) => typeof command === "string" && namesGate(command, path))
      .map(([name]) => `${index === 0 ? "worktree" : "HEAD"} ${name}`),
  );
}

/**
 * The classes whose reason states a MEASUREMENT of this tree, and therefore goes stale in both directions.
 *
 * `debt` says "measured red, N findings", `report` says "it prints while exiting 0", `installed` says "the build output
 * does not match" - each is a reading taken on a day, and a reading nobody re-takes is how five of eight `debt` rows
 * ended up wrong both ways at once (three were green, and three understated their own debt by an order of magnitude).
 *
 * `environment` is deliberately NOT here: it states which input a checkout has not got, which is a property of the
 * checkout rather than a reading that drifts. `elsewhere` states where a gate runs (which `runsIn` and the CI coverage
 * gate verify mechanically), `arguments` what a caller must supply, `fixup`/`suite` where the work happens - none of
 * those is re-measurable, so stamping them would be ceremony rather than evidence.
 */
export const MEASURED_REASON_CLASSES = Object.freeze(["debt", "report", "installed"]);

/** ` · measured <reading> at <sha>`: the reading a reason was taken from, and the revision it was true at. */
const MEASUREMENT_STAMP = / · measured (.+?) at ([0-9a-f]{7,40})$/u;

/**
 * How many release tags may be cut after a reading before the register stops calling it current.
 *
 * Releases are this repository's `v0.1.0-rc.*` tags, counted with `git tag --contains <sha>`: a reading taken five
 * releases ago describes a tree that has moved five times, and re-taking it is cheaper than trusting it.
 */
export const RELEASES_BEFORE_UNVERIFIED = 5;

/** The stamp a reason carries, or null when it carries none. */
export function stampOf(entry) {
  const match = MEASUREMENT_STAMP.exec(typeof entry.reason === "string" ? entry.reason : "");
  return match === null ? null : { reading: match[1], revision: match[2] };
}

/**
 * Release tags containing `revision`, or null when git cannot resolve it.
 *
 * Null is the interesting answer: a stamp naming a revision nobody can find is not an old reading, it is a claim with no
 * subject, so the caller reports it as a finding rather than as staleness.
 */
export function releasesSince(revision, { root = ROOT } = {}) {
  if (!/^[0-9a-f]{7,40}$/u.test(revision)) return null;
  const result = spawnSync("git", ["tag", "--contains", revision], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/** The class an exemption declares, or `null` when it carries no reason to declare one. */
function declaredClass(entry) {
  return typeof entry.reason === "string" ? entry.reason.split(":")[0].trim() : null;
}

/**
 * How short a statement is too short to name anything. A `reason` and an `expires` are held to the same floor: each is
 * prose a later reader has to act on, and "later" or "someday" acts on nothing.
 */
const MIN_STATEMENT_CHARS = 40;

/**
 * The register, checked in both directions. Every finding names the file it is about, because the file is the thing
 * the reader has to open. `headScripts` is `HEAD`'s script table, or `null` when git could not read it; passing it
 * is what keeps a stale worktree copy from deciding whether an exemption's `runsIn` resolves.
 *
 * `population` stays what `derivePopulation()` derives - the scans' answer - and `unscanned` is the declared set of gate
 * files no scan reaches (`UNSCANNED_GATES`). They are two arguments rather than one merged list because the derivation
 * is what `check-gate-population-agreement.mjs` reads, and widening it would have taught that gate a second rule.
 *
 * `read` is how a `suite:` or `hook:` claim is verified; `workflowText` is every workflow concatenated, so `unrun`
 * ("nothing names this file") can be checked rather than asserted. Null means nobody passed it and the claim is
 * printed as unverified instead of passing quietly.
 */
export function checkRegistry({
  population,
  unscanned = [],
  wired,
  exemptions = EXEMPTIONS,
  scripts,
  headScripts = {},
  workflow,
  workflowText = null,
  ciCoverage,
  releases = releasesSince,
  read = readText,
}) {
  const wiredPaths = new Set(wired.keys());
  const members = [...population, ...unscanned];
  const populationMembers = new Set(members);
  const exempt = new Map();
  const findings = [];
  const unverified = [];
  for (const path of wiredPaths)
    if (!populationMembers.has(path))
      findings.push({ code: "wired_not_a_gate", path, detail: `prelive ${wired.get(path)} names it` });
  for (const entry of exemptions) {
    if (exempt.has(entry.path)) findings.push({ code: "exempt_duplicated", path: entry.path });
    exempt.set(entry.path, entry);
  }
  const forgotten = members.filter((path) => !wiredPaths.has(path) && !exempt.has(path));
  for (const path of forgotten) findings.push({ code: "gate_forgotten", path });
  for (const path of unscanned) {
    if (inAPopulationScan(path))
      findings.push({
        code: "unscanned_but_scanned",
        path,
        detail: "a population scan reaches it now; delete the row from UNSCANNED_GATES",
      });
    if (read(path) === null)
      findings.push({ code: "unscanned_gate_missing", path, detail: "the declared file is not on disk" });
  }
  const exemptOnly = exemptions.filter((entry) => !wiredPaths.has(entry.path));
  for (const entry of exemptions) {
    if (wiredPaths.has(entry.path)) {
      findings.push({ code: "exempt_but_wired", path: entry.path, detail: `prelive ${wired.get(entry.path)} runs it` });
      continue;
    }
    if (!populationMembers.has(entry.path)) {
      findings.push({ code: "exempt_not_a_gate", path: entry.path });
      continue;
    }
    const className = declaredClass(entry);
    if (className === null) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: "the entry carries no reason" });
      continue;
    }
    if (!Object.hasOwn(REASON_CLASSES, className)) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: `unknown class "${className}"` });
      continue;
    }
    if (entry.reason.length < MIN_STATEMENT_CHARS) {
      findings.push({
        code: "exempt_unreasoned",
        path: entry.path,
        detail: "the reason is too short to name anything",
      });
      continue;
    }
    if (typeof entry.runsIn !== "string" || entry.runsIn.length === 0) {
      findings.push({
        code: "exempt_runs_in_missing",
        path: entry.path,
        detail: "no runsIn; write pnpm <script>, suite:<script>, ci:<workflow> or on-demand",
      });
      continue;
    }
    // A row with a home is re-checked on every run by the script/suite/hook/workflow it names, so it expires by going
    // red. A row with none has nothing to re-check, and a silence kept forever is what this register exists to name.
    if (
      entry.runsIn === "on-demand" &&
      !(typeof entry.expires === "string" && entry.expires.length >= MIN_STATEMENT_CHARS)
    )
      findings.push({
        code: "exempt_expiry_unreasoned",
        path: entry.path,
        detail:
          typeof entry.expires === "string" && entry.expires.length > 0
            ? "`expires` is too short to name the condition that ends the row"
            : "the row says nothing runs this gate, and carries no `expires` saying what would end that",
      });
    const dangling = verifyRunsIn(entry, { scripts, headScripts, workflow, read });
    if (dangling !== null) findings.push({ ...dangling, path: entry.path });
    // A reason in a measured class states a reading; this is where it says when it was taken, and where a reading too
    // old to trust is named. Printed rather than found: a register that reddens on ninety unstamped rows teaches nobody
    // which row to re-measure, and one that says nothing leaves the prose unmeasured - so it names each row.
    if (MEASURED_REASON_CLASSES.includes(className)) {
      const stamp = stampOf(entry);
      if (stamp === null)
        unverified.push({ path: entry.path, why: "the reason carries no ` · measured <reading> at <sha>`" });
      else {
        const since = releases(stamp.revision);
        if (since === null)
          findings.push({
            code: "exempt_measured_revision_unknown",
            path: entry.path,
            detail: `the stamp names ${stamp.revision}, which git cannot resolve`,
          });
        else if (since >= RELEASES_BEFORE_UNVERIFIED)
          unverified.push({ path: entry.path, why: `${since} release(s) since ${stamp.revision}` });
      }
    }
    if (className === NOTHING_RUNS_IT) {
      const naming = entriesNaming(entry.path, [scripts, headScripts]);
      if (naming.length > 0)
        findings.push({ code: "exempt_unrun_but_named", path: entry.path, detail: `${naming.join(", ")} names it` });
      else if (workflowText === null)
        unverified.push({ path: entry.path, why: "no workflow text was read, so `nothing runs it` is unchecked" });
      else if (namesGate(workflowText, entry.path))
        findings.push({ code: "exempt_unrun_but_named", path: entry.path, detail: "a workflow step names it" });
    }
    if (className === RUNS_ON_EVERY_PUSH && entry.runsIn.startsWith("pnpm ")) {
      const script = entry.runsIn.slice("pnpm ".length);
      if (!ciCoverage.runs.has(script)) {
        const registered = ciCoverage.registered.get(script);
        findings.push({
          code: "exempt_elsewhere_not_in_ci",
          path: entry.path,
          detail:
            registered === undefined
              ? `${script} is in no workflow and in no gates job`
              : `gates/meta/check-ci-coverage.mjs registers ${script} as ${registered.reason}: ${registered.detail}`,
        });
      }
    }
  }
  const counts = new Map();
  for (const entry of exemptOnly) {
    const className = declaredClass(entry);
    if (className === null) continue;
    counts.set(className, (counts.get(className) ?? 0) + 1);
  }
  const onDemand = exemptions.filter((entry) => entry.runsIn === "on-demand").map((entry) => entry.path);
  return {
    status: findings.length === 0 ? "passed" : "failed",
    wired: members.filter((path) => wiredPaths.has(path)).length,
    total: members.length,
    exempt: exemptOnly.length,
    byClass: Object.fromEntries([...counts.entries()].sort()),
    onDemand,
    unscanned,
    unverified,
    scriptTrees: {
      head: headScripts === null ? null : Object.keys(headScripts).length,
      disagreeing: headScripts === null ? [] : scriptTreeDisagreements(scripts, headScripts),
    },
    findings,
  };
}

/** A repo-relative file's text, or null when it is not there: the one reader the register asks for any file. */
function readText(file) {
  try {
    return readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    return null;
  }
}

/** The scripts the worktree's `package.json` declares: what this checkout has on disk, not what it has committed. */
export function readScripts({ root = ROOT } = {}) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
}

/**
 * The scripts `HEAD`'s `package.json` declares, or `null` when git cannot answer (no repository, no commit).
 *
 * The register used to read the worktree copy alone, and a script committed through a private index - in `HEAD`,
 * absent from this file on disk - was reported as `exempt_runs_in_unknown_script`: a gate that runs called
 * unreachable because of a stale local file. Every gate in this tree that asks "does anything run this?" reads
 * `HEAD` for exactly this reason.
 */
export function readHeadScripts({ root = ROOT } = {}) {
  const result = spawnSync("git", ["show", "HEAD:package.json"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).scripts ?? {};
  } catch {
    return null;
  }
}

/**
 * Script names whose command differs between the worktree and `HEAD`, sorted. A name only one tree has is a
 * disagreement: it is the reading that decides whether an exemption's `runsIn` resolves, so it is printed rather
 * than left to decide a verdict silently.
 */
export function scriptTreeDisagreements(worktreeScripts, headScripts) {
  const worktree = worktreeScripts ?? {};
  const head = headScripts ?? {};
  const names = new Set([...Object.keys(worktree), ...Object.keys(head)]);
  return [...names].filter((name) => worktree[name] !== head[name]).sort();
}

/** `gates/meta/check-ci-coverage.mjs` owns the fact "does a script run on every push"; this reads it, never restates it. */

/**
 * The register, read off the real tree: the derived population, the ladder's own wired set, both `package.json`
 * trees, the workflows and the CI coverage gate. One function, so the CLI and its tests cannot read the tree two
 * different ways.
 */
export function auditRegistry() {
  const scripts = readScripts();
  const headScripts = readHeadScripts();
  const files = readdirSync(resolve(ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `${WORKFLOW_DIR}/${name}`);
  const texts = new Map(files.map((file) => [file, readText(file) ?? ""]));
  const coverage = deriveCiCoverage({ scripts, workflowText: [...texts.values()].join("\n") });
  return checkRegistry({
    population: derivePopulation(),
    unscanned: UNSCANNED_GATES.map((entry) => entry.path),
    wired: preludeGatePaths(),
    exemptions: [...EXEMPTIONS, ...UNSCANNED_GATES],
    scripts,
    headScripts,
    workflow: (file) => texts.get(file) ?? null,
    workflowText: [...texts.values()].join("\n"),
    ciCoverage: {
      runs: new Set([...coverage.workflow, ...coverage.derived]),
      registered: new Map(coverage.register.map((entry) => [entry.script, entry])),
    },
  });
}

/**
 * The register's output as data - the lines a reader sees, and the exit code - so a falsifier can assert the named
 * finding and the status without spawning a subprocess, and `report` cannot print a verdict it did not return.
 */
export function renderRegistry(result) {
  const lines = [];
  const byClass = Object.entries(result.byClass)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
  lines.push(
    `prelive_gate_registry: wired ${result.wired} of ${result.total}; exempt ${result.exempt}` +
      `${byClass === "" ? "" : ` (${byClass})`}`,
  );
  lines.push(
    result.scriptTrees.head === null
      ? "prelive_gate_registry: scripts_read=worktree-only; git cannot read HEAD:package.json"
      : "prelive_gate_registry: scripts_read=worktree+HEAD",
  );
  if (result.scriptTrees.disagreeing.length > 0)
    lines.push(
      `prelive_gate_registry: package_json_trees_disagree=${result.scriptTrees.disagreeing.length} ` +
        `${result.scriptTrees.disagreeing.join(",")}`,
    );
  if (result.onDemand.length > 0)
    lines.push(`prelive_gate_registry: no_scheduled_home=${result.onDemand.length} ${result.onDemand.join(",")}`);
  // Printed apart from the population on purpose: these are gate files the derivation does not scan, and a reader has to
  // see that they are declared rather than counted among the members a scan found.
  if (result.unscanned.length > 0)
    lines.push(`prelive_gate_registry: outside_the_scan=${result.unscanned.length} ${result.unscanned.join(",")}`);
  if (result.unverified.length > 0)
    lines.push(
      `prelive_gate_registry: reason_unverified=${result.unverified.length} ${result.unverified
        .map((entry) => entry.path)
        .join(",")}`,
    );
  for (const finding of result.findings) {
    switch (finding.code) {
      case "gate_forgotten":
        lines.push(
          `prelive_gate_registry_forgotten: ${finding.path} runs in no prelive rung and no exemption names where it runs`,
        );
        break;
      case "exempt_but_wired":
        lines.push(`prelive_gate_registry_exempt_but_wired: ${finding.path} (${finding.detail}); delete the exemption`);
        break;
      case "wired_not_a_gate":
        lines.push(
          `prelive_gate_registry_wired_not_a_gate: ${finding.path} is named by ${finding.detail} but is not in the derived population`,
        );
        break;
      case "exempt_not_a_gate":
        lines.push(
          `prelive_gate_registry_exempt_not_a_gate: ${finding.path} is not in the derived population; delete the entry`,
        );
        break;
      case "exempt_duplicated":
        lines.push(`prelive_gate_registry_exempt_duplicated: ${finding.path} is listed twice`);
        break;
      case "exempt_unreasoned":
        lines.push(
          `prelive_gate_registry_exempt_unreasoned: ${finding.path} - ${finding.detail}; classes are ` +
            `${Object.keys(REASON_CLASSES).join("|")}`,
        );
        break;
      case "exempt_expiry_unreasoned":
        lines.push(
          `prelive_gate_registry_exempt_expiry_unreasoned: ${finding.path} - ${finding.detail}; a row with no ` +
            "scheduled home must say what would end it, the way an expiring exemption does elsewhere in this tree",
        );
        break;
      case "exempt_runs_in_missing":
        lines.push(
          `prelive_gate_registry_exempt_runs_in_missing: ${finding.path} - ${finding.detail}; with no runsIn the entry ` +
            "claims nothing and this register cannot tell a gate with a home from one without",
        );
        break;
      case "exempt_elsewhere_not_in_ci":
        lines.push(`prelive_gate_registry_exempt_elsewhere_not_in_ci: ${finding.path} - ${finding.detail}`);
        break;
      case "exempt_measured_revision_unknown":
        lines.push(
          `prelive_gate_registry_exempt_measured_revision_unknown: ${finding.path} - ${finding.detail}; a stamp naming a ` +
            "revision nobody can resolve is a reading with no subject, not an old one",
        );
        break;
      default:
        lines.push(`prelive_gate_registry_${finding.code}: ${finding.path} - ${finding.detail}`);
    }
  }
  lines.push(
    `prelive_gate_registry: ${result.status}` +
      `${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  return { lines, exitCode: result.findings.length === 0 ? 0 : 1 };
}

function report(result) {
  const rendered = renderRegistry(result);
  for (const line of rendered.lines) process.stdout.write(`${line}\n`);
  return rendered.exitCode;
}

function main() {
  process.exitCode = report(auditRegistry());
}

if (import.meta.main) main();
