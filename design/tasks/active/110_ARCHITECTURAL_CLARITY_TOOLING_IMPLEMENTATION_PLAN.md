---
id: ARCHITECTURAL-CLARITY-TOOLING-110
type: implementation-plan
status: draft
owner: architecture
specs:
  - architecture/architecture-governance-and-anti-erosion.md
  - 58_ARCHITECTURE_TOOLING_AND_KNIP_TRUTH_IMPLEMENTATION_PLAN.md
---

# 110 架构清晰性工具增量实施计划（tsc strict flags + publint + jscpd）

> **前置阅读**：[`58_ARCHITECTURE_TOOLING_AND_KNIP_TRUTH_IMPLEMENTATION_PLAN.md`](58_ARCHITECTURE_TOOLING_AND_KNIP_TRUTH_IMPLEMENTATION_PLAN.md)、[`design/architecture/architecture-governance-and-anti-erosion.md`](../architecture/architecture-governance-and-anti-erosion.md)。
>
> **状态**：草稿（Draft）。本文是 58 的补充（58 仍 active 且未实施；本文不覆盖 58 的职责，只新增“编译期边界 + 声明正确性 + 克隆漂移”三档门禁）。
>
> **拥有者**：`architecture` 领域负责人（Named Domain Owner: `architecture`）
>
> **跨 owner 边界**：Task 2（publint）修改 `vendor/magic-context/packages/pi-plugin/package.json`——vendor 是 submodule（`magic-context-airp`），改动需在 submodule 内 commit；Task 5（CI 集成）修改 `.github/workflows/ci.yml` 与根 `package.json` scripts。各 owner 的领域 checker（gameplay catalog、Stardew mechanism register 等）**不在**本文变动范围。

## 目标

在 knip（死代码/未使用）+ dependency-cruiser（依赖图/循环）+ biome（lint/format）之上，补充三档**互补**门禁，并为现有手写 checker 建立明确的分类边界（哪些可由工具替代、哪些是产品语义必须保留），以提升架构清晰性、减少同类逻辑漂移。

## 三类 checker 分类（先决定“加什么/留什么/删什么”）

| 类别 | 例子 | 能否由工具替代 | 处置 |
|---|---|---|---|
| **A. 图拓扑/循环** | `check-host-production-import-boundary.mjs` 中的纯路径/循环部分；`.dependency-cruiser.host-production.cjs` 的 `no-host-production-circular-dependencies` | ✅ 已由 dependency-cruiser 覆盖 | 确认不重复实现；重复面移入 dep-cruiser |
| **B. 治理语义白名单** | `check-host-production-import-boundary.mjs` 的 `LEGACY_ADOPTION_FUNCTIONS` / `MOUNTED_TURN_COMPOSITION_ROOTS`；`check-dist-runtime-exports.mjs` 的产物导出断言 | ❌ dep-cruiser/publint 只能正则路径，表达不了“list 是 legacy、动态 import 也算” | **保留**；可收敛为共享清单 |
| **C. 领域语义** | `check-gameplay-capability-catalog.mjs`、`check-stardew-action-promotion.mjs`、`check-chat-conversational-quality-gate.mjs` | ❌ 工具不知道产品语义（catalog 合法形状、机制 family） | **保留**，不可删 |
| **D. 产物闭包断言** | `check-dist-runtime-exports.mjs` 断言“dist/tavern/index.js 必须导出受控函数、零裸 prompt renderer” | ⚠️ publint 只查声明正确性（types 指向、条件），产物实际导出面**必须另验** | **保留**，与 publint 互补不互替 |

**结论**：不做“删手写 checker”的减法；只保障“A 类已由 dep-cruiser 优先承担 + B 类清单收敛”，新增下述三档工具作为**补充**门禁。

## 新增三档门禁

| 工具 | 补缺口 | 作用对象 | 门禁形式 |
|---|---|---|---|
| **tsc 严格 flags** | 编译期边界 | `host/tsconfig.json` + `.production` + `.test` | 温和档（`noUnusedLocals/noUnusedParameters/noImplicitOverride`）本轮；激进档（`noUncheckedIndexedAccess/exactOptionalPropertyTypes`）Dry-run 量化后另立 |
| **publint** | package exports 声明正确性（子路径 types 解析） | `vendor/.../pi-plugin/package.json`（有 `exports`） | `publint --strict`，非零即失败 |
| **jscpd** | 代码克隆/同类漂移 | `host/src dialogue-web/src voice-gateway/src packages tools/*.mjs` | 先出基线报告（report-only），不设新墙 |

