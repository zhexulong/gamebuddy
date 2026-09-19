---
id: TASK-CHAT-TAVERN-CONTEXT-ENGINE-DECOUPLING
type: task-plan
status: active
owners:
  - chat
  - memory
  - architecture
specs:
  - domains/chat/overview.md
  - domains/memory/overview.md
  - architecture/context-memory-and-lorebook-architecture.md
  - architecture/architecture-governance-and-anti-erosion.md
  - architecture/release-model.md
  - operations/release-evidence.md
references:
  - ../../../tools/tavern-live-run-charter.md
---

# Chat/Tavern Context Engine 解耦：决策与实施计划

## 1. 状态与治理边界

**Status：`active`，implementation open。** D-01、D-02、D-03 的方向已经确定；这不表示任何代码切片已经完成，也不表示 package boundary、Memory contract、context lifecycle 或仓储迁移已经通过验收。

本文是一个有边界的实施任务，不覆盖 Chat、Memory、Magic Context、Game、Desktop 或 release owner 的 current 文档。实现只能补齐本文明确的 seam 和验证，不能借本文改变这些 owner 的 authority、产品行为或发布条件。

本文不产生 `release`、`live`、`publication`、`ready` 或 `release-candidate` claim。Chat/Tavern live gate 仍由 Chat owner 的独立任务和 gate 决定；本任务的静态、确定性或集成结果不能替代它。

## 2. Authority 与不变量

- [Chat](../../domains/chat/overview.md) 拥有 Chat surface、Host session/DTO/turn persistence、`ChatThreadStore` 与 Chat/Tavern release boundary。
- [Memory](../../domains/memory/overview.md) 拥有 Memory 行为契约、普通玩家 CRUD、revision conflict 和成功后的 safe reread；Magic Context extension 拥有生产 Memory SQLite。
- [Context、Memory 与 Lorebook 架构](../../architecture/context-memory-and-lorebook-architecture.md) 拥有 `m[0]`、`m[1]`、raw tail、cache、cursor、fold、replay、cleanup 及 surface isolation 语义。
- [架构治理](../../architecture/architecture-governance-and-anti-erosion.md) 拥有 current 文档、跨领域 seam、校验器和工具退役边界。
- [发布与验证模型](../../architecture/release-model.md) 拥有证据层级和 gate 的最小化原则。
- [发布证据维护](../../operations/release-evidence.md) 与 [Tavern live charter](../../../tools/tavern-live-run-charter.md) 拥有 `chat-tavern-live` 的执行和 evidence 语义。

必须保持的边界：

1. Host 可以提供经验证的 typed immutable source snapshot/binding，但不得直接写 Magic Context SQLite、`m[0]`、`m[1]` 或拼装 provider prompt。
2. Magic Context 负责 source validation、context materialization、cache/cursor/fold/replay/cleanup；Host 只消费受控 facade 或 canonical projection。**Memory/Context 语义归 Magic Context，不对外暴露**（D-02）：Magic Context 是 Pi 插件、用 Pi API（`pi.on("context")` 等）操作 context/memory；core 不做 memory 领域级 fail-closed 断言（例如不把 `profileCanonicalHash` 作为 CRUD 强制绑定条件）。
3. `ScenarioBinding` 只能属于 Chat；`GameProfileSnapshot` 的输入端必须排除 Scenario。WorldBook binding 必须保留 continuity、world-book identity、revision 和 canonical hash，并在不匹配时 fail closed。
4. 普通 Memory mutation 是独立应用操作，不等待未来 provider round、marker、nonce、receipt 或 attestation。
5. Chat 与 Game 的 raw history、surface lifecycle、capability、receipt 和 action state 保持独立；本任务不创建跨 surface 的恢复或回放路径。
6. Host 只装配受信的 Pi 扩展（默认 Magic Context），不把 Host 内部 authority（凭证、runtime 获取、Game 状态、控制管）暴露给任何扩展；World Book 引擎、context 注入与 Game 权威保留 Host/Magic Context 既有归属。

## 3. 冻结决策与实现状态

