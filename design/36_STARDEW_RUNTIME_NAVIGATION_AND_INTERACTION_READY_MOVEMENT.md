# Stardew Agent Navigation V1：地点发现、搜索与原生移动

> **状态：V1 技术边界已冻结；尚未 materialize 或 live-closed。**
>
> 本文是 Navigation V1 的产品与技术设计 authority。它规定三个由 Agent 调用的 typed operations：`inspect_world_map`、`find_destination` 与 `navigate_to_destination`。所有直接 consumer 都是 Agent，不是玩家；玩家自然语言由 Agent 理解，Mod 不承担开放式自然语言理解。实施顺序、owned paths、验证与唯一 live mutation gate 仍由 [`38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`](38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md) 管理；若 design/38 的旧 Navigation contract、matcher 或预算描述与本文冲突，以本文为准并应删除旧描述。

## 1. 冻结结论

Navigation V1 采用以下唯一方案：

1. `inspect_world_map` 是 Agent-facing、按 decision frontier 自动折叠单子节点且可分页的 read-only operation。
2. `find_destination` 是 Agent-facing、进程内、bounded lexical search；使用 `Raffinert.FuzzySharp` `5.0.3` 做保守候选排序，不声称语义搜索。
3. `navigate_to_destination` 是唯一 mutation action；唯一且无歧义的 canonical label 使用 label selector，歧义或不能稳定证明唯一的 destination 使用当前 Mod runtime 签发的 opaque `{ kind: "ref"; ref: "dr1_…" }` selector（其 key 恒为 `ref`，无 `destinationRef` 兼容字段/别名）。
4. 三者共享唯一 Mod-owned `DerivedDestinationSet` 与 runtime-private ref table；Host 不拥有 destination catalog、matcher、ref binding、route 或 arrival authority。
5. 路径解析、规划、移动、transition、replan 与到达验证全部在 Mod/game thread 中完成。Agent/Host 不提交坐标、tile、route、warp、facing 或 native member；Agent 不提交自定义 page size、offset、query matcher 或 selector binding。
6. Navigation 对 Agent 是一个 bounded cancellable execution；内部是逐 hop 的 native commit/revalidation，不承诺回滚已经发生的移动。
7. 到达 Mine exterior 即完成 Navigation；它不调用 `enter_mine`、`use_mine_ladder` 或 `select_mine_elevator_floor`。`reach_mine_floor` 不是本 batch 的 action、capability、route、tool 或 gate。

V1 不建设 remote retrieval、Lucene/full-text service、vector DB、embedding、GameBuddy Atlas、人工 POI/route catalog 或 generic native dispatcher。

## 2. Consumer 与语义责任

### 2.1 所有 operation 的使用者都是 Agent

玩家可能说：

```text
“去矿井入口。”
“找一个可以买种子的地方。”
```

Agent 负责理解意图、选择 operation，并把查询收敛为适合 lexical lookup 的短表达：

```text
find_destination({ query: "矿井" })
find_destination({ query: "种子 商店" })
```

Mod 搜索只承诺对 current/fallback locale 名称、显式别名、短关键词与有限拼写偏差进行 bounded lexical ranking。它不承诺从任意自然语言描述推理地点。无法安全匹配时返回候选或 `not_found`，不得猜测并启动 mutation。

### 2.2 Agent-facing 不等于全知

WorldMap 名称、native conditions 与 content-author metadata 是合法 world-fact 来源，不是 UI presentation requirement。输出为 Agent 优化：结构化、紧凑、无修辞；唯一 destination 尽量直接返回 label selector，只有歧义 destination 返回 opaque ref。

`find_destination` 遵循已冻结的 K2：可搜索当前 installed-and-existing 且有合法玩家名称的 G1 destinations；`inspect_world_map` 只投影当前可披露的 source hierarchy。两者都不得披露 coordinates、routes、hidden state 或 internal map keys。

## 3. 三个 public typed contracts

### 3.1 `inspect_world_map`

