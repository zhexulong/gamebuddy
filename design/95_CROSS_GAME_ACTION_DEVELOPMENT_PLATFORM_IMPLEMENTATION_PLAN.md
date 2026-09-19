# Cross-Game Action Development Devkit and Game-Project Boundary Implementation Plan

**Status:** Draft implementation plan; no devkit/project implementation or live gate is authorized by this document alone  
**Date:** 2026-08-21  
**Owner:** GameBuddy Action Devkit + game-project-owned action development  
**Repository target:** GameBuddy core remains the host/web/common repository; Stardew is an extractable game project and may move to its own repository without moving or forking the devkit  
**Primary authorities:** `AGENTS.md`, `design/33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md`, `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`, `design/97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`  
**Historical problem record:** `design/37_STARDEW_ACTION_DEVELOPMENT_ENGINEERING_BOTTLENECK_HANDOFF.md` (root-cause context only; `design/38` owns the current Stardew implementation sequence)  
**First game adapter:** Stardew Valley  
**First pilot action:** existing `equip_tool` implementation  

---

## 1. Purpose

Build one small, versioned GameBuddy Action Devkit plus game-project-owned development/verification packages so that future action work spends time on game semantics, native transitions, fixtures, and postconditions rather than repeatedly rebuilding process supervision, evidence storage, timeout handling, cleanup, and collaboration scaffolding.

The devkit standardizes **how an action project invokes and proves its own actions**. It does not centrally register games or actions, own a repository's CI portfolio, standardize gameplay semantics, or make actions portable between games.

The physical seam is part of the deliverable. GameBuddy core owns the reusable devkit and common product surfaces such as Host/web. Stardew owns its integration runtime plus its own action-development manifest, portfolio, inventory, adapter, scenarios, fixtures, target profiles, live CI/runbook, and evidence queries. During the current monorepo phase the two packages use a workspace dependency; a future Stardew repository replaces only that dependency with an exact released devkit version.

The first vertical pilot wraps the existing Stardew `equip_tool` action and its existing native-local scenario. It does not rewrite the action's production handler, protocol, native dispatch, receipt semantics, fixture Given, postcondition, or runtime publication.

---

## 2. Clarification: “98 runners” is not the migration scope

A filename inventory on 2026-08-21 found:

- `tools/run-stardew-*.mjs`: **98 files**;
- of those, **56** are non-`.test.mjs` entries;
- **42** are `.test.mjs` files;
- the broader `run/check/replay/prepare/restore-stardew-*` filename set contains **160 files**, including tests, validators, replay programs, diagnostics, PowerShell helpers, and wrapper entrypoints.

Therefore, the phrase “migrate all 98 runners” describes a rejected approach: bulk-rewriting every file matching a naming pattern. The 98 files are not 98 independent production runners and are not 98 actions.

This plan instead creates a machine-readable inventory and classifies each existing tool as one of:

- `canonical-scenario`: action-specific scenario logic that should remain;
- `shared-runtime`: cross-action or game-adapter runtime logic;
- `conformance-test`: deterministic test or validator;
- `replay-preflight`: non-live proof consumer;
- `diagnostic`: operator-only troubleshooting;
- `obsolete`: no current owner or reference and safe to delete;
- `unclassified`: blocking until reviewed.

Existing files are not rewritten merely to satisfy the inventory. Repeated process/evidence mechanics are removed incrementally when a canonical scenario is connected to the devkit/project seam. Once a path is replaced, the old owner is deleted rather than retained as a compatibility route.

---

## 3. Current reusable foundations

The implementation must evolve existing repository owners rather than create parallel systems:

| Existing owner | Current responsibility | Planned role |
|---|---|---|
| `.ci/test-portfolio-manifest.v1.json` | GameBuddy root generic test/evidence inventory | remain generic and remove every Stardew-specific entry; it does not select the game project |
| `tools/test-portfolio-manifest.mjs` | root portfolio validation | remain a GameBuddy root CI owner; do not become a multi-game action registry |
| `tools/test-portfolio-manifest-runner.mjs` | root changed-path selection and bounded execution | consume the released devkit process module, without learning Stardew actions/stages |
| `host/scripts/test-supervisor.mjs` | bounded child and process-tree cleanup | source for `@gamebuddy/game-action-devkit/process-supervisor`, then delete after caller cutover |
| `tools/ci-snapshot-*.mjs` | clean-room source materialization and transactional directories | consume the released devkit atomic-directory module where its interface fits |
| `tools/lib/stardew-native-smoke-harness-v1.mjs` | Stardew bridge/session mechanics | move incrementally into the Stardew action-development package; never enter the devkit |
| `tools/lib/stardew-formal-action-gate.mjs` | Stardew receipt/fresh-reread mechanics | move incrementally into the Stardew project; action semantics remain game-owned |
| `tools/stardew-action-gate-descriptors.mjs` | published Stardew action-to-runner mapping | Stardew project input; never a publication authority |
| `tools/run-stardew-native-local-player-move-fixture.ps1` | Stardew profile/save/launch/cleanup transaction | initial Stardew project runtime backend; migrates with the game project |
| `.github/workflows/ci.yml` | GameBuddy root CI | unconditionally invoke exactly one opaque Stardew `action:ci` command while co-located; delete all other explicit Stardew commands/jobs |

The Mod-owned action catalog and policy remain the only Stardew membership/publication authority. Neither the devkit nor either repository's CI may grant it.

### 3.1 Explicit future extraction set

This plan does not execute the whole split, but it records the ownership destination now:

| Owner after split | Current co-located sources |
|---|---|
| GameBuddy core | `packages/game-action-devkit/`, generic Host/web/common code, generic root CI tooling |
| Stardew project | `integrations/stardew/`, `integrations/stardew/action-development/`, Stardew-specific root `tools/` as they are touched/migrated, Stardew target/live CI and runbook |
| Separate runtime-seam follow-up | current `host/src/*stardew*` and any generic Host interfaces they reveal |

No new Stardew dependency may be added from the devkit or generic Host/web packages. The current Host Stardew source migration is not hidden inside this tooling plan; before a repository split it requires its own runtime-interface inventory and cutover plan. That follow-up must distinguish three seams: the trusted in-process `GameIntegrationAdapter` used by first-party Host code; the trusted generic `ConnectorSessionAdapter`, which validates a finite installed descriptor and mediates its external ABI envelope; and the separately versioned out-of-process community `Game Connector Protocol`, both owned by `design/97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`. It must not turn the devkit, root CI, or arbitrary game-project JavaScript into a dynamic plugin loader or generic gameplay interpreter. Concrete Stardew Host adapters move with the Stardew project only after the chosen seam is accepted. Until then, this plan may claim only an extractable Action-development package—not a completed Stardew repository split or a community connector SDK.

---

## 4. Non-goals

This plan does not:

- perform the full Stardew repository split or move all current Stardew runtime/Host source in this project;
- create a central GameBuddy game/action registry, central multi-game action portfolio, root-owned Stardew adapter, or dynamic community-plugin loader;
- make the CLI own orchestration, target profiles, action lookup, gameplay verification, or publication state;
- rewrite old action handlers, coordinators, native calls, receipts, or postconditions;
- create a universal gameplay DSL, generic route planner, generic native dispatcher, or cross-game action taxonomy;
- make Stardew world facts, tiles, locations, tools, warps, or fixtures portable to another game;
- infer runtime publication from tests, evidence, documentation, or platform maturity;
- publish `navigate_to_destination` or resolve its separate multi-hop blocker;
- migrate every existing runner in one batch;
- preserve old CLI wrappers after a completed cutover;
- run a real game in ordinary pull-request CI;
- allow stdout text alone to constitute passing evidence;
- add hashes, signatures, or attesters except where identity matching or byte-for-byte restore prevents a concrete existing failure; or introduce a marketplace, remote installation, automatic update, custom connector signing/key system, or user-supplied dynamic code loading;
- require a fixed number of reviewers.

### 4.1 Navigation Host-contract parity boundary

Navigation's Host mapping, selector, and completion behavior is verified by current Host-focused tests and C#↔Host wire-parity tests. This is a Host contract-parity prerequisite, not a Mod capability authority, release artifact, or agent-live admission input. Host tests may prove that the typed Host projection is restrictive and current; they must not publish a test-only surface, `dist-test` manifest, source-text scan, replay frame, or static receipt projection for a Stardew live preflight to consume.

The Stardew agent-live preflight owns only current environment, fixture transaction, process ownership, cleanup and fresh runtime readiness. It does not read Host test artifacts/source, consume topology-characterization receipts, replay caller-supplied frames, or infer a future action's terminal receipt. The Mod remains the sole action-capability authority, and the real action path alone produces its receipt, evidence and fresh postcondition. If Host runtime behavior needs additional parity coverage, it belongs in Host-owned test commands; it must not create a new cross-package capability or evidence authority.

### 4.2 Stardew same-lineage recovery boundary

A bridge response timeout is a transport observation, not an action verdict. For Stardew, the Mod owns durable ingress and receipt truth for an exact action tuple; Host owns only durable recovery material for the dispatch it sent; the fixture transaction owns the private working-state retention needed until that lineage settles. This is an action/runtime lifecycle, not devkit evidence, test-artifact, topology-receipt, or preflight authority.

The generic devkit may eventually offer only lifecycle-neutral process/evidence primitives after a second independent consumer proves that need. It must not own an execution receipt journal, infer `not_accepted`, authorize same-envelope resend, inspect game arguments, scope/binding identity, native side effects, STOP/redirect behavior, save/profile retention, or any game-specific recovery state. Stardew retains all of those semantics under Design 94's Task 8.

---

## 5. Architectural seams and repository ownership

### 5.1 GameBuddy core: `@gamebuddy/game-action-devkit`

Create one workspace package at `packages/game-action-devkit/`. This is the only cross-game Action development module retained by the GameBuddy core repository after a game split. It may own only:

- bounded child-process and process-tree ownership;
- run identity and total external deadline;
- private result-file transport validation;
- staging/complete/incomplete evidence-bundle lifecycle;
- project-manifest/profile/work-brief schemas and parsers;
- portable process/evidence/lifecycle conformance helpers;
- the thin `game-action` executable.

Its external interface is intentionally small:

```ts
runActionProject({
  projectFile,
  invocation: { command, actionId?, profileFile?, briefFile? }
}): Promise<RunReport>
```

The executable only parses `check|preflight|run-live|status`, `--project`, `--action`, `--profile`, and `--brief`; resolves the explicit project file or the current project's exact default manifest; syntax/bounds-checks `actionId` as an opaque identifier without resolving it; materializes one immutable invocation object; and calls this interface. It does not contain a game registry, action registry, workflow DAG, profile semantics, target launcher, scenario lookup, receipt verifier, CI selector, or publication logic.

### 5.2 Game project: Stardew-owned action development

Create the current monorepo package under `integrations/stardew/action-development/`. Everything below this seam is Stardew-owned and moves with a future Stardew repository:

```text
integrations/stardew/action-development/
  package.json
  game-action-project.json
  portfolio.json
  tool-inventory.json
  src/project-adapter.mjs
  src/profile.mjs
  src/scenario-result.mjs
  scenarios/
  fixtures/
  profiles/example.json
  tests/
  ACTION_RUNBOOK.md
```

The Stardew project owns:

- action-stage selection and dependency ordering within Stardew;
- target runtime/profile validation and launcher identity;
- game process recognition and authenticated bridge connection;
- game-specific fixture/save/profile transaction;
- action scenario lookup and exact scenario verifier;
- teardown and restore hooks;
- its own tool inventory and CI commands;
- a read-only publication query sourced from the Mod-owned catalog/policy;
- bounded normalization into the devkit evidence envelope.

The temporary monorepo package may call existing root `tools/` paths during the pilot, but `game-action-project.json` records them as migration debt with exact replacement/disposition. New Stardew action-development code is created inside this package, not under root `tools/game-adapters/` or root `.ci/`.

### 5.3 Action scenario

Each Stardew action scenario owns:

- selection of a legal target from current game facts;
- request arguments;
- forbidden precondition/outcome;
- typed action invocation through the real integration;
- action-specific receipt/evidence validation;
- fresh postcondition reread;
- action-specific completion verdict and claim scope.

### 5.4 Root repository integration

The root repository may own only integration with its own generic CI and workspace:

- exact workspace dependency from the Stardew action-development package to `@gamebuddy/game-action-devkit`;
- one unconditional root workflow command that invokes the Stardew package's `action:ci` while Stardew resides in the monorepo;
- GameBuddy-wide tests for Host/web/common contracts.

The root generic test portfolio remains generic and contains no Stardew entries. The root workflow unconditionally runs exactly one opaque Stardew package `action:ci` command; it does not copy Stardew actions, stages, profiles, trigger paths, or live gates into a central multi-game inventory. Unconditional execution avoids teaching the root portfolio about package prefixes and covers new/deep project files. Stardew's own portfolio owns internal selection. When Stardew moves out, remove the workspace entry and this one workflow invocation; do not redesign the Stardew package.

### 5.5 Runtime publication

Neither the devkit nor the Stardew action-development package grants capability. For Stardew, the authority chain remains:

```text
FarmhandActionDefinitions / ModConfig
→ ActionPolicyEngine
→ FarmhandCapabilitySurface
→ game-thread router / hello / bridge
→ Host restrictive projection
```

A complete evidence bundle is necessary for a publication workflow when policy requires it, but is never sufficient to publish by itself.

---

## 6. Thin CLI interface

The devkit exposes one thin executable. From the Stardew package, developers use package-local scripts:

```bash
pnpm --dir integrations/stardew/action-development action:check --action equip_tool
pnpm --dir integrations/stardew/action-development action:preflight --action equip_tool --profile <absolute-profile-json>
pnpm --dir integrations/stardew/action-development action:run-live --action equip_tool --profile <absolute-profile-json>
pnpm --dir integrations/stardew/action-development action:status --action equip_tool
```

Those scripts call the same thin binary with a project-local manifest, for example:

```bash
game-action check --project ./game-action-project.json --action equip_tool
```

Rules:

- the binary owns only strict argument parsing, manifest loading, and invocation of the project adapter through the devkit interface;
- project discovery uses only an explicit `--project` or one exact filename in the current project root; it never scans parent repositories or a global plugin directory;
- there is no `--game stardew` registry in the devkit; `gameId` comes from the exact project manifest;
- commands are shell-free after argument parsing;
- unknown actions, commands, profiles, duplicate options, and extra options fail closed in the project adapter;
- `check` is deterministic and cannot launch a game;
- `preflight` may inspect the target installation and fixture prerequisites but cannot submit an action;
- `run-live` is the only command allowed to launch a game and submit an action;
- `run-live` requires explicit local operator invocation or a game-project-owned self-hosted runtime queue; it is not mounted in ordinary GitHub-hosted PR CI.