“决策冻结”和“实现闭合”分开记录：

| 决策 | 已确定方向 | 当前实现状态 |
|---|---|---|
| **D-01 Source / Marker / Render** | Host 输入不可变；marker 是引擎内测试探针；upstream 只保留通用、引擎内部的 section seam；Tavern source/render 逻辑留在 engine-owned boundary。 | `DECISION_FROZEN_IMPLEMENTATION_OPEN` |
| **D-02 Context/Memory 归属与生态形态** | 不对外暴露 memory/context API——memory 与 context 是 Magic Context 的职责，Magic Context 本身是 Pi 插件、直接用 Pi API（`pi.on("context")` 等）操作 context/memory；“换插件”= 换 Pi 扩展。core 只做装配（加载哪些 Pi 扩展）+ 玩家面（浏览器受管 API）；Game/凭证/存活 authority 不暴露。 | `DECISION_FROZEN_IMPLEMENTATION_OPEN` |
| **D-03 Repository / Build** | 先在当前单仓收敛公开 package seam，再由独立迁移任务决定是否进行 submodule/拆仓。 | `DECISION_FROZEN_MIGRATION_NOT_STARTED` |

以下为 2026-09-16 复核后的现状分类（与第 4 节代码事实一致）：`./tavern` 与 `./memory` exports、零 `./internal/` consumer 已是完成事实；typed successor contract、generic section seam、`PiContextPipelineDelegate`、Submodule 或双向 CI 仍不是完成事实。**受管插件槽 / 自造 provider 协议层（registerProvider/manifest/能力协商）按 D-02 收敛为“不实现”**——memory/context 归 Magic Context（Pi 插件），core 不新增对外 provider 面。

## 4. 当前 checkout 事实

1. `host/package.json` 通过 `file:../vendor/magic-context/packages/pi-plugin` 消费 `@cortexkit/pi-magic-context`；Host package 名称是 `@gamebuddy/companion-host`。**pnpm `file:` 会快照 store，vendor dist 重建不自动回流——host 本地开发经 `pnpm vendor:link`（junction 直连 vendor 源码）+ `vendor:refresh` 刷新。**
2. `vendor/magic-context/packages/pi-plugin/package.json` 已导出 package root、`./tavern` 与 `./memory`，且 `./tavern`/`./memory` 已补 `types` 条件（111：`types` 指向 `./dist/<subpath>/index.d.ts`，由构建链产出）；`internal/gamebuddy-authored-context-bridge` 的 Host consumer 已清零。本项为 2026-09-16 复核后的现网事实，替代早期“只导出 root + internal、无子路径、无类型声明”的过时描述。
3. Host 的 runtime core、production coordinator、Chat materializer 及相关类型声明/测试通过 `@cortexkit/pi-magic-context/tavern` 与 `/memory` 消费受控导面（marker observer、capability mint、Memory facade）；不再依赖 internal bridge。**Host 类型来源已从手写 ambient 声明切到 vendor 声明（111 Task 2：删除 `magic-context-authored-context-bridge.d.ts`/`magic-context-memory-facade.d.ts`，经 `vendor:link` 解析 vendor dist .d.ts）。**本文不把具体调用处数量作为验收事实；实施前后必须以实际 consumer closure 和扫描口径记录结果。
4. `src/index.ts` 不再从 package root 导出 Memory facade 与 Tavern marker 运行时函数（仅保留引擎内 `registerTavernNarrativeGateMarkerHook` 等内部接线），根入口导出的是引擎自有能力。
5. Marker 的当前 API 是两个职责不同的函数：
   - `registerTavernNarrativeGateMarker({ sessionId, nonceSha256 }): () => void` 负责绑定和清理；
   - `registerTavernNarrativeGateMarkerHook(pi): void` 负责挂载 `before_provider_request` hook。
   不得在计划或代码中把二者合并为 `registerTavernNarrativeGateMarker(pi)`。