```ts
type InspectWorldMapArgs =
  | Record<string, never>                 // current root; auto-fold singleton groups
  | { nodeRef: string }                   // expand this branch to its next frontier
  | { cursor: string };                   // continue this frontier only

type DestinationSelector =
  | { kind: "label"; label: string }     // unique current canonical label
  | { kind: "ref"; ref: string };       // opaque dr1_ ambiguity disambiguator (no destinationRef field)

interface WorldMapEntry {
  label: string;
  contextLabel?: string;
  nodeRef?: string;                       // this entry can be expanded
  destination?: DestinationSelector;      // this entry can be navigated to
}


type InspectWorldMapResult =
  | {
      status: "succeeded";
      reason: "world_map_observed";
      entries: readonly WorldMapEntry[];
      nextCursor?: string;
    }
  | {
      status: "blocked";
      reason:
        | "world_map_node_invalid"
        | "world_map_node_stale"
        | "world_map_node_not_found"
        | "world_map_unavailable"
        | "world_map_cursor_invalid"
        | "world_map_cursor_stale"
        | "world_map_projection_too_large";
    };
```

规则：

- `{}` 从 current native world-map root 开始。没有合法 Agent-facing label 的结构容器无论有几个都透明 flatten；有合法 label 但只有一个有效 group child 时继续 singleton folding，直到出现可选择的 decision frontier、destination leaf 或 empty result。
- `{ nodeRef }` 从指定 branch 开始执行相同的 unlabeled-container flattening 与 singleton folding；它不是原生内部层级的机械展开接口。
- 每次最多返回 20 个 Agent-facing、G1 location-level entries，最多 4096 UTF-8 bytes；只在折叠后的 frontier 上分页。
- `nextCursor` 存在即明确表示同一 frontier 还有下一页；Agent可调用 `{ cursor: nextCursor }`，但目标已出现时可以立即停止。没有 `nextCursor` 只表示当前 frontier 已完成，不表示全世界已遍历。
- `cursor` 绑定同一 folded frontier、scope、source generation 与 immutable page snapshot；不能跨 node、frontier 或 generation 使用。
- 一个 entry 可以同时有 `nodeRef` 与 `destination`，避免同一 location 以 group 和 destination 重复出现。
- `destination` 使用唯一 canonical label 时优先为 `kind: "label"`；同名、alias、content-owner collision 或无法证明唯一时使用 `kind: "ref"`。仅当存在必要歧义时返回最短 `contextLabel`。
- 自动丢弃无 Agent-facing label、无 executable G1 destination 且无有效 descendants 的内部节点；无合法 label 但有有效 descendants 的结构容器必须透明 flatten，不能把 raw/internal key冒充 label；有合法 label的单一有效 child source 层可以折叠。
- 不返回完整 breadcrumb、total、未过滤 child count、raw key、coordinate、route、score、source lineage 或 internal diagnostics。
- stale/invalid node 或 cursor fail closed，不回退到 root，也不自动重置 pagination。
- 这是 read-only request/result，不生成 gameplay execution receipt 或 `authoritatively_completed`。

### 3.2 `find_destination`

```ts
interface FindDestinationArgs {
  query: string;
}

interface DestinationCandidate {
  label: string;
  contextLabel?: string;
  destination: DestinationSelector;
}

type FindDestinationResult =
  | {
      status: "resolved";
      reason:
        | "exact_current_locale"
        | "exact_fallback_locale"
        | "exact_explicit_alias";
      destination: DestinationCandidate;
    }
  | {
      status: "candidates";
      reason: "ambiguous_exact" | "fuzzy_match";
      candidates: readonly DestinationCandidate[];
    }
  | {
      status: "not_found";
      reason: "destination_not_found";
    }
  | {
      status: "invalid";
      reason: "destination_search_invalid";
    }
  | {
      status: "blocked";
      reason: "destination_search_unavailable";
    };
```

规则：

