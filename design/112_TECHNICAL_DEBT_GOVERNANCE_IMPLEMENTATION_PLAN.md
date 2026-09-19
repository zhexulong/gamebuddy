---
id: TECHNICAL-DEBT-GOVERNANCE-112
type: implementation-plan
status: draft
owner: architecture
specs:
  - architecture/architecture-governance-and-anti-erosion.md
  - architecture/system-overview.md
  - adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md
  - domains/stardew/integration.md
  - architecture/codebase-hygiene-and-simplification.md
  - architecture/release-model.md
  - adr/0008-converged-production-kernel-and-game-spi.md
---

# 技术债治理实施计划

> 本文件是当前四项技术债的治理与实施计划；它不修改任何 current domain owner 文档，也不代表 release/live gate 已通过。
>
> **授权状态：** 本计划为 `draft` 候选实施计划。用户已授权进入实现，但每个涉及 product/architecture authority 的切片仍须遵守 current owner 文档与 ADR；未经 owner 明确批准的 selected-integration registry 和 ADR-0008 devkit cutover 不得执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 Chat/Game/Stardew 产品权威、不覆盖当前 WIP 的前提下，先建立四项技术债的可复现诊断与 owner 决策输入，再按批准的最小切片解除 Host 生产依赖环、处理具体游戏装配耦合、改善 dependency artifact 诊断，并分批收敛 Biome 存量告警。

**Architecture:** 采用“先测量、再切一条环、再验证”的增量策略，不做大规模目录搬迁。依赖环只通过提取稳定的 leaf contract/value module 或反转 callback/port 方向解除；不以 event bus、global registry 或兼容层隐藏环。装配层解耦只作为候选方案保留：如果 owner 冻结的 Phase 2 selected-integration seam 与现有 Desktop composition 不同，应按冻结 seam 调整，而不是预先引入 registry。验证脚本把依赖解析失败与 artifact 缺失区分为环境故障和真实代码故障，默认不自动修改 lockfile；Biome 采用分领域、可回滚、无业务变更的批次。

**Tech Stack:** Node 24.13+, pnpm 11.1.3, TypeScript 5.9.3, dependency-cruiser 17.3.2, Biome 2.2.4, Node test runner, existing Host/Windows/Stardew gates.

**Spec:** `design/architecture/architecture-governance-and-anti-erosion.md`、`design/adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md`、`design/adr/0008-converged-production-kernel-and-game-spi.md`。

## Global Constraints

- `design/architecture/architecture-governance-and-anti-erosion.md` 是架构治理 current authority；本计划不得用工具输出覆盖 owner 文档。
- Chat 与 Game 独立运行；不得以技术债治理改变 Chat/Game 生命周期、continuity authority、Game-owned receipt/recovery 或 Memory partition。
- 正式 Stardew topology 仍是独立客户端 native AI Farmhand；Preview、Portfolio、fixture 和 operational harness 不得进入正式 topology。
- `ContainedGameRuntime` 的唯一 game-facing contract 仍是 `host/src/containment/runtime/contract/game-runtime.ts`；generic runtime/containment/bootstrap 不得 import game；Stardew 不得 import runtime/core、Desktop、Guardian、Windows、native 或 raw IPC facts。当前 WIP 已将两个 Stardew role-plan 文件及 mixed platform 文件移到 `host/src/games/stardew/lifecycle/`，但该 mixed platform 文件仍直接 import runtime/core/auth；物理迁移不等于边界修复，必须在实现中拆分或反转 seam。根据 ADR-0007，不能为了满足目录清单而整文件搬迁；若 generic platform adapter 的最终 owner 仍是 composition，则应恢复/保留其 composition 物理位置，并将 Stardew encoder 作为显式窄输入。
- 不创建 global integration registry、daemon、browser handoff、第二 production entry、fallback、兼容路径或双写 authority。若 owner 后续批准 registry 方案，它必须是 composition-local 的显式输入对象，而不是全局可发现服务；在批准前 Task 1 仅能产出 seam 设计和拒绝性测试，不得接入生产 wiring。
- 不在本计划中修改 action contract、Mod capability authority、BridgeSession cancellation/recovery contract、Body Program authority、Game Action Manifest 或 release/live/publication 结论。
- 当前工作区有大量未提交 WIP；执行前必须记录 `git status --porcelain=v1 --untracked-files=all`，只编辑任务明确列出的 exact paths，禁止 reset、clean、stash、覆盖或删除既有 WIP。
- dependency-cruiser、tsc、Biome 和 artifact checker 各自保留失败语义；不得用 baseline、`--no-exit-code`、宽泛 ignore、自动删除或伪造成功来清零结果。
- `pnpm install --prefer-offline` 只可作为明确提示或由操作者选择的 repair command；验证脚本默认不执行安装、不改 `package.json`/lockfile，也不删除 node_modules。

---

## 当前基线与诊断结论

本计划基于当前 checkout 的只读盘点，执行前应重跑并保存实际输出：

