---
id: TASK-58-ARCHITECTURE-TOOLING-KNIP-TRUTH
type: task
status: active
owner: architecture
---

# Architecture Tooling and Knip Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Knip an honest JS/TS reachability gate, add mature dependency graph and C# architecture tooling for narrow named obligations, and remove only superseded custom governance machinery.

**Architecture:** Knip keeps its native workspace/production static analysis role and its default exit semantics. `dependency-cruiser` owns only generic TypeScript graph obligations; existing Host checks that establish dynamic-import, artifact, facade, provenance, or legacy-authority semantics are separated as owner-specific checks rather than silently deleted. ArchUnitNET validates one already-established Core/Mod boundary without requiring directory reorganization or a giant-class refactor.

**Tech Stack:** Node 24.13+, pnpm 11.1.3, Knip 6.34.0, dependency-cruiser 17.3.2, TypeScript 5.9.3, .NET 6, xUnit 2.9.2, ArchUnitNET 0.13.3.

**Spec:** `design/architecture/architecture-governance-and-anti-erosion.md`

## Global Constraints

- Do not use broad Knip entries, ignores for production sources, baseline/ledger/disposition state, `--no-exit-code`, or `--fix`.
- Every retained Knip entry must cite a package script, CI/release workflow, package manifest, actual child-process worker, or externally loaded artifact.
- Do not add a custom architecture scanner, graph database, score, or umbrella gate.
- dependency-cruiser rules must be standard, small, path/package-bound rules with their own default failure semantics.
- Keep product safety semantics that dependency-cruiser cannot express in domain-owned checks; do not delete them merely because a new graph tool exists.
- The first ArchUnitNET rule must use the existing `GameBuddy.Stardew.Core` → `GameBuddy.Stardew` assembly seam; do not restructure C# directories or giant classes for this work.
- Work in the isolated integration worktree; do not modify unrelated dirty changes in the primary checkout.

---

## File Structure

| File | Responsibility |
|---|---|
| `knip.json` | Honest package-specific Knip project and entry model. |
| `package.json` | Native Knip and dependency-cruiser commands. |
| `.github/workflows/ci.yml` | Direct CI invocation of native Knip and dependency-cruiser gates. |
| `.dependency-cruiser.host-production.cjs` | Host production graph rules only. |
| `tools/check-host-production-import-boundary.mjs` | Reduced to owner-specific semantic checks that cannot be expressed as a generic graph rule, or replaced by focused domain checks. |
| `tools/*.test.mjs` | Focused equivalence and negative-fixture proof for each retained or migrated Host check. |
| `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj` | Pinned ArchUnitNET package references. |
| `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ArchitectureTests.cs` | One Core-does-not-depend-on-Mod architecture rule. |
| `design/architecture/architecture-governance-and-anti-erosion.md` | Approved current policy (already updated before implementation). |

---

### Task 1: Replace Knip governance state with native, evidence-backed configuration

**Files:**
- Modify: `knip.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Delete: `tools/run-knip-reports.mjs`
- Delete: `tools/knip-finding-ledger.json`
- Delete: `tools/knip-config.test.mjs`

**Interfaces:**
- Consumes: package scripts, CI workflows, package `bin`/`exports`, Host child-process launch sites, and production artifact configuration.
- Produces: `pnpm check:knip`, which runs native workspace and production Knip commands with standard exit codes.

- [ ] **Step 1: Inventory every existing Knip entry before modifying it**

For each entry, record its consumer in the task evidence: package script, workflow, package manifest, child-process launch, or external artifact. Mark entries backed only by another Knip entry as unsupported.

- [ ] **Step 2: Write an initial failing native gate test through the actual commands**

Run:

```bash
pnpm exec knip --config knip.json
pnpm exec knip --config knip.json --production
```

Expected: existing configuration may report findings; capture them outside the repository as the starting candidate inventory.

- [ ] **Step 3: Delete governance state and broad configuration**

Remove ledger/disposition/runner files and their CI invocations. Replace `tools/*.mjs`, `src/**/*.mjs`, `scripts/*.mjs`, `tests/**/*.mjs`, scenarios, implementation roots, and test-support roots with only individually evidenced roots. Retain normal generated/build/test output ignores only.

- [ ] **Step 4: Make the native commands the only Knip interface**

Add scripts equivalent to:

```json
{
  "knip": "knip --config knip.json",
  "knip:production": "knip --config knip.json --production",
  "check:knip": "pnpm knip && pnpm knip:production"
}
```

Make CI run `pnpm check:knip`; remove custom report artifact upload and runner arguments.

- [ ] **Step 5: Resolve every exposed finding honestly**

For each finding: establish its static consumer, add one evidenced root only when the consumer is a true independent root, narrow/re-export through the real boundary, or delete it after non-static consumer review proves it orphaned. Do not suppress a finding.

- [ ] **Step 6: Verify the native gate**

Run:

```bash
pnpm check:knip
pnpm format:check
pnpm lint
```

Expected: all commands exit `0`; neither Knip report contains issues.

- [ ] **Step 7: Commit**

```bash
git add knip.json package.json pnpm-lock.yaml .github/workflows/ci.yml tools
git commit -m "ci: simplify Knip reachability gate"
```

### Task 2: Add dependency-cruiser for Host production graph rules

**Files:**
- Create: `.dependency-cruiser.host-production.cjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tools/check-host-production-import-boundary.mjs`
- Modify: `tools/check-host-production-import-boundary.test.mjs`
- Create or modify: focused domain tests for migrated semantic checks

**Interfaces:**
- Consumes: `host/tsconfig.production.json`, actual Host production roots, and named owner obligations from the current architecture document.
- Produces: `pnpm check:host-module-graph`, a dependency-cruiser command that fails on generic production cycles or named forbidden module edges.

- [ ] **Step 1: Add a failing dependency-cruiser rule test for a generic cycle**

Create a temporary or fixture graph inside the existing checker test strategy with `a.ts -> b.ts -> a.ts`. Invoke dependency-cruiser with the Host production configuration and assert a `no-circular` violation.

- [ ] **Step 2: Add the pinned dependency and explicit configuration**

Install `dependency-cruiser@17.3.2`. Configure one Host production graph rooted in real Host production roots and `host/tsconfig.production.json`. Exclude test-only paths from this production graph by root selection, not broad ignore.

- [ ] **Step 3: Migrate only graph-expressible rules**

Move each rule only if it is expressible as a dependency-cruiser forbidden edge/cycle and has a matching positive and negative fixture. Keep computed dynamic import, runtime/type-only distinction, exact bridge/export shape, artifact closure, and legacy-authority semantics outside dependency-cruiser.

- [ ] **Step 4: Split retained semantic checks by owner**

For each retained obligation, give its check a domain-owned name and focused test. Remove the generic parser/checker implementation only for behavior now proved by dependency-cruiser.

- [ ] **Step 5: Verify graph and semantic gates**

Run:

```bash
pnpm check:host-module-graph
pnpm check:host-production-import-boundary
node --test tools/check-host-production-import-boundary.test.mjs
```

Expected: all commands exit `0`; negative fixtures demonstrate failures in the owning checker/tool.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .dependency-cruiser.host-production.cjs .github/workflows/ci.yml tools
git commit -m "ci: add Host module graph gate"
```

