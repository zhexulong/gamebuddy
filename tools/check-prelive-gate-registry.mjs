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
 *     `exempt_elsewhere_not_in_ci`;
 *   - an entry carrying no `runsIn` at all is `exempt_runs_in_missing`. It used to reach the `elsewhere` assertion and
 *     crash there (`Cannot read properties of undefined (reading 'startsWith')`), and a gate that dies on a stack
 *     trace has named nothing - the same defect as a register that passes on an empty population. A missing `reason`
 *     is `exempt_unreasoned` for the same reason rather than a second crash.
 *
 * WHICH `package.json`. `runsIn` is resolved against the scripts `HEAD` has AND the scripts on disk: a script
 * committed through a private index is in `HEAD` and absent from the worktree copy, and reading only the worktree
 * called a gate that runs `exempt_runs_in_unknown_script` - a passing gate reported unreachable because of a stale
 * local file (measured 2026-11-09: `tools/check-preset-macros.mjs` on `check:preset-macros`). So the two trees are
 * read, a script either of them has is a script that runs, and the disagreement between them is printed
 * (`scripts_read=` / `package_json_trees_disagree=`) rather than left to decide a verdict silently.
 *
 * `wired N of M; exempt K` is the verdict line; `node tools/check-prelive-gate-registry.mjs` exits 1 on any finding.
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
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
    path: "tools/check-presentation-delivery-account.mjs",
    reason:
      "arguments: it reconciles ONE finished run's bundle - `--run-dir DIR` or the newest under `.live-runs` - so before a" +
      " run exists there is nothing for it to examine, and it says so with `delivery_account_not_measured` (exit 2) rather" +
      " than passing on an empty population. Its verdict is also an arm of every run's own rung in the runner" +
      " (`deliveryAccountClause`), which is what keeps a bundle whose pieces and account disagree from being published as" +
      " passed without anyone remembering to run this entry",
    runsIn: "on-demand",
  },
  {
    path: "tools/audit-action-breadth.mjs",
    reason:
      "arguments: requires `--result <bundle>/result.json` from one FINISHED live run and, for the concentration, the" +
      " flat trace in that run's directory, so there is nothing to measure before a run exists; measured 2026-11-07 on" +
      " round39 it reports `narrow:below_baseline:round38` on the family ratchet, and no `attempted of addressable`" +
      " number at all - that bundle predates `snapshotCensus`, so the reading is `not_measured:no_snapshot_census`" +
      " wherever the families do not already decide it. Its verdict is also published in" +
      " every bundle by the runner's own `action_breadth` clause, which is what keeps a narrow run visible without" +
      " anyone remembering to run this entry",
    runsIn: "on-demand",
  },
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
    path: "tools/check-release-generation-self-contained.mjs",
    reason:
      "elsewhere: reads the generation `host/dist/current.json` points at and the modules `production-artifact.config.json` " +
      "declares; runs in the CI `gates` job, where it reports `not_measured` when no generation is on disk, and in " +
      "`release-windows.yml` immediately after the generation is assembled, which is the only place one exists",
    runsIn: "pnpm check:release-generation-self-contained",
  },
  {
    path: "tools/check-vendored-bundle-leaks.mjs",
    reason:
      "elsewhere: reads every `dist` under `vendor/`, i.e. bundles a submodule builds; runs in the CI `gates` job " +
      "after `pnpm build:magic-context`, so it needs an install and a vendor build the rungs before launch do not have",
    runsIn: "pnpm check:vendored-bundle-leaks",
  },
  {
    path: "tools/check-preset-macros.mjs",
    runsIn: "pnpm check:preset-macros",
    reason:
      "elsewhere: reads a SillyTavern preset document and asks whether every macro it spells is declared in PRESET_MACROS, which is a judgement about a source file that exists before any install or build." +
      " It runs through its `pnpm check:` script in the derived gate corpus, not in a prelive rung.",
  },
  {
    path: "tools/check-preset-round-trip.mjs",
    runsIn: "pnpm check:preset-round-trip",
    reason:
      "elsewhere: imports a preset, exports it and re-imports it to prove nothing was dropped on the way through the store, which needs no rung and no environment." +
      " It runs through its `pnpm check:` script in the derived gate corpus, not in a prelive rung.",
  },
  {
    path: "tools/check-vendor-build-artifacts.mjs",
    reason:
      "elsewhere: asks whether the files the workspace's `file:` dependencies promise exist, so it must run AFTER " +
      "`vendor/magic-context` and `vendor/pi-koe` are built and BEFORE the install that imports them; that seam is " +
      "the `host` and `gates` CI jobs, not a prelive rung (a rung that ran it before the build would only measure " +
      "an unbuilt checkout)",
    runsIn: "pnpm check:vendor-build-artifacts",
  },
  {
    path: "tools/check-workflow-expressions.mjs",
    reason:
      "elsewhere: reads `.github/workflows/*.yml`; runs in the CI `gates` job, and a prelive rung that examined them " +
      "would be checking the same files twice on a machine that has no workflows of its own",
    runsIn: "pnpm check:workflow-expressions",
  },
  {
    path: "tools/check-configuration-surfaces.mjs",
    reason:
      "elsewhere: reads the Type.Union of OperationId in host/src/tavern/browser-contract/index.ts and every .tsx/.ts in " +
      "dialogue-web, and its default run is report-only (exit 0 unless --fail) - measured 2026-11-09: examined 58, " +
      "violations 0. A rung that ran it without --fail would call it green whatever it found, and the contrast/persona " +
      "rungs already read the same dialogue-web sources",
    runsIn: "pnpm check:configuration-surfaces",
  },
  {
    path: "tools/check-frontend-reads-have-producers.mjs",
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
    path: "tools/audit-airp-scorecard.mjs",
    reason:
      "arguments: needs one finished run's result.json and the Pi session files under its own runtime-root, so no rung " +
      "before a launch can run it; measured 2026-11-07 on round39: `first visible text 861 s`, `plans preceded by a " +
      "stated intent 8 of 30`, `executions timed 124 of 124` - every metric the artifact cannot support is printed as " +
      "not_measured with its reason instead of being estimated",
    runsIn: "on-demand",
  },
  {
    path: "tools/audit-long-session-metrics.mjs",
    reason:
      "arguments: needs one finished run's result.json (--result) and reads its session transcript, so no rung before a " +
      "launch can run it; measured 2026-11-06 on round38: `executions 379, of which timed 0`, i.e. it answers " +
      "NOT_EXERCISED where the bundle has no receipt timestamps rather than reporting a number it cannot support",
    runsIn: "on-demand",
  },
  {
    path: "tools/audit-preset-macro-frequency.mjs",
    reason:
      "environment: the population is presets, and the only real ones in this tree live in the design/library mount - " +
      "`ref/` supplies the SillyTavern checkout whose `default/content/presets/openai/Default.json` is the single " +
      "member, so a checkout without that mount reads zero presets and the census BLOCKS with " +
      "`preset_macro_frequency_no_presets` by design rather than passing; measured 2026-11-09 with the mount: " +
      "`examined 1 preset file(s), 4 macro occurrences` (char 3, user 1, and neither `{{if}}` nor `{{random}}`), 1087 " +
      "json document(s) read and 1033 rejected by the preset shape",
    runsIn: "on-demand",
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
    path: "tools/audit-stardew-open-ground-claims.mjs",
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
    path: "tools/check-ci-dead-conditions.mjs",
    reason:
      "elsewhere: reads every workflow's `if:` expressions against every writer of the variables they name, runs " +
      "on every push in the CI gates job",
    runsIn: "pnpm check:ci-dead-conditions",
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
    path: "tools/check-contrast-tokens.mjs",
    reason:
      "report: measures every declared token pair in dialogue-web/src/style.css and prints each ratio while exiting 0 " +
      "unless --fail is passed, so a rung would call a pair below AA green; it also has no pnpm script yet, so " +
      "on-demand is the honest home rather than a rung",
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
    path: "tools/check-child-output-parsing.mjs",
    reason:
      "debt: measured red at HEAD — 3 sites hand-parse subprocess output and all three are files another lane holds " +
      "uncommitted (`tools/refusal-exp.mjs`, `tools/sandbox/sandbox-bus.mjs`, `tools/scripts/check-workspace-debris.mjs`), " +
      "so adopting it needs their fix, not the wiring",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-derived-population.mjs",
    reason:
      "debt: measured red at HEAD — `examined 794, violations 994, unread 1`, i.e. the tree's history of literal " +
      "population assertions that a first sweep legitimately predates; asserting it in the sweep needs the fixes, " +
      "not the wiring",
    runsIn: "on-demand",
  },
  {
    path: "tools/check-head-self-contained.mjs",
    reason:
      "elsewhere: reads the commit's own module graph (`git ls-tree HEAD`, not the index), runs on every push in " +
      "the CI gates job",
    runsIn: "pnpm check:head-self-contained",
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
    path: "tools/check-fail-closed-forward-path.mjs",
    reason:
      "elsewhere: reads every refusal the two browser contracts declare and the step its own sentence owes " +
      "the player, runs on every push in the CI gates job",
    runsIn: "pnpm check:fail-closed-forward-path",
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
    path: "tools/check-release-live-evidence.mjs",
    reason:
      "elsewhere: runs in the protected release lane, where the evidence it reads is the release claim - " +
      "release-windows.yml invokes it by path on tag pushes (not every push, which is why runsIn names that workflow " +
      "rather than a pnpm script). prelive would be the wrong home for it: the ladder asks whether a live run can " +
      "start, and this gate asks whether the last committed live evidence still describes this tree",
    runsIn: "ci:.github/workflows/release-windows.yml",
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
    path: "tools/check-stardew-execution-terminal-uniqueness.mjs",
    reason:
      "arguments: requires `--artifact <path>` pointing at one FINISHED run's receipt reading (the frames its fact" +
      " listeners emitted, and the answers its caller received), so there is nothing to compare before a run exists;" +
      " measured 2026-11-08 on a recorded run it examines 159 terminal frames and reports `duplicated: 0`, because the" +
      " Mod publishes each receipt once and the duplicate this gate exists for was the client counting the answer" +
      " beside the push",
    runsIn: "pnpm check:stardew-execution-terminal-uniqueness",
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
    path: "tools/check-stardew-invented-gates.mjs",
    reason:
      "debt: measured red at HEAD - one gating constant states a number no engine member backs " +
      "(`GeodeCounterInteractionRadius = 2`, geodeactions.cs:104, `ours=2:engine=unstated`, measured against the " +
      "owner's tile rather than the counter), which is the fix this gate asks for and not a wiring gap; adopting it " +
      "in a rung would also need `ref/external/StardewValleyDecompiled`, which prelive runs without. Its falsifier " +
      "suite runs in CI through `pnpm test:stardew-invented-gates` (the tool-test corpus), where the real-tree arm " +
      "skips itself when the decompiled tree is absent",
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
    path: "tools/check-stardew-discovery-exclusions.mjs",
    reason:
      "debt: measured red at HEAD - `discoveries 84, with exclusions 8, filters without a reason 5 (filed 5)` plus 10" +
      " `backlog_token_available` findings, i.e. ten discovery families still filter a subject on a state the closed" +
      " vocabulary already names (`not_ready` for five building-construction countdowns, `already_tapped` and `dead`" +
      " for two whereabouts counts, `wrong_harvest_method`, and a baitless crab pot) and publish nothing about it." +
      " Wiring it into L0 today would stop the ladder on a defect this register is meant to report; the ten are" +
      " named, with their owner files, in tools/stardew-discovery-exclusions-backlog.json, and the gate turns green" +
      " the moment the last of them records its reason",
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
 *
 * A script is read from both `package.json` trees - `HEAD`'s and the worktree's - because a script either of them has
 * is a script that runs somewhere, and a worktree copy that has not caught up is not evidence about the commit.
 */
export function verifyRunsIn(entry, { scripts, headScripts = {}, workflow }) {
  if (entry.runsIn === "on-demand") return null;
  const fromPnpm = /^pnpm (\S+)$/u.exec(entry.runsIn);
  const fromSuite = /^suite:(\S+)$/u.exec(entry.runsIn);
  if (fromPnpm !== null || fromSuite !== null) {
    const name = fromPnpm?.[1] ?? fromSuite?.[1];
    const head = headScripts ?? {};
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
    return { code: "exempt_runs_in_script_does_not_name_the_gate", detail: readings.join("; ") };
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

/** The class an exemption declares, or `null` when it carries no reason to declare one. */
function declaredClass(entry) {
  return typeof entry.reason === "string" ? entry.reason.split(":")[0].trim() : null;
}

/**
 * The register, checked in both directions. Every finding names the file it is about, because the file is the thing
 * the reader has to open. `headScripts` is `HEAD`'s script table, or `null` when git could not read it; passing it
 * is what keeps a stale worktree copy from deciding whether an exemption's `runsIn` resolves.
 */
export function checkRegistry({
  population,
  wired,
  exemptions = EXEMPTIONS,
  scripts,
  headScripts = {},
  workflow,
  ciCoverage,
}) {
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
    const className = declaredClass(entry);
    if (className === null) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: "the entry carries no reason" });
      continue;
    }
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
    if (typeof entry.runsIn !== "string" || entry.runsIn.length === 0) {
      findings.push({
        code: "exempt_runs_in_missing",
        path: entry.path,
        detail: "no runsIn; write pnpm <script>, suite:<script>, ci:<workflow> or on-demand",
      });
      continue;
    }
    const dangling = verifyRunsIn(entry, { scripts, headScripts, workflow });
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
    const className = declaredClass(entry);
    if (className === null) continue;
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
    scriptTrees: {
      head: headScripts === null ? null : Object.keys(headScripts).length,
      disagreeing: headScripts === null ? [] : scriptTreeDisagreements(scripts, headScripts),
    },
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

/** `tools/check-ci-coverage.mjs` owns the fact "does a script run on every push"; this reads it, never restates it. */

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
  const texts = new Map(files.map((file) => [file, readWorkflow(file) ?? ""]));
  const coverage = deriveCiCoverage({ scripts, workflowText: [...texts.values()].join("\n") });
  return checkRegistry({
    population: derivePopulation(),
    wired: preludeGatePaths(),
    scripts,
    headScripts,
    workflow: (file) => texts.get(file) ?? null,
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
      case "exempt_runs_in_missing":
        lines.push(
          `prelive_gate_registry_exempt_runs_in_missing: ${finding.path} - ${finding.detail}; with no runsIn the entry ` +
            "claims nothing and this register cannot tell a gate with a home from one without",
        );
        break;
      case "exempt_elsewhere_not_in_ci":
        lines.push(`prelive_gate_registry_exempt_elsewhere_not_in_ci: ${finding.path} - ${finding.detail}`);
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
