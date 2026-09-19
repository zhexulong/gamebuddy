# Stardew Capability Publication Target Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deleted legacy Farmhand capability-projection static leaf with a current-architecture target-artifact contract that proves the Mod's single `FarmhandCapabilityPublication` composition, while keeping ordinary CI honest about the absence of licensed target assemblies.

**Architecture:** The new standalone contract is a narrow observer of a freshly built `GameBuddy.Stardew.dll` plus its exact `GameBuddy.Stardew.Core.dll` dependency. It must prove compiled composition of the current authority graph—one Mod-owned publication consumed by execution and bridge projections—without restoring the removed `FarmhandCapabilitySurface`/`ExecutionManager` model or duplicating source-level Core and integration semantics. The static portfolio must inventory this new leaf consistently, while ordinary GitHub CI runs only deterministic self-tests and source/unit checks; full target-artifact verification remains fail-closed in the existing target-version local/release gate.

**Tech Stack:** .NET 6 / C#, `System.Reflection.Metadata`, Node.js 24 ESM, pnpm, PowerShell, GitHub Actions.

**Spec:** A bounded prerequisite repair for `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` Task 7, plus project authority constraints #1704 and #1337. This plan does **not** complete Task 7's game-project-owned CI cutover.

## Global Constraints

- The Mod owns the one-way capability/projection graph; Host, schemas, descriptors, catalogs, tests, and CI may restrict or observe it but never grant capability.
- Tests and attestation observe production authority only; missing target-artifact evidence remains blocked and must not be relabeled passed.
- Do not restore legacy `FarmhandCapabilitySurface`, `ExecutionManager`, old action-policy semantics, compatibility shims, or deleted `FarmhandActionCapabilityProjection` identity.
- The target contract is static and deterministic only: do not start Stardew, SMAPI, pipes, fixtures, action execution, or live mutation.
- The contract binds the freshly built Mod and Core assemblies as one exact artifact closure; no stale `bin/` output, arbitrary sibling Core DLL, or independently supplied alternate Core path may satisfy it.
- Keep source-level policy behavior in existing Core/Integration tests. The new standalone contract proves compiled production composition, not all policy/parser/router behavior again.
- Ordinary GitHub CI has no licensed target Stardew/SMAPI assemblies. Its exact permitted Stardew set is source-only scaffold verification, Node static-verifier self-tests, and `GameBuddy.Stardew.Core.Tests`; it must not run `GameBuddy.Stardew.Integration.Tests`, any project referencing `GameBuddy.Stardew.csproj`, or the target-artifact verifier as a passing required command.
- `GameBuddy.Stardew.Integration.Tests`, the standalone target contracts, and full `verify:stardew:static` belong exclusively to the target-version local/release gate. Missing target assemblies or target contract artifacts remain nonzero, fail-closed `blocked` evidence.
- This is a bounded prerequisite repair, not Task 7 completion: until package-owned parity exists, the existing root `stardew-scaffold` job remains an explicitly temporary `retain_until_package_parity` edge. No action-development package migration, root portfolio cutover, or root CI opaque edge is performed or claimed here.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `integrations/stardew/tests/FarmhandCapabilityPublicationProjection.Contract.csproj` | Standalone contract project, explicitly builds against the exact Mod/Core target closure and target-version references. |
| `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionProgram.cs` | Validates CLI input, snapshots exact artifacts, verifies hashes/closure, then invokes compiled metadata/IL assertions. |
| `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionTests.cs` | Narrow metadata/IL assertions for the current Mod publication composition and restrictive downstream projections. |
| `integrations/stardew/tests/ProductionAssemblyBinding.cs` | Existing/private binding helper updated only if it needs explicit paired-Mod/Core closure support. |
| `GameBuddy.sln` | Builds every executable the target static verifier invokes. |
| `package.json` | Declares the new static script with its exact compiled entrypoint. |
| `tools/stardew-static-portfolio.v1.json` | Replaces the stale script/leaf identity with the new contract identity and exact command. |
| `tools/verify-stardew-static.mjs` | Builds and binds the target artifact closure; permits only exact current contract entrypoints. |
| `tools/verify-stardew-static.test.mjs` | Regression tests for inventory, closure binding, no stale artifacts, failure states, and verifier behavior. |
| `integrations/stardew/tests/README.md` | Documents actual build/execute closure and separates ordinary self-tests from target-version verification. |
| `.github/workflows/ci.yml` | Performs only the temporary root job's no-target evidence repair: runs the exact permitted self-test/Core set and removes the impossible full target verifier invocation; Task 7 later moves selection to the package. |