### Task 3: Add one ArchUnitNET Core/Mod seam rule

**Files:**
- Modify: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ArchitectureTests.cs`

**Interfaces:**
- Consumes: compiled `GameBuddy.Stardew.Core` and `GameBuddy.Stardew` assemblies.
- Produces: an xUnit assertion that Core types never depend on Mod assembly types.

- [ ] **Step 1: Add a failing architecture test**

Add matching `ArchUnitNET` and `ArchUnitNET.xUnit` `0.13.3` package references. Load both assemblies using real marker types:

```csharp
new ArchLoader()
    .LoadAssemblies(
        typeof(GameBuddy.Stardew.Core.Policy.FarmhandActionCatalog).Assembly,
        typeof(GameBuddy.Stardew.ModEntry).Assembly)
    .Build();
```

Write a rule that selects all `GameBuddy.Stardew.Core` types and forbids dependency on types in `GameBuddy.Stardew` outside the Core namespace.

- [ ] **Step 2: Verify package restore and rule compilation**

Run:

```bash
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter FullyQualifiedName~ArchitectureTests
```

Expected: test compiles and passes against the existing one-way Core → Mod reference topology.

- [ ] **Step 3: Add a negative proof fixture if ArchUnitNET supports it without production changes**

Use an isolated test assembly/fixture only if it can prove rule failure without adding a reverse production dependency. Otherwise document the existing assembly reference direction and retain the focused positive rule.

- [ ] **Step 4: Run Stardew deterministic gates**

```bash
pnpm test:stardew:core
pnpm test:stardew:integration
```

Expected: both exit `0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/stardew/tests/GameBuddy.Stardew.Core.Tests
git commit -m "test: guard Stardew Core dependency direction"
```

### Task 4: Final integration and independent review

**Files:**
- Modify: only files required by failed gates from Tasks 1–3.
- Modify: `design/architecture/architecture-governance-and-anti-erosion.md` only if final tool evidence changes an approved claim.

- [ ] **Step 1: Run final quality sequence**

```bash
pnpm check:knip
pnpm check:host-module-graph
pnpm check:host-production-import-boundary
pnpm typecheck
pnpm test:stardew:core
pnpm test:stardew:integration
pnpm test
```

Expected: every command exits `0`; if a platform/resource limitation prevents a suite, run its independently invocable batches and record the limitation rather than claiming CI green.

- [ ] **Step 2: Inspect the final diff for prohibited mechanisms**

Verify there are no Knip baselines, broad source entries, production source ignores, ledger/disposition files, `--fix`, `--no-exit-code`, or newly introduced custom generic graph scanners.

- [ ] **Step 3: Fresh review**

Assign a read-only reviewer to inspect the actual diff, native Knip commands, dependency-cruiser config/rules, ArchUnitNET test, and evidence. The reviewer must distinguish unverified platform gates from passing gates.

- [ ] **Step 4: Commit and publish only after all required gates pass**

```bash
git add -A
git commit -m "ci: govern reachability and module boundaries"
git push origin chore/architecture-governance
```

## Self-Review

- **Spec coverage:** Task 1 implements approved A; Task 2 implements corrected B without deleting non-graph safety semantics; Task 3 implements C; Task 4 enforces the approved validation and review boundary.
- **Placeholder scan:** No task delegates a generic “write tests” action; every task specifies files, commands, and intended behavior.
- **Type consistency:** dependency-cruiser uses the Host production tsconfig; ArchUnitNET uses real Core and Mod marker types; no new application interfaces are introduced.