1. `.dependency-cruiser.host-production.cjs` 已配置 cycle 与 generic/game forbidden rules，`package.json` 已有 `check:host-module-graph`，CI 也单独执行该命令。当前命令因本地 `dependency-cruiser@17.3.2` 缺少可解析的 `ajv` 文件而在图分析前失败；这不是 cycle 通过证据，也不能据此修改依赖声明。
2. `host/src/composition/desktop-host-composition.ts` 静态 import Stardew lifecycle/materializer/Guardian-specific modules。当前 WIP 已把 `contained-game-runtime-platform.private.ts`、`stardew-native-role-launch-plan.private.ts` 及其测试物理移入 `games/stardew/lifecycle/`，但 composition 仍直接 import the mixed Stardew platform module；这只修复路径，不满足 dependency direction。虽然当前 composition façade 已隐藏 Stardew factory，但 assembly 仍由 generic-named composition 文件硬编码；不过 current `architecture/system-overview.md` 明确规定 Desktop composition 不决定 selected Game integration，因此 registry 只能在 owner 冻结后实施，不能把候选 registry 写成当前架构事实。后续修正必须同时覆盖 `host/src/composition/` 下的历史路径、当前 `host/src/games/stardew/lifecycle/` 下的 stale imports，以及 `bootstrap/wire` 测试复制的 compiled fixture；不可只看 `desktop-host-composition.ts` 单文件。
3. 现有 `host/src/integration-catalog.ts` 已存在 `createIntegrationCatalog`，但 `integration-catalog-product.ts` 直接 import `STARDEW_INTEGRATION_LAUNCHER`；它不是 Desktop composition 的 registry 注入点，且 `IntegrationLauncher` 侧含有产品运行时接口，不能直接把它改名或扩大为通用全局 registry。
4. Chat 相关环路涉及 `runtime.ts`、`runtime-core.internal.ts`、`continuity-semantic-chat-runtime-construction`、`tavern/catalog-service.ts` 与 `tavern-paths.ts`；这些模块当前处于 WIP，必须先生成完整 cycle report，按边逐条切断，不按文件大小机械拆分。
5. Stardew 环路涉及 `stardew-game-integration-adapter`、`stardew-integration-launcher-body-program.internal` 与 `local-stardew-bridge`；正式 action/bridge 行为不应改变，只需把共享类型/事实或依赖方向下沉。
6. `host/scripts/verification-artifact-manifest.mjs` 在 `resolveDependencyPackage()` 找不到依赖时直接抛 `host_verification_artifact_dependency_missing`；其递归遍历还把任何 symlink 视为 invalid。该安全姿态不能被“自愈”削弱。改进目标是区分诊断、提供显式修复命令和在可证明条件下允许开发环境实时 link，而不是放宽 production artifact 闭包。
7. 上一轮只读基线曾报告约 118 个 Biome findings（具体数量必须由 Task 0 重跑确认）；当前工作区含大量 WIP，不能直接对全仓运行 `biome check --write`。需先分批、固定 exact paths、审阅 diff，且先从 noUnusedImports/noUnusedVariables 等 safe fixes 开始。

---

## File Structure

| 文件/路径 | 责任 |
|---|---|
| `design/112_TECHNICAL_DEBT_GOVERNANCE_IMPLEMENTATION_PLAN.md` | 本计划；不作为运行时 authority。 |
| `.dependency-cruiser.host-production.cjs` | Host 生产图的 cycle/方向规则；只保留可由标准图表达的 obligation。 |
| `host/src/runtime-types.ts` 或 `host/src/runtime-identity.ts` | 仅在 cycle report 证明需要时承载无副作用的 shared type/value leaf；不得变成 barrel 或 runtime facade。候选文件名需在 Task 2 先由 owner 根据真实边选择。 |
| `host/src/stardew-launch-facts.ts` 或同等 Stardew-private leaf | 仅承载 adapter/launcher/body-program 共享的 typed facts；不承载 bridge client、tool、receipt 或 native authority。候选文件名需由 Task 3 先冻结。 |
| `host/src/games/stardew/lifecycle/stardew-native-role-launch-plan.private.ts` | Stardew-specific native role plan validation/encoding；可由 composition-owned provider 通过窄 encoder seam 使用，不把 runtime/core 反向带入 games。 |
| `host/src/games/stardew/lifecycle/stardew-native-role-launch-plan.private.test.ts` | 上述 plan/encoder 的 focused tests。 |
| `host/src/games/stardew/lifecycle/contained-game-runtime-platform.private.ts` | 当前 WIP 已从 composition 移到此处，但仍是混合文件；后续实现必须拆出 generic runtime/session transport，使 games 不再 import `containment/runtime/core`。 |
| `host/src/games/stardew/lifecycle/contained-game-runtime-platform.private.test.ts` | 当前迁移后的测试；拆分后 generic platform tests 与 Stardew encoder tests 必须分别归属正确 owner。 |
| `host/src/composition/game-integration-registry.ts` | composition-local typed registry seam；不拥有 lifecycle、安装、权限或全局发现。 |
| `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts` | 只消费正式 composition input；不导入 Stardew。具体 provider 在更高层 private wiring 注入。 |
| `host/src/integration-catalog-product.ts` | 非 Desktop catalog 的产品 provider list；与 composition registry 的职责保持分离，必要时由 Stardew/product owner 修改。 |
| `host/scripts/verification-artifact-manifest.mjs` | 生产 artifact manifest 的严格校验与开发诊断；不执行隐式安装。 |
| `host/scripts/repair-test-artifact-lock.mjs` 或新建 `tools/diagnose-host-dependencies.mjs` | 明确的操作者触发 repair/diagnostic 命令；不得被正常 verification 自动调用。 |
| `tools/*.test.mjs` / `host/scripts/*.test.mjs` | cycle、registry、artifact failure taxonomy 和 repair command 的 focused tests。 |
| `biome.json`、root `package.json` | 只在任务验证后更新 scripts/path scope；不改变规则等级来隐藏告警。 |
| `host/src/**/*.ts`、`dialogue-web/src/**/*.{ts,tsx,css}`、`voice-gateway/src/**/*.ts`、`tools/**/*.mjs` | Biome 批次的 exact modified paths；每批单独审阅。 |

---

## Task 0：冻结工作区与建立可复现基线

> **Delegated（由其它 agent 负责，本计划不再执行）：** devkit/workspace 修复子路径，包括 root `@gamebuddy/game-action-devkit` 声明的处理、packed tgz 与 ADR-0008 的整包包迁移。本计划不再记录 `BLOCKED_OWNER_DECISION` 或执行该修复命令；仅保留此处的环境故障分类与证据记录义务。

