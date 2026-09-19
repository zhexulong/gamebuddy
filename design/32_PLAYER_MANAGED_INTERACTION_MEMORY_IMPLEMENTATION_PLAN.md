# 玩家可管理 Interaction Memory Implementation Plan

> **状态：玩家管理、CAS、来源排除、`m[1]` freshness、Historian 双类型 candidate/promotion、Tavern Narrative Gate、Historian real-provider authoring gate，以及 Chat-only player-direct `exact-next` provider-bound attestation 已完成；`design/30` owned fresh semantic SQLite authority 的 S0–S5 mounted engineering evidence 已存在，但其 S6 + production-entry consumer record 尚未通过；Game Operational Gate 的真实独立 Chat/Game provider、Mod bridge 与 receipt evidence 仍未完成，P7 auto-promotion reopen decision 尚未完成。当前 Dialogue 仍存在 evidence-bound 与普通 facade 两条玩家 HTTP mutation dispatch；其 destructive single-mount cutover 是 [`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P2 的 required work card，未完成前不得把 exact-next attestation扩展为全部玩家mutation已统一挂载的声明。**
> **范围：同一 `CompanionContinuity` partition 内的玩家直接管理、受限 Agent 代理、`SEMANTIC_MEMORY` / `INTERACTION_EPISODE`、来源治理、next-invocation `m[1]` freshness，以及独立 Chat/Game surface 对同一长期 Memory 候选池的读取规则。**
> **不在范围：Chat/Game 模式切换或返回、跨 Continuity Memory、跨设备同步、导入/导出、at-rest encryption、原始聊天隐私擦除、持久 proposal/review queue、embedding/RAG/auto-search。**

本文是 [`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md) 的实施规范，并把逻辑 gates 落入 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)。实施前后都必须保持：Magic Context fork 是 Memory 的唯一存储、选择和 Context 物化内核；Host 只认证并路由 typed commands，不直接读写 SQLite、不拼 synthetic Memory prompt、不复制 Chat/Game JSONL。

---

## 1. 当前基线与真实缺口

### 1.1 已实现，可复用

当前 `vendor/magic-context` 已有：

- `ongoing-interaction` domain、两类 ongoing-interaction category，以及 active/permanent Memory 的 `m[0]/m[1]` 注入；
- `memories` 的 `category`、`source_type`、`status`、`verification_status`、`superseded_by_memory_id`、`merged_from`、timestamps 与 `metadata_json`；
- create/list/get/update/archive/merge/delete 的底层路径；
- `memory_mutation_log` 的 update/archive/delete/superseded delta；
- cache-aware `m[0]` baseline、`cached_m1_bytes`、SOFT+ replay 和 source-aware soft refresh；
- Host-owned opaque Continuity runtime identity 映射为 Magic Context `projectIdentity`；
- Chat/Game 独立 Pi surface session；它们可并存并独立 lifecycle，同 Continuity Memory 不依赖复制 JSONL。

当前工作树还包含 Tavern stable-context source extension 的 WIP publication/materialization路径；它与本计划的 Memory command/delta contract不同，但共享 `m[0]/m[1]` cache边界。该 WIP 尚未完成 fork-owned single-valued source-kind validation、持久 cursor/restart、fold 与 surface-isolation gates，不能作为已发布能力，也不能与 Memory mutation cursor混用。

### 1.2 当前缺口

- production `host/src/runtime.ts` 的 `MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED = false` 已完成，且 P7 前必须保持关闭。
- Host 注入的受限 `companion_memory`、authenticated Dialogue Web Memory API/UI、Magic Context-owned facade、CAS、governance、生命周期命令、opaque provenance/source exclusion 与 `m[1]` coverage refresh 已有实现；其定向 tests 与受控 Host/API/provider probes 已运行。
- embedded Historian 的 prompt/output parser、`PROMOTABLE_CATEGORIES` 与 shared admission validator 已允许 `SEMANTIC_MEMORY` 和 `INTERACTION_EPISODE` 在同一 chunk 走同一 promotion/exclusion/dedup 链路；普通 tool/receipt/snapshot/failure-recovery 内容的 Episode 或伪装 Semantic promotion 被拒绝。`ongoing-interaction` 只有 `autoPromote === true` 才 promotion，防止配置省略或上游默认反转；production 仍不写任一类别。
- Chat/Game 的产品语义是独立 surface：同 Continuity 只共享长期 Memory 候选池；它们可并存、独立启动/停止/恢复，不能有 Chat→Game→Chat 模式切换。
- Tavern Narrative Gate 已通过 immutable Host artifact、authenticated Memory lifecycle、独立 Chat real-provider pre-send materialization marker、archive/delete 防复活与 foreign Continuity negative evidence；它不要求 Game attachment，也不以 provider answer 作为 materialization 证明。补充的 Chat-only player-direct `exact-next` attestation 进一步证明一次 create-only committed revision 在紧接的真实 provider attempt 前被 frozen `m[1]` 精确选中：Magic Context source callback 仅在 `(memoryId, latestMutationId)` 等于 committed target/revision 时覆盖，Host 本地校验 `covered=true` 与 session/nonce/round 后才向 runner 发送不含 Memory/prompt/provider 内容的 derived attestation；它不替代 Tavern lifecycle coverage，也不声称 provider acceptance/semantic output 或任何 Game evidence。
- `design/30` owned production authority 已挂载 schema v2 `independent_chat_and_game_surfaces` fresh semantic SQLite single authority：`main.ts` 使用独立 Game semantic facade，`dialogue-web-main.ts` 使用独立 Chat semantic facade，旧 JSON continuity/lease/bootstrap/return authority 不再是 production ingress。S0–S5 定向 typecheck、artifact closure、source-boundary、close-commit retry checkpoint 与 explicit dead-owner recovery tests 已通过；S6 + production-entry consumer record、真实独立 Game provider/Mod bridge/receipt evidence 尚未完成。