- normalization 后 1–128 Unicode scalar values；拒绝 blank、control、coordinate/path/raw-map-action-shaped input。
- Agent 不提供 locale、threshold、scorer、candidate count 或 ranking policy。
- 不回显 query；Agent 已持有输入，重复输出只增加 context 和 transcript 扩散。
- current-locale exact、fallback-locale exact 与唯一 explicit alias exact 可以直接 `resolved`。
- ambiguous exact 与所有 non-exact lexical/fuzzy 命中只返回最多 3 个 candidates；V1 fuzzy 不直接 `resolved`。
- 不向 Agent 暴露 score、threshold、margin 或 canonical internal identity。
- 返回结果不是 capability、permit、receipt 或 Navigation success evidence。
- 这是 read-only request/result，不生成 gameplay execution receipt。

### 3.3 `navigate_to_destination`

```ts
interface NavigateToDestinationArgs {
  destination: DestinationSelector;
}

type NavigateToDestinationTerminal =
  | {
      status: "succeeded";
      reason: "destination_arrived" | "already_at_destination";
      destination: {
        label: string;
        contextLabel?: string;
      };
    }
  | {
      status: "failed";
      reason:
        | "destination_selector_invalid"
        | "destination_selector_ambiguous"
        | "destination_selector_stale"
        | "destination_unreachable"
        | "path_not_found"
        | "transition_removed"
        | "location_changed"
        | "player_not_actionable"
        | "native_controller_replaced"
        | "policy_revoked"
        | "cancelled"
        | "deadline_expired"
        | "native_transition_uncertain";
    };
```

标准 action lifecycle 继续拥有 requestId、idempotency、expected revision、deadline、executionId、receipts、evidence 与 cancel。只有同一 execution 的 `succeeded` terminal、non-empty Navigation evidence 与 fresh same-canonical-destination postcondition 共同成立时，才可投影完成。`already_at_destination` 也必须经过 fresh admission/reread 并产生自己的成功 receipt/evidence。

## 4. `DerivedDestinationSet`：唯一 destination authority

Mod 在 game thread 从 current target content/world 派生 immutable generation snapshot：

```text
Data/Locations
+ Data/WorldMap
+ content-author explicit metadata
+ current Game1 locations / LocationContext
+ native Condition / KnownCondition / TokenParser results
→ DerivedDestinationSet generation
```

每条 private record 至少包含：

```text
content owner
canonical destination identity
current/fallback localized labels
explicit content aliases/former names
source-proven WorldMap binding（若存在）
runtime existence/availability facts
world/content generation
```

不允许两个独立 catalogs：

```text
DerivedDestinationSet
  ├─ WorldMap projection → folded frontier / nodeRef / label-or-ref selector
  ├─ Search projection   → label-or-ref candidates
  └─ Navigation resolve  → private canonical binding
```

当前冻结 target `1.6.15.24356` 的 `Data/WorldMap` root有两个 content dictionary records，internal keys 为 `Valley` 与 `GingerIsland`；对应 `WorldMapRegionData` 只有 `BaseTexture`、`MapAreas`、`MapNeighborIdAliases`，没有合法玩家可见 region label。因此 production root不得返回这两个 internal keys，也不得把它们当作两个 Agent-visible groups；应透明 flatten二者，在current condition/disclosure过滤后形成合并的 area decision frontier。Source characterization共有17个areas，正常可落在单个20-entry page内；4 KiB byte ceiling或未来content扩展仍可产生`nextCursor`。

WorldMap 没有显式 hierarchy 的地点不会通过 `inspect_world_map` 出现；K2允许它在满足当前存在与合法玩家名称条件时通过 `find_destination` 出现。Coordinates、map assets、warps、door tiles、routes 与 native members 永不进入 public destination record。

## 5. 搜索技术方案

### 5.1 选定依赖

生产实现使用：

```xml
<PackageReference Include="Raffinert.FuzzySharp" Version="5.0.3" />
```

选择理由：

- MIT；NuGet `5.0.3` 提供 native `net6.0` asset；该 target group 无 package dependencies。
- nupkg 当前约 593 KiB；适合随 SMAPI Mod 本地部署。
- 提供 one-to-many extraction、cached scorers 与 bit-parallel distance 实现，避免维护自写 edit-distance/ranking engine。
- current corpus 预计低于数百条，单次线性 bounded scan 足够；Lucene/index service 的 analyzer、index lifecycle 和 package surface 不成比例。

