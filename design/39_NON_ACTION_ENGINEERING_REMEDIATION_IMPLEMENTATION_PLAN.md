# 非 Action 工程重复与验证基础设施整改实施计划

**状态：已实施；P0–P11 的代码整改与规定的自动验证已完成。target-live、clean-clone 与 release gate 仍按各自 owner 保持未通过/未运行，不得由本文推断为通过。**
**更新时间：2026-08-15**
**问题来源：** 2026-08-13 至 2026-08-14 对 `design/37` 同类软件工程问题的只读清查；用户已明确排除 Action platform 范围。
**相关 owner：** [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md)、[`32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md`](32_PLAYER_MANAGED_INTERACTION_MEMORY_IMPLEMENTATION_PLAN.md)、[`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md)、[`33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md`](33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md)、[`35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`](35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md)。

本文是本轮获批结果面的 **整改组合、依赖排序与最终验收 owner**。它把两轮只读清查中获批的问题收敛成可分批执行、可删除旧路径、可验证且不会侵入 Action 平台的计划；它不夺取既有领域计划的内核所有权：`design/32` 继续拥有 Magic Context Memory semantic/fork implementation，`design/24` 继续拥有 `TavernArtifactStore` 与 Tavern canonical persistence，`design/35` P6 继续拥有 companion-live fixture/runner/scorer，`design/30` 继续拥有 fresh production continuity authority。本计划拥有这些 owner 之间的 required work cards、Host-side legacy deletion、cross-cutting portfolio 接线和 15 个结果面的最终验收。

[`38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`](38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md) 继续独占 Action execution kernel、Action truth/projection、Host Portfolio lifecycle、Action closure harness、affordance/arrival 与 Action transport/platform。本计划不得复制、替代或提前实施其中任何工作。

**硬依赖顺序：**

```text
P0 dirty-tree baseline + owner lanes + design-state reconciliation
  ├─→ P1 delete obsolete continuity implementation
  ├─→ P2 remove Memory mutation fallback
  ├─→ P3 destructive Tavern compatibility cutover
  ├─→ P4 strict stable JSON reader
  ├─→ P5 secure atomic-file primitive
  ├─→ P6 .NET compilation/test graph repair
  └─→ P7 Stardew static command taxonomy + fixture/preflight/live proof split

P5 → P8 Tavern revision repository
P4 + P6 + P7 → P9 final static portfolio/CI aggregation
P1–P9 stable → P10 Voice protocol package + UTF-8 NDJSON framer
P10 → P11 production exclusions simplification + final verification
```

P1–P7 可在路径完全不相交且每个 shared hub 只有一个 writer 时并行准备。P8 必须等待 P5 的文件写入 seam 稳定；P10 放在后段，避免在 Host/Voice 两个 workspace 尚有其他共享编辑时扩大冲突面。

---

## 1. 已批准范围

### 1.1 非 Action 架构整改

本计划实施以下九项：

1. 删除已被 fresh production authority 取代、且 production artifact 已明确禁止的旧 generic continuity coordinator/backend/store；
2. 移除 Dialogue Memory mutation 的 legacy fallback，只允许 evidence-bound mutation；
3. 删除 Tavern production legacy 文件 fallback、宽松 historical schema 与 resume-or-create conversation adapter；
4. 抽取 Host-owned strict JSON + bounded stable-file reader；
5. 统一安全原子写、temporary ownership 与 identity-verified cleanup；
6. 抽取小型 typed Tavern revisioned-artifact repository；
7. 建立 Host/Voice Gateway 共用的 Voice wire protocol package；
8. 复用 bounded fatal-UTF-8 NDJSON framing primitive；
9. 在旧源码物理删除后，简化 production artifact/import exclusion 清单，同时保留行为级 no-legacy-ingress gate。

### 1.2 不属于 Action platform 的 Stardew 工程整改

本计划同时实施此前清查中获批的六个工程结果面：

1. dirty-tree baseline、owned paths、known failures、命令与 drift gate；
2. 为当前 99 个 Stardew root scripts 建立领域分组、唯一 leaf commands 与 layered aggregate commands，并物理删除被替代alias、重复长chain和proof-class误导入口；
3. 修复 `.NET` production/test compilation graph：solution discovery、TFM 与 test source ownership；
4. 让 companion-live JSON fixture 成为 scenarios/phrases 的唯一内容真相源；
5. 将 deterministic fixture、production admission preflight 与 actual live runner 拆成不同入口和不可混投影的 evidence schemas；
6. 最终形成一个只聚合 static/deterministic 工程门、绝不冒充 live closure 的 Stardew verification portfolio。

这里的第 1 项既是 Stardew 清查结论，也是全计划共同前置门；不会建立第二套 baseline 系统。

### 1.3 明确排除

本计划不修改或设计：

- Mine Entry/Ladder/Elevator coordinator、protocol 或 execution kernel；
- Action descriptor、registry、capability truth/projection、Host typed tools；
- Host Portfolio pending/terminal promise lifecycle；
- shared Action smoke/closure harness 或 action gate descriptor；
- Action transport/platform abstraction；
- Action source-proof/closure platform；
- Action launcher、real live action supervisor 或 action-specific fixture Given；
- current-location affordance、interaction-ready arrival、navigation；
- 大规模 Action 目录重组；
- 任何新 Game Action、capability publication 或 live closure。

若实施某一项必须修改上述 surface，应停止并将该工作移交 `design/38`，不得在本计划中“顺手完成”。

---

## 2. 审计基线与已确认问题

调查时工作树有约 **227 个 status entries**，root `package.json` 中有 **99 个名称含 `stardew` 的 scripts**。这些数字仅是调查快照，不是未来实施 authority；P0 必须重新采集。

### 2.1 Continuity 旧实现仍以完整可执行形态存在

以下旧链路在 production artifact/import gate 中已被禁止，却仍保留 production-like implementation 与独立 tests：

```text
host/src/continuity-authority-coordinator/
host/src/continuity-semantic-backend/
host/src/continuity-semantic-store/continuity-semantic-store.ts
host/src/continuity-semantic-store/continuity-semantic-store.production-internal.ts
host/src/continuity-semantic-store/continuity-semantic-store.test.ts
host/src/continuity-semantic-store/continuity-semantic-store.initial-saga.test.ts
```

新 production authority 已由 `continuity-semantic-production-store.ts`、provisioning、production coordinator、deployment composition 和 Chat/Game materializer 拥有。旧 generic 链路不是安全 fallback，也不是第二 adapter，而是应删除的被替代实现。

### 2.2 Memory HTTP mutation 有两条 authority 路径

`host/src/dialogue-web-main.ts` 同时构造普通 `GameBuddyMemoryFacade` 和可选 `GameBuddyPlayerMemoryEvidenceFacade`。`host/src/dialogue-web.ts` 在 evidence facade 不存在时回退到普通 mutation，并为 `exclude-source` 保留单独 fallback。这使同一玩家 mutation contract 依赖环境变量决定是否经过 next-round evidence。

目标不是删除查询能力，而是将接口分成：

```text
read projection: list/get only
mutation capability: evidence-bound only
```

没有 evidence capability 时，mutation route 不注册或稳定返回不可用；绝不能切换到较弱写路径。

### 2.3 Tavern 仍保留 production compatibility 路径

当前至少存在：

- `scenario-management/scenario.json` fallback；
- `greeting-management/greetings.json` fallback；
- Persona 中遗留的 legacy path surface；
- `openTavernConversation()` resume-or-create adapter；
- `chat-thread-store.ts` 对 historical opening source 的 read compatibility；
- tests 对上述行为的正向固化。

本项目不要求向后兼容。SillyTavern Card/Chat/World Info 的受控 candidate/import compatibility 由 `design/24` 保留；production runtime 文件 fallback、latest/resume 猜测和 historical schema 宽容不属于该兼容范围。

### 2.4 严格 JSON 与 bounded stable read 被重复实现

`host/src/deployment-manifest.ts` 与 `host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.ts` 分别维护几乎相同的：

- 64 KiB bounded handle read；
- before/after file size/identity stability check；
- fatal UTF-8 decode；
- 深度上限；
- escaped-equivalent duplicate-key detection；
- `JSON.parse` 前 fail closed。

`companion-control-protocol.ts` 与 continuity provisioning 也有 strict JSON parser，但它们分别属于 wire codec 与 bootstrap admission。本计划先抽取已确认完全同构的 **Host config-file** seam；其他调用方只有经行为 characterization 证明错误语义一致时才迁移。

### 2.5 文件写入安全语义多处复制

`host/src/path-lock.ts::atomicWriteFile()` 已实现 exclusive temporary、inode identity 与 cleanup；但 Tavern artifact、World Info、Chat Draft、Run Manifest、Model Profile 等仍维护不同的 temporary/rename/cleanup 变体。`tavern/artifact-store.ts` 与 `world-info-management.ts` 还重复定义 `TemporaryFileIdentity`。

本计划统一机械写入 seam，但保留调用方各自的 revision、CAS、overwrite、journal 与 authority 语义。

### 2.6 Tavern revision traversal 重复

Persona、Scenario、Greeting 各自重复：

- `revisions/<n>.json` path；
- 数字 revision enumeration/sort；
- latest valid read；
- exact id/revision validation；
- corrupt canonical revision 的 fail-closed policy；
- create/update conflict mapping。

目标是小型 typed repository，不是通用 CRUD framework。

### 2.7 Voice wire contract 与 framing 双真相

Host 与 Voice Gateway 分别写死 protocol version、Request/Response/Event 类型、limits 和 validators。当前 framing 还有不同限制与实现：Host response buffer 约 64 KiB，Gateway request buffer 约 16 KiB；Gateway 使用字符串累计，而 Companion Control 已有 fatal UTF-8、split multibyte 与 trailing-frame contract。

目标是共享 wire facts 与纯 framing module；transport、authentication、capture、ASR/TTS、queue、STOP 和 device lifecycle 继续分离。

### 2.8 `.NET` solution 未发现 projection executable tests

当前 `GameBuddy.sln` 只包含 `integrations/stardew/GameBuddy.Stardew.csproj`。`integrations/stardew/tests/PortfolioMineElevatorProjection.Tests.csproj`：

- 未加入 solution；
- 使用 `net8.0`，production Mod 使用 `net6.0`；
- 通过多个手工 `<Compile Include=... Link=...>` 复制 production source compilation graph；
- 是 console executable test，不会被 `dotnet test GameBuddy.sln` 自动发现。

这意味着“solution build green”不包含该测试编译面，手工 Link 也可能随 production source 变化而漂移。

### 2.9 Companion-live fixture 与 runner proof class 混杂

`tools/lib/stardew-companion-live-scenario.mjs` 内嵌完整 canonical scenarios 与 phrases，同时 `fixtures/stardew/companion-live/*.json` 又保存相同内容；JSON 不是唯一真相源。

`tools/run-stardew-companion-live-scenarios.mjs --mode real` 当前实际只做 production admission preflight，而 `--mode deterministic_fixture` 才运行 scenario suite。名为 “real” 的入口没有实际 Host/Mod/bridge/live mutation，因此存在证据误标风险。

---

## 3. 不变量与 seam 决策

### 3.1 删除优先于 compatibility

被替代的 production path 直接删除：

- 不保留 dual read/write；
- 不保留 environment-selected fallback；
- 不保留 legacy schema reader；
- 不新增 migration/adoption；
- 不使用 deprecation wrapper 延迟删除；
- tests 在新 seam 上重写后删除旧 implementation-specific tests。

### 3.2 深模块而非 helper 集合

每个新模块必须通过 deletion test：删除后复杂度会重新散落到多个 caller，才值得存在。计划批准的 seam 只有：

```text
readStrictStableJsonFile(path, filePolicy, validate)
atomicWriteOwnedFile(path, bytes, writePolicy)
openRevisionRepository(spec)
createNdjsonDecoder(policy)
@gamebuddy/voice-protocol codec/validators
```

最终方法名可在 P0 characterization 后收窄，但不得扩成通用 filesystem framework、通用 artifact ORM、通用 IPC runtime 或任意 protocol registry。

### 3.3 安全 authority 不合并

必须保持独立：

- Chat 与 Game production lifecycle/materializer/binding；
- continuity SQLite 与 Magic Context SQLite；
- Tavern artifact CAS 与 continuity authority CAS；
- Voice transport/auth 与 Companion Control transport/auth；
- Windows mutex broker authority 与 ordinary NDJSON framing；
- Memory semantic command ownership与 Host HTTP evidence admission；
- deterministic fixture、production preflight、process smoke 和 target-live evidence。

机械模块不能返回或持有 authority-bearing permit、lease、principal、scope、capability、receipt 或 mutable domain state。

### 3.4 证据不可升级

遵守 `design/33`：

```text
static < deterministic < process < clean-room < clean clone < target live
```

- `verify:stardew:static` 只证明列入 manifest 的 static/deterministic gates；
- `.NET` projection executable 只证明纯投影/protocol contract；
- deterministic companion fixture 不能生成 `real`/`live` evidence；
- production preflight 只能生成 admission record；
- actual live runner 必须使用真实 GameBuddy Host/SDK、正式 Mod bridge、target game 与 authoritative receipt；未实现时保持 `blocked`，不得用 preflight 代替。

---

## 4. 工作树与 owner lanes

### 4.1 P0 baseline artifact

实施前创建 repository-local、非 production authority 的 baseline，建议路径：

```text
design/references/non-action-remediation/baseline-v1.json
```

至少记录：

```text
schemaVersion
capturedAtUtc
HEAD / branch
statusPorcelainV2Sha256 + readable summary
staged / unstaged / untracked separation
trackedDiffSha256
allowlisted untracked relative paths + content hashes
owned lanes + writable/prohibited paths
shared integration owner
known failing commands and exact exit status
focused command inventory
```

采集命令至少包括：

```bash
git status --short --branch
git status --porcelain=v2 -z
git diff --stat
git diff --name-status
git diff --check
```

baseline 不清理、不吸收、不认领 unrelated change。每个 lane 开始写入与最终验证前都重新计算 drift；非 allowlisted drift fail closed。

### 4.2 Owner lanes

| Lane | 初始 owned paths | 共享写入约束 |
|---|---|---|
| A — Continuity deletion | old generic continuity directories/files；production artifact/import checks | 与 P11 共用 checks 时由同一 integration owner 串行 |
| B — Memory Host cutover | `dialogue-web-main.ts`、`dialogue-web.ts`、Host-side Memory facade declarations/tests | `vendor/magic-context` 变更是 `design/32` owned prerequisite；本 lane 不改 Memory taxonomy/SQLite/semantic command implementation |
| C — Tavern cutover/repository | Tavern management/conversation/thread files及 tests | persistence/repository seam 必须作为 `design/24` owned `TavernArtifactStore` 内部实现；`artifact-store.ts`、`path-lock.ts` 与 Lane D/E 串行集成 |
| D — Strict JSON | deployment manifest、operator selection、新 Host config reader及 tests | 不同时修改 continuity provisioning parser |
| E — Secure file | `path-lock.ts`、选定 caller 与 tests | 每次只迁移一个 caller family；不与 Tavern repository 并发写 shared files |
| F — .NET graph | solution、test project/Program、必要的 non-semantic build metadata | 禁止修改 Action coordinator/protocol semantics |
| G — Stardew command/evidence portfolio | root scripts、test portfolio与 cross-cutting aggregate tests | companion-live fixture/runner/scorer由 `design/35` P6 单独拥有；本 lane只消费其稳定 leaf commands/schemas，且不触碰 `design/38` action harness/runner internals |
| H — Voice protocol | 新 shared workspace、Host Voice client、Voice Gateway server/gateway/tests | Host/Voice 各一个 writer，由一名 integration owner完成最终 cross-workspace cutover |
| I — Documentation integration | 本文、`design/README.md`、`design/04`、`05`、`08`、`24`、`28`、`32`、`33`、`34`、`35` 的边界/required-card/status同步 | 不复制各领域backlog；只修改其设计原则、owner pointer、required work card与状态漂移 |

任何 lane 需要改 `package.json`、`pnpm-workspace.yaml`、Host production build scripts、`.ci/test-portfolio-manifest.v1.json` 时，必须由 integration owner 串行落地。

### 4.3 先修文档状态漂移

`design/24` 仍有“fresh authority replacement 尚未 mount”的历史文字，而 `design/30` 与当前 entrypoint 已声明 S0–S5 mounted。P0 只修正状态与引用：

- `design/30` 继续是 fresh authority mount 的 source of truth；
- 不把 S6/live/release pending 误写成已完成；
- 不让 `design/24` 的旧状态为 production legacy fallback 提供理由；
- `design/35` 的 R0–R4 只作为相关 release/clean-room 约束；其 P6 继续拥有 companion-live fixture/runner/scorer，本计划通过 required work card消费该结果，不形成第二 owner；
- P0 documentation integration 同步 `design/04/05/08/24/28/32/33/34/35`：设计文档只冻结no-fallback、single-owner、proof-class separation与protocol/framing边界；具体依赖顺序和最终15项验收只留在本文。

---

## 5. 实施阶段

## P0 — Baseline、characterization 与 scope freeze

### 工作

1. 写 baseline artifact 与 owner lane manifest；
2. 列出每项旧 path 的 production consumer、test consumer、artifact/import checker consumer；
3. 为 strict JSON、atomic write、Tavern revision、Voice framing 保存当前行为矩阵与 error taxonomy；
4. 为 `.NET` solution/project graph输出 machine-readable project/TFM/source ownership inventory；
5. 为 99 个 Stardew scripts 记录 `{name, family, evidenceKind, owner, leafOrAggregate, requiredOn, command}`；
6. 为 companion-live 三种 proof class 冻结当前命令、真实行为、输出 schema 和禁止 claim；
7. 修正 `design/24` 相对 `design/30` 的 mount 状态漂移；
8. 独立 reviewer 确认排除项没有 production write path。

### Exit gate

- baseline 可重放，shared owner 无冲突；
- 15 个获批结果面全部有 phase、owner、tests，以及明确的变更与删除处置（新增／替换／保留／物理删除）；
- `design/38` owned paths 全部列入 prohibited paths；
- 当前测试失败被记录，不以“本来就失败”隐藏新回归；
- P0 不修改 production behavior。

---

## P1 — 删除旧 generic continuity implementation

### 删除范围

删除旧 generic coordinator/backend/store public/internal implementation及只服务于它们的 tests：

```text
host/src/continuity-authority-coordinator/**
host/src/continuity-semantic-backend/**
host/src/continuity-semantic-store/continuity-semantic-store.ts
host/src/continuity-semantic-store/continuity-semantic-store.production-internal.ts
host/src/continuity-semantic-store/continuity-semantic-store.test.ts
host/src/continuity-semantic-store/continuity-semantic-store.initial-saga.test.ts
```

保留且不得误删：

```text
continuity-semantic-production-store.ts + tests
continuity-semantic-deadline-cancellation.internal.ts
production physical-fixture worker（若仍只消费 production store）
provisioning / production coordinator / deployment composition
Chat/Game runtime construction, materializer, binding, recovery tests
```

### Cutover 规则

1. 先证明 production entry graph 只消费新 authority；
2. 删除旧实现和旧行为 tests；
3. production artifact denylist 中对已不存在具体文件的枚举移到 P11 简化；
4. 仍保留 checker mutation fixture：若未来重新新增 generic legacy module/import，行为级 no-legacy gate必须失败；
5. 不创建 type alias、compatibility export 或 forwarding adapter。

### 验收

- source graph 与 build artifact 均无旧模块；
- fresh production store/provisioning/coordinator focused tests全绿；
- production artifact inventory 和 import-boundary checker 全绿；
- negative checker fixture 能捕获人为重新引入的 legacy module/import；
- S6/live 状态不因代码删除被误报为通过。

---

## P2 — Memory 单一 mutation authority

### 目标接口

Host 只接收：

```ts
type DialogueMemoryReadProjection = {
  listMemories(...): Promise<readonly DialogueMemoryView[]>;
  getMemory(...): Promise<DialogueMemoryView>;
};

type DialogueMemoryMutationCapability = {
  // every mutation requires Host-minted PlayerMemoryNextRoundEvidence
  createMemory(...): Promise<EvidenceMutation<DialogueMemoryView>>;
  updateMemory(...): Promise<EvidenceMutation<DialogueMemoryView>>;
  // archive/restore/pin/unpin/merge/delete/exclude-source likewise
};
```

实际命名可调整，但 read 与 mutation authority 必须在类型和 construction 上分开。

### Owner handoff

`design/32` 是 Magic Context Memory semantic mutation contract、state token/validator、SQLite与 fork-side facade implementation的唯一 owner。本阶段在 `design/32` 下先完成一个 prerequisite card：为所有获批玩家 mutation（包括 `exclude-source`）提供冻结的 evidence-bound facade contract和focused tests。本计划不得在 fork 内另建 Memory command/SQL/validator实现；只消费该稳定 contract并验收它满足本阶段的Host cutover前置条件。

### 工作

1. Host 将普通 facade收窄成查询/内部 Agent semantic command所需接口，不再作为玩家 HTTP mutation fallback；
2. 消费 `design/32` 提供的 evidence-bound `exclude-source` mutation，删除普通 facade特例；
3. `dialogue-web-main.ts` 只有在 exact provider/session/nonce evidence coordinator 成功构造时才挂载 mutation capability；
4. `dialogue-web.ts` 的 bootstrap contract 分别报告 read availability 与 mutation availability；
5. 无 mutation capability 时，写 route 不注册或稳定返回 fail-closed unavailable；
6. 删除 `handleMemoryMutation()` 中 legacy branch和对应Host旧 facade write types；
7. Host只调用 frozen fork contract，不复制第二套 SQL/semantic command/state-token/validator rules；
8. 关闭时只关闭实际挂载的 evidence mutation facade/coordinator。

### Characterization

必须先覆盖：

- read 可用、mutation capability 缺失；
- nonce 缺失/错误、session/surface mismatch；
- active/draining turn 拒绝；
- create/update/archive/restore/pin/unpin/merge/delete/exclude-source 全部需要 evidence；
- stale token/CAS conflict；
- commit receipt mismatch、late marker、double mutation；
- browser不能提供 continuity/path/provider binding；
- error/redaction不泄漏 Memory正文、SQLite path、raw marker或 provider payload。

### Exit gate

- 任意环境配置都无法使玩家 HTTP mutation绕过 evidence；
- read-only query 不依赖 mutation nonce；
- Magic Context 仍是 Memory semantic/SQLite owner，Host只拥有 auth/evidence/HTTP adapter；
- `design/32` 的 Memory taxonomy、m[1] 与 auto-promotion gate未被本计划重写。

---

## P3 — Tavern destructive compatibility cutover

### 删除范围

1. 删除 Scenario/Greeting 的 legacy singleton-file fallback；
2. 删除 Persona 未使用的 legacy path及所有对应 compatibility tests；
3. 以显式 `createTavernConversation()` 与 `resumeExactTavernConversation()` 替换 `openTavernConversation()`；
4. caller 必须明确提供操作意图和 exact thread identity；不存在时不自动 create，已存在时不自动 resume；
5. 删除 `chat-thread-store` historical opening source/schema宽容；canonical schema 不匹配直接失败；
6. 删除“canonical absent则读 legacy、canonical corrupt则尝试更旧/legacy”的正向行为。

### 保留范围

- ST Card/Chat/World Info candidate-first safe import；
- explicit external archive/content disposition；
- current canonical Tavern revision tree；
- new thread explicit blank/greeting opening；
- exact current-thread recovery；
- `design/30` 的 fresh continuity authority。

保留的 import adapter 只能生成 reviewed candidate，不得成为 production runtime read fallback。

### 数据处置

这是 pre-release destructive cutover：

- 不自动迁移 legacy singleton files；
- 不从 legacy文件推断 current companion/thread；
- 如需保留样例，仅复制为 test fixture并明确 `non_production_legacy_fixture`；
- production root 发现 legacy file 时按 P0 inventory/disposition policy阻断或忽略为非 authority，不读取其内容建立 runtime state。

### Exit gate

- production code对 `scenario.json`、`greetings.json` 与 resume-or-create adapter零引用；
- create/resume exact negative matrix全绿；
- corrupt/missing/stale current revision fail closed；
- ST candidate/import tests继续通过；
- `design/24` 文档与 `design/30` mounted状态一致。

---

## P4 — Host strict stable JSON reader

### 外部 seam

建议一个 Host-internal 深模块：

```ts
readStrictStableJsonFile<T>({
  path,
  maxBytes,
  maxDepth,
  containment?,
  validate,
  mapError,
}): Promise<T>
```

接口不暴露 file handle、parser cursor、raw mutable object或通用 filesystem adapter。`validate` 是 domain validator；`mapError` 将内部失败收敛为调用方已有稳定错误码。

### Implementation 必须隐藏

- open-by-handle bounded read；
- before/after identity、type、size stability；
- fixed upper-bound allocation；
- fatal UTF-8 + BOM policy；
- duplicate decoded key detection，包括 escaped-equivalent keys；
- JSON depth、trailing bytes、invalid number/string/literal拒绝；
- `JSON.parse` 后 exact data-object admission；
- handle close 与 redacted error mapping。

### 首批迁移

仅迁移：

- `loadHostDeploymentManifest()`；
- semantic game operator selection config loader。

continuity provisioning、Companion Control codec 等只有在后续 characterization 证明 interface/error policy相同后才迁移；本计划不强求全仓替换。

### Tests

共享 interface tests覆盖：duplicate nested/escaped key、deep input、invalid UTF-8、BOM、oversize、short/changed read、non-file、symlink/reparse policy、trailing input、validator rejection、read error redaction。调用方 tests只保留各自 schema/runtimeRoot/operator规则，不重复 parser矩阵。

### Exit gate

- 两个 caller无 duplicate parser/bounded-reader implementation；
- 旧 exact domain error code不变；
- shared tests替代重复 parser tests，调用方 schema tests仍可读；
- 无通用配置 registry或动态 schema dispatch。

---

## P5 — Secure atomic-file primitive

### 目标 seam

深化现有 `path-lock.ts`，而不是另建第二套文件安全库。接口至少表达两件事：

```ts
withPathLock(target, transaction, policy)
atomicWriteOwnedFile(target, bytes, policy)
```

`atomicWriteOwnedFile` 内部拥有：

- containment/no-reparse verification；
- exclusive temporary create；
- temporary `{dev, ino}` identity；
- bounded write + close；
- rename/no-overwrite/CAS mode中明确的一种；
- identity-verified cleanup；
- primary error 与 cleanup error disposition；
- 可选、明确支持的平台 durability policy。

### 不得合并的 caller policy

- Tavern artifact revision/CAS；
- World Info generation swap；
- Chat Draft overwrite semantics；
- Run Manifest immutability；
- Model Profile update policy；
- continuity SQLite transactions。

### 增量迁移顺序

1. characterization `path-lock.ts` 当前 contract；
2. `tavern/artifact-store.ts` 与 `world-info-management.ts` 删除重复 `TemporaryFileIdentity`；
3. Chat Draft；
4. Run Manifest 与 Model Profile；
5. 每迁移一类即删除旧 temporary/cleanup implementation，不保留 wrapper；
6. 若 caller要求不同 rename/CAS semantics，先增加窄 policy variant及 tests；不能让 caller绕过 seam。

### Security tests

- outside sentinel；
- symlink/junction/reparse ancestor和leaf；
- parent/temporary replacement barrier；
- temporary identity substitution；
- rename failure；
- cleanup failure；
- concurrent writer/lock timeout；
- crash留下 temporary的明确 operator/recovery policy；
- primary error不被 cleanup error伪装。

### 声明限制

这是 path-based defense-in-depth，不声称在同权限 hostile process任意竞态下具备 descriptor-relative `openat` 等价安全。若 threat model要求 hostile same-user race proof，另开 OS-specific设计，不在本计划扩大承诺。

---

## P6 — `.NET` production/test compilation graph 修复

### 决策门

P0 必须在两种方案中选择并记录理由：

**首选方案 A：真实 test project + ProjectReference**

```text
GameBuddy.Stardew.csproj
  ← ProjectReference
GameBuddy.Stardew.Tests.csproj
```

- production需要被测试的 pure/internal types通过 `InternalsVisibleTo` 或窄 public projection seam暴露；
- test project与production使用兼容 TFM；
- 引入成熟 test SDK/framework前先检查现有依赖与离线 restore约束；
- 加入 solution，`dotnet test GameBuddy.sln` 可发现。

**允许方案 B：显式 executable contract-test project**

若当前环境不允许新增 test framework，可保留 console executable，但必须：

- 重命名为不冒充 `dotnet test` 自动发现的 contract-test project；
- 加入 solution；
- 使用 `ProjectReference` 消费production assembly，而非手工 Compile Link；
- 在 root aggregate中显式 `dotnet run --project ...`；
- evidenceKind标为 `deterministic_contract`。

### 禁止

- 继续以手工 `<Compile Link>` 复制 production source graph；
- 仅加入 solution但仍不执行 test entry；
- 为统一 TFM 将 production Mod任意升级到未验证 target framework；
- 修改 Action semantic implementation来迁就 test project；
- 把 pure projection green声称为真实 Mod/game evidence。

### Exit gate

- solution列出 production与test/contract-test project；
- TFM兼容决策有 target SMAPI/Stardew build证据；
- production source只编译一次，test通过assembly reference消费；
- `dotnet build GameBuddy.sln --configuration Release`全绿；
- 选定的 `dotnet test` 或 `dotnet run` aggregate实际执行并输出非零失败；
- negative canary证明删除一个test project/entry会使aggregate失败。

---

## P7 — Stardew commands、fixture source 与 proof-class cutover

### Owner handoff

P7A 的 command portfolio与aggregate接线由本计划拥有。P7B/P7C 是 `design/35` P6 harness foundation的 required work card：`design/35` 继续独占 `fixtures/stardew/companion-live/**`、scenario loader、runner、scorer及其direct tests；本计划只冻结验收条件、消费其稳定 leaf commands/schemas并拒绝错误证据升级。实施时不得由两个lane同时写这些文件。

### P7A：Stardew scripts 的分类与破坏性命令收口

建立 versioned command portfolio，建议扩展 `.ci/test-portfolio-manifest.v1.json` 或新增由其引用的：

```text
.ci/stardew-verification-portfolio.v1.json
```

每项至少记录：

```text
id / existingScript
owner / riskId
evidenceKind
family: scaffold | portfolio-contract | source-audit | source-realization |
        native-universe | fixture | process-preflight | live
leafOrAggregate
requiredOn
requires / timeout / retryPolicy
```

P0先按exact implementation/evidence owner去重。真正唯一且语义清楚的leaf script可保留稳定名称；仅alias/legacy拼写/重复长chain/把fixture或preflight伪装成live的旧script必须在新portfolio和runbook同步后物理删除，不保留forwarding compatibility。root `package.json` 只新增少量 discoverable aggregate：

```text
verify:stardew:static
verify:stardew:contracts
verify:stardew:preflight
```

实际名字可根据现有 conventions微调。aggregate从 manifest读取或由单一 runner解析，不在 package.json复制长 command chain。

### P7B：JSON 是 companion-live content唯一真相源（`design/35` P6 实施）

下列变更由 `design/35` P6 owner落地，本计划按其输出验收：

1. 删除 `stardew-companion-live-scenario.mjs` 内嵌 `CANONICAL_SCENARIO_MANIFEST` 与 `CANONICAL_PHRASE_MANIFEST` 内容副本；
2. loader从 `fixtures/stardew/companion-live/scenarios.v1.json` 与 `phrases.zh-CN.v1.json` 读取；
3. validator固定 schema、IDs、topology、bounds、run order references、integrity digest和exact keys；
4. run order如是执行策略，保留在代码；scenario/phrase内容只在JSON；
5. fixtures hash进入portfolio/证据记录；
6. mutation tests修改JSON输入并验证validator fail closed，不用源码token比较。

### P7C：三种入口彻底分离（`design/35` P6 实施）

由 `design/35` P6 owner建立三个不同命令与模块边界；本计划只将其登记到portfolio并验证不可跨class投影：

```text
run:stardew-companion-fixture
  input: deterministic control adapter + fixture JSON
  output: gamebuddy_stardew_companion_fixture_evidence/v1

check:stardew-companion-production-admission
  input: profile/operator/runtime/transaction/artifact metadata
  output: gamebuddy_stardew_companion_admission_record/v1

run:stardew-companion-live
  input: immutable admitted artifact + formal Host/SDK + Mod bridge + target game
  output: gamebuddy_stardew_companion_live_evidence/v1
```

规则：

- 删除 `--mode real|deterministic_fixture` 多态入口；
- preflight命令名称不得含义上声称运行scenario/live；
- fixture adapter flag只存在于fixture入口；
- live入口不得接受fixture adapter、handcrafted summary或`--preflight-only`；
- scorer按schema discriminator拒绝跨class输入；
- actual live runner尚未实现完整正式 attachment/bridge evidence时，命令以 machine-readable `blocked` 退出，不调用preflight冒充成功；
- 真实live场景、fixture、runner、scorer与direct tests所有权继续在 `design/35`；本计划只完成portfolio登记、cross-class rejection验收与aggregate接线。

### Exit gate

- JSON/JS内容只有一份；
- 三个命令、schemas、artifact roots和tests互不兼容；
- `verify:stardew:static` 不执行或统计 live gate；
- portfolio能列出99个旧scripts的归属，未分类新script fail closed；
- package scripts数量不作为KPI；成功标准是可发现、单一归类、无重复alias/长chain与无证据混投影；被替代alias/多态入口已物理删除。

---

## P8 — Tavern typed revision repository

### 依赖与 owner

P3 已删除 legacy fallback；P5 secure atomic write稳定。不得在 legacy/canonical双读仍存在时抽 repository，否则会把 compatibility固化进新 seam。`design/24` 继续拥有 canonical Tavern persistence；本阶段只能把下述repository实现成 `host/src/tavern/artifact-store.ts` 的 typed internal seam（或同目录中由其唯一导出的内部模块），不能建立平行 persistence/revision authority。本计划拥有去重验收，不拥有第二个Tavern repository contract。

### Interface

建议在 `TavernArtifactStore` 内部提供窄 typed seam：

```ts
openRevisionRepository<T, View>({
  root,
  artifactKind,
  id,
  validateArtifact,
  project,
  mapConflict,
}): {
  readLatest(): Promise<View | undefined>;
  create(buildRevisionOne): Promise<View>;
  update(expectedRevision, buildNext): Promise<View>;
}
```

Repository隐藏：revision path、safe enumeration、numeric sorting、artifact read/write、ID/revision cross-check、CAS/conflict。领域模块继续拥有：stable ID derivation、text bounds、artifact shape、projection、error names和业务规则。

### Corrupt revision policy先冻结

当前 Persona测试允许最新revision损坏后回退更旧有效revision，而审计目标要求canonical corruption fail closed。P8开始前必须统一为：

- 缺少更高revision：可返回latest现有；
- 存在声称为revision的文件但损坏、ID不符或revision不符：整个read fail closed；
- 非revision垃圾文件：按明确policy拒绝，而不是静默忽略；
- 不回退legacy或更旧revision掩盖corruption。

### Exit gate

- Persona/Scenario/Greeting通过同一repository interface；
- 三个领域模块只保留真实差异；
- 新interface methods不超过实际caller需求；
- tests从旧private helper迁到repository interface与领域projection；
- 未建立generic CRUD、migration framework或跨artifact dynamic registry。

---

## P9 — Stardew static verification portfolio 收口

P9 在 P4、P6 与 P7 全部稳定后，将 P6 与 P7 接入一个分层入口，但不吞并 leaf commands。P6 的项目发现、TFM决策、ProjectReference/contract entry和negative canary未完成时，P9不得通过：

```text
verify:stardew:static
  ├─ solution/build graph + projection contract entry
  ├─ scaffold/manifest/isolation structural gates
  ├─ declared source audit/realization deterministic suites
  ├─ fixture schema/integrity tests
  └─ portfolio completeness/drift checker
```

输出必须逐项记录：command、exit code、duration、evidenceKind、artifact/input identity、skipped/blocked reason。不得将所有项目压成一个没有细目证据的绿色 exit code。

### Exit gate

- 新增/删除/改名任何 Stardew leaf command都必须更新portfolio；
- aggregate失败时定位到leaf与riskId；
- live/manual entries显示为 `not_run`/`blocked`，不计入pass denominator；
- CI manifest至少能选择此aggregate或其稳定families；
- 本阶段不启动游戏、不执行target mutation。

---

## P10 — Voice protocol package 与 bounded UTF-8 NDJSON framer

### Workspace/模块布局

优先新增最小 project-owned workspace：

```text
packages/voice-protocol/ 或 voice-protocol/
  package.json: @gamebuddy/voice-protocol
  src/wire.ts
  src/codec.ts
  src/ndjson.ts
```

最终路径由 P0 检查现有 workspace convention后确定。该包无 Host、audio、provider、socket lifecycle依赖。

### Voice protocol owner

共享包唯一拥有：

- protocol version；
- Request/Response/Event discriminated unions；
- exact allowed keys、ID/token/reason bounds；
- encode request/response；
- variant-complete validators；
- wire byte limits；
- version mismatch错误分类。

Host client与Gateway server删除各自的 duplicated types/constants/partial validators。Host的 `validResponse()` 必须变成 shared variant validator，不能只检查 object/type/requestId。

### NDJSON framer

纯 module interface：

```ts
createBoundedUtf8NdjsonDecoder({ maxRecordBytes, maxBufferedBytes })
  .push(bytes): readonly string[]
  .finish(): void
```

必须处理：split multibyte、fatal malformed UTF-8、CRLF policy、empty record、oversize before newline、multiple records、trailing incomplete frame、buffer reset after failure。

首批消费者：

- Voice Gateway server request ingress；
- Host Voice Gateway client response ingress；
- Companion Control仅在characterization证明error contract兼容时迁移，否则保持既有codec并复用底层decoder；
- Windows mutex broker/sidecar只允许复用framer，不合并authority/auth/state machine。

### Cross-process tests

- package contract tests；
- Host client against fake Gateway；
- real Gateway server against protocol encoder；
- chunk permutation与malformed/oversize矩阵；
- handshake/version、每种response/event variant；
- server在坏peer后仍服务第二client；
- late/unknown requestId、duplicate terminal与close行为保持caller-owned。

### Exit gate

- protocol version/limits/types/validators单一owner；
- Host/Gateway无本地复制的wire union；
- framing limits按direction明确，不因“统一”被意外放宽；
- capture/ASR/TTS/STOP/device lifecycle tests保持原owner；
- deterministic process tests不声称真实硬件/provider证据。

---

## P11 — Production checks 简化与最终切换

### 工作

1. P1物理删除后，删去 production artifact中对不存在具体旧文件的长期枚举；
2. 保留并重命名为行为/类别级检查：
   - production entry不可到达任何 legacy continuity namespace或signature；
   - production artifact inventory不可包含test/fixture/legacy authority module；
   - mutation fixture人为新增旧模块/import时checker失败；
3. 更新 `tools/check-host-production-import-boundary.mjs`、tests与 `host/scripts/production-artifact*`；
4. 删除仅为旧源码存在而维护的例外和重复 fixture；
5. 运行全计划验证矩阵和独立review；
6. 更新 `design/README.md`，将本文登记为当前implementation owner；
7. 复核 `design/04/05/08/24/28/32/33/34/35` 的required cards和status，保证没有文档仍授权被删除fallback、部分Voice validator或三proof class多态入口。

### Exit gate

- checker更小但防线不弱：物理删除 + 类别级反重引入；
- production artifact从fresh output构建，无orphan/stale旧文件；
- no-legacy-ingress、no-test-support、resource inventory保持fail closed；
- 所有被替代implementation/tests/wrappers均删除，无dead compatibility layer。

### 实施状态（2026-08-15）

- **已完成并实测：** 旧 generic continuity source paths 均已物理删除；production artifact 检查由精确旧文件枚举改为 legacy namespace matcher，并对每个旧 namespace 的嵌套重引入做 negative mutation test；`host` typecheck、fresh production build、artifact inventory、production import-boundary、artifact tests及import-boundary tests均通过。
- **已验证的 P0–P10 结果：** Host continuity/P3–P5/P8 定向矩阵、P2 Host + Magic Context evidence 矩阵、P6 target assembly `Release` build与两个 compiled contract executables、P7 deterministic fixture/production-admission/target-live class separation、P9 target-aware static portfolio、P10 Voice tests/typecheck/build均已运行；每项的真实环境 `blocked` 不计为 pass。
- **已关闭的 hygiene 子门：** `GameBuddy.sln` 的 UTF-8 BOM、`host/src/farmhand-companion-preview.test.ts` 的 trailing whitespace、`host/tmp-rewrite-game-tools.mjs` 的 final newline，以及受管 `tools`/`host/src`/`voice-gateway/src`/`dialogue-web/src` 的 Biome 格式已统一；`pnpm quality:check`、`git diff --check` 均通过。该机械 hygiene 清理不改变任何 Action bridge 行为或 `design/38` ownership。
- **已关闭的 P11 总门：** `design/38` owner 已完成窄 `presentationLocale` bridge migration：Host `Snapshot` 与 Mod `BridgeSnapshot` 都将 locale 设为必填，Host 对 `hello_ack`/`snapshot` 的缺失或非法 BCP-47 值 fail closed，Mod 从 native game locale 取得并在无效/抛错时拒绝发布，golden fixture 亦已同步。当前工作树实测 `pnpm --filter @gamebuddy/companion-host test`、`pnpm quality:check` 与 `git diff --check` 全部通过。Windows junction 对抗 fixture 还将 rename/lstat invariant 与可跳过的 junction creation 分离，避免将安装失败误记为环境 skip；其 focused suite 和独立 review 均通过。
- **仍不得声称：** 以上是当前脏工作树的工程自动验证，不是 clean clone、真实 target-live、完整 Portfolio closure 或 release evidence；这些门继续由各自 Action/Companion owner 负责。

---

## 6. 验证矩阵

具体命令以实施时 `package.json` 与 baseline为准；下表冻结最低验证责任，不允许以较低层替代较高层。

| Slice | 最低自动验证 | 额外证据 | 不可声称 |
|---|---|---|---|
| P0 baseline | baseline schema/hash/drift tests；`git diff --check` | independent scope review | clean tree / clean clone |
| P1 continuity deletion | Host typecheck、production store/coordinator/composition focused tests、production artifact/import checks | fresh output inventory | S6/live/release passed |
| P2 Memory | Host dialogue tests；Magic Context fork typecheck + focused facade/evidence tests | process-level Dialogue route test | real provider next-round gate，除非实际运行 |
| P3 Tavern cutover | management/conversation/thread exact create/resume/corruption tests；Tavern import tests | explicit archived-fixture disposition review | Tavern live/release |
| P4 JSON | shared parser/stable-read security matrix + two caller schema suites | mutation fixtures | hostile same-user race proof |
| P5 file write | `path-lock` + caller security/race tests | Windows junction/reparse focused run | descriptor-relative TOCTOU elimination |
| P6 .NET graph | `dotnet build GameBuddy.sln --configuration Release` + actual test/contract entry | project/TFM/source inventory | Mod/game/live behavior |
| P7/P9 Stardew portfolio | manifest/schema/drift tests；`verify:stardew:static` | leaf verdict report | action closure or target-live |
| P10 Voice | shared package tests；Host typecheck/focused client tests；Gateway typecheck/build/test；process peer-reset test | optional hardware/provider run separately | hardware/provider release evidence |
| P11 final | root typecheck/build/focused tests、production artifact/import checks、quality checks、`git diff --check` | independent Standards + Spec review | clean-clone or release unless actually run |

### 6.1 预计命令族

```bash
# Host
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host build:test
pnpm --filter @gamebuddy/companion-host test
pnpm --filter @gamebuddy/companion-host build
pnpm --filter @gamebuddy/companion-host check:production-artifact
pnpm check:host-production-import-boundary

# Magic Context fork
bun run --cwd vendor/magic-context/packages/pi-plugin typecheck
bun run --cwd vendor/magic-context/packages/pi-plugin test
bun run --cwd vendor/magic-context/packages/pi-plugin build

# Voice
pnpm --filter @gamebuddy/voice-protocol typecheck
pnpm --filter @gamebuddy/voice-protocol test
pnpm --filter @gamebuddy/voice-gateway typecheck
pnpm --filter @gamebuddy/voice-gateway build
pnpm --filter @gamebuddy/voice-gateway test

# .NET / Stardew
 dotnet build GameBuddy.sln --configuration Release
# 加上 P6 选定的 dotnet test 或 dotnet run contract entry
pnpm verify:stardew:static

# Repository
pnpm typecheck
pnpm build
pnpm quality:check
git diff --check
```

命令是否存在、是否需要 Windows/游戏/provider、当前是否已知失败必须由 P0 baseline记录。不存在的未来命令不得在实施前被报告为已运行。

### 6.2 真实运行边界

本计划本身不要求通过任何 Action live gate。只有 `design/35` P6 owned actual companion-live runner的真实接线实际完成并满足 `design/35` 的 immutable artifact、正式 Host/SDK、Mod bridge、target game、receipt/fresh observation要求时，才可执行其 target-live gate。否则最终状态应写：

```text
actual_companion_live_runner: blocked
reason: formal_host_mod_target_live_attachment_not_implemented_or_not_run
```

不能把 deterministic fixture、production admission preflight、人工录像或单客户端模拟改名为 live。

---

## 7. 删除清单与完成定义

### 7.1 必须物理删除

- old generic continuity coordinator/backend/store implementation及专属tests；
- Dialogue legacy Memory mutation branch/types；
- Tavern singleton legacy file fallback和resume-or-create adapter；
- duplicated Host config strict JSON parser/bounded reader；
- duplicated Tavern temporary identity/cleanup implementations；
- Persona/Scenario/Greeting duplicated revision traversal；
- Host/Gateway duplicated Voice wire constants/unions/partial validators；
- multi-mode companion-live runner；
- JS内嵌 companion scenarios/phrases副本；
- 仅因旧源码仍存在而维护的production exclusion枚举。

### 7.2 完成定义

只有同时满足以下条件，本文才能标记 implemented：

1. P0–P11 exit gates全部通过或明确分离的 target-live项保持非必需 `blocked`；
2. 15个获批结果面逐项有changed files、tests、commands和review evidence；
3. 所有明确排除的 Action platform files没有非预期diff；
4. 被替代旧路径物理删除，无fallback、dual read、wrapper或migration；
5. static/deterministic/process/live evidence schema不可互换；
6. Host、Magic Context、Voice、.NET、Stardew aggregate的匹配验证已实际运行并记录exit code；
7. `git diff --check`通过；
8. independent reviewer完成 Standards 与 Spec review；
9. residual risks、未运行真实环境门和已有 unrelated dirty-tree failures明确报告。

---

## 8. Stop rules

出现以下情况立即停止并收窄：

- 任何新模块开始承载 capability、lease、principal、receipt或跨domain authority；
- 为复用而合并 Chat/Game materializer、Voice/Control state machine或Tavern/continuity CAS；
- P3试图自动迁移或双读legacy Tavern production文件；
- P4/P5接口开始接受任意动态parser/filesystem callbacks并成为通用framework；
- P6需要修改Action semantics或升级production TFM却没有target SMAPI/Stardew证据；
- P7 aggregate把live/manual `blocked`算作pass；
- “real”命令仍只运行preflight或fixture；
- P8需要大量artifact-specific flags才能支持三个caller；
- P10共享包引入Host/audio/provider依赖或放宽directional limit；
- P11为了减小checker而删除反重引入negative mutation test；
- baseline后出现未allowlist drift或shared file多writer；
- 任何工作侵入 `design/38` 明确拥有的Action platform。

---

## 9. 非声明

本文来自 active dirty-tree 的只读软件工程审计。它不证明上述整改已实施，不证明 production clean clone、S6 continuity evidence、Tavern release、Memory real-provider gate、Voice hardware/provider gate、Stardew Action closure、陪玩体验硬门或任何 release gate 已通过。