---

## 2. 冻结的产品语义

### 2.1 Memory 类型

只允许：

```ts
type OngoingInteractionCategory =
  | "SEMANTIC_MEMORY"
  | "INTERACTION_EPISODE";
```

`SEMANTIC_MEMORY`：长期成立的偏好、互动边界、约定、关系事实或共同表达。

`INTERACTION_EPISODE`：对玩家—Companion 的关系、承诺、共同叙事、情绪理解或未来互动方式具有持续意义的经历。工具/游戏事件只能是背景；普通 action、snapshot、任务完成和执行失败—恢复链默认 promotion-ineligible。

两种 category 都不是 surface visibility：相同 Continuity partition 内所有 active/permanent `SEMANTIC_MEMORY` 和 `INTERACTION_EPISODE` 是 Chat/Game 的共同候选池。Chat/Game raw history、compartment、recent tail、Tavern source、Live World、capability 和 receipt 不在池中且不互相复制。没有已证明需求时，不增加 `surfaceId`、`visibility` 或 surface-only Memory schema。

### 2.2 不需要 confirm

- 玩家 create/update 即为明确表达；
- 玩家当前回合明确委托 Agent mutation 即为该 operation 的充分授权；
- 不新增强制 confirm、attestation schema 或 review queue；
- `verification_status` 不承担玩家审批语义。

### 2.3 权威优先级

```text
fresh Mod/Bridge Live World + Host receipt/evidence + capability/policy
    > 当前玩家明确输入
    > 玩家创建/纠正/pinned Memory
    > Agent/Historian inferred Memory
    > older/superseded/archived/deleted Memory
```

Memory 永远不能授予 action、证明成功或覆盖当前世界。

---

## 3. 最小数据契约

### 3.1 不扩张 `memories` 行 schema

第一阶段复用现有 row：

- partition：`project_path`（canonical opaque continuity runtime identity）；
- type：`category`；
- origin：`source_type`；
- active/pinned/disabled：`active/permanent/archived`；
- correction/merge：现有 update、supersession、merged lineage；
- CAS：由当前 row 派生 opaque state token；
- current-revision governance：受控 `metadata_json.governance.authority`；
- provenance：`metadata_json.source_refs`。

禁止新增 `title/tags/surfaceId/visibility/origin/pinned/activation/revision/companionId/tombstoned/reviewStatus`，除非后续 ADR 对真实 Tavern/Game 场景和成本收益重新证明。

### 3.2 Expected-state token

Magic Context facade 输出 opaque token，至少绑定：

```text
memory id
updated_at
normalized_hash
status
superseded_by_memory_id
governance authority
```

mutation 必须提交 token；不匹配返回稳定错误：

```text
memory_revision_conflict
```

不得向 UI 暴露 token 内部编码，不允许 last-write-wins fallback。

### 3.3 Current-revision governance

创建来源与当前 revision 的治理优先级必须分开：

```json
{
  "governance": {
    "authority": "player"
  }
}
```

允许值：

- `player`：玩家直接 create/update；或当前回合明确委托 Agent 且命令明确采用为玩家修订；
- `inferred`：Agent/Historian 自主 create/update。

要求：

- 与 content/status mutation 在同一 Magic Context transaction 写入；
- 参与 CAS、conflict、merge 与 promotion 判定；
- `source_type` 继续保留原始创建来源，不因玩家后来纠正而被改写；
- Host operation receipt 只审计 principal，不能成为 facade 判断玩家优先级的唯一状态；
- delegated Agent 默认仍为 `inferred`，只有命令显式表达“采用为玩家修订”且 delegation policy 通过才可设 `player`；
- 编辑生成的新 revision 必须重新确定 authority，不按旧 content hash 默默继承。

这是复用现有 `metadata_json` 的必要治理 contract，不新增 Memory 列。

### 3.4 Provenance

第一阶段只使用受控 metadata：

```json
{
  "source_refs": [
    "pi-message:<opaque-session>:<opaque-entry>",
    "pi-range:<opaque-session>:<opaque-start>:<opaque-end>",
    "host-receipt:<opaque-receipt>"
  ]
}
```

要求：