---

### Task 1: Freeze the new target-artifact contract identity and red test seams

**Files:**
- Create: `integrations/stardew/tests/FarmhandCapabilityPublicationProjection.Contract.csproj`
- Create: `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionProgram.cs`
- Create: `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionTests.cs`
- Modify: `tools/verify-stardew-static.test.mjs`
- Modify: `tools/stardew-static-portfolio.v1.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: a freshly built Mod artifact and its paired Core artifact.
- Produces: `FarmhandCapabilityPublicationProjection.Contract.dll`, invoked as:
  ```text
  dotnet <contract-dll> --expected-mod-sha256 <64-lowercase-hex> --expected-core-sha256 <64-lowercase-hex> <absolute-mod-dll> <absolute-core-dll>
  ```
- Produces: static portfolio leaf ID `stardew_capability_publication_projection_contract` with a new, versioned risk ID; no old capability-projection ID remains.

- [ ] **Step 1: Write verifier inventory regressions before restoring a leaf**

  Update `tools/verify-stardew-static.test.mjs` so it expects exactly the new leaf and rejects the deleted identity:

  ```js
  assert.ok(portfolio.leaves.some((leaf) => leaf.id === "stardew_capability_publication_projection_contract"));
  assert.ok(!portfolio.leaves.some((leaf) => leaf.id === "stardew_capability_projection_contract"));
  ```

  Add a test that mutates the leaf command to omit either `--expected-mod-sha256` or `--expected-core-sha256` and asserts `static_portfolio_leaf_script_drift` or a named closure-validation failure.

- [ ] **Step 2: Run the narrowed self-test and confirm it is red**

  Run:

  ```bash
  node --test tools/verify-stardew-static.test.mjs
  ```

  Expected: fail because the new portfolio identity/project/entrypoint does not yet exist. Preserve the named failure; do not remove the old leaf solely to make this test green.

- [ ] **Step 3: Create the contract project with an explicit target closure**

  Create `FarmhandCapabilityPublicationProjection.Contract.csproj` with:

  ```xml
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>FarmhandCapabilityPublicationProjection.Contract</AssemblyName>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  ```

  Reference the Mod project and explicit target-version external references. Compile only the new program/assertion files plus the existing binding helper if it is still the narrowest reusable implementation. Do not reference the action-development package, Host, root Node tools, or legacy `FarmhandActionCapabilityProjection` source.

- [ ] **Step 4: Define the strict program argument boundary**

  Implement a parser accepting only:

  ```text
  --expected-mod-sha256 <hash> --expected-core-sha256 <hash> <mod-path> <core-path>
  ```

  Reject duplicate flags, extra args, non-lowercase-hex hashes, missing/non-file paths, and a Core path that is not the dependency physically paired with the selected Mod artifact. Snapshot and hash both artifacts before metadata/type inspection; fail before loading when either artifact changes or its expected digest mismatches.

- [ ] **Step 5: Replace the stale portfolio identity atomically**

  In `package.json` and `tools/stardew-static-portfolio.v1.json`, replace—not supplement—the deleted script/leaf with:

  ```text
  test:stardew-static-capability-publication-projection
  stardew_capability_publication_projection_contract
  FarmhandCapabilityPublicationProjection.Contract.dll
  ```

  Update every exact contract entrypoint allowlist in `tools/verify-stardew-static.mjs` in the same task. The old script name, DLL path, csproj identity, leaf ID, and risk ID must be absent after this step.

- [ ] **Step 6: Run the contract inventory and unit feedback loop**

  Run:

  ```bash
  node --test tools/verify-stardew-static.test.mjs
  pnpm test:stardew:static
  ```

  Expected: verifier self-tests no longer reference deleted sources. If target assemblies are absent, do not run or claim the full verifier passed.

---

### Task 2: Prove the compiled current authority composition

**Files:**
- Modify: `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionProgram.cs`
- Modify: `integrations/stardew/tests/FarmhandCapabilityPublicationProjectionTests.cs`
- Modify: `integrations/stardew/tests/ProductionAssemblyBinding.cs` only if paired artifact binding cannot be expressed in the program
- Test: `integrations/stardew/tests/FarmhandCapabilityPublicationProjection.Contract.csproj`

**Interfaces:**
- Consumes: verified paired Mod/Core artifact snapshots from Task 1.
- Produces: exit `0` only if the current compiled graph uses `FarmhandCapabilityPublication` as the sole capability lineage described below.

- [ ] **Step 1: Write failing metadata/IL assertions for the authority graph**

  Add assertions that inspect the compiled target artifacts and fail with named messages when any required current symbol/call edge is absent:

  ```text
  ModEntry → FarmhandCapabilityPublication.Initial(config.EnabledActionSet)
  ModEntry → FarmhandExecutionController(publication provider)
  ModEntry → BridgeSession(publication provider)
  policy reload → FarmhandCapabilityPublication.WithEnabledActions(...)
  BridgeSession hello → publication.CapabilitySet.AdvertisedCapabilityIds
  BridgeSession hello → publication.EnabledActionIds
  BridgeSession catalog update → publication.CapabilityRevision and publication.EnabledActionIds
  ```

  Add a negative assertion rejecting compiled references to the removed `FarmhandCapabilitySurface` and `ExecutionManager` authority types.

- [ ] **Step 2: Run the contract build to establish the expected red failure**

  On a machine with `GAMEBUDDY_STARDEW_GAME_PATH` set to the target version:

  ```bash
  dotnet build integrations/stardew/tests/FarmhandCapabilityPublicationProjection.Contract.csproj --configuration Release --no-restore -p:GamePath="$GAMEBUDDY_STARDEW_GAME_PATH"
  ```

  Expected before implementation completion: missing assertion/program symbols or an explicitly failing authority edge. Do not fabricate target assemblies when the target path is unavailable.

- [ ] **Step 3: Implement narrow compiled-composition validation**

  Use `System.Reflection.Metadata` / IL inspection to verify the authority edges from Step 1 without instantiating SMAPI or starting the game. Keep behavioral conditions in Core/Integration suites; this contract checks that the freshly built artifacts actually compose them.

  The contract must additionally prove the restrictive projection boundary in compiled code:

  ```text
  read-only operations may be advertised but are not enabled execution IDs
  protocol controls may be advertised but are not enabled execution IDs
  unknown operation IDs cannot enter FarmhandCapabilitySet membership
  ```

- [ ] **Step 4: Add artifact closure regressions**

  Add contract and Node-verifier tests covering:

  ```text
  wrong Mod hash → fail before type load
  wrong Core hash → fail before type load
  changed Mod or Core file during snapshot → fail
  Core DLL outside the selected Mod output closure → fail
  absent contract DLL after build → fail, never execute stale bin output
  removed legacy authority type reference → required absence
  ```

- [ ] **Step 5: Run focused deterministic checks**

  Run:

  ```bash
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --no-restore
  node --test tools/verify-stardew-static.test.mjs
  ```

  On a target-equipped local/release machine also run:

  ```bash
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --no-restore
  ```

  Then run the Task 2 contract build and its exact binary invocation. Record a target-artifact command as blocked—not passed—when target assemblies are unavailable.

---

### Task 3: Repair build, verifier, README, and CI semantics without weakening evidence

**Files:**
- Modify: `GameBuddy.sln`
- Modify: `tools/verify-stardew-static.mjs`
- Modify: `tools/verify-stardew-static.test.mjs`
- Modify: `integrations/stardew/tests/README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 portfolio identity and Task 2 contract.
- Produces:
  - temporary ordinary root CI: exactly scaffold verification, Node static-verifier self-tests, and `GameBuddy.Stardew.Core.Tests` only;
  - target-version local/release gate: Integration tests plus exact build + contract execution with missing target closure as nonzero `blocked`.