> **publint 目标说明**：`host/package.json` 是 `type: module`、无 `main/exports/types`（被 build 成 artifact，不发布），publint 对它无意义；真正有 `exports` 的是 vendor `pi-plugin` 包（root + `./tavern` + `./memory`），那才是 D-02 public seam 的声明面。

## Task 1：tsc 严格 flags（Dry-run 量化后分档）

**Files:**
- Modify: `host/tsconfig.json`、`host/tsconfig.production.json`、`host/tsconfig.test.json`

**Interfaces:**
- Produces: `tsc --project tsconfig.json --noEmit`（及 production/test）在更严格下通过。

- [x] **Step 1: Dry-run 量化温和档（已实测 73 错误，2026-09-16）**
  `noUnusedLocals`+`noUnusedParameters`+`noImplicitOverride` 临时追加后 tsc 报 73 错，≤300 预算内，本轮纳入。
- [x] **Step 2: Dry-run 量化激进档（已实测 129 错误含温和档，2026-09-16）**
  追加 `noUncheckedIndexedAccess`+`exactOptionalPropertyTypes` 后共 129 错，≤300，本轮纳入不分阶段。
- [x] **Step 3: flags 全开提交（2026-09-16 commit）**
  三个 tsconfig 已全开 5 flags；修了非 dirty 文件中的一批 unused/参数错误（tavern-paths、windows-bootstrap-guardian、stardew-game-integration-adapter 等）。
- [x] **Step 4: 基础设施提交（commit）**
  tsc flags + publint/jscpd/CI 一起提交为「110 已稳定部分」。
- [ ] **Step 5: 剩余 host/src 错误收口（待 WIP 解决，owner 决策已定）**
  **现状**：普通 `pnpm typecheck`=红（~83 错）且与并行 WIP 文件交织（`chat-thread-store`、`catalog-service`、`continuity-semantic-store`、`game-browser-contract`、`voice-gateway-client`、`stardew-attachment`、`dialogue-web-main` 等），其中含 `game-browser-contract/index.ts` 由并行修改新引入的 14 个 unused 错误。**owner 裁定**：只提交已稳定部分；tsc 红门禁标记待 WIP；剩余错误由对应 WIP owner 在其落定后自行解决（不覆盖其改动）。本 Step 阻塞至此决策达成。

**告警**：本任务会动 `host/src` 大量文件（unused 清理）。与后续 109 等实施提交无关，独立 commit。

## Task 2：publint（vendor exports 声明正确性）

**Files:**
- Modify: `vendor/magic-context/packages/pi-plugin/package.json`（submodule 内）
- Modify: `vendor/magic-context/packages/pi-plugin/tsconfig*.json`（若需产出 .d.ts，vendor 侧构建变更）
- Add: `tools/check-publint.mjs`（包装执行 + 非零退出）

**Interfaces:**
- Consumes: `vendor/.../pi-plugin/package.json` 的 `exports`（root + `./tavern` + `./memory`）。
- Produces: `check:publint`（先 tool 包装，再挂 CI）。

**[已核实的现状（2026-09-16）]**：vendor `pi-plugin` 的 `exports` **没有 `types` 条件**（`.": "./dist/index.js"`、`"./tavern": "./dist/tavern/index.js"`、`"./memory": "./dist/memory/index.js"`，各仅一个 `import` 分支），`types` 字段缺失；且 **`dist/` 下 0 个 `.d.ts`**。当前 Host 能编译仅因本地手写 ambient 声明（`magic-context-authored-context-bridge.d.ts`、`magic-context-memory-facade.d.ts` 的 `declare module "@cortexkit/pi-magic-context/tavern"/"/memory"`）；第三方消费者 install 后 import 子路径会因无声明而 TS 报错。