- facade 验证 ref 属于当前 Continuity；
- 不复制原消息或 receipt 正文；
- 不进入 Prompt；
- UI 通过受限 endpoint 请求可显示的来源摘要，不获得内部 JSONL/ledger；
- receipt ref 不把 Memory 升格为权威 evidence。

### 3.5 Source exclusion

实现前先用 migration spike 冻结最小结构，目标等价于：

```sql
memory_source_exclusions(
  project_path TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY(project_path, source_ref)
)
```

不保存被排除正文。若现有 migration framework 需要 surrogate ID，可增加，但不得无场景扩充更多列。

### 3.6 `m[1]` coverage markers

现有 `cached_m0_max_memory_id` / `cached_m0_max_memory_mutation_id` 只描述 baseline；不能证明 `cached_m1_bytes` 已消费到哪个 delta。先做代码 spike 冻结最小 session-local markers，逻辑上至少包括：

```text
cached_m1_max_memory_id
cached_m1_max_memory_mutation_id
```

如果 source exclusion 本身会产生可渲染 tombstone，再加入单一 exclusion mutation watermark；若 exclusion 只约束 Historian，不直接渲染，则不需要。

markers、`cached_m1_bytes` 和 visible/trim metadata 必须在同一事务提交。不得用 Host 内存 dirty fan-out 代替持久 cursor。

---

## 4. API 与职责边界

### 4.1 Magic Context-owned Command Facade

从 `vendor/magic-context/packages/pi-plugin/src/tools/ctx-memory.ts` 提取 runtime-neutral service；tool 只成为 adapter。

概念接口：

```ts
executeMemoryCommand({
  projectIdentity,
  principal,
  command,
  now,
}): MemoryCommandResult
```

`projectIdentity` 必须由当前 runtime binding 传入，永远不接受浏览器/模型提供的 path。

`principal`：

```ts
type MemoryPrincipal =
  | { kind: "player_direct"; operationId: string }
  | {
      kind: "companion_agent";
      operationId: string;
      turnId: string;
      delegatedByPlayer: boolean;
    }
  | { kind: "historian"; operationId: string };
```

`principal` 是 command/receipt context，不要求复制成每条 Memory 的新列。现有 `source_type` 仍记录创建来源。

### 4.2 命令集

```text
list
get
create
update
archive
restore
pin
unpin
merge
delete-entry
exclude-source
```

产品语义：

- `archive`：保留正文、停止注入、可 restore；
- `pin/unpin`：`permanent` 与 `active` 转换；
- `delete-entry`：删除结构化 Memory 和派生 embedding，不声称删除 raw history；
- `exclude-source`：独立操作，不隐含于 delete；
- merge/update 继续使用现有 mutation log/supersession，但必须 CAS；
- create 也进行 category、content、provenance、principal 与 conflict validation。

### 4.3 Agent policy

Agent可在 policy 内创建普通 inferred Memory。以下操作要求 `delegatedByPlayer=true` 且绑定当前 turn：

- pin/unpin；
- 修改、archive、restore、merge 或删除 current revision 为 `governance.authority=player` 或 `status=permanent` 的 Memory，不论最初 `source_type` 是 user、agent 还是 historian；
- exclude-source；
- 任何未来隐私相关 mutation。

所有 facade 写入入口和 Historian promotion 都执行同一 category/admission/governance validator。Agent/Historian 对 `INTERACTION_EPISODE` 的 create/update 不得只通过 category allowlist：必须有非 tool-only 的 interaction provenance 并通过 P2 准入校验；若当前回合玩家明确要求保存一段互动经历，facade 可按玩家命令处理。receipt/snapshot/tool-result-only refs、普通 action过程或执行失败—恢复流水账一律拒绝为 Episode；它们也不得被伪装为 Semantic。Historian 必须能分别写入通过 validator 的稳定结论和持续意义经历，但 production auto-promotion 关闭时不执行任一 durable write。

Agent/Historian candidate 与 `governance.authority=player` 或 permanent Memory 冲突时返回 structured conflict，不写入：

```ts
{
  kind: "memory_conflict";
  candidate: ...;
  conflictsWith: MemorySummary[];
}
```

第一阶段不持久化 proposal queue。

### 4.4 Host adapter 和 operation receipt

Host adapter 负责：

- 当前玩家与 Continuity认证；
- surface/turn binding；
- command body bounds；
- deadline、operation ID/idempotency；
- 将 facade result 映射为受限 Web/tool result；
- 写 Host operation receipt：principal、command、target IDs、result/error、timestamp；不复制 Memory正文到 gameplay receipt ledger。

Host 不负责：

- SQL；
- Memory filtering/retrieval；
- Context XML/render；
- source exclusion eligibility；
- m[0]/m[1] cursor；
- Historian promotion。

---

## 5. 实施工作包

### P0 — 文档与 rollout safety（已实现基础）

**修改**

- `host/src/runtime.ts`：将 `MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED` 改为 `false`；生成 config/test 同步。
- fork README：记录治理 gate 与 `INTERACTION_EPISODE` rollout，避免文档继续宣称 production auto-promotion 已完成。

**验收**