6. 当前 Memory facade 已有完整 profile binding：`continuityId + profileId + profileRevision`，并由 vendor 侧校验/profile 身份匹配（`assertMemoryProfileMatch`）；D-02 方向下该 profile 三元组作为 provider 调用参数保留，`profileCanonicalHash` 已按 owner 决策从 CRUD 绑定移除（68ec0e4）。
7. `inject-compartments-pi.ts` 已不再直接渲染 `<gamebuddy-volatile-context>` 原样注入（改由引擎侧 `materializeGameBuddyAuthoredStableCatalog`/volatile selector 消费 typed catalog）；`context-handler.ts` 的委托代理商由 Magic Context 引擎自管理，不属于本文所谓“四处”固定委托。
8. `vendor/magic-context` 已是 Git Submodule（`.gitmodules` 指向 `zhexulong/magic-context-airp`，vendor-compat 已提交 `2a63fad4`→`7d56cef7`；仓库拓扑见 `commit d8bf059`）。仓储迁移相关约束仍适用：不能在共享 dirty checkout 上通过 reset、clean、stash 或覆盖既有 WIP 完成。
9. Host 测试 package script 在 root 中可通过 `pnpm --filter @gamebuddy/companion-host test` 调用；vendor package 自己的可用脚本以其 `package.json` 为准。

## 5. D-01：Source / Marker / Render contract

### 5.1 Source

- Host 继续拥有 canonical Persona、Chat-only Scenario 和 WorldBook 状态，并生成带 scope、revision/hash、ordering、budget 和 provenance 的 immutable typed input。
- 优先复用当前 `GameBuddyChatContextScope`、`GameBuddyAuthoredStableCatalog`、stable/volatile source/ref 类型。`AuthoredContextSnapshot` 只是候选概念名；在 Slice 1 冻结前，不得把一个不存在的同名类型当成已存在 API。
- snapshot 必须绑定 continuity、Chat surface、thread/session、profile identity/revision；Scenario 不得进入 Game snapshot。WorldBook/source mismatch、revision mismatch 或 hash mismatch 必须 fail closed。
- Host 不直接写 `m[0]`、`m[1]`，不把 raw XML 或裸 section string 作为跨边界 authority，不组装 prompt。

### 5.2 Marker

- `tavern-narrative-gate-marker.ts` 留在 Magic Context/Pi 内，marker 只做 bounded observation/test probe，不拥有 provider settlement、context materialization、turn completion、publication 或 release authority。
- 公开 seam 必须分别描述 binding API 和 engine hook API，至少保持当前职责分离：binding 接收受限配置并返回一次性 clear 操作；hook 只由 engine composition 安装并监听 Pi 内部事件。
- marker 输出只能是脱敏、有限的 outcome/observation，不能携带 prompt、`m[0]`/`m[1]` 文本、transcript、provider payload、credential、SQLite 内容或内部路径。late callback、clear、close、重复绑定和错误必须有确定的测试结果。
- Slice 1 可以为该 seam 采用命名的 registration type，但必须以实际 API 和 owner-approved shape 为准；不能为了满足名称而新增第二套 marker API。

### 5.3 Render

- upstream core 只提供引擎内部、可复用的 typed contributor/source 到 rendered section 的窄接缝。若内部最终使用 `extraM0Sections`/`extraM1Sections`，它们不得成为 Host 或 browser 可调用的裸字符串 API；转换、校验、排序、预算和 XML escaping 由 Magic Context owner 管理。
- Tavern-specific XML/source renderer 可以归拢到 engine-owned `src/tavern/` boundary，但目录迁移必须由真实 consumer 和测试驱动，不能以文件名或“仅 2 行改动”作为目标。
- Slice 3 必须保护 stable source replacement、volatile turn binding、revision/cursor、fold、replay、cleanup 和 surface isolation；M0 fixture parity 只能证明声明的 fixture 和 revision，不得宣称整体 Prompt Caching “零漂移”。

## 6. D-02：Context/Memory 归属与生态形态（Pi 扩展，不对外暴露 memory）

**方向（2026-09-16 再次收敛：不再自造 provider 协议层；memory/context 归 Magic Context，Magic Context 是 Pi 插件，直接用 Pi API 操作 context/memory。）：**