依赖不提供语义理解或中文/日文分词。必须使用 GameBuddy 自己的 Unicode-preserving normalizer，不能使用可能丢弃 CJK 字符的默认 English-oriented full preprocessor。

### 5.2 固定 pipeline

```text
validate Unicode scalar/query shape
→ NFKC
→ invariant case fold where applicable
→ whitespace/punctuation fold without deleting CJK letters
→ exact current-locale labels
→ exact fallback-locale labels
→ exact explicit aliases/former names
→ deterministic prefix/contains feature
→ Raffinert.FuzzySharp bounded scorer
→ stable top-3 lexical candidates
```

V1 scorer policy：

- Latin/space-delimited labels可比较 `WeightedRatio` 与 direct ratio；
- unspaced CJK 默认使用 direct ratio/partial character comparison，不把 token sort/set 当 authority；
- scorer、cutoff 与 tie/margin 是 versioned private policy constants；
- exact 始终优先；
- non-exact 永远只返回 candidates，不自动选择可执行 destination。

发布前以当前 target 游戏内容和 normal/fallback locale 的 focused regression 覆盖 exact、标点/case/width、短 query、同名、低置信度及 control/path-shaped input；并确认 package 在 exact SMAPI/.NET 6 packaging 中 restore/load。非 exact 结果始终只是候选，因而不会自动选择错误目的地。

若依赖无法在 exact runtime 加载，`find_destination` 保持未发布；不得回退为自写 Levenshtein 或把弱 matcher 称为自然语言搜索。其他两个 operations 不因此改变 authority。

## 6. Context 与资源预算

Context budget 不是 gameplay capability，也不授权 destination；它只防止 observation/search 无界消耗 Agent context。

### 6.1 Mod-owned per-call hard limits

`inspect_world_map`：

```text
最多 20 Agent-facing entries
public JSON UTF-8 最多 4096 bytes
一次请求只读取一个 folded frontier 的 immutable DerivedDestinationSet generation/page snapshot
```

`find_destination`：

```text
最多 3 candidates
public JSON UTF-8 最多 2048 bytes
每次只执行一次 current-generation bounded linear scan
```

实现必须先构造 DTO、严格序列化并检查 UTF-8 byte count，再发布结果。不能为了塞入预算而静默截断 label，使两个地点变得不可区分；超限 record 不签发 executable ref，并只产生 bounded private diagnostic。

### 6.2 单次 projection boundary

每次有效的 `inspect_world_map` 或 `find_destination` 都必须满足 source-owned typed result 的单次 projection contract：inspect page 最多 20 个 G1 entries、4096 UTF-8 bytes；find result 最多 3 个 candidates、2048 UTF-8 bytes。超限结果不得静默截断或签发 executable ref，应以结构化 blocked/invalid result 返回。

Host 只投影 Mod 产生的当前 strict result；它不设置跨 task、turn、tool-call、cursor 或 control epoch 的累计次数/字节 gameplay quota，也不拥有 destination、route、execution 或 completion authority。已签发 ref 仍由 Mod 在当前 generation、TTL、scope 和 world/content binding 上重新校验。

## 7. Opaque ref 技术方案

Wire format 固定为：

```text
ref            = "dr1_" + base64url(128-bit CSPRNG handle)
nodeRef        = "nr1_" + base64url(128-bit CSPRNG handle)
cursor         = "wc1_" + base64url(128-bit CSPRNG handle)
```

C# issuer 使用 `RandomNumberGenerator.Fill(Span<byte>)` 生成 16 bytes，再编码为无 padding base64url。Prefix 只用于 type/version rejection，不携带语义。

Mod runtime-private table 保存：

```text
runtime instance
save/world/player/companion/scope
task/control epoch（若可证明绑定）
content owner + canonical destination identity
world/content generation
issue observation sequence
issuedAt + expiresAt
node parent/revision/page position（nodeRef/cursor）
```

冻结规则：