The CLI is a convenience interface over the devkit module, not the architecture. CI and tests may call the same module directly.

---

## 7. Project manifest, portfolio, and inventory

### 7.1 Devkit project manifest

The devkit owns only the schema/parser for `gamebuddy-action-project/v1`; each game project owns its manifest instance. The Stardew instance is `integrations/stardew/action-development/game-action-project.json`:

```json
{
  "schema": "gamebuddy-action-project/v1",
  "gameId": "stardew",
  "projectVersion": 1,
  "adapter": "./src/project-adapter.mjs",
  "portfolio": "./portfolio.json",
  "toolInventory": "./tool-inventory.json",
  "evidenceRoot": "./artifacts/action-runs",
  "defaultProfileExample": "./profiles/example.json"
}
```

All paths are project-root-relative, canonical, non-escaping, and package-owned. The manifest cannot contain publication, enabled capability, credentials, arbitrary shell hooks, or a repository-global game registry.

### 7.2 Stardew project portfolio

`integrations/stardew/action-development/portfolio.json` is the sole Stardew action-workflow inventory **after its entries are package-owned**. It must not be a mirror of legacy root `tools/` or an inferred executable registry. The first entries are created by the `equip_tool` pilot only after its deterministic check/verifier has moved into the Stardew package; later migrations add entries only when their executable implementation and all PR-safe dependencies are package-local or use an explicit stable public interface. It owns action IDs, `check|preflight|live|publication-check` stages, claim scopes, dependency ordering, profile requirements, and commands implemented inside the Stardew package. Executable work is represented only as an exact project-relative executable plus an argument array and bounded timeout; shell command strings, inline scripts, and escaping working directories are rejected.

The GameBuddy root `.ci/test-portfolio-manifest.v1.json` remains generic and, after Task 7, contains no Stardew entry. While Stardew is co-located, `.github/workflows/ci.yml` unconditionally invokes exactly one opaque command, `pnpm --dir integrations/stardew/action-development action:ci`; it does not duplicate Stardew actions/stages/claim scopes. A future Stardew repository carries `portfolio.json` unchanged and gives it its own CI.

### 7.3 Stardew tool inventory

Create `integrations/stardew/action-development/tool-inventory.json` with exact repository-relative legacy paths plus project-local paths and classifications from Section 2. This inventory belongs to the Stardew project and moves with it. During the co-located migration, each legacy root-tool entry also has `futureProjectPath` and one disposition. The inventory freezes an exact `pilotLegacyClosure` for the existing `equip_tool` scenario/fixture dependency graph at Task 1:

- `keep-project-local`;
- `fold-into-stardew-runtime`;
- `replace-and-delete`;
- `diagnostic-only`;
- `delete-obsolete`.

The Stardew validator must:

- enumerate the agreed Stardew tool filename patterns deterministically;
- require every matching tracked file to be classified exactly once;
- reject case-folded duplicates, missing files, unknown keys, and unsafe paths;
- reject every newly added matching Stardew root tool during and after the pilot, even if someone attempts to classify it; all new Stardew action-development tools belong under the project package;
- prevent new Stardew action-development implementation under generic root devkit paths;
- resolve the project package's legacy root-tool import/invocation graph and require it to be a subset of the frozen `pilotLegacyClosure`;
- allow that closure only to shrink as dependencies move project-local or are deleted, never grow;
- forbid every PR-safe `action:ci` entry from depending on the legacy closure; the closure is available only to explicitly profiled target preflight/live backends;
- allow deletion of an inventory entry only when the file is deleted or its canonical project path replaces it;
- report counts by classification without calling them action or runner counts.

No existing file is automatically accepted as canonical based only on its name.

### 7.4 Status is project-owned observation

The thin CLI delegates `status` to the Stardew project adapter, which reports separately:

- available workflow stages from the Stardew portfolio;
- latest complete/incomplete local evidence bundles;
- exact claim scopes in those bundles;
- Mod-derived publication observation, when available;
- blockers such as missing profile, missing artifact, or portfolio/inventory drift.

Neither the devkit nor the adapter may collapse these into one mutable maturity flag or infer `published` from `live` evidence.

---

## 8. Evidence bundle

### 8.1 Location and lifecycle

Bundles are project-local, ignored by the game project itself, and move with the game project:

```text
integrations/stardew/action-development/artifacts/action-runs/<actionId>/<runId>/
```

The devkit accepts the project manifest's canonical evidence root; it does not choose a repository-global `artifacts/` location.

A run starts in a private sibling staging directory. The final run directory becomes visible only after atomic commit.

Final status values:

- `complete`: command reached a validated terminal outcome and all required cleanup/restore checks passed;
- `incomplete`: timeout, crash, disconnect, invalid output, or cleanup uncertainty; retained for diagnosis but never accepted as passing evidence.

A failed gameplay outcome may still have a structurally complete bundle with `verdict: blocked|failed|uncertain`. `complete` means evidence finalization completed, not that the action succeeded.

### 8.2 `bundle.json`

The root manifest uses exact keys and bounded values:

```json
{
  "schema": "gamebuddy-action-run/v1",
  "runId": "ar1_...",
  "gameId": "stardew",
  "actionId": "equip_tool",
  "stage": "live",
  "claimScope": "equip_one_live_inventory_tool",
  "source": {
    "baseCommit": "...",
    "sourceDigest": "..."
  },
  "runtime": {
    "adapterVersion": "...",
    "targetVersion": "...",
    "profileIdentity": "..."
  },
  "outcome": {
    "status": "complete",
    "verdict": "passed",
    "reasonCode": "tool_selected"
  },
  "cleanup": {
    "processTreeExited": true,
    "fixtureRestored": true,
    "profileRestored": true
  },
  "artifacts": []
}
```

The final schema must define size limits and exact keys. The bundle excludes credentials, bridge tokens, raw save contents, hidden reasoning, raw model output, and unrestricted stdout/stderr.

### 8.3 Trust rule

- stdout is bounded diagnostics only;
- child exit code alone cannot mint a passing verdict;
- the game adapter must parse and validate an action scenario result file with an exact action-specific verifier;
- a live `passed` verdict requires the real typed request, exact receipt lineage, action-specific evidence, fresh postcondition, and cleanup;
- cleanup failure downgrades the run to `incomplete` and prevents publication of a passing final directory;
- CI uploads finalized bundles as CI artifacts; they remain ignored local outputs rather than source authority.

### 8.4 Atomic-directory primitive

Extract the generic canonical-parent, private-staging, atomic-commit, and cleanup functions from `tools/ci-snapshot-lib.mjs` into `packages/game-action-devkit/src/atomic-directory.mjs` with dedicated package tests. Update compatible root CI snapshot tooling to consume the package export and remove the duplicate implementation from `ci-snapshot-lib.mjs`.

This is a destructive internal cutover, not a compatibility wrapper.

---

## 9. Process supervision

Create one `packages/game-action-devkit/src/process-supervisor.mjs` by moving the strongest behavior from `host/scripts/test-supervisor.mjs` and reconciling the generic root portfolio runner requirements.

