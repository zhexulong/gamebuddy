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
 *   `runsIn` is one of `pnpm <script>` / `suite:<script>` (the script must exist and name this gate's path),
 *            `ci:<workflow>` (that workflow must name the path), or `on-demand` (no scheduled home at all - printed
 *            under `no_scheduled_home`, so the gates nothing runs are a line of output rather than an assumption).
 *            An `elsewhere` exemption additionally asserts that the script runs on every push, and that assertion is
 *            checked against `tools/check-ci-coverage.mjs`, which owns the fact.
 *
 * The table is validated in both directions, so it cannot rot into a list nobody looked at:
 *   - a population member neither wired nor exempt is `gate_forgotten`, and the message names the FILE;
 *   - an exemption for a gate that prelive now runs is `exempt_but_wired` - the reason has been overtaken;
 *   - an exemption for a path that is no longer a gate is `exempt_not_a_gate`;
 *   - a class outside `REASON_CLASSES`, or a reason too short to name anything, is `exempt_unreasoned`;
 *   - a `runsIn` that does not resolve to a script/workflow naming the gate is `exempt_runs_in_dangling`;
 *   - an `elsewhere` exemption whose script `tools/check-ci-coverage.mjs` registers as running in no workflow is
 *     `exempt_elsewhere_not_in_ci`.
 *
 * `wired N of M; exempt K` is the verdict line; `node tools/check-prelive-gate-registry.mjs` exits 1 on any finding.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCiCoverage } from "./check-ci-coverage.mjs";
import { PRELUDE_RUNGS } from "./prelive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STARDEW_TESTS = "integrations/stardew/action-development/tests";
const WORKFLOW_DIR = ".github/workflows";

/** The derivation, as data: one entry per scan, each with what it includes and what it deliberately leaves out. */
export const POPULATION_SCAN = Object.freeze([
  {
    dir: "tools",
    include: /^(?:check|audit)-.*\.mjs$/u,
    exclude: [/\.test\.mjs$/u],
  },
  {
    dir: STARDEW_TESTS,
    include: /(?:-drift|-reconciliation)\.test\.mjs$/u,
    exclude: [],
  },
]);

/** Why a gate in the population does not run in prelive, as closed classes so the count is a measurement. */
export const REASON_CLASSES = Object.freeze({
  elsewhere:
    "runs on every push in the CI gates job through a pnpm script; prelive would be a second copy of a gate that " +
    "already has a home, and the ladder's budget is the ~5 s L0 plus the ~40 s L0b it already spends",
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
  suite: "its measurements are made by the named node --test suite, not by running this file as a gate",
});

/**
 * Every population member that does not run in prelive, in path order. `elsewhere` entries are the bulk on purpose:
 * they are the gates that already run on every push, and the register's job is to say so rather than to duplicate them.
 */