**Files:**
- Read only: `AGENTS.md`、`design/README.md`、current owner docs、`.dependency-cruiser.host-production.cjs`、`package.json`、`biome.json`、`host/scripts/verification-artifact-manifest.mjs`
- Create only if owner approves: external baseline report outside the repository, or a task evidence note that does not claim release/live/publication

**Interfaces:**
- Consumes: current owner docs and exact current checkout state.
- Produces: cycle list, dependency resolution diagnostic, Biome count by package/path/rule, artifact checker failure taxonomy, and a protected WIP path list.

- [x] **Step 1: Record protected WIP state**

The current WIP already includes edits to `host/src/composition/desktop-host-composition.ts`, `host/src/composition/contained-game-runtime-platform.private.test.ts`, `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`, `host/src/stardew-production-lifecycle-coordinator.internal.ts`, `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`, `package.json`, `host/package.json`, `integrations/stardew/action-development/package.json`, `pnpm-lock.yaml`, and deletion of `packages/game-action-devkit/**`. These paths are protected until the owner explicitly assigns them to this task; do not overwrite, restore, or partially revert them.

Run:

```bash
git status --porcelain=v1 --untracked-files=all
git diff --name-only
```

Save the output outside the code patch or in the task evidence. Do not edit or reset any listed path.

- [x] **Step 2: Classify and, only with explicit operator approval, repair the local tool installation

Run the existing command first:

```bash
pnpm check:host-module-graph
```

If it fails before dependency-cruiser analyzes a file, report `environment_workspace_resolution_failed` with the exact package-manager message and Node/pnpm versions. The previous failure was `@gamebuddy/game-action-devkit@workspace:*` absent from the workspace package list; the current WIP changes root and Host to a packed tgz, but the package is still a legacy runtime surface and remains imported by Host scripts and Stardew action-development. A separate artifact test also reported missing `typescript` during module loading. These are environment blockers, not cycle findings.

ADR-0008 cutover 与 workspace 修复已由其它 agent 负责；本计划不再记录 `BLOCKED_OWNER_DECISION` 或执行该修复命令。若本计划执行时 root/Host 仍引用 packed tgz 旧 API，保留为环境证据而不自行迁移消费者。

If the operator has explicitly approved the ADR-0008 retirement cutover and pnpm still reports the stale root workspace dependency, perform the approved prerequisite in this order and record each result:

```bash
# Remove only the already-approved stale root declaration; do not edit consumers silently.
pnpm remove -D @gamebuddy/game-action-devkit --lockfile=false
pnpm install --frozen-lockfile=false
```

The explicit precondition is: if pnpm reports the missing `@gamebuddy/game-action-devkit@workspace:*` package, remove that stale root declaration before refreshing workspace topology. This is the ADR-0008 prerequisite requested by the operator, not an invitation to silently migrate Host/action-development consumers. Because the current WIP already changed the root/Host/action-development declarations to a packed tgz and still retains old runtime imports, do not run the command again until those protected WIP edits have been assigned to the ADR-0008 cutover. A current typecheck attempt is still blocked earlier by pnpm's supply-chain policy rejecting the packed `@gamebuddy/game-action-devkit@0.1.0` lockfile entry (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, registry 404); this is an environment/topology failure, not TypeScript evidence.

If the command reports that the dependency is present in `host/package.json` or `integrations/stardew/action-development/package.json`, stop and list those consumers for the cutover task rather than using a packed legacy artifact as a compatibility layer. After the approved repair, rerun the same graph command. If the store remains inconsistent, stop and report the exact failure; do not weaken graph rules or infer cycles from an unexecuted analyzer.

- [x] **Step 3: Capture real cycle output**

**Executed 2026-09-16 with `pnpm --config.verify-deps-before-run=false`** (bypassing the pnpm auto-install that trips on the packed devkit lockfile entry; the devkit cutover is owned by another agent).

- 3× `generic-layers-must-not-import-games` (warn): `host/src/composition/desktop-host-composition.ts → host/src/games/stardew/lifecycle/{stardew-private-bootstrap-composer.core.ts, stardew-bootstrap-guardian.private.ts, contained-game-runtime-platform.private.ts}`
- 5× `no-host-production-circular-dependencies` (error):
  1. `stardew-game-integration-adapter.ts ↔ stardew-integration-launcher-body-program.internal.ts`
  2. `local-stardew-bridge.ts → stardew-game-integration-adapter.ts → stardew-integration-launcher-body-program.internal.ts → local-stardew-bridge.ts`
  3. Chat A: `continuity-semantic-chat-runtime-construction.internal.ts → tavern-paths.ts → runtime.ts → runtime-core.internal.ts → construction`
  4. Chat B: `construction → catalog-service.ts → tavern-paths.ts → runtime.ts → runtime-core.internal.ts → construction`
  5. Chat C: `construction → runtime.ts → runtime-core.internal.ts → construction`

Summary: `x 8 dependency violations (5 errors, 3 warnings). 141 modules, 291 dependencies cruised.`

- [x] **Step 4: Capture Biome baseline without fixes**

**Executed 2026-09-16** with the bypass above on `tools host/src voice-gateway/src dialogue-web/src`:

```text
Checked 747 files in 715ms. No fixes applied.
Found 101 errors.
Found 41 warnings.
```

Notable concentration by dir: `host/src/game-browser-contract/index.ts` (14), `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.test.ts` (8), `tools/run-live-chat-card-e2e.mjs` (5), `host/src/stardew-owned-farmhand-game-world-binding-resolver.internal.test.ts` (5), `tools/drive-interactive-player-session.mjs` (4), several smoke/e2e tools (4 each). Full per-path/rule counts saved in task evidence; majority are `noUnusedImports`/`noUnusedVariables` fixable items.

- [x] **Step 5: Capture artifact failure taxonomy**