- ref 是 lookup handle，不是 self-describing signed blob、JWT、serialized authority 或 hash chain。
- Host 原样传递，不解析、不重签、不持久化为 continuity authority。
- TTL 为 5 分钟，并受 scope lifetime、task epoch 与 action deadline 中更短者限制；不 sliding refresh。
- ref 不是一次性 permit；TTL 内可用于新的 idempotent request，但每次都重新走 capability/policy/admission。
- Navigation accepted 后把 validated binding复制到 execution-private state；public ref 后续过期不使已 accepted execution失败。
- 普通 observation sequence 前进不使 ref stale。scope、world/content generation、owner/canonical identity 或 freshness proof 不再成立才 stale。
- generation 变化后只在 Mod 能 fresh 证明相同 content owner + canonical identity 时 rebind；否则 `destination_ref_stale`。
- runtime close、world unload、scope revoke 与 task epoch终结会清除相关 table entries。

## 8. Read-only bridge 与 capability publication

`inspect_world_map` / `find_destination` 不伪装成 execution action，也不塞进全量 `stardew_observe` snapshot。它们使用一个新的、严格 typed、authenticated read-only bridge request/result route，形状类似现有 receipt query，但拥有自己的：

```text
request kind
strict args union
current capability/policy/admission check
game-thread current-generation read
strict result union
fresh source-lineage/private audit
```

它们不创建 executionId、mutation receipt 或 `authoritatively_completed`。Host 为每个 operation materialize 单独 typed tool，不提供 generic observation payload API。

Mod 仍是 publication authority：ordinary Farmhand definitions/policy 必须能分别发布三个 operation identity；Host registry/schema/tool 只是 restrictive projection。Read-only lifecycle 与 mutation lifecycle不同，但不得因此让 Host 单独创造 `inspect_world_map` 或 `find_destination` availability。

## 9. Native Navigation execution

### 9.1 对 Agent：一个 execution

`navigate_to_destination` 对 Agent 表现为：

- 一个 accepted execution；
- 一个 active body owner；
- 一个唯一 terminal outcome；
- existing authenticated STOP/cancel/redirect 是唯一外部中断面；
- 不暴露 route、tiles、warps 或内部 sub-action receipts；
- partial movement 不回滚。

Agent 不用多个 `move_to_tile` / `travel` / `enter_exit` tools 编排路线。Mod 也不通过 Host 递归调用这些 public tools或伪造它们的 receipts。

### 9.2 对 Mod：逐 hop commit

```text
initial game-thread admission
→ validate destination binding
→ derive bounded advisory route
→ for each hop:
   pre-controller revalidation
   → arm one native PathFindController local target
   → observe local arrival
   → pre-transition revalidation
   → commit one approved native transition
   → correlate exact same-execution location change
   → post-transition fresh reread
   → discard old local target/route suffix
   → bounded replan when allowed
→ fresh final canonical destination reread
→ unique terminal CAS
```

每个 checkpoint fresh 检查：

```text
scope + live published capability/policy
revision + idempotency/request identity
deadline + cancellation epoch
player actionability + body/controller ownership
current location + relevant route edge
world/content generation + destination binding
```

V1 execution boundaries:

```text
有效 Navigation task 不因 hop 或 replan 次数而终止
每个 armed transition edge 最多一次 native commit attempt
总时间受 action deadline、authenticated STOP/cancel、真实不可达或 runtime terminal failure 限制
```

The one-attempt rule prevents replaying a transition whose native side effect may
already have occurred; it is not a route quota. The runtime keeps only the
current source-derived route/edge state needed to make progress and discards
obsolete suffixes after a correlated location change.

允许 replan：

- initial route；
- successful correlated transition 后；
- 尚未产生副作用时发现 planned edge drift；
- local path failure，但玩家仍在预期 location、controller ownership 未丢失且 fresh source facts still yield a route。

禁止 replan并必须 terminal：

- 未关联的外部 location change；
- controller 被其他 owner替换；
- native transition 可能已经产生副作用但 correlation 不确定；
- policy/cancel/deadline 终结；
- destination binding 无法 fresh 证明。

已 commit transition 后抛错不能自动重试；返回 `native_transition_uncertain`。Navigation 不把玩家恢复到起点，只停止继续移动并诚实报告可证明状态。