export const EXEMPTIONS = Object.freeze([
  {
    path: "tools/audit-chat-live-run.mjs",
    reason:
      "arguments: requires `--audit <chat-run-dir>` pointing at an existing Chat live-run directory (same entry as " +
      "tools/check-ci-coverage.mjs's register), so there is nothing to verify before a run exists",
    runsIn: "pnpm audit:chat-live-run",
  },
  {
    path: "tools/audit-gate-red-proofs.mjs",
    reason: "elsewhere: static gate-red-proof audit, runs on every push in the CI gates job",
    runsIn: "pnpm audit:gate-red-proofs",
  },
  {
    path: "tools/audit-stardew-action-admission-ledger.mjs",
    reason:
      "report: re-derives the ledger of design/architecture/stardew-action-execution-kernel.md and prints the drift " +
      "to stderr while exiting 0 (measured 2026-11-05: `requestHandlers: document says 42, source has 95`), so a rung " +
      "would report it green while it is reporting a disagreement",
    runsIn: "on-demand",
  },
  {
    path: "tools/audit-stardew-admission-fork-delta.mjs",
    reason: "elsewhere: static audit of the forked admission sites, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-admission-fork-delta",
  },
  {
    path: "tools/audit-stardew-decision-closure.mjs",
    reason: "elsewhere: static decision-closure audit over the action surface, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-decision-closure",
  },
  {
    path: "tools/audit-stardew-handler-actor-guard.mjs",
    reason:
      "arguments: reads `integrations/stardew/` out of a git revision (`git ls-tree -r <rev>`, `git show <rev>:<file>`), " +
      "so it measures a commit's tree, not the worktree the ladder is about to run",
    runsIn: "on-demand",
  },
  {
    path: "tools/audit-stardew-native-local-runner-contract.mjs",
    reason: "elsewhere: static audit of the native-local runners' two habits, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-native-local-runner-contract",
  },
  {
    path: "tools/audit-stardew-nogame-subset.mjs",
    reason:
      "environment: reads the decompiled tree under ref/external/StardewValleyDecompiled to decide which " +
      "Integration.Tests files can run without a game",
    runsIn: "ci:.github/workflows/ci.yml",
  },
  {
    path: "tools/audit-stardew-scene-kind-projection.mjs",
    reason: "elsewhere: static nine-hop projection audit for `observe_scene`, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-scene-kind-projection",
  },
  {
    path: "tools/audit-stardew-state-coverage.mjs",
    reason: "elsewhere: static state-coverage audit over the Mod and the snapshot families, runs on every push",
    runsIn: "pnpm audit:stardew-state-coverage",
  },
  {
    path: "tools/audit-stardew-test-shape.mjs",
    reason: "elsewhere: static audit of source-shape pins in the C# test projects, runs on every push",
    runsIn: "pnpm audit:stardew-test-shape",
  },
  {
    path: "tools/audit-totality.mjs",
    reason: "elsewhere: loads the built Host modules to walk every declaration class, runs on every push",
    runsIn: "pnpm audit:totality",
  },
  {
    path: "tools/audit-totality-head.mjs",
    reason:
      "report: exports its class list to tools/audit-totality.mjs and has no CLI of its own - running it is measured " +
      "exit 0 with no output at all, so a rung would count a gate that measures nothing",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-action-coverage.mjs",
    reason:
      "report: counts dispatches out of `.live-runs/game-ladder` artifacts and exits 0 by design until someone puts a " +
      "number on what well-covered means (`--fail-under`), so there is nothing to fail before a run exists",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-assertion-substance.mjs",
    reason: "elsewhere: static surface-journey assertion scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:assertion-substance",
  },
  {
    path: "tools/check-build-artifact-producers.mjs",
    reason: "elsewhere: static scan of every documented artifact path against its producer, runs on every push",
    runsIn: "pnpm check:build-artifact-producers",
  },
  {
    path: "tools/check-chat-conversational-quality-gate.mjs",
    reason:
      "environment: needs the Host's live DB (`--require-db`) and a synthetic transcript fixture, which the smoke " +
      "script supplies and the ladder does not have",
    runsIn: "pnpm smoke:chat-conversational-quality-gate",
  },
  {
    path: "tools/check-ci-coverage.mjs",
    reason:
      "elsewhere: it IS the CI gate that runs in ci.yml's gates job (`--run`), and it registers the gates a checkout " +
      "does not run - this register consumes it for exactly that fact",
    runsIn: "ci:.github/workflows/ci.yml",
  },
  {
    path: "tools/check-class-name-declarations.mjs",
    reason: "elsewhere: static scan for undeclared class names, runs on every push in the CI gates job",
    runsIn: "pnpm check:class-name-declarations",
  },
  {
    path: "tools/check-commit-staging.mjs",
    reason:
      "fixup: a committer's preflight over the staged set against the paths the commit names, so it describes a " +
      "commit in flight; bare mode says it cannot see the commit's intent and exits 0",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-crab-pot-output-fixture-contract.mjs",
    reason:
      "arguments: requires `--contract <path>` to a provenance contract; without it the gate exits 1 with its own " +
      "usage line, so bare running is not a reading of the tree",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-credential-export-isolation.mjs",
    reason: "elsewhere: static scan that no long-lived credential reaches an artifact, runs on every push",
    runsIn: "pnpm check:credential-export-isolation",
  },
  {
    path: "tools/check-csharp-compile.mjs",
    reason: "elsewhere: compiles the committed C# projects, which ci.yml runs as its own step",
    runsIn: "pnpm check:csharp-compile",
  },
  {
    path: "tools/check-dependency-audit.mjs",
    reason: "elsewhere: validates the recorded advisory dispositions, runs on every push in the CI gates job",
    runsIn: "pnpm check:dependency-audit",
  },
  {
    path: "tools/check-dependency-risk.mjs",
    reason: "elsewhere: validates the frozen risk snapshot and lock hashes, runs on every push",
    runsIn: "pnpm check:dependency-risk",
  },
  {
    path: "tools/check-diff.mjs",
    reason:
      "fixup: `git diff --check` over the worktree, so it reads uncommitted whitespace rather than the tree's contents",
    runsIn: "pnpm check:diff",
  },
  {
    path: "tools/check-dist-runtime-exports.mjs",
    reason:
      "installed: imports `vendor/magic-context/packages/pi-plugin/dist` (a build output), which nothing in the " +
      "ladder assembles",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-draft-declaration-coverage.mjs",
    reason: "elsewhere: static draft-surface coverage scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:draft-declaration-coverage",
  },
  {
    path: "tools/check-duplicated-authority.mjs",
    reason: "elsewhere: static duplicated-authority scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:duplicated-authority",
  },
  {
    path: "tools/check-error-identity-classification.mjs",
    reason: "elsewhere: static scan for failure classification by message text, runs on every push",
    runsIn: "pnpm check:error-identity-classification",
  },
  {
    path: "tools/check-evidence-bundle.mjs",
    reason: "elsewhere: validates the documented evidence-bundle shape, runs on every push in the CI gates job",
    runsIn: "pnpm check:evidence-bundle",
  },
  {
    path: "tools/check-game-historian-rubric.mjs",
    reason: "elsewhere: static rubric gate over the historian prompt, runs on every push in the CI gates job",
    runsIn: "pnpm check:game-historian-rubric",
  },
  {
    path: "tools/check-gameplay-capability-catalog.mjs",
    reason: "environment: reads design/gameplay-capability-catalog.json from the design/ mount",
    runsIn: "pnpm check:gameplay-capability-catalog",
  },
  {
    path: "tools/check-head-typecheck.mjs",
    reason: "elsewhere: typechecks HEAD through the installed workspace, runs on every push as its own step",
    runsIn: "pnpm check:head-typecheck",
  },
  {
    path: "tools/check-host-diagnostic-output.mjs",
    reason: "elsewhere: static scan of Host diagnostic output shape, runs on every push",
    runsIn: "pnpm check:host-diagnostic-output",
  },
  {
    path: "tools/check-host-game-physical-seam.mjs",
    reason: "elsewhere: static scan of the Host/Game physical seam, runs on every push in the CI gates job",
    runsIn: "pnpm check:host-game-physical-seam",
  },
  {
    path: "tools/check-host-production-import-boundary.mjs",
    reason: "elsewhere: static import-boundary scan over host/src, runs on every push in the CI gates job",
    runsIn: "pnpm check:host-production-import-boundary",
  },
  {
    path: "tools/check-host-windows-test-preflight.mjs",
    reason: "elsewhere: static preflight over the Windows Host test entry, runs on every push",
    runsIn: "pnpm check:host-windows-test-preflight",
  },
  {
    path: "tools/check-live-run-failure-dump.mjs",
    reason: "elsewhere: static scan of the live-run failure dump, runs on every push in the CI gates job",
    runsIn: "pnpm check:live-run-failure-dump",
  },
  {
    path: "tools/check-live-run-isolation.mjs",
    reason:
      "environment: builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam " +
      "install (measured exit 1 with live_run_isolation_source_profile_config_missing on a bare tree)",
    runsIn: "pnpm check:live-run-isolation",
  },
  {
    path: "tools/check-live-run-multiday-baseline.mjs",
    reason: "elsewhere: static comparison against the recorded multi-day baseline, runs on every push",
    runsIn: "pnpm check:live-run-multiday-baseline",
  },
  {
    path: "tools/check-live-run-silence.mjs",
    reason: "elsewhere: static scan for silent live-run outcomes, runs on every push in the CI gates job",
    runsIn: "pnpm check:live-run-silence",
  },
  {
    path: "tools/check-parser-agreement.mjs",
    reason: "elsewhere: static parser-agreement scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:parser-agreement",
  },
  {
    path: "tools/check-perf-budget.mjs",
    reason: "elsewhere: re-measures recorded budgets, runs on every push in the CI gates job",
    runsIn: "pnpm check:perf-budget",
  },
  {
    path: "tools/check-perf-scaling.mjs",
    reason: "installed: drives the bench suite as size pairs in child processes, which needs a built `host/dist-test`",
    runsIn: "pnpm check:perf-scaling",
  },
  {
    path: "tools/check-production-pack-load.mjs",
    reason:
      "environment: measured pointer_missing on host/dist/current.json, a generation only the release lane builds",
    runsIn: "pnpm check:production-pack-load",
  },
  {
    path: "tools/check-publint.mjs",
    reason: "elsewhere: package-format gate over the built packages, runs as its own step on every push",
    runsIn: "pnpm check:publint",
  },
  {
    path: "tools/check-refusal-informativeness.mjs",
    reason:
      "debt: measured red at HEAD (exit 1, `unclassified_reason_code " +
      "remove_placed_item_furniture_move_unsupported - no declared family matches it`), so wiring it into a rung " +
      "would only stop the ladder on a defect this register is meant to report",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-scope-references.mjs",
    reason: "debt: measured 4 findings (3 out_of_scope_reference, 1 read_before_declaration) at HEAD",
    runsIn: "pnpm check:scope-references",
  },
  {
    path: "tools/check-silent-failure.mjs",
    reason: "elsewhere: static silent-failure scan, runs on every push in the CI gates job",
    runsIn: "pnpm check:silent-failure",
  },
  {
    path: "tools/check-spec-reachability.mjs",
    reason: "elsewhere: derives which tools/ suites a checkout runs, and runs on every push in the CI gates job",
    runsIn: "pnpm check:spec-reachability",
  },
  {
    path: "tools/check-stardew-action-promotion.mjs",
    reason: "elsewhere: static promotion gate over the action surface, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-action-promotion",
  },
  {
    path: "tools/check-stardew-actor-admissibility.mjs",
    reason:
      "debt: measured red at HEAD - ENOENT on " +
      "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json, an input " +
      "nothing in this tree produces",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stardew-companion-production-admission.mjs",
    reason:
      "arguments: reports admission_cli_required_flag_missing without a caller's evidence paths (same entry as " +
      "tools/check-ci-coverage.mjs's register)",
    runsIn: "pnpm check:stardew-companion-production-admission",
  },
  {
    path: "tools/check-stardew-dialogue-autonomy.mjs",
    reason:
      "arguments: takes `<ladder-result.json> [--session <file>]` and judges one run's autonomy, so there must be a " +
      "run first",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stardew-dialogue-stream.mjs",
    reason: "arguments: takes `<result.json> [--expect-speaker] [--session]` and judges one run's dialogue stream",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stardew-discovery-collection-coverage.mjs",
    reason: "elsewhere: static discovery-collection coverage gate, runs on every push as its own step",
    runsIn: "pnpm check:stardew-discovery-collection-coverage",
  },
  {
    path: "tools/check-stardew-execution-receipt-field-parity.mjs",
    reason: "elsewhere: static receipt-field parity gate, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-execution-receipt-field-parity",
  },
  {
    path: "tools/check-stardew-fixture-scenario-wiring.mjs",
    reason: "elsewhere: static fixture-scenario wiring gate, runs on every push in the CI gates job",
    runsIn: "pnpm audit:stardew-fixture-scenario-wiring",
  },
  {
    path: "tools/check-stardew-gameplay-completeness.mjs",
    reason: "arguments: requires `--report <direct-inspector-report.json>`, a report a live lane produces",
    runsIn: "pnpm check:stardew-gameplay-completeness",
  },
  {
    path: "tools/check-stardew-hold-sufficiency.mjs",
    reason:
      "debt: measured red at HEAD - ENOENT on " +
      "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json, the same " +
      "missing input check-stardew-actor-admissibility names",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stardew-loop-closure.mjs",
    reason:
      "environment: measured stardew_decompile_root_missing; it counts call sites in ref/external/StardewValleyDecompiled",
    runsIn: "pnpm check:stardew-loop-closure",
  },
  {
    path: "tools/check-stardew-loop-closure.mutation.mjs",
    reason:
      "suite: a mutation driver, not a gate - `suite:test:stardew-loop-closure-mutation` plants the defect and " +
      "expects the closure gate to go red",
    runsIn: "suite:test:stardew-loop-closure-mutation",
  },
  {
    path: "tools/check-stardew-mod-folder-name.mjs",
    reason: "elsewhere: static three-file scan of the deployed folder name, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-mod-folder-name",
  },
  {
    path: "tools/check-stardew-native-mechanism-review-register.mjs",
    reason: "arguments: requires `--mechanism-report`, `--register` and `--source-root`",
    runsIn: "pnpm check:stardew-native-mechanism-review-register",
  },
  {
    path: "tools/check-stardew-native-multiplayer-sensitivity.mjs",
    reason:
      "environment: reads the gitignored decompiled tree; its own script passes " +
      "`--source-root ref/external/StardewValleyDecompiled/Stardew Valley`",
    runsIn: "pnpm check:stardew-native-multiplayer-sensitivity",
  },
  {
    path: "tools/check-stardew-native-normal-player-ingress-register.mjs",
    reason: "arguments: requires `--register`, `--mechanism-report` and `--source-root`",
    runsIn: "pnpm check:stardew-native-normal-player-ingress-register",
  },
  {
    path: "tools/check-stardew-native-notice-coverage.mjs",
    reason: "environment: counts call sites in the gitignored decompiled tree, which a checkout reports as 0 files",
    runsIn: "pnpm check:stardew-native-notice-coverage",
  },
  {
    path: "tools/check-stardew-native-pathfinder-source.mjs",
    reason: "elsewhere: static pathfinder-source gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-native-pathfinder-source",
  },
  {
    path: "tools/check-stardew-native-router-exit-classifier.mjs",
    reason: "arguments: requires `--inventory` and `--classifier`",
    runsIn: "pnpm check:stardew-native-router-exit-classifier",
  },
  {
    path: "tools/check-stardew-native-source-closure.mjs",
    reason: "arguments: requires a certificate, universe, boundary model, source root, assembly and content manifest",
    runsIn: "pnpm check:stardew-native-source-closure",
  },
  {
    path: "tools/check-stardew-native-transition-ledger.mjs",
    reason: "arguments: requires a ledger, mechanism report, review register, scope manifest and source root",
    runsIn: "pnpm check:stardew-native-transition-ledger",
  },
  {
    path: "tools/check-stardew-receipt-attribution.mjs",
    reason: "elsewhere: static receipt-attribution gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:stardew-receipt-attribution",
  },
  {
    path: "tools/check-stardew-snapshot-family-bounds.mjs",
    reason:
      "debt: measured red at HEAD (exit 1, 1 finding) on the Mod's bounded target arrays against the Host's caps, so " +
      "wiring it would stop the ladder on a disagreement between two hand-written sides",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stardew-tool-family-stamina-evidence.mjs",
    reason: "elsewhere: static stamina-evidence gate over the tool families, runs on every push",
    runsIn: "pnpm check:stardew-tool-family-stamina-evidence",
  },
  {
    path: "tools/check-stardew-wia-agent-loop.mjs",
    reason:
      "arguments: judges ONE ladder-6 run from its result/session artifacts, so it is a post-run verdict with " +
      "nothing to read before the run",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-stub-subject-collision.mjs",
    reason: "elsewhere: static stub-subject collision report over the surface journeys, runs on every push",
    runsIn: "pnpm check:stub-subject-collision",
  },
  {
    path: "tools/check-surface-journeys.mjs",
    reason: "elsewhere: static surface-journey coverage gate, runs on every push in the CI gates job",
    runsIn: "pnpm check:surface-journeys",
  },
  {
    path: "tools/check-tavern-release-prerequisites.mjs",
    reason: "environment: needs live provider turns and an assembled generation; it exits 2 (blocked) without them",
    runsIn: "pnpm check:tavern-release-prerequisites",
  },
  {
    path: "tools/check-test-store-teardown.mjs",
    reason: "elsewhere: static scan for unclosed test stores, runs on every push as its own step",
    runsIn: "pnpm check:test-store-teardown",
  },
  {
    path: "tools/check-text-hygiene.mjs",
    reason: "debt: measured red at HEAD - committed C# files under desktop/ are missing a final newline",
    runsIn: "pnpm check:text-hygiene",
  },
  {
    path: "tools/check-unreported-catch.mjs",
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

/** `<dir>/<file>` for every population member, derived from `POPULATION_SCAN`. */
export function derivePopulation({ list = (dir) => readdirSync(resolve(ROOT, dir)) } = {}) {
  const members = [];
  for (const scan of POPULATION_SCAN) {
    for (const name of list(scan.dir).sort()) {
      if (!scan.include.test(name)) continue;
      if (scan.exclude.some((pattern) => pattern.test(name))) continue;
      members.push(`${scan.dir}/${name}`);
    }
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
 * Does `runsIn` actually lead to this gate? The three claim forms are checked against the file they name, so an
 * exemption cannot outlive the script that stopped running it.
 */
export function verifyRunsIn(entry, { scripts, workflow }) {
  if (entry.runsIn === "on-demand") return null;
  const fromPnpm = /^pnpm (\S+)$/u.exec(entry.runsIn);
  const fromSuite = /^suite:(\S+)$/u.exec(entry.runsIn);
  if (fromPnpm !== null || fromSuite !== null) {
    const name = fromPnpm?.[1] ?? fromSuite?.[1];
    const command = scripts[name];
    if (typeof command !== "string") return { code: "exempt_runs_in_unknown_script", detail: name };
    if (!command.includes(entry.path))
      return { code: "exempt_runs_in_script_does_not_name_the_gate", detail: `${name} runs: ${command}` };
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

/** Reason classes that assert the gate runs on every push; that claim is checked against the CI coverage gate. */
const RUNS_ON_EVERY_PUSH = "elsewhere";

/**
 * The register, checked in both directions. Every finding names the file it is about, because the file is the thing
 * the reader has to open.
 */
export function checkRegistry({ population, wired, exemptions = EXEMPTIONS, scripts, workflow, ciCoverage }) {
  const wiredPaths = new Set(wired.keys());
  const populationMembers = new Set(population);
  const exempt = new Map();
  const findings = [];
  for (const path of wiredPaths)
    if (!populationMembers.has(path))
      findings.push({ code: "wired_not_a_gate", path, detail: `prelive ${wired.get(path)} names it` });
  for (const entry of exemptions) {
    if (exempt.has(entry.path)) findings.push({ code: "exempt_duplicated", path: entry.path });
    exempt.set(entry.path, entry);
  }
  const forgotten = population.filter((path) => !wiredPaths.has(path) && !exempt.has(path));
  for (const path of forgotten) findings.push({ code: "gate_forgotten", path });
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
    const className = entry.reason.split(":")[0].trim();
    if (!Object.hasOwn(REASON_CLASSES, className)) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: `unknown class "${className}"` });
      continue;
    }
    if (entry.reason.length < 40) {
      findings.push({
        code: "exempt_unreasoned",
        path: entry.path,
        detail: "the reason is too short to name anything",
      });
      continue;
    }
    const dangling = verifyRunsIn(entry, { scripts, workflow });
    if (dangling !== null) findings.push({ ...dangling, path: entry.path });
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
              : `tools/check-ci-coverage.mjs registers ${script} as ${registered.reason}: ${registered.detail}`,
        });
      }
    }
  }
  const counts = new Map();
  for (const entry of exemptOnly) {
    const className = entry.reason.split(":")[0].trim();
    counts.set(className, (counts.get(className) ?? 0) + 1);
  }
  const onDemand = exemptions.filter((entry) => entry.runsIn === "on-demand").map((entry) => entry.path);
  return {
    status: findings.length === 0 ? "passed" : "failed",
    wired: population.filter((path) => wiredPaths.has(path)).length,
    total: population.length,
    exempt: exemptOnly.length,
    byClass: Object.fromEntries([...counts.entries()].sort()),
    onDemand,
    findings,
  };
}