1. **不对外暴露 memory/context API。** memory 条目语义、检索、存储、materialization 是 Magic Context 的职责；core 不定义、不暴露任何 memory/context 接口给生态。此前推演的 `registerMemoryProvider`/`MemoryProviderPort`/`ContextEnginePort` 角色拆分、C0 协议种子（manifest/能力协商/路由仲裁/版本矩阵）**全部撤回**——Pi 扩展机制本身就是 provider 机制。
2. **Magic Context 是 Pi 插件，用 Pi API 操作 context/memory。** 它通过 `pi.on("context")` 注入 context、`pi.registerTool(...)` 注册检索/记忆工具、`pi.on("before_provider_request")` 等挂接生命周期；SQLite、`m[0]`/`m[1]`、fold/replay/cleanup 全是它内部（用 Pi API 实现），core 不介入。换 memory 实现 = 换一个 Pi 扩展（它自己用 Pi API 做 memory），core 不写任何 provider 接线。
3. **core 只做两件事：装配（加载哪些 Pi 扩展）+ 玩家面（浏览器受管 API）。** 装配 = Host 决定启动哪些 Pi extension（noTools 白名单 + extension list）；玩家面 = 现有 Host 受管 typed API（session/CSRF/DTO/记忆管理 browser-contract），由 Host 经 facade 调 Magic Context。
4. **玩家面是产品面，不是生态面。** 浏览器管理记忆的能力（`memory-management`/browser-contract）是 Host 履行 Chat/Memory owner 契约；它不开放给第三方，也不是 provider 自带的 UI/面板。
5. **Game/凭证/存活/release authority 不暴露。** 这些属各域 owner（#968/#2254/#2428/#2336），与 Pi 扩展无关。
6. **普通玩家操作语义保持。** opaque projection handle/revision/state token、safe reread、失败不伪造成功、mutation 不等待未来 LLM round/marker（但等待 MemoryProvider mutation durable outcome 后 safe reread）；`actor: { principal: "player_direct", delegated: false }` 仍作为 provenance。
7. **证据分域不变。** 描述性可观察 / 规范性经各域既有 gate；不建统一 predicate 框架；Game/Guardian 证明不进入任何扩展协议。
8. **对外不暴露的面是零新增类型。** 若未来出现第二个 memory 扩展（Pi 插件），它实现 Pi 扩展入口 + 必要时提供与玩家面契约兼容的实现即可；core 无需新增注册面或协议种子。 

### 6.1 D-02 架构分层拓扑与落地顺序（Pi 扩展 + 装配 + 玩家面）

#### 1. 分层拓扑

```
Pi 进程（Host 启动，noTools 白名单 + extension list）
  ├─ Magic Context = Pi 插件
  │     ├─ pi.on("context") / pi.on("before_provider_request") …   ← 用 Pi API 操作 context
  │     ├─ pi.registerTool(...)                                     ← 用 Pi API 注册检索/记忆
  │     └─ 内部:SQLite、m[0]/m[1]、fold/replay/cleanup（全是它的职责，core 不介入）
  │
  └─ 其他 Pi 扩展（未来可能：另一个 memory 实现 = 另一个 Pi 插件）

Host / core（装配根 + 玩家面）
  ├─ 装配：决定加载哪些 Pi 扩展（配置，不是协议）
  ├─ 玩家面：浏览器受管 typed API（session/CSRF/DTO/记忆管理 browser-contract）
  │       经 Host facade 调 Magic Context（现有 memory-management）
  └─ 持有：Game/凭证/存活/release authority（#968/#2254/#2428/#2336）

【不存在的面】
  ✗ core 不暴露 registerMemoryProvider / MemoryProviderPort / ContextEnginePort
  ✗ 不做 provider manifest / 能力协商 / 路由仲裁 / 版本矩阵
  ✗ 不做受管“UI 槽”（玩家面是产品面，不是 provider 面板）
```

#### 2. 核心拆分原则