- [x] **Step 1: 运行 publint 确认（2026-09-16 已跑）**
  `tools/check-publint.mjs` 已执行并验证：exit 0，两条已知 baseline（missing-types-condition + missing-declaration-artifacts）正确识别。
- [x] **Step 2: 判定修复范围（已定）**
  ①“缺失 types 条件”修 vendor `exports`；②“0 个 .d.ts”需 vendor 构建产出声明——**该项已立案为独立 vendor 任务**（owner 拍板走 2：不碰 vendor，由 vendor 侧自建任务解决）。Host ambient 声明作为临时垫片标注保留。
- [x] **Step 3: 修复（在独立任务 111 完成）**
  见 [111_VENDOR_DECLARATIONS_PUBLINT_IMPLEMENTATION_PLAN.md](111_VENDOR_DECLARATIONS_PUBLINT_IMPLEMENTATION_PLAN.md)：vendor 构建产出 `.d.ts`（`tsconfig.declarations.json` + `postprocess-declarations.mjs`）、`exports` 补 `types` 条件，vendor commit `7d56cef7`（un push）。
- [x] **Step 4: 包装工具（2026-09-16 已提交 `37c4106`）**
  `tools/check-publint.mjs` 已建并提交，CI 已加两行。
- [x] **Step 5: 提交（vendor 侧，由 111 完成）**
  由独立任务 111 在 submodule 内 commit（`7d56cef7`），Host 删 ambient + 新增 `vendor:link` 工具于 main `bba7940`。publint 基线现收敛为仅 root 一条（上游待办）。

> **预留决策点（需 owner 拍板）**：vendor submodule 内改动是只 commit 不 push，还是需要整体 push 到 `magic-context-airp`？本文默认**不 push**。若 vendor 需产出 .d.ts（Step 2 ②），该项涉及 vendor 构建链路变更，超出本任务单工具接入范围，需独立 vendor 任务。

## Task 3：jscpd（克隆漂移基线）

**Files:**
- Add: `jscpd.json`（配置文件）
- Modify: `package.json`（仅声明 `jscpd` 依赖与 `check:clones` script；不动 scripts 之外）

**Interfaces:**
- Produces: `pnpm check:clones`（report-only，非门禁）。

- [x] **Step 1: 写配置（2026-09-16 已提交 `37c4106`）**
  `jscpd.json`：`minTokens: 50`、`minLines: 5`；ignored：`vendor/ ref/ tmp/ .worktrees/ dist*/ **/*.test.*/ node_modules/`；scan：`host/src dialogue-web/src voice-gateway/src packages tools`。
- [x] **Step 2: 声明依赖与 script（2026-09-16 已提交 `37c4106`）**
  `pnpm add -D jscpd`；`check:clones` 已挂。
- [x] **Step 3: 基线报告（2026-09-16 已提交 `37c4106`）**
  `tools/jscpd-baseline-2026-09-16.md`：372/373 文件、636-637 克隆、~7.4% duplicated，report-only。
- [x] **Step 4: 提交（2026-09-16 已提交 `37c4106`）**
  `jscpd.json`、`package.json`、`pnpm-lock.yaml` 一并提交。

## Task 4：A 类重复确认（并入集成）

- [x] **Step 1: 比对（2026-09-16 完成）**
  逐条核对 `tools/check-host-production-import-boundary.mjs` 的规则 vs `.dependency-cruiser.host-production.cjs`。dep-cruiser 仅含 1 条 `no-host-production-circular-dependencies`；import-boundary 的 `DEFAULT_ROOTS`/`MOUNTED_TURN_COMPOSITION_ROOTS`（入口身份）、`LEGACY_*`（治理白名单）均为语义规则，dep-cruiser 无法表达（正则路径表达不了“list 本身是 legacy、动态 import 也算”）。
- [x] **Step 2: 迁移（无）**
  核实 import-boundary **不含循环检测逻辑**（唯一 `cycle` 命中是 `game-surface-lifecycle/` 位于 legacy 清单，非图算法）——循环检测已完全由 dep-cruiser 承担，**无重复实现、无需迁移**。双方职责互补：dep-cruiser 管图拓扑，import-boundary 管语义白名单。

