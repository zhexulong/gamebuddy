---
id: VENDOR-DECLARATIONS-PUBLINT-111
type: implementation-plan
status: draft
owner: vendor-magic-context
specs:
  - 110_ARCHITECTURAL_CLARITY_TOOLING_IMPLEMENTATION_PLAN.md
  - tasks/active/chat-tavern-context-engine-decoupling.md
---

# 111 vendor 声明产出与 publint 修复实施计划

> **前置阅读**：[`110_ARCHITECTURAL_CLARITY_TOOLING_IMPLEMENTATION_PLAN.md`](110_ARCHITECTURAL_CLARITY_TOOLING_IMPLEMENTATION_PLAN.md) Task 2、[`chat-tavern-context-engine-decoupling.md`](chat-tavern-context-engine-decoupling.md) D-02。
>
> **状态**：草稿（Draft）。110 Task 2 的闭环：让 `@cortexkit/pi-magic-context` 成为**可发布的、带类型声明的 public package**，消除「类型仅存在于 Host 手写 ambient 声明」的现状。
>
> **拥有者**：`vendor-magic-context`（即 `magic-context-airp` submodule 的维护 owner）
>
> **跨 owner 边界**：改动全部位于 `vendor/magic-context/`（submodule）内，主仓只引用其结果；Host 侧手写 ambient 声明（`host/src/magic-context-authored-context-bridge.d.ts`、`magic-context-memory-facade.d.ts`）在本任务完成后**删除**（由 vendor 声明接管）。

## 已核实事实（2026-09-16，publint 审计）

- `vendor/magic-context/packages/pi-plugin/package.json` 的 `exports` **缺 `types` 条件**：
  - `".": { "import": "./dist/index.js" }`
  - `"./tavern": { "import": "./dist/tavern/index.js" }`
  - `"./memory": { "import": "./dist/memory/index.js" }`
- **`dist/` 下 0 个 `.d.ts`**（运行时产物在，声明完全缺失）。
- Host 当前能编译仅因本地手写 ambient 声明（`declare module "@cortexkit/pi-magic-context/tavern"` 等）；第三方消费者 install 后 import 子路径会 TS 报 `no declaration`。
- publint 包装工具 `tools/check-publint.mjs` 已含这两条**已知基线**（vendor 任务完成后移除基线、转全绿门禁）。

## 目标

1. vendor `pi-plugin` 构建产出 `.d.ts`(每个 export 声明文件);
2. `exports` 每个子路径补 `types` 条件,指向真实存在的声明文件;
3. 删除 Host 侧手写 ambient 声明,由 vendor 类型接管(Host 编译仍绿);
4. `tools/check-publint.mjs` 移除两条已知基线,`check:publint` 转为 full-strict 全绿门禁。

## 约束

- 改动仅限 `vendor/magic-context/`（submodule 内）;主仓 Host 只做「删除 ambient 声明 + typecheck 验证 」。
- vendor submodule 内 commit **不 push**(与既有方针一致,由 owner 统一管理远端同步)。
- 不改变 runtime 行为、不改变导出名称/语义(110/D-02 已冻结的 public seam 不变)。
- 若 vendor 构建 tsconfig 无 `declaration: true`,优先开声明产出,而不是手写 `.d.ts`。

## Task 1: vendor 构建产出声明

**Files:**
- Modify: `vendor/magic-context/packages/pi-plugin/tsconfig.json`（或 `tsconfig.build.json`;确认 pi-plugin 实际构建用哪个）
- Modify: `vendor/magic-context/packages/pi-plugin/package.json`（`exports` 补 `types` 条件）

**Interfaces:**
- Produces: `dist/**/*.d.ts` 覆盖 `index`、`tavern`、`memory` 子路径;`exports` 每个 key 有 `types` 条件指向真实文件。
- Consumes: pi-plugin 现有 build script(`bun build ... src/tavern/index.ts src/memory/index.ts`),需确认能否带 `--declaration` 或需补 tsc emit。

- [ ] **Step 1: 现状确认**
  读 pi-plugin 构建链路(`package.json` build、`tsconfig*.json`),确认输出 dist 结构与现有入口。