**Temporary ownership disposition:** This task repairs an already-retained root CI edge. It neither moves a check to `action-development` nor grants root permanent portfolio-selection authority; `root-ci-disposition-audit` must continue to report all retained root edges as `retain_until_package_parity` until Task 7 completes.

- [ ] **Step 1: Add every executed standalone target contract to the build closure**

  Add the new capability-publication contract and the existing `PortfolioMineElevatorProjection.Contract` project to `GameBuddy.sln`, with configuration mappings for Debug and Release. Alternatively, if solution membership cannot be maintained, change `buildTargetProduction()` to explicitly build each exact contract project and assert their exact output paths before execution. Choose exactly one mechanism; do not rely on pre-existing `bin/` files.

- [ ] **Step 2: Extend verifier binding from one artifact to a paired closure**

  Replace the single `hashProductionAssembly()` contract handoff with a closure API such as:

  ```js
  hashProductionClosure() => {
    mod: { path, expectedSha256 },
    core: { path, expectedSha256 },
  }
  ```

  `verifyStaticPortfolio()` must append both hashes and both absolute paths to the capability-publication contract only. Preserve a narrow contract-specific command shape; do not give arbitrary portfolio leaves additional input paths.

- [ ] **Step 3: Add verifier state regressions**

  In `tools/verify-stardew-static.test.mjs`, prove:

  ```text
  no target assemblies → report.state === "blocked" and process exit 2
  target build failure → affected leaves failed and never invoked
  target build succeeds but an exact contract output is missing → failed and never invoked
  every invoked contract receives only its approved artifact closure
  stale legacy contract path/identity cannot load the portfolio
  ```