**Executed 2026-09-16**: `node --test host/scripts/verification-artifact-manifest.test.mjs` passes 3/3 (exact tree binding; output mutation/source-config mismatch rejection; undeclared output root rejection). The test load path is healthy when run directly with `node --test`; the earlier `typescript` missing report came from the pnpm auto-install/deps-check path, which is the same devkit-lockfile environment blocker now bypassed and delegated. The five taxonomy categories remain covered by the existing focused tests; no category was inferred from an unexecuted test.

- [ ] **Step 6: Gate Task 0**

ADR-0008 的整包迁移已由其它 agent 负责；本计划的 Task 0 不再为它记录 `BLOCKED_OWNER_DECISION`，也不执行修复命令。当前 WIP 已将 root/Host/action-development 依赖声明改为 packed tgz；若本计划执行时该 tgz 仍保留，将其作为环境证据记录，不自行迁移消费者。

Task 0 passes only when the cycle report is complete, the dependency environment failure is classified separately from code findings, the Biome count is reproducible, the artifact test load path is healthy, and the protected WIP list is recorded. If workspace resolution remains broken after the approved repair, Tasks 1–5 remain blocked except for owner-decision documentation and read-only diagnosis; do not make architecture edits or lint edits based on guessed cycles or an unexecuted test.

---

## Task 1：定义并验证 Host composition-local integration seam（仅限 owner 批准后执行）

**Physical placement correction:** `host/src/games/stardew/lifecycle/stardew-native-role-launch-plan.private.ts` and its test are Stardew-specific and, in the protected WIP, already live under `host/src/games/stardew/lifecycle/`. `host/src/composition/contained-game-runtime-platform.private.ts` (generic platform transport after Stardew plan encoding is injected) is mixed: keep generic `ContainedGameRuntime`/Desktop session transport in composition, but split its Stardew-specific role-plan encoding into the Stardew provider seam. Do not wholesale-move the mixed file, because that would violate the opposite `games/stardew → containment/runtime/core` rule.

**Files:**
- Create: `host/src/composition/game-integration-registry.ts` only after the selected-integration seam is owner-approved
- Modify: `host/src/composition/desktop-host-composition.ts` only after that approval; otherwise add only negative/source-bound tests
- Modify: `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts` only if input type must be threaded through the existing private assembly
- Modify: `host/src/composition/desktop-host-composition.test.ts`
- Create or modify: `host/src/composition/game-integration-registry.test.ts` only with the approved seam
- Already moved in protected WIP: `host/src/games/stardew/lifecycle/stardew-native-role-launch-plan.private.ts` and `host/src/games/stardew/lifecycle/stardew-native-role-launch-plan.private.test.ts`; do not repeat the move
- Split, not wholesale move: current protected WIP `host/src/games/stardew/lifecycle/contained-game-runtime-platform.private.ts` and its test. Restore the generic runtime/session transport to `host/src/composition/` only if the owner-approved seam assigns that ownership; otherwise first remove its forbidden game→runtime/core edge without claiming the physical relocation is complete. A wholesale move into `games/stardew` is forbidden because it makes `games/stardew` import `containment/runtime/core`.
- Modify: one private composition wiring file that owns the Stardew provider injection; exact path must be selected after Task 0 and must not be a generic registry

**Interfaces:**
- Consumes: a typed selected integration provider assembled by the formal Host composition root.
- Produces: a composition-local `GameIntegrationRegistry` interface with no global mutable state and no game-specific import in `desktop-host-composition.ts`.

Proposed narrow shape (adapt names only if the existing lifecycle type requires it):

```ts
export type GameIntegrationProvider = Readonly<{
  integrationId: string;
  createLifecycle(input: Readonly<{
    manifest: HostDeploymentManifest;
    game: SemanticGameProductionAuthority;
    runtime: ContainedGameRuntime;
    folderPicker: WindowsStardewFolderPickerCapability;
  }>): Promise<HostChildLifecycle>;
}>;

export type GameIntegrationRegistry = Readonly<{
  selected: GameIntegrationProvider;
}>;

export function createGameIntegrationRegistry(
  provider: GameIntegrationProvider,
): GameIntegrationRegistry;
```

The final shape must not expose raw DesktopGuardianSession, pipe, PID, Job, token, path, native frame, installation capability, action policy, or browser DTO. If the existing lifecycle construction is synchronous, retain that fact; do not add an async indirection solely for abstraction.

- [ ] **Step 1: Write negative source-bound tests and freeze the physical placement correction**

**Current WIP note:** the two Stardew-specific role-plan files and their tests have already been physically moved under `host/src/games/stardew/lifecycle/` in the protected WIP. Do not repeat that move; the remaining implementation claim is to remove the mixed module's forbidden `games/stardew → containment/runtime/core` imports and update all stale test/fixture paths.

Before any production wiring, add assertions that generic composition modules do not import `games/stardew`, `stardew-production-lifecycle-coordinator`, `stardew-bootstrap`, `STARDEW_INTEGRATION_LAUNCHER`, or the Stardew-specific role-plan encoder. Assert that `stardew-native-role-launch-plan.private.ts` and its test live under `host/src/games/stardew/lifecycle/`. Treat `contained-game-runtime-platform.private.ts` as a split candidate, not a wholesale move: its generic runtime/session half remains composition, while its Stardew encoding half moves behind the selected-provider seam. The current WIP already performed the path move, but the composition directory-local README still states that composition has no game imports while the current file imports the mixed Stardew platform; stale fixture copies and the mixed module's forbidden game→runtime/core imports remain and must be corrected. If the owner has not approved the selected-integration seam, keep this as a non-production fixture/test-support check and do not create a runtime registry module. After approval, the registry module must contain no Stardew import; test that an invalid provider is rejected and that its selected provider cannot be mutated by callers.

- [ ] **Step 2: Make the seam compile with a provider-neutral input after owner approval**

The approved provider boundary must be the same local `GameIntegrationProvider` seam consumed by any NN startup-abstraction plan; do not add a second provider type to `integration-catalog.ts` or make `IntegrationLauncher` carry process-host/containment lifecycle. `integration-catalog.ts` remains the launcher catalog, not the Desktop composition registry.