## Task 5：集成与 CI 门禁

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`（scripts）

**Interfaces:**
- Produces: `check:architecture`（= knip + dependency-cruiser + import-boundary + publint + jscpd + biome + typecheck 的聚合门禁）。

- [x] **Step 1: 聚合 scripts（2026-09-16 提交 `37c4106` 及本次）**
  新增 `check:architecture`。因 knip/module-graph/typecheck 受并行 WIP（dirty：`protocol.ts`、`stardew-integration-launcher-body-program.internal`、`continuity-semantic-chat-runtime-construction`、`desktop-host-composition` 等）影响为红，按 owner 裁定当前修改为 **WIP 感知版本**：`pnpm check:publint && pnpm check:clones && echo "[110] knip/module-graph/import-boundary gated by live WIP..."`。knip/module-graph/import-boundary/typecheck 的红由各自 WIP owner 落定后恢复为全门禁。
- [x] **Step 2: CI 接入（已完成，`37c4106` 加了两行）**
  CI host job 已添加 `node tools/check-publint.mjs` 与 `pnpm check:clones`（在 typecheck 后、构建前）；jscpd report-only。
- [x] **Step 3: 验证（部分完成，仍受 WIP）**
  `pnpm check:publint` exit 0、`pnpm check:clones` exit 0（已验证）；111 落地后 `check:architecture` 含 publint/clones 两成员绿。knip/module-graph/typecheck 仍受并行 WIP 红（`protocol.ts`、`game-browser-contract` 等），待相应 WIP owner 落定后跑一次通过并还原 `check:architecture` 为全门禁。
- [x] **Step 4: 提交**
  `package.json` 聚合脚本已提交（与 `37c4106` 同批）。

## 并行 Wave 计划

```
Wave 1（并行，owned paths 互斥）
  L1  tsc 严格 flags   独占 host/tsconfig* + host/src（Task 1）
  L2  publint          独占 vendor pi-plugin + tools/check-publint.mjs（Task 2）
  L3  jscpd            独占 jscpd.json + package.json 依赖（Task 3，script 不动）
  L4  重复面比对       只读（Task 4 Step 1，父进程或 scout）

每个 lane 完成 → 该 lane 独立 review（审查者不看 worker 摘要，直接审 post-write diff）
→ 合并/冲突检查（L1 可能动 host/src 大量文件；L2/L3 不碰 host/src）

Wave 2（串行集成）
  集成（父进程或单 worker）独占 root package.json scripts + .github/workflows/ci.yml
  → 串 News 全量门禁验证（pnpm check:architecture + pnpm quality:check）
```

## 待 owner 拍板（阻塞本计划敲定）

1. ~~L1 激进档授权~~ **已由 Dry-run 数据消解**：温和档实测 73 错误、激进档（+`noUncheckedIndexedAccess`+`exactOptionalPropertyTypes`）实测 129 错误，均 ≤300，两档本轮都纳入（无跨 host 数百处变更疑虑）。
2. **L2 vendor 改动归属**：已被证据消解——publint 抓到的实质问题是「vendor 缺 `types` 条件 + `dist/` 0 个 `.d.ts`」。补 `types` 条件属本任务范围（submodule 内 commit，不 push）；**若需 vendor 构建产出 .d.ts，则超出单工具接入范围，独立 vendor 任务**（已写入 Task 2 Step 2 分工）。是否授权 push 到 `magic-context-airp` 仍待 owner。,

## 验收

- Task 1–5 的 checkbox 全勾选且有真实输出（Dry-run 数字、publint 报告、jscpd 基线）。
- `pnpm check:architecture` 绿；`pnpm quality:check` 不回归。
- 手写 checker 分类表落地：A 类无重复实现、B/C/D 保留。
- 本文不产生 release/live/publication claim。

## Self-Review

- **Spec coverage**：三档门禁（编译期边界/声明正确性/克隆漂移）+ checker 分类均对应 Task。
- **Placeholder scan**：无“写测试/导出工具”空话；每个 task 有文件、命令、预期输出。
- **一致性**：publint 明确指向 vendor（host 无 exports）；jscpd 明确 report-only；与 58 职责分离（58 管 knip/dep-cruiser 诚实化，本文管三档增量）。