- [ ] **Step 4: Separate CI commands by available evidence**

  In `.github/workflows/ci.yml`, retain only this temporary root job's exact no-target set:

  ```text
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-stardew-scaffold.ps1
  pnpm test:stardew:static
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --no-restore
  ```

  Remove the unconditional `pnpm verify:stardew:static` command and do not add `pnpm test:stardew:integration`: both require target-version Mod build inputs that GitHub-hosted CI does not own. Keep Integration tests and target contracts in the local/release target gate. Do not add a `--allow-blocked`, fake assemblies, target skip that returns success, or an alternative CI-only capability authority.

- [ ] **Step 5: Correct the README to match reality**

  Document:

  ```text
  ordinary CI runs self-tests and source/unit evidence only;
  target-version local/release verification builds every listed contract from clean inputs;
  the capability-publication contract checks a paired Mod/Core artifact closure;
  missing target assemblies is blocked, not passed;
  this static contract is not live/release evidence.
  ```

  Remove all references to `FarmhandActionCapabilityProjection.Contract`, `FarmhandCapabilitySurface`, and `ExecutionManager` as the current contract authority.

- [ ] **Step 6: Run complete non-live acceptance**

  Run:

  ```bash
  pnpm test:stardew:static
  pnpm test:stardew:core
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-stardew-scaffold.ps1
  pnpm --dir integrations/stardew/action-development action:ci
  git diff --check
  ```

  On a target-equipped local/release machine, also run:

  ```bash
  pnpm test:stardew:integration
  pnpm verify:stardew:static
  ```

  Expected: target verifier is `passed` only with actual target assemblies and a freshly built, validated Mod/Core closure. Without those assemblies, its explicit `blocked`/nonzero result is expected and is not a CI pass claim.

---

## Self-Review

### Spec coverage

- Task 1 replaces every stale package/portfolio identity rather than deleting coverage.
- Task 2 distinguishes compiled authority-composition proof from existing Core/Integration behavioral tests and binds Mod/Core artifacts together.
- Task 3 repairs solution/verifier/README/CI contradictions while preserving fail-closed target evidence and defines the exact target-free GitHub set.
- No task adds a game registry, expands Devkit, starts a game, runs a live mutation, or claims Task 7 root CI cutover. The root job remains a recorded temporary retained edge until package parity.

### Placeholder scan

The plan contains no unspecified implementation placeholders. Where the exact reusable binding helper shape is unknown, the task constrains the only permitted change: paired artifact closure support in the existing helper, only if the program cannot own it directly.

### Type consistency

- New contract executable: `FarmhandCapabilityPublicationProjection.Contract.dll`.
- New leaf ID: `stardew_capability_publication_projection_contract`.
- New script: `test:stardew-static-capability-publication-projection`.
- Program flags: `--expected-mod-sha256`, `--expected-core-sha256`.
- Verifier closure API: `hashProductionClosure()`.