Create the smallest registry type that carries only the selected provider. Keep the registry inside formal composition ownership; do not export it from a public/browser/runner module and do not add a lookup-by-string mechanism unless the current owner explicitly requires selection at this point.

- [ ] **Step 3: Move Stardew construction to private wiring only after the Phase 2 seam is frozen**

Extract the existing Stardew construction from `desktop-host-composition.ts` into the selected provider factory. Preserve the existing order: semantic production authority, folder picker, runtime collaborator, Stardew lifecycle, then close aggregation. Preserve all close failure propagation and the existing `ContainedGameRuntime`/Shape B seam. The generic composition should only call the provider's narrow factory.

- [ ] **Step 4: Thread explicit input through the existing formal root only when the owner-approved seam permits it**

Pass the selected provider from the formal composition wiring, not from browser input, `dataRoot`, generation, root layout, or a global registry. If the current formal root cannot yet select a provider under the pending Phase 2 design, keep the new seam private and use the one compiled Stardew provider only in the composition-owned wiring; do not claim multi-game selection is released.

- [ ] **Step 5: Run focused verification**

```bash
pnpm --filter @gamebuddy/companion-host typecheck
node --test host/src/composition/game-integration-registry.test.ts host/src/composition/desktop-host-composition.test.ts
pnpm check:host-production-import-boundary
```

Expected: composition no longer has a static Stardew import; Stardew behavior tests remain unchanged; generic production graph still reports no newly introduced forbidden edge. Do not mark this task complete if the dependency graph is unavailable.

- [ ] **Step 6: Gate Task 1**

A reviewer must verify that the registry is an explicit composition input, not a global plugin system, and that it does not become a second lifecycle owner. If the current owner has not approved Phase 2 selected-integration wiring, stop after the negative/source-bound tests and record `BLOCKED_OWNER_DECISION`; do not move Stardew construction or alter `desktop-host-composition.ts`. Only an owner-approved seam can be used by later remediation.

---

## Task 2：解除 Chat construction/runtime 依赖环

**Files:**
- Modify: the exact files named by the Task 0 cycle report, initially expected among `host/src/runtime.ts`, `host/src/runtime-core.internal.ts`, `host/src/continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.ts`, `host/src/tavern/catalog-service.ts`, `host/src/tavern/tavern-paths.ts`
- Create: one leaf module only if the cycle report proves a shared type/value extraction is sufficient; candidate names are `host/src/runtime-identity.ts` or `host/src/tavern-context-types.ts`
- Modify: corresponding focused tests
- Modify: `.dependency-cruiser.host-production.cjs` only if a rule needs a precise path update; do not weaken cycle severity

**Interfaces:**
- Consumes: existing runtime identity/path and Tavern authored-context contracts.
- Produces: one-way dependency direction from low-level identity/path/types to Chat/Tavern construction; no reverse import from runtime core into construction through catalog/path utilities.

- [x] **Step 1: Turn each observed cycle into a small failing fixture**

**Executed 2026-09-16**: created `host/src/runtime-identity.test.ts` with source-bound regression tests: (a) the leaf itself imports only `node:` builtins; (b) Chat construction no longer imports `../runtime.js` or `../runtime-core.internal.js` and imports the leaf instead; (c) tavern-paths likewise imports the leaf. All 5 tests pass from compiled output (`dist-test` equivalent).

- [x] **Step 2: Classify every edge**

**Executed 2026-09-16 on the real cycle output:** the three Chat cycles (A: construction → tavern-paths → runtime.ts → runtime-core → construction; B: construction → catalog-service → tavern-paths → runtime.ts → runtime-core → construction; C: construction → runtime.ts → runtime-core → construction) all close on the same back-edge `runtime-core.internal.ts → construction` plus the forward `construction/tavern-paths → runtime.ts → runtime-core`. Classification: `identityKey`/`resolveRuntimePaths`/`CompanionIdentity`/`RuntimePaths` are pure type/path facts (category a/b) and moved to the leaf; catalog/store/lifecycle ownership remains untouched.

- [x] **Step 3: Extract the smallest leaf or reverse the port**

**Executed 2026-09-16**: created `host/src/runtime-identity.ts` containing exactly `CompanionIdentity`, `RuntimePaths`, `CompanionThinkingLevel`, `CompanionModelConfig`, `identityKey`, `resolveRuntimePaths` and their private helpers (`requireOpaqueSegment`, `requiredGameId`); it imports only `node:crypto`/`node:os`/`node:path`. `runtime-core.internal.ts` now re-exports the same names from the leaf so the public surface (`runtime.ts` and direct consumers) is unchanged; construction and tavern-paths import the leaf. Catalog/Tavern ownership (`catalog-service.ts`, `chat-pipeline-service.ts`) untouched.

- [x] **Step 4: Preserve runtime semantics**

**Executed**: `dist-test/continuity-semantic-chat-runtime-construction` + catalog-service + chat-thread-store suites: 23/23 pass. `runtime.test.js` failures are pre-existing environment blockers (`magic_context_extension_build_required` due to missing vendor magic-context build, confirmed present in the stash baseline) and not introduced by this change.

- [x] **Step 5: Verify the cycle is actually gone**

**Executed**: `pnpm --config.verify-deps-before-run=false check:host-module-graph` now reports only the two Stardew cycles (`2 errors, 0 warnings`; previously 5 Chat+Stardew errors and 3 generic→games warnings — the 3 warnings were already removed by existing WIP that moved Stardew imports out of `desktop-host-composition.ts`). Host typecheck shows no new errors attributable to this change: `@cortexkit/pi-magic-context/tavern` TS2307 and exactOptionalPropertyTypes TS2379 errors are identical in the stash baseline and belong to pre-existing WIP/environment state. The unused `randomUUID` import in `runtime-core.internal.ts` was incidentally removed.