Required behavior:

- shell-free spawn;
- total deadline over direct child plus inherited stdio;
- Windows `taskkill /T /F` for the exact spawned PID;
- POSIX detached process group with TERM then KILL or immediate KILL according to the caller policy;
- bounded cleanup even if the reaper hangs;
- bounded UTF-8-safe stdout/stderr capture;
- diagnostic heartbeat that cannot influence outcome;
- structured outcome for success, non-zero exit, spawn failure, timeout, and cleanup uncertainty;
- no interpretation of gameplay success.

Cutover order:

1. move and expand supervisor tests under `packages/game-action-devkit/tests/`;
2. update compatible Host artifact/test runners to import the package export;
3. update `tools/test-portfolio-manifest-runner.mjs` to use it;
4. remove local process-tree execution from the portfolio runner;
5. delete `host/scripts/test-supervisor.mjs` and its old test after all callers move.

No two production supervisors remain after the task.

---

## 10. Runtime profiles

The devkit defines the common profile-envelope schema under `packages/game-action-devkit/`; `integrations/stardew/action-development/src/profile.mjs` owns the Stardew-specific fields and validation. A profile is operator-supplied machine configuration, not action authority.

For Stardew it includes only required local facts such as:

- game installation path;
- Mods path;
- fixture root;
- save/template identity;
- expected game/SMAPI/adapter versions;
- runtime lease identity;
- bounded external timeout.

Rules:

- profiles are passed by absolute path;
- profiles containing credentials or bridge tokens are rejected;
- repository examples contain placeholders only;
- local real profiles remain ignored;
- canonical path/reparse checks follow existing fixture/publication rules;
- `preflight` validates the profile and exact target identity before any profile/save mutation;
- one game adapter defines the meaning of its profile fields.

Each repository pins its portable SDK versions. While co-located, Stardew may inherit the workspace's `global.json` and pnpm version; extraction acceptance requires a copied explicit Stardew project pin and no ambient dependency on the former parent. A devcontainer is deferred until a demonstrated setup gap remains after project `check`; the target game itself is never placed in the portable container.

---

## 11. Clean collaboration boundary

### 11.1 Frozen action work brief

Define the schema/parser in `packages/game-action-devkit/`. Brief instances are task-local inputs, not root `.ci/` inventory. A task brief records:

```json
{
  "gameId": "stardew",
  "actionId": "equip_tool",
  "baseCommit": "<40 hex>",
  "ownedPaths": ["..."],
  "sharedHubs": ["..."],
  "requiredPortfolioEntries": ["..."],
  "liveAuthorized": false
}
```

It does not record gameplay authority or publication.

### 11.2 Worktree rules

- implementation writers use a clean worktree based on the brief's exact base commit;
- reviewers use a separate read-only worktree or clean snapshot;
- the game project's `action:check --brief <path>` delegates generic brief validation to the devkit and compares the diff against `ownedPaths`, reporting shared-hub changes separately;
- an unlisted changed path blocks acceptance;
- live execution is rejected unless `liveAuthorized` is true and the requested stage is `live`;
- shared hubs use repository CODEOWNERS or an equivalent existing review rule; the CLI does not invent an approval authority;
- timeout/crash leaves a structured incomplete report in the task worktree/session output, not unclassified edits in the shared parent cwd.

Neither the devkit nor a game project auto-commits, auto-merges, or auto-publishes.

---

## 12. CI tiers

### T0 — Game-project local deterministic check

`pnpm --dir integrations/stardew/action-development action:check [--action <id>]`

- Stardew inventory and project-portfolio validation;
- action-specific deterministic suites;
- contract/lifecycle conformance selected by Stardew dependencies;
- source generation/diff checks where applicable;
- affected Stardew builds;
- owned-path validation.

No game launch.

### T1 — Pull request CI

While co-located, the GameBuddy GitHub-hosted Windows runner unconditionally invokes exactly one opaque Stardew package `action:ci` command. The Stardew package then owns selection from its portfolio. The root workflow and root portfolio do not interpret action IDs, stages, profiles, claim scopes, or Stardew changed paths.

After repository extraction, the Stardew repository's own workflow invokes the same `action:ci` command. No licensed Stardew assemblies or live game are used in ordinary PR CI.

### T2 — Main/clean-source integration

- each repository materializes its own clean source when required;
- the devkit package runs supervisor/evidence conformance;
- the Stardew package runs its project checks through the public devkit interface;
- the GameBuddy root does not materialize or orchestrate Stardew live state.

### T3 — Target preflight

Manual or Stardew-project-owned dedicated self-hosted Windows runtime runner:

- exact profile and target version;
- bundle and launcher identity;
- fixture transaction prerequisites;
- no pre-existing game process;
- action scenario and verifier availability;
- teardown command and evidence destination;
- no action request.

### T4 — Serial live gate

Manual approval or Stardew-project-owned exclusive queue:

- one target installation lease;
- one scenario execution;
- typed receipt and fresh postcondition;
- process, fixture, save, and profile cleanup;
- finalized complete/incomplete bundle.

External process timeout is a harness verdict only and cannot become a gameplay quota.

### T5 — Publication check

After a separately authorized Stardew-owned publication change:

- query actual game capability surface;
- verify Host restrictive projection;
- verify withdrawn/unpublished actions are not mounted;
- never modify the game catalog or policy from CI evidence alone.

---

## 13. Implementation tasks

## 13.1 Non-blocking lane-start discipline

This is an execution rule, **not a Task 0 and not a repository-wide admission gate**. Do not delay Task 1 to clean, attribute, commit, or checkpoint unrelated dirty work. Before a mutation-capable writer starts, the parent records only the facts relevant to that lane:

- the exact base commit/worktree used by that lane;
- the lane's owned paths, forbidden paths, focused acceptance commands, and no-live default;
- only pre-existing dirty paths the lane would otherwise edit, with their owner or an explicit exclusion;
- each shared hub actually touched and its single integrator/merge owner.

Use separate worktrees for concurrent writers. A writer stops if it needs an unknown-owned dirty path or an unapproved shared authority decision. Reviewers use a clean/read-only snapshot. This record grants **no** gameplay, live-run, merge, or publication authority.

The recurring hubs are: devkit package/workspace/lockfile; Stardew action-development package; root workspace/CI files; and legacy extraction callers. They are integrated serially only when a lane actually changes them. Task 8 later automates these checks; it does not retroactively block Tasks 1–7.

## Task 1 — Freeze tool inventory and stop unclassified growth

**Create**

- `integrations/stardew/action-development/package.json`
- `integrations/stardew/action-development/game-action-project.json`
- `integrations/stardew/action-development/tool-inventory.json`
- `integrations/stardew/action-development/src/tool-inventory.mjs`
- `integrations/stardew/action-development/tests/tool-inventory.test.mjs`

**Modify**

- `pnpm-workspace.yaml`
- root `package.json` only if needed for one temporary package-level inventory command
- `.github/workflows/ci.yml` temporarily to invoke the package-local inventory check before Task 7

**Steps**