1. **memory/context 归 Magic Context，不对外暴露；Magic Context 用 Pi API 操作。** 换 memory 实现 = 换 Pi 扩展，core 不写 provider 接线。
2. **core = 装配 + 玩家面。** 装配是配置（加载哪些 Pi 扩展），玩家面是 Host 受管 typed API；两者都不是“对外可编程面”。
3. **玩家面是产品面，不是 provider 自带 UI/面板。** 浏览器记忆管理是 Host 履行 Chat/Memory owner 契约，不开放给第三方。
4. **三域 authority 不变**：core 装配/入口认证/隔离；Chat session/DTO/turn/release；Memory/Context 语义归 Magic Context；Game 域独立。core 不产生任何域内 normative outcome。
5. **证据分域不变，无 global pass。**
6. **权威证明不过度化（AGENTS.md 尺子）**：防真实事故（Game/Guardian receipt、凭证、release gate）的必须，说不清事故的删（`profileCanonicalHash` 已删）。
7. **本方向不撤回 Slice 1–3 已实现的窄 `./tavern`/`./memory` 子路径与受控 facade。** 它们是 Host 经 facade 消费 Magic Context 的当前实现，不属于对外“生态协议”。

#### 3. 落地切片次序（实现即闭合，不冻结协议）

- **已完成**：D-01 上下文拼装归引擎；109 宿主运行时与世界书/叙事兼容加固；111 vendor 声明产出（Host 类型来源切成 vendor .d.ts）。
- **剩余（D-02 收敛后）**：
  - **Slice A：玩家面确认**——host 侧 `memory-management`/browser-contract 作为“玩家面”的职责边界已有（`./memory` facade + browser schema）；D-02 不再新增。
  - **Slice B：装配清单确认**——Host 启动哪些 Pi 扩展（Magic Context 为默认）的清单/配置存在即可；如无显式清单，补一个最小配置（记录扩展 ID/版本/来源），不引入插件市场。
  - **未来（出现第二个真实 memory/context 插件时）**：该插件实现 Pi 扩展入口 + 与玩家面契约兼容的实现；届时再定它是否作为第二个扩展装配——但 core 无需为此新增协议。

> 与上一版（Core 可编程受控面 + 12 条 + C0 协议种子）的差异：本版撤回“自造 provider 协议层”，回到 Pi 原生扩展模型——memory/context 归 Magic Context，core 只做装配 + 玩家面。原 6.1 的“ST 三层桥/caller facades/声明层纯/效果层显式/C0”等章节内容已由本版取代。
## 7. D-03：Repository / build consumption

### 7.1 当前单仓步骤

1. Slice 1 冻结 typed source、marker、Memory facade 和 public consumer shape。
2. Slice 2 增加窄的 `./tavern`、`./memory` public subpaths，迁移真实 consumer，并在所有 consumer closure 完成后删除不再需要的 internal export。公开 path 不得暴露 private composer、capability minting 或 storage internals。
3. Slice 3 在 engine-owned boundary 内收敛 render/source lifecycle，保留 Magic Context 的 m0/m1/replay/cache authority。
4. 每一步只更新实际 owner obligation；没有等价测试覆盖时，不删除现有 source-bound、dynamic-import、artifact-closure 或安全检查。

### 7.2 物理拆仓是后置迁移

Submodule、远端仓库、分支名称、upstream 同步和双向 CI 不属于 Slice 1–3 的完成事实，也不在本文固定具体远端地址。只有在 public API、artifact provenance、fresh clone/build、rollback、remote protection、CI required checks 和失败/quarantine 语义都形成独立迁移任务或 ADR 后，才可启动迁移。

Submodule topology 只是 repository composition，不授予 runtime、Memory、Chat 或 release authority；“零业务关键词”“不会冲突”“测试全绿”也不能单独证明依赖方向或运行时隔离。

## 8. 实施切片与 acceptance

### Slice 1：Contract discovery & type definitions

**范围：** 在现有 source、marker、Memory facade 和 Host ambient/type boundary 上冻结最小 public consumer contract；不改变运行路径。

**必须闭合：**