### 9.3 现有代码复用

实现复用而不复制：

- `FarmhandActionCatalog` / `ActionPolicyEngine` / `FarmhandCapabilitySurface` 的 Mod-owned publication authority；
- `BridgeSession` 的 authenticated ingress、revision/deadline/idempotency gates；
- `FarmhandActionRouter` / `ExecutionManager` 的 game-thread lifecycle 与 receipt ledger；
- `StardewBodyController` / native `PathFindController` 的同图移动；
- source-realized ordinary warp/door mechanics与 exact location-change reread；
- Host `IntegrationToolContext` fresh pre-write admission 与 restrictive tool projection。

现有 `StardewBodyController` 当前把 local path terminal直接回调给 `ExecutionManager`。Semantic Navigation 需要把它收敛为 owner-neutral internal local-leg result，使 Navigation coordinator拥有唯一外部 receipt；不得让每一 leg 生成 public `move_to_tile` receipt，也不得建立第二个 body controller。

## 10. Arrival 与 Mine 边界

V1 arrival 由 destination-owned canonical postcondition判断，不由 display label、search score、route completion 或最后一个 tile判断。

首个 Mine tracer：

```text
DerivedDestinationSet canonical Mine exterior binding
→ destination ref ({ kind: "ref"; ref: "dr1_…" })
→ Mod-private native route
→ fresh current location identity == same canonical Mine exterior
→ destination_arrived
```

到此结束。它不要求面对入口、站在 action tile、触发 `Action="Mine"` 或进入 `MineShaft`。之后若 Agent要进矿井，独立调用已完成的 `enter_mine`。三个 M8 actions继续拥有自己的 policy、execution、receipt/evidence 与 fresh postcondition。

## 10.5 非变更 preflight 边界 (frozen)

Task 7 的 preflight 包即三个可执行检查：`tools/replay-stardew-navigation-operation.mjs`（回放一条真实形状的 accepted/running/terminal receipt 线，断言单一 requestId/executionId 关联、单一 terminal、仅 `navigation_completed` + bounded fresh-read evidence 才算 success，且任何 receipt evidence 不得泄漏 route/tile/warp/leg/source 原始单元）、`tools/stardew-navigation-topology-preflight.mjs`（校验目标版本 `1.6.15.24356`、static bundle、caller-supplied transition artifact 与 no-dispatch/no-M8 源码闭包）、`tools/preflight-stardew-navigation-agent-live.mjs`（组合 replay+topology，静态核验 opaque selector `ref-only`、Host tool 名、仅 destination selector args、完成谓词严格性、fixture 事务/teardown 路径与 no-M8 navigation 路径）。三者严格 non-mutating：绝不 launching Stardew、绝不 connect named pipe、绝不写 fixtures/profiles/config、绝不调用 `execute()`、绝不发布 receipt、绝不在 repo 内制造 target artifact。Target transition proof 只接受 caller-supplied JSON artifact 且须通过现有 `validateTransitionCharacterization` 与 `allowsTransitionImplementation`。

## 11. Closure 与 evidence

| Operation | Formal closure | Agent-context gate | 真实使用 evidence |
|---|---|---|---|
| `inspect_world_map` | target-version hierarchy、strict result、fresh scoped refs、stale/forged/cursor negative cases | 20 entries、4 KiB per result | 记录调用、展开深度、selector 是否被 Navigation 消费 |
| `find_destination` | exact/alias/candidate/not-found contract、current game-derived labels、package/runtime load、canonical selector lineage | 3 candidates、2 KiB per result | `used_and_consumed / used_not_consumed / not_invoked / failed_to_resolve / misresolved` |
| `navigate_to_destination` | same-execution succeeded receipt、non-empty per-hop evidence、fresh canonical postcondition；cancel/deadline/replay/uncertain negatives | 不披露 internal route/evidence dump | 至少一次真实 Agent autonomous invocation + target-version live mutation gate |

Search telemetry默认只记录：

```text
opaque invocation/scenario id
query source category + length bucket
match stage
candidate count
score/margin bucket（private audit only）
latency
是否被 Navigation消费
final canonical/navigation verdict
```