1. Enumerate the exact governed filename patterns and record the 2026-08-21 baseline counts.
2. Classify every matching tracked file using Section 2 categories.
3. Record `futureProjectPath` and disposition for each co-located legacy root tool, and freeze the exact equip-tool pilot legacy closure separately from the broader inventory.
4. Add deterministic validation and a package-local `action:inventory` command. It rejects any new root Stardew tool and any action-development dependency outside the frozen closure; classification alone cannot expand the closure.
5. Until Task 7, add at most one temporary unconditional opaque root workflow edge to package-local `action:inventory`; do not reference the not-yet-created project portfolio or add Stardew entries to root `.ci/`.
6. Fail on every future matching Stardew file added under root tool paths and any Stardew implementation placed under generic devkit paths. New game-project files are permitted only under `integrations/stardew/action-development/`. Task 7 atomically replaces the temporary workflow edge with `action:ci`.

**Acceptance**

```bash
pnpm --dir integrations/stardew/action-development test
pnpm --dir integrations/stardew/action-development action:inventory
node tools/test-portfolio-manifest.mjs
```

The report must say “files”, not “actions” or “runners”. It prints the broader inventory and the exact, monotonic `pilotLegacyClosure` separately. Any temporary root workflow edge invokes only `action:inventory` and contains no Stardew action/stage/profile/path-selection data. No existing action or runner changes in this task.

---

## Task 2 — Create the devkit package and extract its process supervisor

**Create**

- `packages/game-action-devkit/package.json`
- `packages/game-action-devkit/src/index.mjs`
- `packages/game-action-devkit/src/process-supervisor.mjs`
- `packages/game-action-devkit/tests/process-supervisor.test.mjs`

**Modify**

- `host/package.json` to declare the direct `workspace:*` **devDependency** used only by Host build/test scripts
- root `package.json` to declare the direct workspace **devDependency** used by root tools
- `pnpm-lock.yaml`
- `host/scripts/build-production-artifact.mjs`
- `host/scripts/build-test-artifact-locked.mjs`
- `host/scripts/run-tests.mjs`
- Host supervisor protocol tests/imports
- `tools/test-portfolio-manifest-runner.mjs`
- `tools/test-portfolio-manifest-runner.test.mjs`

**Delete after cutover**

- `host/scripts/test-supervisor.mjs`
- `host/scripts/test-supervisor.test.mjs`

**Steps**

1. Freeze the devkit package exports and forbid imports from `integrations/stardew/`, Stardew root tools, or Host product modules.
2. Move bounded output, inherited-stdio deadline, hanging-reaper bound, and heartbeat behavior into the shared module.
3. Preserve shell-free process tree behavior on Windows and POSIX.
4. Return structured outcomes; adapt callers to their current exception text only where externally tested.
5. Move all current root callers to the package export.
6. Remove portfolio-local spawning/termination implementation.
7. Declare every package/root consumer's direct devDependency; do not rely on workspace hoisting or ambient `node_modules` resolution. The devkit must not enter Host runtime dependencies, production runtime composition, or browser bundles.
8. Delete the old Host owner.

**Acceptance**

```bash
pnpm install --frozen-lockfile
pnpm --filter @gamebuddy/game-action-devkit test
node --test tools/test-portfolio-manifest-runner.test.mjs
node --test host/scripts/test-artifact-protocol.test.mjs host/scripts/production-artifact.test.mjs
pnpm test
```

The old `host/scripts/test-supervisor.test.mjs` cases must be moved into `packages/game-action-devkit/tests/process-supervisor.test.mjs` before the old file is deleted; acceptance runs only the new owner. Verify timeout reaps a spawned descendant, a hanging reaper remains bounded, large UTF-8 output is valid, and non-timeout Host builds retain behavior.

---

## Task 3 — Extract atomic directory finalization and implement evidence bundles

**Create in `packages/game-action-devkit/`**

- `src/atomic-directory.mjs`
- `src/evidence.mjs`
- `schemas/game-action-run.v1.schema.json`
- `tests/atomic-directory.test.mjs`
- `tests/evidence.test.mjs`

**Modify**

- root `package.json` if Task 2 has not already declared the devkit dependency
- `pnpm-lock.yaml`
- `tools/ci-snapshot-lib.mjs`
- `tools/create-ci-snapshot.mjs`
- `tools/materialize-ci-snapshot.mjs`
- `tools/ci-snapshot.test.mjs`
- `integrations/stardew/action-development/.gitignore` to ignore the project-local evidence root while preserving checked-in schemas/examples
- root `.gitignore` only if a root integration rule is still required

**Steps**

1. Extract generic canonical staging/commit/cleanup mechanics from CI snapshot tooling.
2. Keep snapshot-specific errors and manifest semantics in snapshot tooling.
3. Implement exact evidence schema and bounded artifact inventory.
4. Implement `beginActionRun`, `finalizeCompleteActionRun`, and `finalizeIncompleteActionRun` over the shared atomic-directory owner.
5. Prevent cleanup failure from publishing a passing final directory.
6. Reject secrets, unsafe paths, duplicate artifacts, oversized metadata, and mismatched game/action/run identity.
7. Preserve incomplete diagnostics without allowing them to satisfy passing queries.

**Acceptance**

```bash
pnpm install --frozen-lockfile
pnpm --filter @gamebuddy/game-action-devkit test
node --test tools/ci-snapshot.test.mjs
```

Include competing-destination, symlink/reparse, crash-before-commit, cleanup-failure, invalid UTF-8 metadata, and complete-versus-passed distinction tests.

---

## Task 4 — Implement evidence primitives only

Task 4 is the Wave C continuation after the devkit supervisor foundation. Do **not** create `portfolio.json` yet: before deterministic checks move into the Stardew package, a portfolio would only mirror legacy root tools and make the future repository boundary false.

**Create in `packages/game-action-devkit/`**

- `src/atomic-directory.mjs`
- `src/evidence.mjs`
- `schemas/game-action-run.v1.schema.json`
- `tests/atomic-directory.test.mjs`
- `tests/evidence.test.mjs`

**Modify only after a separately owned caller cutover**

- CI snapshot callers and tests, retaining snapshot-specific semantics;
- the Stardew package `.gitignore` for its project-local evidence root.

**Steps**

1. Extract generic canonical staging/commit/cleanup mechanics without moving CI snapshot semantics into the devkit.
2. Implement exact evidence identity, complete/incomplete finalization, bounded artifact inventory, and fail-closed query primitives.
3. Prevent cleanup failure, crash, mismatched identity, unsafe paths, secrets, invalid UTF-8 metadata, or duplicate artifacts from publishing a passing final directory.
4. Preserve incomplete diagnostics without allowing them to satisfy passing queries.
5. Keep the package game-agnostic; action/game values are opaque identity fields.

**Acceptance**

```bash
pnpm --filter @gamebuddy/game-action-devkit test
```

Tests cover competing destinations, crash-before-commit, cleanup failure, invalid UTF-8 metadata, and complete-versus-passed distinction. Existing CI snapshot callers are cut over only in their own owned-path integration lane.

---

## Task 5 — Implement the thin devkit CLI and Stardew project adapter

**Create in `packages/game-action-devkit/`**

- `bin/game-action.mjs`
- `src/project.mjs`
- `schemas/game-action-project.v1.schema.json`
- `schemas/game-action-profile-envelope.v1.schema.json`
- `schemas/game-action-scenario-result.v1.schema.json`
- `tests/project.test.mjs`
- `tests/cli.test.mjs`

**Create in `integrations/stardew/action-development/`**