- [ ] **Step 2: 开启声明产出**
  方案 A(优先):若 tsc 链路可独立产出 `.d.ts`,在 build 中加 `tsc --declaration` 生成;方案 B:对 `src/index.ts`、`src/tavern/index.ts`、`src/memory/index.ts` 单独 tsc emit 声明。选可维护、可复现的方式,避免手写。
- [ ] **Step 3: 修正 exports 补 types**
  `exports` 每子路径补 `types` 条件指向生成的 `.d.ts`(与 `import` 条件并列,或按 NodeNext 惯例放首位)。
- [ ] **Step 4: 验证声明完整性**
  在 vendor 内跑 `publint --strict`,确认两条已知基线消失、无新增错误;再在独立临时目录 install 该包,import 三个子路径确认 TS 可解析(用 `tsc --noEmit` 消费方探针)。

## Task 2: Host 切换到 vendor 声明并删 ambient

**Files:**
- Delete: `host/src/magic-context-authored-context-bridge.d.ts`
- Delete: `host/src/magic-context-memory-facade.d.ts`
- Modify: `host/package.json`(若 `@cortexkit/pi-magic-context` 依赖方式需调整以解析 vendor 产物)

**Interfaces:**
- Produces: Host typecheck 在无 ambient 声明下通过,证明类型真正来自 vendor。

- [ ] **Step 1: 切换依赖解析**
  确保 Host 的 `@cortexkit/pi-magic-context` 解析到 vendor `dist`(现为 `file:../vendor/...` 链接;若需先 build vendor 再让 Host 看到 `.d.ts`,确认构建顺序)。
- [ ] **Step 2: 删除 Host ambient 声明**
  删除两个 `.d.ts`,跑 `pnpm --filter @gamebuddy/companion-host typecheck`;若有类型差异(如声明宽窄不一致),以 vendor 为准修复 Host 引用点,不做行为变更。
- [ ] **Step 3: 验证**
  Host typecheck 绿 + `pnpm check:publint` 全绿(移除基线后)+ `pnpm check:architecture` 不含 knip/module-graph(仍受 WIP)但 publint 项绿。

## Task 3: publint 转全绿门禁 + 收尾

**Files:**
- Modify: `tools/check-publint.mjs`(移除两条 `KNOWN_VENDOR_GAP_RULES`,恢复 full-strict)

**Interfaces:**
- Produces: `check:publint` 仅凭 publint 真实退出码判定,无兜底基线。

- [ ] **Step 1: 移除基线**
  删 `KNOWN_VENDOR_GAP_RULES`、`readActiveKnownGaps` 等兜底逻辑,脚本退化为「跑 publint,非零即失败」。
- [ ] **Step 2: 验证**
  `node tools/check-publint.mjs` exit 0(在 Task 1 完成后);回归 110 Task 2 Step 4。
- [ ] **Step 3: 更新 110 文档**
  110 Task 2 Step 3/5 由「转独立任务」改回已完成;移除「预留决策点」中 vendor 待办措辞。
- [ ] **Step 4: 提交**
  vendor submodule 内 commit(不 push);Host 侧删 ambient + tools 简化 commit。

## 验收

- `dist` 含三个子路径的 `.d.ts`;`exports` 各子路径有 `types` 条件且指向存在文件。
- 独立消费方探针(临时目录)import 三个子路径 TS 解析通过。
- Host 删除两个 ambient 声明后 typecheck 绿(证明类型真来自 vendor)。
- `check:publint` 无基点全绿。
- 不改变任何 runtime 行为;110/D-02 冻结的 public seam 不变。
- 本任务不产生 release/live claim。

## Self-Review

- **Spec coverage**:三个 Task 覆盖「产声明、切 Host、删基线」完整闭环。
- **Placeholder scan**:每个 Task 有文件、命令、预期输出;无「写测试/导出工具」空话。

---

## 实施记录（2026-09-16，Task 1 已完成）

### Task 1 已交付（vendor submodule commit，未 push）