- Host默认生成的 production runtime config 与 run manifest 都证明 `ongoing-interaction` 保留但 `auto_promote=false`；
- Web/API、模型输入或普通测试 override不能把 production profile重新打开；只有显式 test-only harness可创建隔离 override；
- Historian compartment authoring 不因关闭 promotion 而失效；触发 Historian publication时只形成 compartment、不创建新 Memory；
- P7显式重开时有反向配置测试，同时断言 auto-search、embedding、Dreamer、Sidekick与RAG仍关闭。

### P1 — Facade 与 CAS（已实现基础）

**修改候选**

- 新建 `vendor/magic-context/packages/pi-plugin/src/memory-command-facade.ts` 或按现有包边界放入 plugin feature service；
- `ctx-memory.ts` 改为 facade adapter；
- storage helpers 增加 restore/pin/unpin、CAS transaction、structured conflict；
- 受控 metadata governance validator，并在玩家 correction transaction 内原子标记 current revision authority；
- 为当前 row 生成/验证 opaque state token。

**验收**

- 现有 ctx-memory 行为保持兼容；
- stale token、跨 project ID、superseded/archived target fail closed；
- update + mutation log + token rotation 在一个事务中完成；
- 不出现重复 Memory schema。

### P2 — `INTERACTION_EPISODE` taxonomy 与 Historian 双类型 promotion（已完成定向逻辑）

**修改候选**

- `PROMOTABLE_CATEGORIES` 加入 `INTERACTION_EPISODE`；
- embedded Historian taxonomy/prompt/output schema 允许单个 chunk 同时给出 `SEMANTIC_MEMORY` 与 `INTERACTION_EPISODE` candidates；
- 在 candidate 解析后、promotion 前调用同一 category/admission validator；source exclusion 仍在 candidate 与 commit 两处检查；
- renderer/category priority、tool/facade category allowlist 保持两类一致。

**准入 gate**

必须拒绝：tool arguments/results、snapshot、普通任务、receipt summary、执行失败—恢复链、planner/action经验。

必须接受：重要承诺形成、关系转折、误会与和解、共同仪式/笑话/称呼、玩家明确赋予纪念意义的共同事件。

**验收**

- table-driven positive/negative fixtures；
- Historian、Agent 自主 create/update、delegated Agent 与 player-direct 四条入口都执行同一准入 validator；
- Historian 可在同一 chunk 产生一条稳定结论与一条不同、具持续意义的具体经历；两者均通过现有去重、exclusion、durable write、mutation watermark 和 embedding 链路；
- tool/receipt/snapshot-only provenance 无法绕过 Episode 准入；普通工具过程也不会被错误改写成 Semantic Memory；
- Episode 不能授予 capability 或覆盖 Live World；
- `SEMANTIC_MEMORY` 与 Episode 可分别 list/filter/render，但相同 Continuity 的 active/permanent row 共同构成两 surface 的候选池。

### P3 — Provenance 与 source exclusion（已实现基础；语义边界已冻结）

**修改候选**

- metadata parser/validator；
- migration + exclusion storage；
- Historian candidate-input eligibility；
- promotion commit-time recheck；
- compartment range overlap 检查。

**验收**

- cross-Continuity ref 拒绝；
- delete-entry 不自动 exclude；
- explicit exclusion 后 raw/range/old compartment 均不能 re-promote；
- restart 后 marker 存续；
- exclusion 不保存正文、不进入 Prompt；
- exclusion 不删除、archive 或立即隐藏已有 direct Memory，也不作为 current injection filter；Tavern gate 只能验证其持久化和未来 promotion negative，不能用它声称现有 row 已撤销。

### P4 — `m[1]` next-invocation freshness（已实现基础）

**修改候选**

- session_meta migration/types/storage；
- `mustMaterializePi` 或进入 `injectM0M1Pi` 的 pre-decision delta check；
- `softRefreshCachedM1Pi` 原子推进 coverage markers；
- OpenCode parity：若 GameBuddy runtime 不使用 OpenCode，也必须明确记录 parity 决策，避免错误声称双 runtime 已一致。

**核心算法**

1. 读取当前 continuity identity set 的 max new Memory ID / max Memory mutation ID；
2. 与 session-local cached-m1 coverage 比较；
3. 有未消费 delta时，把本 pass 提升为 `recomputeM1ThisPass` 等价 source-aware SOFT refresh；
4. 保持 m[0] CAS identity 与 bytes 不变；
5. 原子写 `cached_m1_bytes`、coverage、trim/visible metadata；
6. contention 时只允许短暂 replay 并保证下一 pass 重试，不得错误推进 cursor；
7. 无 delta 时继续 byte-identical replay。

**验收**

- 独立 Chat surface 的 player UI、Agent tool、同 turn continuation；
- 两个可并存的独立 surface 的双向 next-invocation visibility；不启动、停止、恢复或返回任一 peer session；
- dormant session、Host restart、cold start；
- concurrent mutation/refresh、contention fallback；
- m[0] byte identity 与 no-extra-turn；
- exact-once update/archive/delete/supersede delta；
- HARD fold 后 cursor 单调收敛。