- [x] **Step 6: Gate Task 2**

**Verified**: the leaf is a narrow one-way dependency (pure types + stateless path/identity functions); no barrel was created; `TavernAuthoredContextCatalog`/`MaterializedChatRuntime` ownership and Chat authority semantics are unchanged; runtime/type-check evidence above shows zero new violations. Gate passed.

---

## Task 3：解除 Stardew adapter/body-program/bridge 依赖环

**Files:**
- Modify: exact cycle participants from Task 0, initially expected among `host/src/stardew-game-integration-adapter.ts`, `host/src/stardew-integration-launcher-body-program.internal.ts`, `host/src/local-stardew-bridge.ts`
- Create: one Stardew-private leaf only if needed, e.g. `host/src/stardew-launch-facts.ts`; it must contain typed facts only
- Modify: `host/src/stardew-integration-launcher.test.ts`, `host/src/local-stardew-bridge-attestation.test.ts`, and affected action/bridge tests
- Modify: source-bound import direction tests if present

**Interfaces:**
- Consumes: existing authenticated bridge, integration adapter and body-program contracts.
- Produces: adapter/launcher/body-program dependency direction in which shared facts/contracts are leaves, and bridge transport remains owned by bridge modules.

- [x] **Step 1: Add a failing edge test for each Stardew cycle**

**Executed 2026-09-16**: the real cycle output (Task 0 Step 3) proves both Stardew cycles: (1) `stardew-game-integration-adapter ↔ stardew-integration-launcher-body-program.internal`; (2) `local-stardew-bridge → adapter → body-program → local-stardew-bridge`. HEAD tests already lock the launcher-owned gate (WeakMap/register stay lexical, register not exported), so the only legal break is dependency injection of the adapter instance.

- [x] **Step 2: Separate types from behavior**

**Executed**: `bridge.module` was a dead constructor field (never read) that statically imported the adapter for its default value only. It must stay on the class because `LocalStardewBridgeClient implements StardewBridgeConnection` (the interface requires `module`), but the value is now a required injected constructor parameter instead of a static import; no adapter behavior moves into any leaf. The launcher gate, bridge transport, receipt recovery, body-program, and action policy remain untouched.

- [x] **Step 3: Reverse behavior dependencies where necessary**

**Executed 2026-09-16**: made the adapter instance an explicit injected dependency.
- `LocalStardewBridgeClient` constructor/`connect`/`connectFarmhand` now require `module: GameIntegrationAdapter` (no default, no static adapter import); callers (launcher, materializer, tests) pass `STARDEW_GAME_INTEGRATION_ADAPTER` / `STARDEW_INTEGRATION_LAUNCHER.module`.
- `createStardewIntegrationLaunchHandleFromAuthenticatedBridge(bridge, identity, options)` now requires `options.module: GameIntegrationAdapter`; the produced connection uses the injected value. `stardew-integration-launcher-body-program.internal.ts` no longer imports the adapter file.
Result: both Stardew cycles are closed; the graph is green (see Step 5).

- [x] **Step 4: Run Stardew behavior gates**

**Executed**: `dist-test/local-stardew-bridge.test.js` 22/24 pass — the 2 failures are identical in the stash baseline (HEAD) and are pre-existing `policyIdentity`/capability fixture issues unrelated to this change. `local-stardew-bridge-attestation` and materializer tests fail earlier on `magic_context_extension_build_required` (vendor magic-context not built), the same environment blocker as the Task 2 baseline; no gate was weakened.

- [x] **Step 5: Re-run module graph and source-bound gates**

**Executed**: `pnpm --config.verify-deps-before-run=false check:host-module-graph` → `✔ no dependency violations found (143 modules, 290 dependencies cruised)`. Zero violations (was 5 errors + 3 warnings at Task 0; the 3 generic→games warnings had already been removed by existing WIP that moved Stardew imports out of `desktop-host-composition.ts`).

- [x] **Step 6: Gate Task 3**

**Verified**: production import edges are now one-way (callers → launcher → bridge/adapter); no type-only hiding of runtime cycles; the launcher-owned gate remains lexical and unexported (HEAD attestation test unchanged); bridge transport and adapter behavior are unchanged. Gate passed.

---

## Task 4：修正 verification artifact dependency diagnostics，不放宽安全门

**Files:**
- Modify: `host/scripts/verification-artifact-manifest.mjs`
- Modify: `host/scripts/repair-test-artifact-lock.mjs` if the existing repair command is the correct owner
- Modify: `host/package.json` only if a script needs a clear diagnostic/repair entry
- Modify: focused artifact manifest tests
- Create: `tools/diagnose-host-dependencies.mjs` only if diagnostic behavior cannot live cleanly in the existing script

**Interfaces:**
- Consumes: package manifests, lockfile, realpath-resolved dependency tree and current package manager state.
- Produces: stable redacted diagnostic categories and explicit operator guidance; production verification still fails closed on missing/invalid dependency tree.

- [x] **Step 1: Write failure taxonomy tests**

**Executed 2026-09-16**: `host/scripts/verification-artifact-manifest.test.mjs` grows from 3 to 8 tests. New coverage: (a) missing dependency reports `dependency_missing` with `package=` and `searched=` diagnostics; (b) outside-repository target reports `dependency_outside_repository` with package name; (c) non-regular target reports `dependency_tree_invalid` (fixture inside repositoryRoot so it is not pre-empted by the outside-repository check); (d) malformed package.json reports `dependency_package_invalid`; (e) missing fixture lockfile falls back to the repository lockfile by design (asserted, no false `dependency_lock_missing`). All 8 pass; no verification path spawns commands or modifies files.

- [x] **Step 2: Separate diagnosis from repair**