共享 artifacts不记录 raw query、labels、aliases、destination identity、refs、routes 或 coordinates。

## 12. 下一轮产品讨论：仅剩两个边界

技术分支已在本文收敛。实现前仍需讨论并最终冻结两个产品语义：

### 12.1 Agent 的 destination knowledge scope

**方案 K1：current visible/known，default-deny**

`inspect_world_map` 与 `find_destination` 都只披露 native conditions 下当前玩家可见/已知的 destinations。优点是 Agent 不通过 search 获得超出游戏世界的全知目录；缺点是某些真实存在但尚未在 WorldMap 公开的地点无法搜索。

**方案 K2（已冻结）：current installed-and-existing player-named destinations**

`find_destination` 可搜索所有当前存在且具有合法玩家名称的 destinations，即使不在当前 WorldMap hierarchy；`inspect_world_map` 仍只显示当前可披露的 source hierarchy。搜索只返回名称与 selector，不披露 quest flag、event、hidden condition 或解锁办法。

两者都不允许 hidden quest state、coordinates、routes 或 internal keys。

### 12.2 V1 destination 粒度

**方案 G1（已同意并冻结）：location-level only**

例如 Farm、Town、Beach、Mine exterior。商店柜台、NPC、机器、门前站位等 interaction-ready pose 由后续 owning action 的 private producer负责。

**方案 G2：location + semantic POI**

允许同一 location 内的 content-authored interaction target成为 destination。它会扩大 derivation、postcondition、search collision、pathfinding 与权限边界，不应在没有具体首个 owner/action 时提前引入。

本文冻结 `K2 + G1` 作为 V1。允许 bounded full traversal，但只限 G1 location directory；不重新打开 Host route、任意 string fallback、弱 search、无界分页、tooltip/position map dump 或 movement primitives。

## 13. 明确拒绝

- untyped `navigate_to_destination` selector，或任何未通过 `DestinationSelector` schema 的 string fallback；
- 把玩家原始自然语言直接当作 Mod semantic-search contract；
- 自写 Levenshtein fallback、remote search、Lucene service、embedding/vector DB；
- 全量原生 map dump、无限 cursor pagination、重复 breadcrumbs、audit evidence进入 Agent context；bounded G1 location-directory traversal 是允许的；
- Agent/Host 提交 coordinate、map、tile、warp、route、facing、native action或matcher参数；
- Host-owned destination catalog/ref binding/path planner；
- generic observation/action payload dispatcher；
- signed/self-describing ref、JWT、无具体威胁理由的 hash/attestation chain；
- UI reading、OCR、keyboard/mouse/XInput、raw input、visual/input injection；
- generic warp、reflection native dispatcher、direct player state write或save edit；
- 将 fuzzy score、candidate、route、PathFindController completion 当作 authorization 或 success；
- transition uncertain 后自动重试或继续 replan；
- 用 Navigation receipt关闭 Mine entry/ladder/elevator，或让 `reach_mine_floor`进入本 batch。

## 14. 当前状态

截至本文冻结：

- M8 action set 已完成，仅包含 `enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor`。
- Navigation V1 技术方案已冻结；K2 knowledge scope 与 G1 location-level granularity 已冻结。
- 三个 Navigation operations 尚未 production materialize，也未通过 target-version formal/live closure。
- 现有 P4 probes/corpus tooling 只是 characterization evidence，不发布 capability、refs、search 或 movement。
- 下一步不是执行 live mutation，而是按本设计同步 design/38 implementation briefs，然后按 read-only materialization → non-mutating preflight → 唯一 serial live mutation gate推进。

相关研究：

- [`research/stardew-runtime-navigation-and-mod-prior-art.md`](research/stardew-runtime-navigation-and-mod-prior-art.md)
- [`research/stardew-navigation-destination-matching-options.md`](research/stardew-navigation-destination-matching-options.md)
- [`research/cross-game-dynamic-semantic-navigation-best-practices.md`](research/cross-game-dynamic-semantic-navigation-best-practices.md)