### P5 — Host API 与 `companion_memory`（已实现基础）

**修改候选**

- Host service 层增加 continuity-bound adapter；
- runtime allowlist 只加入 GameBuddy-owned `companion_memory`，不直接暴露通用 coding `ctx_memory`；
- Agent tool schema使用 opaque Memory IDs/tokens；
- delegation 只能由当前 turn 的玩家请求产生，不从模型文本自证；
- operation receipt 与 idempotency。

**验收**

- 不接受 project path/Continuity ID越权；
- Agent可创建普通 inferred Memory；
- 未委托 Agent 对 `governance.authority=player` 或 permanent Memory 的 update/archive/restore/merge/delete 一律拒绝，包括 `source_type=agent` 但后来被玩家纠正的条目；
- tool result不泄露 SQLite path、其他 Continuity、prompt、raw transcript；
- Memory tool不带入 shell/file/Git/network能力。

### P6 — Dialogue Web Memory API/UI（已实现基础）

**最小 UI**

- list/filter active/permanent/archived 与两类 category；
- create/edit；
- archive/restore；
- pin/unpin；
- merge/delete；
- provenance摘要与显式 exclude-source；
- conflict/stale-token 展示和 refresh；
- 不提供 confirm 按钮作为必要工作流。

**安全**

- 复用 loopback origin/token/nonce 与 bounded JSON protocol；
- endpoint只作用于当前 authenticated Continuity handle；
- browser拿不到 `project_path`、SQLite、Pi JSONL、完整 receipt ledger 或其他 Companion 数据；
- body/response/列表条数有上限；
- destructive action有明确 UI intent，但不增加第二套持久 confirmation state。

### P6.1 — Player HTTP mutation single-mount cutover（required remediation card）