function readWorkflow(file) {
  try {
    return readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    return null;
  }
}

export function readScripts() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts ?? {};
}

/** `tools/check-ci-coverage.mjs` owns the fact "does a script run on every push"; this reads it, never restates it. */

/**
 * The register, read off the real tree: the derived population, the ladder's own wired set, package.json, the workflows
 * and the CI coverage gate. One function, so the CLI and its tests cannot read the tree two different ways.
 */
export function auditRegistry() {
  const scripts = readScripts();
  const files = readdirSync(resolve(ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `${WORKFLOW_DIR}/${name}`);
  const texts = new Map(files.map((file) => [file, readWorkflow(file) ?? ""]));
  const coverage = deriveCiCoverage({ scripts, workflowText: [...texts.values()].join("\n") });
  return checkRegistry({
    population: derivePopulation(),
    wired: preludeGatePaths(),
    scripts,
    workflow: (file) => texts.get(file) ?? null,
    ciCoverage: {
      runs: new Set([...coverage.workflow, ...coverage.derived]),
      registered: new Map(coverage.register.map((entry) => [entry.script, entry])),
    },
  });
}

function report(result) {
  const byClass = Object.entries(result.byClass)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
  process.stdout.write(
    `prelive_gate_registry: wired ${result.wired} of ${result.total}; exempt ${result.exempt}` +
      `${byClass === "" ? "" : ` (${byClass})`}\n`,
  );
  if (result.onDemand.length > 0)
    process.stdout.write(
      `prelive_gate_registry: no_scheduled_home=${result.onDemand.length} ${result.onDemand.join(",")}\n`,
    );
  for (const finding of result.findings) {
    switch (finding.code) {
      case "gate_forgotten":
        process.stdout.write(
          `prelive_gate_registry_forgotten: ${finding.path} runs in no prelive rung and no exemption names where it runs\n`,
        );
        break;
      case "exempt_but_wired":
        process.stdout.write(
          `prelive_gate_registry_exempt_but_wired: ${finding.path} (${finding.detail}); delete the exemption\n`,
        );
        break;
      case "wired_not_a_gate":
        process.stdout.write(
          `prelive_gate_registry_wired_not_a_gate: ${finding.path} is named by ${finding.detail} but is not in the derived population\n`,
        );
        break;
      case "exempt_not_a_gate":
        process.stdout.write(
          `prelive_gate_registry_exempt_not_a_gate: ${finding.path} is not in the derived population; delete the entry\n`,
        );
        break;
      case "exempt_duplicated":
        process.stdout.write(`prelive_gate_registry_exempt_duplicated: ${finding.path} is listed twice\n`);
        break;
      case "exempt_unreasoned":
        process.stdout.write(
          `prelive_gate_registry_exempt_unreasoned: ${finding.path} - ${finding.detail}; classes are ` +
            `${Object.keys(REASON_CLASSES).join("|")}\n`,
        );
        break;
      case "exempt_elsewhere_not_in_ci":
        process.stdout.write(`prelive_gate_registry_exempt_elsewhere_not_in_ci: ${finding.path} - ${finding.detail}\n`);
        break;
      default:
        process.stdout.write(`prelive_gate_registry_${finding.code}: ${finding.path} - ${finding.detail}\n`);
    }
  }
  process.stdout.write(
    `prelive_gate_registry: ${result.status}` +
      `${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}\n`,
  );
  return result.findings.length === 0 ? 0 : 1;
}

function main() {
  process.exitCode = report(auditRegistry());
}

if (import.meta.main) main();