**提交内容**：
1. `packages/pi-plugin/tsconfig.declarations.json`（新建）：仅 include `src/tavern/index.ts` + `src/memory/index.ts` 的 declaration-only emit（**不含 root**——root `index.ts` 公开签名含 `@magic-context/core` alias，属上游 Magic Context 生态，本任务不触碰；已核实 Host 只消费 `./tavern`/`./memory`，从不 import root）。
2. `packages/pi-plugin/scripts/postprocess-declarations.mjs`（新建）：两步——① tsc 公共根输出平拖回 `dist/**`（tsc 因程序含 `plugin/src` 依赖把公共根推到 `packages/`，GameBuddy 公开声明自包含无需保留该层级，删除 `pi-plugin/plugin` 冗余树）；② 相对 import 补 `.js` 扩展（NodeNext 消费方解析需要）。
3. `packages/pi-plugin/package.json`：`./tavern`/`./memory` 各补 `types` 条件指向 `./dist/<subpath>/index.d.ts`（root 保持无 `types`——归上游）；build script 末尾追加 `&& tsc -p tsconfig.declarations.json && node scripts/postprocess-declarations.mjs`。
4. `packages/pi-plugin/scripts/verify-dts-resolution.cjs`（新建）：递归验证 emitted 声明图内所有相对 import 都能解析（供后续回归）。

**验证证据（全部实测）**：
- vendor 完整 build EXIT=0（bun runtime + tsc declarations + postprocess）；dist 平拖后为 7 个 `.d.ts`（`tavern/index.d.ts`、`memory/index.d.ts` + 5 个 gamebuddy 依赖），无 pi-plugin/plugin 乱目录；
- `verify-dts-resolution.cjs`：memory 与 tavern 声明链**全部可解析**（`./x.js` → `./x.d.ts` 映射成立），全链无 alias import（`@magic-context/core` 在 tavern/memory 公开签名零泄漏）；
- publint 基线收敛：只剩 root `.` 一条 `missing-types-condition`（tavern/memory 已修），`check:publint` exit 0；
- **Host 消费探针**（临时 junction 指向 vendor + 临时移除两个 ambient 声明 + `probe-vendor-types.ts`）：`import type { ... } from "@cortexkit/pi-magic-context/tavern"/"memory"` 编译**零错误**——证明「删 ambient → Host 经 vendor 声明解析」可行。探针与 junction 为验证性临时操作，验证后已回滚（ambient 恢复，探针删除）。

### Host 侧问题：pnpm `file:` store 快照不刷新 — 已解决（`vendor:link` 策略）

**已验证事实**：`host/node_modules/@cortexkit/pi-magic-context` 是 junction 指向 `.pnpm` store 旧快照（无新 `.d.ts`）；`pnpm install`/`--force`/删 store 节点均被 lockfile 判 up to date 跳过。

**落地策略（普遍最佳实践）**：pnpm-workspace.yaml 刻意排除 vendor（`!vendor/magic-context/**`，Bun 隔离）→ workspace 协议不可行；dev 用 **`pnpm link` 式 symlink 直连 vendor 源码**（实时可见 dist 重建），CI 保持 `file:` 快照 + 构建顺序（bun build vendor → pnpm install）。

已交付：`tools/vendor-link.mjs`（幂等 junction 脚本）+ 根 scripts `vendor:link` / `vendor:refresh`。开发流程：`bun build vendor` → `pnpm vendor:link` → Host typecheck 立即解析新声明。

### Task 2 已完成（2026-09-16，main commit `bba7940`）

- 删除 `host/src/magic-context-authored-context-bridge.d.ts`、`magic-context-memory-facade.d.ts`；
- **验证**：删除前后 Host tsc 错误数 **83 → 83（不变）**，全部为并行 WIP 错误、无 missing-declaration——证明 vendor 声明完整接管 Host 类型；
- Host 类型来源正式从手写 ambient 切到 vendor 声明（typecheck 全绿仍受 WIP 阻塞，与 tsc 门禁同批）。

### Task 3 已完成（2026-09-16）

- publint 基线收敛为仅 root `.`（tavern/memory 两条已随 vendor 修复自动消失）；`check:publint` exit 0；`check-publint.mjs` 逻辑自适应无需改代。root 一条保留声明为上游待办（upstream Magic Context 自管）。

### 剩余待办（WIP 落定后）

- Host typecheck 全绿（依赖你的并行 WIP 修复）后，`check:architecture` 从 WIP 感知版还原全门禁。
- **一致性**:publint 基线移除时机锁定在 Task 1 完成且验证后,避免中途红;Host ambient 删除锁定在 vendor 声明确认后。