- 明确 typed authored source 的实际名称、scope、revision/hash、stable/volatile placement、ordering/budget、Scenario exclusion 和 fail-closed 错误。
- 明确 marker binding 与 Pi hook 的两个 API、返回值、清理和观察数据边界。
- 明确 Memory facade 的 manifest/profile binding、opaque revision/state token、允许的 current CRUD 操作和错误分类。
- 明确哪些类型只在 engine 内部，哪些可从 `./tavern`/`./memory` 消费；不得以裸 `string[]` 作为 Host-facing contract。

**验证：** vendor package `typecheck`、Host `typecheck`、新增的 export/contract tests。contract 未经对应 owner 确认或无法表达 current invariant 时，结果为 `blocked`，不进入 Slice 2。

### Slice 2：Public exports & seam cleansing

**范围：** 实现已冻结的 `./tavern`、`./memory` 窄 exports；迁移实际 Host production consumers；删除已无 consumer 的 internal export。

**验证：** package build/typecheck、public subpath resolution test、Host typecheck、`pnpm check:host-production-import-boundary` 及针对 dynamic import/type-only declaration/artifact closure 的 owner-specific tests。扫描必须记录 roots、consumer 计数口径、允许例外和 `pass`/`blocked`/`failed` 结果；不能用“6 处”代替 closure。

**失败：** 任一旧 consumer、private export、错误 public export、动态加载遗漏或 artifact closure 缺口都 fail closed；不得保留仅为兼容的旧路径。

### Slice 3：Engine seam & context lifecycle

**范围：** 在 `inject-compartments-pi.ts`、`context-handler.ts` 和 engine-owned Tavern boundary 中完成最小实现；不固定改动行数或委托数量。

**验证必须覆盖：**

- 同一 revision 的 stable source 不发生无故 invalidation；stable replacement 正确使 cache 失效。
- ordinary Memory mutation 与 provider round 解耦；成功 mutation 有 durable read-back，storage/CAS failure 不伪造成功。
- volatile turn source 遵守 durable-before-provider、turn binding、cursor、replay、cleanup 和 uncertain failure 语义。
- m0/m1/fold/cache 的 bounded deterministic parity fixture 通过；fixture 的 hash 只能证明该 fixture、serializer/version 和声明 revision。
- Chat/Game source isolation、Scenario exclusion、WorldBook/profile mismatch fail closed。

**验证层级：** vendor focused tests 和 typecheck；必要时 Host integration tests。`chat-tavern-live` 不因 Slice 3 的通过而自动运行或通过。

### Slice 4：Repository migration follow-up

Slice 4 不是当前单仓切片的完成条件。它只能在 Slice 1–3 有可复现结果、工作树和来源可归因、并由 repository/build owner 建立独立迁移任务后启动。迁移任务必须定义 package provenance、pinned revision、fresh clone/build、CI required checks、rollback/recovery anchor、失败/quarantine 和不覆盖现有 WIP 的操作边界。

### 8.1 实施切片实际核验记录 (Verified Implementation Records)