- `src/project-adapter.mjs`
- `src/profile.mjs`
- `src/scenario-result.mjs`
- `profiles/example.json`
- corresponding tests

**Steps**

1. Implement only the devkit interface `runActionProject({ projectFile, invocation })` plus the thin argument-parsing bin. The immutable invocation contains only `command`, optional `actionId`, optional `profileFile`, and optional `briefFile`; there is no central adapter/game registry.
2. Define the game-project adapter methods behind that one devkit interface: `check`, `preflight`, `runScenario`, `verifyScenarioResult`, `cleanup`, `status`, and optional `observePublication`.
3. Define the exact `gamebuddy-action-scenario-result/v1` transport envelope. Required bounded keys are `schema`, `runId`, `gameId`, `actionId`, `stage`, `profileIdentity`, `claimScope`, `receipt`, `postcondition`, `verdict`, and `reasonCode`; action-specific nested payloads remain owned and verified by the game/action adapter. Reject unknown root keys, wrong identity, forbidden secrets/raw output, malformed UTF-8, duplicate JSON keys, and oversized files.
4. Define the sole child contract as `--result-file <absolute-private-path>`. The parent creates a new private staging directory and proves the target path is absent; the child writes a private sibling temp file with exclusive creation and atomically renames it once. Pre-existing, second, stale, or out-of-root result files fail closed.
5. Implement strict thin-CLI parsing and command separation; project/action/profile semantics are delegated.
6. Implement Stardew profile validation and exact target preflight by reusing existing fixture/launcher facts.
7. Keep action selection in the Stardew project portfolio/gate descriptor/scenario; do not add game or action IDs to devkit source.
8. Add a fixture project in devkit tests to prove no Stardew assumptions or root-repository paths exist.
9. Make Stardew `status` read project portfolio/evidence/publication observations separately.
10. Before Task 6 creates the first package-owned portfolio entry, project-level `status` runs without an action selector and reports a structured `portfolio_missing` blocker. It must not infer a known action from the tool inventory, a legacy root descriptor, the acceptance command, or a hard-coded action ID. Action-scoped unknown-versus-known resolution is proven in Task 5 only through the devkit's neutral fixture project; Stardew action-scoped `status`/`check` becomes available in Task 6 when that task creates the initial `equip_tool` portfolio entry.

**Acceptance**

```bash
pnpm --filter @gamebuddy/game-action-devkit test
pnpm --dir integrations/stardew/action-development test
pnpm --dir integrations/stardew/action-development action:status
```

All tests are non-live. A missing/escaping project manifest, unknown command, mismatched action, missing profile, duplicate/extra option, attempted preflight action submission, stale/pre-existing result, wrong run/profile identity, duplicate write, malformed/oversized result, or result outside the private staging root fails closed. A devkit import-dependency test rejects any Stardew or root-product import.

---

## Task 6 — Connect `equip_tool` as the zero-runtime-rewrite pilot

**Modify tooling only**

- `tools/run-stardew-native-local-player-equip-tool-smoke.mjs`
- its existing test
- `tools/run-stardew-native-local-player-move-fixture.ps1`
- its existing helper tests
- `tools/stardew-action-gate-descriptors.mjs`
- `integrations/stardew/action-development/portfolio.json`
- `integrations/stardew/action-development/package.json`

**Do not modify**

- `integrations/stardew/` production action implementation;
- Host protocol/schema/tool semantics;
- Stardew action catalog or policy;
- equip-tool fixture gameplay semantics.

**Steps**

1. Make the existing equip-tool scenario consume only the Task 5 `--result-file <absolute-private-path>` contract and emit exactly one `gamebuddy-action-scenario-result/v1`; stdout remains bounded diagnostics.
2. Make the Stardew project adapter call the existing fixture transaction and existing equip-tool scenario through the devkit supervisor.
3. Validate scenario output with an equip-tool-specific verifier: exact run/game/action/stage/profile/claim identity, typed action identity, exact receipt lineage, `succeeded/tool_selected`, bounded evidence, and fresh observed `currentTool`.
4. The fixture backend must return a separate bounded cleanup/restore result owned by the parent adapter. Only an exact child outcome, a valid scenario result, and successful process/fixture/profile restore may finalize `complete/passed`; crash, timeout, missing result, or restore uncertainty finalizes `incomplete`.
5. Write complete/incomplete evidence bundles.
6. Create the initial Stardew project portfolio here—not earlier—from the pilot's own package-local deterministic check, preflight, and manual-live entries. Every executable must be project-local or depend only on a declared stable public interface; it must not point at legacy root `tools/`.
7. Switch the canonical Stardew package commands to its local `action:*` scripts; do not add action-specific root CLI scripts.
8. Delete any equip-tool-only wrapper made redundant by the cutover; retain the action-specific scenario and the shared Stardew fixture backend.

**Static acceptance**

```bash
pnpm --dir integrations/stardew/action-development action:check --action equip_tool
pnpm --dir integrations/stardew/action-development test
pnpm --filter @gamebuddy/game-action-devkit test
```

Use deterministic fake child processes to prove timeout, crash-before-write, missing result, pre-existing/stale result, duplicate write, wrong run/action/profile identity, malformed/oversized JSON, invalid result, failed fresh reread, restore failure, and valid complete bundle behavior.

**Live acceptance — separately authorized serial gate**

```bash
pnpm --dir integrations/stardew/action-development action:preflight --action equip_tool --profile <absolute-profile-json>
pnpm --dir integrations/stardew/action-development action:run-live --action equip_tool --profile <absolute-profile-json>
```

The live pilot is allowed only after static acceptance and an aggregate review. It must use an existing legitimate fixture, perform one existing typed equip operation, restore all transaction-owned state, and produce one complete bundle. A harness defect is repaired offline before any rerun.

---

## Task 7 — Connect the Stardew package to CI without centralizing its portfolio

**Modify**

- `integrations/stardew/action-development/package.json`
- `integrations/stardew/action-development/portfolio.json`
- `.ci/test-portfolio-manifest.v1.json`
- `.github/workflows/ci.yml` to perform the complete Stardew CI cutover
- package/root integration tests

**Steps**

1. Inventory every current Stardew-specific root CI/portfolio check, including direct `test:stardew-*`, `check:stardew-*`, `verify:stardew-*`, Stardew jobs, and root portfolio entries such as static/isolation/live-environment diagnostics.
2. Move every retained deterministic check into the Stardew package's project portfolio and make one `action:ci` command validate the project manifest, inventory, portfolio, and all PR-safe selected checks. Every `action:ci` executable must be package-local or consume a declared devkit/common public interface; it cannot invoke root `tools/*stardew*`, root package scripts, root Host build outputs, or the pilot legacy closure. Preserve equivalent coverage; opacity cannot be achieved by deleting checks.
3. Delete every Stardew-specific entry from `.ci/test-portfolio-manifest.v1.json`.
4. Delete every direct Stardew command/job from `.github/workflows/ci.yml` and atomically replace Task 1's temporary edge with exactly one unconditional opaque workflow command: `pnpm --dir integrations/stardew/action-development action:ci`. No dual invocation remains.
5. Keep unrelated generic Host/web/Voice CI commands in the root workflow; their generic tests may cover common integration interfaces, but they cannot invoke Stardew-named tools or own Stardew action workflow selection.
6. Add a root integration validator proving the root portfolio contains no Stardew entry and the root workflow contains exactly one Stardew package command, with no `tools/*stardew*` command, Stardew action/stage/claim/profile/live metadata, or second Stardew job.
7. Add a Stardew-project validator proving `action:ci` cannot select `preflight`, `live`, or `publication-check` entries.
8. Test that any deep existing, modified, or newly added file under `integrations/stardew/action-development/` is covered because the root command is unconditional; no root trigger-path enumeration is allowed.
9. Keep target/live CI definitions in the Stardew package/runbook now; when a standalone Stardew repository is created, its workflow calls the same package commands.
10. Upload only bounded deterministic package reports in root CI. Live evidence remains under game-project-owned self-hosted operation.