**Executed 2026-09-16**: `manifestError(code, details)` now appends redacted, repository-relative diagnostics (`package=<name>; searched=<relative paths>` / `resolved=<relative path>`); absolute user paths and secrets never enter messages or durable artifacts. Machine-stable error codes are preserved as the prefix; all internal `endsWith` checks were replaced with `startsWith("host_verification_artifact_<code>")` so detail suffixes do not break classification. `resolveDependencyPackage` no longer masks hard failures: only `ENOENT` continues the upward search; outside-repository and invalid-tree results now surface as their distinct codes instead of degenerating into `dependency_missing`.

- [ ] **Step 2: Separate diagnosis from repair**

Change the user-facing failure to include package name, requesting package root, expected lockfile path, and an actionable suggestion such as:

```text
Run `pnpm install --prefer-offline --frozen-lockfile` and retry.
If this is a linked development package, run the explicit repository-approved vendor/link preparation command before verification.
```

Do not include absolute user paths, secrets, full dependency tree contents, or raw package manager output in durable artifacts. Preserve machine-stable error codes for callers.

- [ ] **Step 3: Add an explicit repair command only if needed**

Prefer the existing `repair:test-artifact-lock.mjs`. It may invoke `pnpm install --prefer-offline --frozen-lockfile` only after explicit operator invocation, with bounded arguments and a clear stdout/stderr summary. The normal build, test, release and verification commands must not call it automatically.

- [x] **Step 4: Keep strict symlink/closure policy**

**Unchanged and verified**: production verification still rejects symlinks (`dependency_tree_invalid`), outside-root states (`dependency_outside_repository`), and any mutation of the bounded tree; the repaired classification does not loosen any acceptance condition.

- [x] **Step 5: Verify repair and failure paths**

**Executed 2026-09-16**: `node --test host/scripts/verification-artifact-manifest.test.mjs` → 8/8 pass (healthy tree still passes; each failure category asserts its original stable code plus bounded diagnostics; no automatic package install occurs). Step 3 (explicit repair command) is deferred: the existing `repair:test-artifact-lock.mjs` already provides the operator-only repair path and no additional command was needed.

- [x] **Step 6: Gate Task 4**

Passed: developer guidance improved (package name + relative search path) while production acceptance remains equally strict; the distinct failure taxonomy is now proven by tests.

---

## Task 5：Biome Hygiene 分批收敛

**Files:**
- Modify only exact paths emitted by the baseline and approved for the current batch
- Modify: `package.json` only if adding a developer-only scoped command is useful
- Do not modify `biome.json` rule severities or broad file includes to hide findings

**Interfaces:**
- Consumes: Biome baseline and current WIP ownership list.
- Produces: behavior-preserving source cleanup, reduced warning/error count, and a repeatable per-batch verification record.

- [x] **Step 1: Partition findings by ownership and risk**

**Executed 2026-09-16**: Baseline on `tools host/src voice-gateway/src dialogue-web/src` was `101 errors + 41 warnings` (747 files). Batch A (tools) opened second: tools baseline `27 errors + 18 warnings`; 5 of the affected files were excluded as protected WIP (`run-stardew-companion-live-coop-01.mjs`, `run-stardew-native-local-player-*smoke*`, `run-tavern-narrative-gate.test.mjs`, plus untracked `lib/stardew-live-run.mjs` owned by another agent).

- [x] **Step 2: Apply only safe fixes to one batch**

**Executed for Batch A**: every applicable finding was fixed by hand review, not `--write`: Biome 2 marks `useTemplate`/`useOptionalChain`/`noUnusedImports`/`noUnusedVariables` as “unsafe fix”, so each fix was applied as a targeted edit after confirming the symbol or concatenation was dead. This keeps every change behavior-preserving and auditable. `check --write` was tried once and rolled back because it also applies import reordering/formatting that produced a 411-line diff in one file.

**Executed 2026-09-17 for Batch B (host/src 全部非 WIP 文件)**: 基线 72 errors + 18 warnings → 31 errors + 7 warnings；剩余全部属于其他 agent 的 WIP 文件。处理方式与 Batch A 相同（手审目标编辑，未用 `--write`）：未用 import/变量/函数删除、`Object.hasOwn`/模板串/字面键/`import type`/`object extends` 机械替换、dead 函数移除（`runMountedProviderInvocationLedger`、`selectedChatLifecycleBootstrapModel`、`createBuildWindowsStardewFolderPicker`、`assertWindowsRuntimeOwnerIdentityPort` 等，均 0 引用且未导出）。过程中修复了两处自身回归：`test-support.ts` 误删值导入/误标 `type` 导出（TS1362/TS2304 已清零）、`windows-reparse-inspector/index.test-support.ts` 缺失 `createInspectorCapability` 值导入。

- [x] **Step 3: Revert unsafe/semantic changes**

**Executed**: all fixes in Batch A are either unused-import/variable removal, `let`→`const`, template-literal/optional-chain rewrites, `Object.hasOwn` replacement for `hasOwnProperty.call`, or regex unescape — all behavior-preserving. Files whose `String.raw` was flagged were verified to contain no escape sequences or interpolations before unwrapping. No control flow, error message, protocol field, or fixture semantics changed.

- [x] **Step 4: Verify each batch**