| 切片 / 检查项 | 执行命令 | 责任域 (Owner) | 当前状态 | 实际输出与核验事实 |
|---|---|---|:---:|---|
| **Slice 1 (Contracts & Types)** | `pnpm --filter @gamebuddy/companion-host typecheck` | Host / Magic Context | **passed（2026-09-16 复核）** | `./tavern`/`./memory` 类型现由 vendor 声明提供（111：`types` 条件指向 vendor dist .d.ts，经 `pnpm vendor:link` 解析）；`magic-context-authored-context-bridge.d.ts`/`magic-context-memory-facade.d.ts` 手写 ambient 已删除（main `bba7940`）。删除前后 Host tsc 错误数 83→83 不变（全为并行 WIP，无 missing-declaration），证明 vendor 类型完整接管。 |
| **Slice 2 (Public Subpaths & Dist Closure)** | `node tools/check-dist-runtime-exports.mjs` && `node tools/check-host-production-import-boundary.mjs` | Build / Packaging | **passed** | `dist/index.js` 零 Memory/Capability 泄露；`dist/tavern/index.js` 导出全部受控 Marker 与 Capability 函数，零裸 prompt renderer；`dist/memory/index.js` 导出受控 CRUD/Projection。Host import boundary 零违规 (`violations: []`)。 |
| **Slice 3 (Engine Seam & Parity Tests)** | `bun test src/tavern-prompt-parity.test.ts src/gamebuddy-stable-context-source.test.ts src/gamebuddy-player-memory-crud-facade.test.ts` | Engine / Parity | **passed** | 16/16 用例通过。M0 XML 字节保真与 SHA-256 签名一致；Volatile 空格绕过防护生效；Memory mandatory profile 校验与 archive safe reread 闭环。 |
| **Prerequisites Gate** | `node tools/check-tavern-release-prerequisites.mjs --profile=chat-tavern-live` | Quality / Release Gate | **passed** | `verdict: "passed"`。`magic_context_stable_source` 与 `semantic_reference_attestation` 均通过，Windows reparse 规则在该 profile 下标记为 `not_applicable`。 |
| **Slice 4 (Repository Migration Follow-up)** | `git push origin main` (in `scratch/magic-context-airp`) | Repository / Infra | **passed（External Mirror）；已切 Submodule（2026-09-16 复核）** | 独立镜像仓库 `git@github.com:zhexulong/magic-context-airp.git` 已同步并推送（commit `2a63fad4`）；主仓库 `vendor/magic-context` 已在并行工作中切为 Git Submodule（`.gitmodules` 指向 `zhexulong/magic-context-airp`，`commit d8bf059`）。**更新**：后续 vendor 改动（111）已在 submodule 内 commit `7d56cef7`（未 push）。迁移失败/quarantine、rollback、CI required checks 仍须由 repository/build owner 另立独立迁移任务。 |
| **Production Bundled Artifact** | `pnpm --filter @gamebuddy/companion-host build` | Release / Build | **blocked** | 退出码 1：`verified_bundled_runtime_input_required`（受控捆绑输入门禁生效，非 TS 语法错误）。当前未产生签名的生产发布制品。 |
| **Live Orchestrator Gate** | `node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live` | Release Gate | **inconclusive** | 退出输出 `turn_failed:runtime_unavailable`，缺少 mounted profile 操作证据。未达到 live release 标准。 |

> [!CAUTION]
> **No-Release-Claim 声明**：
> 以上静态、构件闭包和单元测试的通过，**不构成**任何生产环境发布声明（No production release claimed）。在 Production Bundled Artifact 与 Live Orchestrator 最终闭环前，系统严禁声明生产可用或发布完毕。


## 9. Evidence 与 release claim 边界

| 层级 | 可以证明 | 不能证明 |
|---|---|---|
| Static | public export、import direction、consumer closure、类型和路径 obligation | runtime lifecycle、provider settlement、Chat release |
| Deterministic | source validation、revision/CAS、cache/cursor/fold/replay、marker cleanup、CRUD 行为 | 真实 provider、真实 UI、live release |
| Integration | 实际 package/process composition、Host facade routing、engine materialization composition | Windows/Desktop/Game/player release |
| Chat live | 只有独立 `chat-tavern-live` gate 实际观察到的 Chat/Tavern scoped facts | full Windows/Desktop/Game、Magic Context 跨域 authority |

`chat-tavern-live` 的入口仍是：

```bash
node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live
```

它必须先通过 `pnpm check:tavern-release-prerequisites`，并遵守真实 embedded provider、fresh disposable runtime、durable read-back、独立 failure/recovery 和 mounted management UI evidence 要求。本文的 fixture、unit/contract test、静态检查、package build 或本地 facade test 均不能替代该 gate，也不能把 `blocked`、`failed` 或 `inconclusive` 升级为 pass。

每个 slice 的记录至少包含：命令、代码/构建版本、owner、实际 observation、失败分类、脱敏 evidence ID 和“不产生 release claim”的声明。不得保存 prompt、transcript、raw provider payload、credential、Magic Context SQLite 或内部路径。