**Acceptance**

```bash
pnpm --dir integrations/stardew/action-development action:ci
pnpm --dir integrations/stardew/action-development test
node tools/test-portfolio-manifest.mjs .ci/test-portfolio-manifest.v1.json
```

A clean simulated PR runs the unconditional Stardew package edge and selects the expected checks internally. Root portfolio has zero Stardew entries; root workflow has exactly one opaque Stardew-package command and no copied game workflow metadata. Current direct Stardew commands/jobs are gone, retained checks have package-owned parity, and ordinary PR/main CI cannot select live game stages.

---

## Task 8 — Add clean work briefs and owned-path enforcement

**Create**

- `packages/game-action-devkit/schemas/game-action-work-brief.v1.schema.json`
- `packages/game-action-devkit/src/work-brief.mjs`
- `packages/game-action-devkit/tests/work-brief.test.mjs`

**Modify**

- devkit project invocation tests
- Stardew package scripts/tests
- repository CODEOWNERS only if the repository adopts CODEOWNERS for existing shared hubs

**Steps**

1. Validate exact base commit, game/action identity, owned paths, shared hubs, required portfolio entries, and live authorization.
2. Compare the current diff against the brief.
3. Reject unowned changed paths and missing required checks.
4. Report shared-hub changes separately for owner review.
5. Document worktree creation through existing developer/subagent tooling; do not implement a second Git worktree manager unless an actual missing behavior remains.
6. Emit an incomplete structured handoff on timeout/failure.

**Acceptance**

```bash
pnpm --filter @gamebuddy/game-action-devkit test
pnpm --dir integrations/stardew/action-development test
```

Fixtures cover clean ownership, unowned path, wrong base, shared hub, case-folded collision, live-without-authorization, and a timeout handoff.

---

## Task 9 — Refactor action-development skills

Before editing skills, load `.agents/skills/writing-for-agents/SKILL.md`.

**Create**

- `.agents/skills/game-action-boundary/SKILL.md`
- `.agents/skills/game-action-implement/SKILL.md`
- `.agents/skills/game-action-close/SKILL.md`
- `.agents/skills/game-action-publish/SKILL.md`
- `integrations/stardew/action-development/ACTION_RUNBOOK.md`

**Modify/delete**

- replace the current Stardew-only closure/implementation skills after content parity;
- update `.gitignore` allowlist for the new project-owned skills;
- delete superseded skill paths instead of retaining aliases.

**Skill boundaries**

- boundary skill freezes public semantics, claim scope, native prerequisite, and reuse/extend/compose/split decision;
- implement skill uses a work brief, scaffold/profile, and deterministic check; it cannot publish or run live unless explicitly authorized;
- close skill owns preflight, one aggregate review, the approved live gate, and evidence finalization; it cannot publish;
- publish skill verifies exact evidence and changes the game-owned catalog/policy through the game integration owner; it cannot change gameplay semantics;
- Stardew-specific fixture, target-version, SMAPI, save, bridge, package CI, and future repository extraction instructions live only in its project-owned `ACTION_RUNBOOK.md`.

**Acceptance**

- skill files pass the writing-for-agents review checklist;
- trigger descriptions do not overlap ambiguously;
- each skill references the canonical CLI commands and authority boundary;
- a fixture walkthrough demonstrates that an implementation agent cannot infer live or publication authorization.

---

## Task 10 — Touched-on migration and obsolete-tool deletion

This is an incremental operating rule, not a bulk project.

For each future action-tool change:

1. consult the project inventory;
2. add all new Stardew tooling under the game project package—never under generic root tool paths;
3. keep action-specific scenario semantics;
4. replace repeated generic supervisor/evidence mechanics with devkit owners and game-specific profile mechanics with the Stardew project owner;
5. run parity tests;
6. move or delete a legacy root path and shrink `pilotLegacyClosure`; never add to that closure;
7. change the inventory classification/disposition;
8. delete the superseded file or code path in the same accepted change;
9. do not maintain a legacy fallback.

A periodic inventory report may propose `obsolete` candidates, but deletion requires references and package/portfolio ownership to be checked mechanically.

**Acceptance per touched action**

- no duplicate canonical entry;
- no old/new CLI dual route;
- no duplicated supervisor/evidence finalizer;
- existing action-specific tests and required live evidence remain valid for their exact claim scope;
- inventory and portfolio stay complete.

---

## Task 11 — Prove package extraction and cross-game readiness

**Create**

- a deterministic fixture project inside `packages/game-action-devkit/tests/fixtures/project/`;
- a Stardew extraction test or script under `integrations/stardew/action-development/tests/`;
- standalone Stardew project pin templates/inputs owned by `integrations/stardew/action-development/`: `package.json` engines/packageManager, lockfile, optional minimal `pnpm-workspace.yaml`, `global.json`, and declared restore/build inputs;
- project onboarding/extraction documentation.

**Steps**

1. Run the thin CLI, supervisor, evidence, profile-envelope, work-brief, and project-manifest tests against the fixture project.
2. Prove the devkit import graph contains no Stardew paths, concepts, executable names, receipts, Host product modules, or root portfolio implementation.
3. Materialize a temporary standalone Stardew action-development package and run deterministic `action:ci` with **zero** legacy-root dependencies; install/link only an exact packed devkit artifact and the minimum declared game-project sources. Separately materialize the frozen `pilotLegacyClosure` only to prove those explicitly Stardew-owned preflight/live backend files are complete and relocatable; do not execute a target game. The materialized root receives Stardew-owned `package.json` engines/packageManager, a frozen lockfile, the minimal workspace file if needed, `global.json`, and explicit restore/build inputs.
4. Run a locked/frozen dependency install and SDK-version check in the temporary root, then run the Stardew package's deterministic `action:ci`. Reject any read from the former monorepo root, any legacy closure use by `action:ci`, undeclared root `tools/`, root `.ci/`, root `package.json`, or root Host build outputs. If current Host coupling prevents this, Task 11 remains blocked and produces the exact dependency inventory; it must not weaken the check or introduce a monorepo fallback.
5. Emit the remaining runtime-source extraction debt separately, especially current `host/src/*stardew*`, and open a separate runtime plugin/interface cutover plan; do not call the whole Stardew repository split complete until that seam is moved.
6. Keep the fixture project clearly non-production and unable to produce live or publication claims.
7. When a second real game project exists, depend on the released devkit package and run the same project conformance without adding that game to a core registry.

**Acceptance**

The devkit may be called “cross-game development-module ready” only after fixture-project conformance and the locked, pinned Stardew package extraction rehearsal. It may not be called validated against multiple real games until a second target-runtime game project completes its own evidence. The Stardew repository split itself remains incomplete while separately inventoried Host/runtime seams remain in GameBuddy core.