Memory taxonomy、SQLite transaction、CAS、command/state-token、source exclusion 与 `m[1]` 仍只由本计划和 Magic Context fork拥有；[`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P2 只拥有 Host-side destructive接线与组合验收。

目标construction必须在类型和生命周期上分开：

```text
DialogueMemoryReadProjection
  → list/get only；不要求 next-round mutation nonce

DialogueMemoryMutationCapability
  → create/update/archive/restore/pin/unpin/merge/delete/exclude-source
  → every call consumes the exact evidence-bound mutation path
```

规则：

1. `dialogue-web-main.ts` 只有在 exact provider/session/surface/nonce evidence coordinator成功构造时才挂载mutation capability；
2. `dialogue-web.ts` 不再在 capability缺失时回退到普通 `GameBuddyMemoryFacade`，`exclude-source` 也没有特例；缺失时写route不注册或稳定返回fail-closed unavailable；
3. read projection继续可独立挂载，不能为了保护写入而让查询依赖mutation nonce；
4. Host不复制Magic Context command、SQL、state-token或validator；fork中的共同机械内核保持单一owner；
5. 关闭时只close实际挂载的capability/coordinator，且不把Browser提供的continuity/path/provider facts当authority；
6. 旧branch、types、tests与wrapper在新matrix通过后物理删除，不保留environment-selected compatibility。

**验收：** 所有mutation family覆盖wrong/missing/replayed nonce、surface/session mismatch、active/draining turn、stale CAS、late marker、double mutation、redaction和capability absent；任意环境配置都不能绕过evidence-bound path；read-only query在mutation不可用时仍可用。该卡不改变“玩家直接create/update不需二次confirm”的产品语义：evidence是当前authenticated next-round执行绑定，不是新的玩家审批状态。

### Consumed Continuity prerequisite（owned by `design/30`）

[`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md#consumer-dependency-passage) exclusively owns fresh Continuity authority, destructive cutover, S0–S6 implementation, Windows cross-process recovery, and production-entry evidence. This plan requires its re-runnable `S6` + production-entry evidence record to be `passed` before the Game Operational Gate or P7 can pass.

For this plan, the consumed record establishes only an independent Chat facade and Game facade for the same manifest-bound partition, an admitted Game receipt-backed binding/post-commit lease, peer-lifecycle isolation, and no legacy production ingress. It does not prove Memory materialization, real-provider behavior, Game Live World/capability/receipt priority, or foreign-Continuity isolation. Memory marker/provider/Game evidence does not substitute for the consumed record; `design/34`/`design/35` STOP, Farmhand harness, body/presentation, or Preview evidence does not substitute for either gate.

### P6.6 — Game Operational closure

This plan owns only the Memory-specific **Game Operational Gate** and its integration order. It does not reintroduce Chat→Game→Chat origin/return.

1. **Required consumed dependency.** The `design/30` Consumer dependency passage record is present, re-runnable, and `passed`; otherwise this gate is `blocked`.
2. **Owned evidence: real independent-surface Game Operational Gate.** At a GameBuddy-owned root with a real provider, official Game bridge/Mod, fresh snapshot/capability/receipt, first use Chat then Game for the next invocation, and use the reverse order for a second mutation. A payload-blind marker proves only same-partition `m[1]` mutation watermark and materialization of both Memory categories; Game success requires a Mod receipt plus action-specific fresh postcondition. A foreign Continuity is not visible. This gate neither enters/returns Chat nor requires `design/34` STOP/Farmhand scenarios.
3. **Failure disposition.** A missing/failed consumed record, owner/binding/world/principal/vector/deadline mismatch, artifact/root/manifest mismatch, unavailable real child/provider/bridge, or unauthenticated evidence remains `failed`, `blocked`, or `inconclusive` as applicable. No fallback, legacy reopen, dual write, read-repair, ordinary cleanup, or cross-lane pass borrowing is allowed.

**P6.6 completion:** the consumed `design/30` S6 + production-entry record passes and is repeatable; both Game Operational invocation orders achieve the scoped evidence on real independent Chat/Game surfaces; all Memory-gate negative/mismatch fixtures fail closed. Completing P6.6 closes only this continuity/Memory scope, not Tavern release, `design/34` Farmhand Preview, Portfolio, Voice, clean-clone, or supply-chain gates.

### P7 — Historian auto-promotion reopen gate

只有以下全部通过才重新设置 `auto_promote=true`：

- facade/CAS和玩家治理；
- current-revision `governance.authority=player` 持久化、player priority 与 structured conflict；
- Interaction Episode negative/positive gate；
- source exclusion 防复活；
- m[1] next-invocation freshness；
- Continuity isolation；
- Live World/capability/receipt priority；
- restart/concurrency；
- Historian 对两类 category 的 parser/validator/promotion/exclusion/dedup regression；
- Tavern Narrative Gate 的真实 Chat provider evidence；
- P6.6 的 S6 independent-process recovery、production-entry closure 与 Game Operational Gate 独立真实 provider/Live World evidence；
- restart/concurrency 与相应 BDD logic gates。

重新开启后只适用于 `ongoing-interaction` 的两类批准 taxonomy；两类均使用相同玩家治理、source exclusion 与 fail-closed admission。auto-search/embedding/RAG 保持关闭。

---

## 6. 测试与证据计划

### 6.1 Magic Context fork tests

- schema migration forward/backward compatibility；
- facade command table；
- CAS/concurrent writers；
- mutation log exactness；
- Interaction Episode taxonomy；
- provenance/ref validation；
- exclusion build/commit double-check；
- m[1] coverage cursor、SOFT+ byte stability、HARD fold、contention；
- same Continuity multiple sessions 与 foreign identity negative tests。

### 6.2 Host tests

- generated config auto-promotion gate；
- tool allowlist只出现 `companion_memory`；
- player direct 与 delegated Agent principal；
- current-turn delegation失效；
- API auth/origin/nonce/body bounds；
- operation idempotency/receipt；
- browser response redaction。

### 6.3 BDD logic gates

执行 `09` 新增场景及 command/race matrices：

- next-invocation exact mutation visibility；
- no-required-confirm 与 delegation/CAS；
- player-authority semantic conflict 与 commit-time race；
- Interaction Episode vs tool-process rejection（覆盖全部写入入口）；
- delete/exclude/erase语义分离与 hostile source refs；
- full command lifecycle、operation idempotency、deadline、surface/Continuity binding；
- concurrent mutation/refresh/contention/HARD-fold cursor monotonicity。

逻辑 tests 必须先于高成本 live run；不得用模型演示替代 deterministic isolation/concurrency/cursor证明。

### 6.4 Consumed Continuity process / production prerequisite

任何 P7 auto-promotion 决定之前，必须取得并复跑 [`design/30` 的 Consumer dependency passage](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md#consumer-dependency-passage) 所指向的 `S6` + production-entry evidence record。`design/30` 是该 harness、negative matrix、failure disposition 和 evidence producer 的唯一 owner；本计划只记录所消费的 artifact/manifest digest、record identity、execution time 和 `passed`/`failed`/`blocked`/`inconclusive` 状态。

这些是 Continuity process/production prerequisite，不是 provider/live evidence；无法提供真实 Windows record 时，本计划的 P6.6/P7 为 `blocked`。

### 6.5 真实模型/live run

#### 已冻结的 P7 live evidence batch（当前实施范围）

此 batch 只闭合 Player-Managed Interaction Memory 的 P7 证据；它不是 `design/34`/`design/35` Farmhand Companion Preview/release gate，也不阻塞 `single_player_native_companion` 的 Portfolio Demo。它不验证改令、STOP、身体 settle、语音、presentation 体验或 action universe。

唯一允许的 live 结果为 `passed`、`failed`、`blocked` 或 `inconclusive`。每个 runner 在所有 non-mutating preflight（fresh Host/Magic Context production artifact、声明包与 vendor artifact provenance、runner parser/schema、目标拓扑/bridge/fixture readiness、teardown/restore 路径）通过前不得发起 live mutation；不可用 provider、Stardew/SMAPI/Mod/bridge、不可认证的 evidence 或不完整 cleanup 都不是 pass。

自动 live attestation 可替代人工操作，但不得使用 mock provider、deterministic model fixture、UI/input injection 或伪造 receipt。runner 必须使用 GameBuddy-owned runtime/data root、正式 production artifact 与真实 provider；输出只含脱敏、最小化的 evidence。

在逻辑 gate 通过后，以 GameBuddy-owned runtime/data root 串行运行以下三个独立 gate；它们共享 artifact/identity/evidence hygiene，但 verdict 绝不互相继承：

1. **Tavern Narrative Gate**：玩家经 UI/API create 或 update Semantic/Episode；同一独立 Chat 下一次真实 provider invocation 以 provider-bound、内容不落盘的 raw-invocation marker 证明两类 current revision 已 materialize；archive row 仍可列出但不得 materialize，delete-entry row 必须缺失且不得 materialize；不同 Continuity 不可见；context budget 下保持稳定降级。它不启动或要求 Game。source exclusion 只验证 endpoint/persistence 与未来 Historian promotion negative，不声称它隐藏既有 direct row。模型自然语言回答不是 deterministic materialization evidence。
2. **Historian real-provider authoring gate**：以合成、无敏感内容的互动 transcript 走 production-resolved embedded Historian provider/parse/admission pipeline，证明稳定结论产生 `SEMANTIC_MEMORY`、持续意义经历产生 `INTERACTION_EPISODE`、普通工具/游戏过程不产生任一不当长期 Memory。该 gate 的隔离 test DB 可为 authoring pipeline 启用 durable candidate/promotion 流程，但 Host production `MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED` 必须仍为 `false`；它不是 production 写入开关的证据。
3. **Game Operational Gate**：一个独立 Chat runtime 与一个独立 Game runtime 仅通过相同 `(playerId, companionId, continuityId)` 共享长期 Memory partition；二者可同时存在，启动、停止、恢复任一方不得进入、暂停、关闭、恢复或复制另一方的 Pi JSONL/raw tail/session。认证的 player-direct facade mutation 后，先由 Chat、再由 Game 触发各自的下一次真实 provider invocation；对第二个 mutation 反向先 Game、后 Chat。每一 receiver invocation 必须由 source-owned、payload-blind pre-send marker 报告其 Pi runtime session、同 partition 的 m[1] mutation watermark 以及实际 materialized 的两类 category count；marker 经 Host launcher IPC 传输，runner 独立比对 runtime session 与 nonce digest，不得读取/保存 prompt、Memory 文本、provider request/response、cookie、token、Pi JSONL 或 SQLite。foreign Continuity receiver 必须报告其 own-partition watermark/categories，不能观察到 shared partition mutation。Game receiver 还必须将同一 invocation 关联到 fresh bridge snapshot revision、Mod-published capability revision 和 authoritative receipt/postcondition；这些事实分别来自 Host/bridge/Mod，Memory marker 不得成为 action capability、Live World 或结果 authority。它不从 Chat 进入或返回 Chat，也不要求 Farmhand Preview/STOP live evidence。

证据记录 artifact identity、model/provider、脱敏 Continuity/surface IDs、commands、operation receipts、Context trace markers、适用时 authoritative game receipt/postcondition，以及明确 pass/fail/blocked/inconclusive。不得依赖用户系统 Pi 安装。

---

## 7. 实施顺序与可回滚点

```text
已实现基础：P0 auto-promotion safety
  → 已实现基础：P1 facade/CAS + governance、P3 provenance/exclusion、P4 m1 freshness、P5 Host adapter、P6 player UI
  → 已完成定向逻辑：P2 Historian 双类型 taxonomy/promotion + shared admission validator
  → Tavern Narrative Gate：provider-bound materialization evidence complete（仅更新状态/报告归档）
  → Historian real-provider authoring gate：embedded-SDK real-provider parse/publish probe complete；双类型 durable promotion 仍由 isolated shared-lifecycle test gate 覆盖，production auto-promote 保持关闭
  → consumed `design/30` prerequisite：S6 Windows cross-process + production-entry consumer record
  → P6.6 Game Operational Gate：独立 Chat/Game next-invocation visibility + Game authority evidence
  → P7 deterministic restart/concurrency/security evidence reconciliation
  → P7 explicit auto-promotion reopen decision
```

每个阶段单独提交、单独迁移/feature flag。任一阶段失败：

- 保持 auto-promotion关闭；
- 现有只读两类 Memory render/management 可继续运行，Historian 不作 durable auto-promotion；
- 不以临时 Host SQL、synthetic prompt、JSONL同步或 global cache clear 绕过；
- 对已有 schema migration只能向前修复，不静默删除用户 Memory。

---

## 8. 当前实现状态（2026-03）

**已完成并有确定性验证：** P0 `auto_promote=false`；Magic Context-owned command facade、opaque CAS、玩家治理与 `INTERACTION_EPISODE` 准入；opaque provenance/source exclusion；持久 `m[1]` coverage cursor 与 next-invocation soft refresh；Host `companion_memory` adapter、当前 turn one-shot delegation、Player Memory API/UI；Tavern profile memory-management route 与 `TVL-09` live-run record coverage。Historian 对两类长期 Memory 的 prompt/parser/admission/promotion/exclusion 定向 tests 已通过；`ongoing-interaction` injection 已验证同 Continuity 两类别 render 且 foreign/coding rows 排除。Host production artifact 通过 `resolveMagicContextExtensionEntry()` 使用 Host package dependency 的 ESM export，避免 generation-relative vendor path。

**已完成的窄 live evidence：** Tavern Narrative Gate 已通过独立真实 Chat provider pre-send materialization boundary evidence：immutable Host production artifact、authenticated Memory API lifecycle、两类 player-created Memory、archive/delete/exclude-source endpoint/persistence、独立 Pi runtime-session IPC 与 one-shot payload-blind provider marker 均被检查。它刻意不保留 prompt/Memory/provider response，也不声称 provider accepted request 或生成语义正确答案；source exclusion 仍只证明 persistence/future-promotion negative，不隐藏 existing direct row。

**已完成的 Chat-only exact-next evidence：** `tools/run-player-memory-next-round-attestation.mjs` 已从 fresh immutable Host production artifact 使用 GameBuddy-owned root，执行一次 player-direct create 后的下一次真实 Chat provider attempt。产物为 create-only、`0600` 且无正文/凭据/prompt 的 redacted report，断言 direct mutation、next provider attempt、Host 对 source marker 的本地接受与 selected exact-revision coverage；它明确记录 `providerAcceptedOrSemanticAnswer=false`。来源端拒绝同一 Memory 的后续 revision 借用，Host 拒绝 `covered=false`、wrong binding 或 replay，runner 不接收 raw correlation、Memory ID/revision/cursor 或 provider request/response。该 evidence 仅补强 direct-create 的 exact-next pre-send path，不能代替 Tavern lifecycle gate、Game Operational Gate 或 P7 reopen 条件。

**已完成的 Historian real-provider evidence：** `tools/run-ongoing-interaction-historian-authoring.mjs` 从 newly built immutable Host production artifact 取得 embedded Pi `ModelRegistry`，通过 no-tool embedded-SDK provider 对三条 GameBuddy-owned in-memory synthetic interaction 运行 production Historian parse/publish pipeline。它以脱敏 aggregate evidence 确认：稳定结论输出 `SEMANTIC_MEMORY` fact、持续互动约定输出 `INTERACTION_EPISODE` fact、普通过程输出零 durable fact；不保留 transcript、prompt、candidate 正文、provider request/response、cookie 或 token。该 live probe 保持 product `MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED=false`，不写 production Memory。isolated shared-lifecycle unit gate 独立证明同一 admission/promotion transaction 对两种 durable category 及 ordinary-process rejection 的写入语义。

**当前硬前置与尚未完成项：** `design/30` owned destructive cutover 的 S0–S5 mounted engineering boundary 已存在：production ingress 使用 schema v2 `independent_chat_and_game_surfaces` semantic SQLite authority，production Game authority ingress 已移除 Chat-origin/return-shaped fields 与 legacy route。其可供本计划消费的 S6 + production-entry record 尚未通过。P6.6 Game Operational Gate 也尚未完成：真实独立 Game surface 的双向 next-invocation visibility 与 Live World/capability/receipt priority evidence 不足。它们与 P7 deterministic restart/concurrency/security reconciliation 和 explicit reopen auto-promotion decision 一同保持 `blocked`，不得由 `design/34` 的 STOP/Preview evidence 或定向 unit tests 代替。`MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED=false` 继续是 production 配置。全 Magic Context suite 在 Windows 上仍含既有非本 slice 环境失败（例如 symlink privilege、仓库 Rust sidecar/DB teardown）；必须以目标 slice tests 和阻断原因单独报告，不能把它们伪称为通过。

## 9. 完成定义

只有同时满足以下条件，才可称“玩家可管理 Interaction Memory 已实现”：

- 玩家可直接查看、create/update/archive/restore/pin/unpin/merge/delete/exclude；
- Agent可在同一 facade内代理，且 destructive operations受当前 turn明确委托约束；
- 不要求逐条 confirm；
- stale/concurrent mutation fail closed；
- Historian 与显式写入入口都能在相同准入下处理 `SEMANTIC_MEMORY` 与 `INTERACTION_EPISODE`；Episode 不吸收工具调用经历；
- delete 与 source exclusion 防复活契约真实持久；
- 已消费 `design/30` 的 passed S6 + production-entry consumer record，以证明 fresh semantic SQLite single authority 下同 Continuity 的独立 Chat/Game surface 可并存，且不含 Chat-origin、return 或 legacy authority；
- 同 Continuity 的独立 Chat/Game surface 在两个 invocation order 都可见共同候选池 mutation，无额外回合且 m[0] 稳定；
- 另一 Continuity 不可见；
- Memory 不能覆盖 Live World、capability 或 receipt/evidence；
- Tavern Narrative Gate、适用的 Game Operational Gate、logic、restart、concurrency 与 Host security tests均通过；
- auto-promotion 仅在以上证据完整后显式重开两类 category。

只完成 schema、tool、UI或单次模型演示，均不构成端到端完成。