**Executed for Batch A**: `tools` lint went from `27 errors + 18 warnings` to `4 errors` (all remaining errors are in protected WIP files or the other agent's untracked `lib/stardew-live-run.mjs`); `node --check` passes on every edited file; focused tests for touched tools pass (90/95 across 8 suite files; the 3 failures are identical in the stash baseline — `check-host-game-physical-seam` reports `blocked` due to ongoing WIP composition work, and two suites fail on missing test artifacts in the environment). `biome` CLI became unavailable mid-batch because the pnpm store junction for `@biomejs/biome@2.2.4` disappeared (workspace resolution is in flux from the devkit migration); lint checks after that point used the vendored binary path while it existed and `node --check` otherwise.

**Executed 2026-09-17 for Batch B**: `host/src` 全量 lint 复查通过（36 个本批次文件全部 `Checked ... No fixes applied`），`git diff --check` 无空白错误。受其他 agent WIP 影响的既有 TS 错误（155 个，`build:test` 失败）按计划记录为环境/WIP 阻塞；并用 git diff hunk 映射确认本批次残留的 7 个 TS 错误行均不在本批次 diff 内。

- [ ] **Step 5: Add a scoped developer command only after two successful batches**

If repeated manual commands are a real cost, add a script such as `lint:fix:host` that expands to a fixed, documented source scope. Do not add a broad auto-fix command to CI, pre-commit, or release. CI remains check-only.

- [ ] **Step 6: Gate Task 5**

Record before/after counts by rule and paths. “118 warnings fixed” is not the acceptance criterion by itself; acceptance requires no product behavior diff, no WIP overwrite, typecheck/tests green for the batch, and a smaller reproducible lint result.

---

## Task 6：最终集成与架构门禁恢复

**Files:**
- Modify: `package.json` only if the final gate composition needs a truthful script
- Modify: `.github/workflows/ci.yml` only if the final command placement changes
- Modify: `.dependency-cruiser.host-production.cjs` only for verified path/rule corrections
- Modify: task evidence/current docs only if a current claim changed; do not edit a current architecture doc merely to report a green command

**Interfaces:**
- Consumes: completed Tasks 1–5 and independent review results.
- Produces: truthful module graph, composition seam, artifact diagnostics, and lint gates.

- [ ] **Step 1: Run the ordered final sequence**

```bash
pnpm install --frozen-lockfile
pnpm check:host-module-graph
pnpm check:host-production-import-boundary
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
pnpm exec biome check --files-ignore-unknown=true tools host/src voice-gateway/src dialogue-web/src
pnpm test:stardew:core
pnpm test:stardew:integration
pnpm --filter @gamebuddy/companion-host check:production-artifact
```

Do not claim success for commands blocked by platform prerequisites; report them as blocked with exact output.

- [ ] **Step 2: Confirm no policy regression**

Run source-bound checks for: no generic-to-game static import, no game-to-runtime-core/platform import, no raw Desktop/Guardian/process facts through game seam, no second product entry, no fallback, no changed action/recovery contract, and no changed Chat/Game authority.

- [ ] **Step 3: Independent review**

Review the post-write diff along two axes: (a) standards/architecture, including deep seam and locality; (b) spec/behavior, including current owner constraints and WIP protection. A review that only sees summaries is insufficient; inspect the actual diff and focused tests.

- [ ] **Step 4: Gate completion**

The plan is complete only when every cycle targeted by the baseline is gone, composition generic modules no longer statically depend on Stardew, artifact failures distinguish environment repair from invalid artifact state, and each approved Biome batch has clean focused verification. Remaining unrelated WIP findings must be explicitly listed, not silently treated as fixed.

---

## Verification matrix

| Obligation | Static evidence | Focused runtime evidence | Failure interpretation |
|---|---|---|---|
| No Host production cycles | `pnpm check:host-module-graph` | N/A | Any cycle is code failure; pre-analysis missing package is environment blocker. |
| Generic composition decoupled | source-bound import test + dep-cruiser | Desktop composition tests | Stardew import in generic composition is code failure. |
| Game capability authority unchanged | import-boundary checks | Stardew core/integration tests | Any changed Mod policy/action/receipt behavior is out of scope and blocks. |
| Artifact closure strict | manifest verifier tests | build:test + artifact check | Missing package suggests explicit repair; symlink/outside root remains hard failure. |
| Biome hygiene | scoped Biome check and before/after counts | package focused tests | New semantic diff or WIP overwrite blocks batch. |

## Rollback and stop rules

1. Before each task, capture status and the task-local diff. If a path outside the task appears modified, stop and reconcile with the owner; do not overwrite it.
2. If an architecture change requires altering a current domain contract, stop and create a separate owner task; do not smuggle the change into a cycle fix.
3. If dependency-cruiser or typecheck fails because the current WIP is interleaved, preserve the failure as evidence and defer that task; do not add an ignore or compatibility path.
4. If provider injection starts requiring a global registry, dynamic game discovery, or second lifecycle owner, reject the design and return to the composition-local seam.
5. If Biome safe fix changes runtime behavior, restore the task checkpoint and fix that file manually or exclude it from the hygiene batch.
6. If artifact repair would mutate a release input, lockfile, durable state, credential, Chat/Memory store, Game lifecycle state, or update staging, stop; repair must remain explicit and local to the package-manager installation.

## Self-Review

- **Spec coverage:** Tasks 0–3 address cycle measurement, three Stardew/Chat cycle families, and composition decoupling; Task 4 addresses dependency diagnostics without weakening strict verification; Task 5 addresses lint hygiene with scoped safe fixes; Task 6 restores truthful final gates.
- **No compatibility layer:** The plan deletes no authority and introduces no fallback, registry daemon, second entry, dual read/write, or legacy import. The existing product catalog and formal composition remain separate until owner-approved wiring is proven.
- **Dependency direction:** The intended seams are deep: registry exposes only selected provider; leaf modules carry only pure facts/types; lifecycle, bridge and store authorities remain behind their existing interfaces.
- **WIP safety:** The plan explicitly preserves the current dirty checkout and requires exact-path ownership before edits.
- **Known blockers:** 当前 dependency-cruiser 与 Biome 命令均触发 pnpm workspace 依赖解析失败（`@gamebuddy/game-action-devkit@workspace:*` 在 workspace package list 中不存在）；artifact manifest 测试另在加载阶段报告 `typescript` 缺失。Task 0 必须先分类并修复/确认该环境问题，计划不把这些失败误判为代码或架构结论，也不宣称约 118 个 findings 可以安全自动修复。
- **No release claim:** Completing this plan would improve architecture/tooling hygiene only; it would not prove Stardew live action publication, Chat release, companion experience, or Game release.