---

## 14. Required deterministic conformance suites

Every action workflow composes only the applicable suites; the devkit never invents gameplay tests.

### 14.1 Project/portfolio conformance

- exact one-project manifest and non-escaping package-local paths;
- unique action/stage identity within the game project;
- deterministic dependency closure;
- live stages manual/self-hosted-only;
- no publication grant in workflow metadata;
- project-owned tool inventory blocks unclassified growth;
- root GameBuddy CI sees only an opaque game-project check, not copied action metadata;
- devkit has no game registry or game-project import.

### 14.2 Protocol/lifecycle conformance

Use real consumer/provider adapters where available:

- exact selector/request fields;
- unknown/mixed/extra fields rejected;
- one request/execution lineage;
- terminal state/action/reason/evidence coherence;
- idempotent replay;
- cancellation/deadline ordering;
- post-side-effect exception becomes uncertain;
- stale/synthetic receipt or trace fails closed;
- completion requires the action's fresh postcondition.

When a review finds a mechanical invariant that applies across actions, add it to this suite rather than relying on future reviewers to rediscover it.

### 14.3 Process/evidence conformance

- direct-child and descendant cleanup;
- timeout remains failure even after cleanup;
- hanging reaper bounded;
- output bounded at valid UTF-8 boundaries;
- staging is never accepted as final;
- complete versus passed distinction;
- cleanup uncertainty prevents passing publication;
- wrong action/game/profile/source identity rejected;
- no secret material in a bundle.

### 14.4 Action-specific scenario conformance

Only the game/action owns:

- legal Given;
- target selection;
- native commit;
- irreversible point;
- expected terminal/evidence;
- fresh postcondition;
- persistence and restore;
- target-runtime claim scope.

---

## 15. Sequencing and release gates

```text
Wave A — bounded reconnaissance / no production writes
  ├─ Task 1 inventory scope and pilot legacy-closure facts
  ├─ Task 2 supervisor caller/parity map
  ├─ Task 3 snapshot/evidence extraction map
  └─ Task 7 current root-CI command disposition map
  ↓ synthesize once; freeze mutation lanes
Wave B — independent foundations
  ├─ Task 1 Stardew inventory/package writer
  └─ Task 2 devkit supervisor writer
  ↓ one devkit/root integrator accepts shared package/workspace/lockfile changes
Wave C — independent project and evidence lanes
  ├─ Task 3 atomic evidence writer
  └─ Task 4 Stardew portfolio writer
  ↓ one integration point after both accepted
Wave D — one connected producer → consumer → verifier chain
  └─ Task 5 thin devkit CLI + Stardew project adapter writer
  ↓
Wave E — disjoint post-interface lanes
  ├─ Task 6 equip_tool static pilot writer
  ├─ Task 8 work-brief enforcement writer
  └─ Task 9 skills/runbook writer
  ↓ Task 6 evidence and Task 8/9 checks accepted; no shared package edits concurrently
Wave F — CI cutover and extraction proof
  ├─ Task 7 package-owned opaque CI cutover writer
  └─ Task 10 touched-on migration becomes ongoing only after its relevant path is accepted
  ↓
Task 11 extraction rehearsal + cross-game readiness
  ↓
optional separately authorized serial equip_tool live pilot (after Task 6 static acceptance + aggregate review; not a prerequisite for Tasks 7–11)
```

Launch every ready mutation lane in the same wave, but do not split one producer → consumer → verifier chain merely to increase concurrency. Task 2 and Task 3 share the devkit package boundary: writers may develop only disjoint source/test paths in parallel after Wave A, while one named devkit/root integrator alone updates `package.json`, exports, workspace entries, and lockfile after both focused suites pass. Task 1 and Task 4 share the Stardew package root, so Task 4 begins only after Task 1 accepts its skeleton; Task 6 and Task 7 both own portfolio/package scripts, so Task 7 begins only after Task 6 static acceptance. Task 8 and Task 9 may proceed with Task 6 because they have disjoint devkit/skill paths and independent deterministic acceptance.

Each wave has one parent synthesis and one post-batch validation/review wave. A timeout, failed focused check, new authority decision, or scope-changing source fact blocks only its dependent lanes; it does not restart or serialize independent lanes. No live pilot is necessary to begin Tasks 7–11 if the static devkit/project contracts are complete. However, the devkit/Stardew package must not claim complete live evidence orchestration until one separately authorized serial pilot produces a valid complete bundle.

---

## 16. Aggregate acceptance

The implementation plan is complete only when all of the following are true:

1. every implemented mutation lane recorded its own exact base, owned/forbidden paths, focused checks, and actual shared-hub integrator without requiring a repository-wide cleanup or checkpoint;
2. the Stardew-owned filename inventory is exact, prevents unclassified growth, and records a future project path/disposition without calling files actions/runners;
3. `@gamebuddy/game-action-devkit` has a small public interface, a thin bin, and no Stardew/game registry/product import;
4. exactly one devkit process supervisor owns bounded process-tree execution for migrated callers;
5. exactly one devkit atomic-directory primitive owns staging/final commit for migrated callers;
6. evidence bundles distinguish complete/incomplete and verdict, and cleanup gates final passing publication;
7. the Stardew project portfolio is the sole owner of Stardew action/stage/claim/live workflow facts;
8. GameBuddy root CI/portfolio invokes only one opaque Stardew package check and contains no copied action workflow metadata;
9. the Stardew project adapter reuses existing runtime/scenario semantics through the devkit public interface;
10. `equip_tool` passes the static pilot with no production action code change and its scenario result is bound to the exact private run context;
11. ordinary GitHub CI cannot select or launch live game stages;
12. work briefs catch unowned changes and wrong-base work;
13. generic skills separate boundary, implementation, closure, and publication while Stardew runbook/CI remain game-project-owned;
14. no superseded supervisor, manifest, CLI entry, or pilot wrapper remains on a migrated path;
15. an extraction rehearsal runs Stardew `action:ci` without ambient monorepo-root tooling, and remaining Host/runtime split debt is explicit;
16. `git diff --check` passes on the scoped implementation;
17. one aggregate independent review finds no P0–P2 blocker;
18. if the optional live pilot is run, it is serial, target-version exact, cleanup-complete, and preserved as a bounded complete evidence bundle.

---

## 17. Expected benefit from existing evidence

The investment is justified by existing repository facts, not future-action ROI measurement:

- 98 `run-stardew-*.mjs` filename matches already require classification;
- two independent process supervisors already exist;
- action fixture wrappers repeatedly own launch, readiness, teardown, and restore;
- Navigation repeatedly required manual repair after timeout partials;
- cross-language and replay invariants were repeatedly found by review instead of one conformance suite;
- a successful runtime characterization was not available later as a durable consumer-supplied artifact;
- the root test portfolio exists but is not the CI workflow entrypoint;
- Stardew tooling/action workflow facts are currently spread through root `tools/`, root scripts, and Host-specific paths, making a future repository split expensive;
- action implementation/evidence/publication state currently requires manual reconciliation.

The expected benefit is therefore reduced duplicate ownership, fewer live slots wasted on harness defects, less shared-tree contamination, durable evidence, and a physical package seam that lets a game project consume GameBuddy's devkit without being centrally owned by the GameBuddy repository. No additional new action is required to prove that these existing problems are real.
