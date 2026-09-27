---
id: DOMAIN-STARDEW-INTEGRATION
type: domain
status: current
owner: stardew-integration
---

# Stardew 集成

## 产品 topology

正式 Stardew 产品使用独立客户端 native AI Farmhand topology。`StardewProductionLifecycleCoordinator` 是 browser admission、安装准入、Player Host/AI Client 生命周期、attachment generation、Game enter、STOP、disconnect、quarantine 和反向 teardown 的唯一产品 owner。

Preview、Portfolio、operational harness 和 community connector 都不能复用或制造该 topology 的 pipe、token、profile、launch generation、manifest 或 session authority。

`PRODUCT_INTEGRATION_CATALOG` 不再注册任何可直接选择的 integration launcher，直接 `pipeName`/`bridgeToken` attach 已移除：`STARDEW_INTEGRATION_LAUNCHER` 仍存在供 Preview 与 coordinator 私有 materializer 使用，但产品入口只能经 composition root 绑定 `stardew` game provider 到 `StardewProductionLifecycleCoordinator`，不保留 fallback、兼容路径或 alternate production mode。Resume 不得把该过渡 attach 当作外部游戏发现或通用绑定机制。

`STARDEW_INTEGRATION_LAUNCHER` 仍可作为 Preview 和 coordinator 私有 Farmhand materializer 的窄 adapter 构造机械；正式产品只有 coordinator 可以消费 generation-bound private materializer。生产 import inventory 必须保持该 materializer 的 coordinator-only ownership。Preview 与 Portfolio 继续拥有各自隔离 topology，不能因产品路径收敛而接入 coordinator。

## Shape B 启动 seam（冻结）

游戏侧 contract 只暴露 typed/private game-facts producer capability，绝不暴露 `Uint8Array` 或 native private-frame bytes。`ContainedGameRuntime.launchRole(role: ContainmentRole, operation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer): Promise<RedactedRoleLaunchOutcome>` 是唯一启动签名；`RoleLaunchOperation` 是 private、per-invocation 对象，由 game lifecycle 在 fresh admission/preconditions 完成且作出 launch decision 后创建，只有 `launch_role` 携带其 deadline。producer 只接收并使用 typed private game facts 或 capability，绝不接收或返回 native frame bytes。Host composition 私下把选定的 Stardew producer 绑定到 platform encoder/private launch transport 与 authenticated session；generic runtime core 只负责 one-shot authorization、role/deadline binding、serialization、terminal states 与 redacted outcomes，不知道或解释 game facts。只有 platform/auth modules 处理 native frame bytes。Chat/Game lifecycle 仍彼此独立；不引入 global registry、daemon、browser handoff、fallback、hash、signature 或 redundant gate。

旧 `Uint8Array` producer 与 deferred launch plan 明确标记为 migration-before；它们不是 compatibility、fallback 或 parallel production authority，必须在 Shape B 实现验收前移除。

## 安装与启动

每个 Windows user 只有一个 Host-private 的 active Stardew installation runtime registration。其 durable record 只保存 schema、revision、state、locator 和 desktop binding；不得保存 opaque `AdmittedStardewInstallation`、`modsPath`、fixture、lease、pipe/token、evidence 或任何运行时 capability。locator 只是后续 strict admission 的私有候选，不是 capability。

`StardewProductionLifecycleCoordinator` 是 Stardew 的第一个 game-private `LaunchAuthorization` producer。它只能通过唯一窄 contract `host/src/containment/runtime/contract/game-runtime.ts` 消费 Host runtime；不得导入 implementation-private `host/src/containment/runtime/core/contained-game-runtime.ts`、auth transport、bootstrap roots、Desktop、Guardian、Windows 或 native，且 `host/src/composition` 独占 runtime/core 与 game adapter 的装配：它仅在 staged Player Host/D 已完成 request-local fresh admission、role recipe、one-shot reservation 与其他 launch preconditions，并决定实际启动后，创建本次 invocation 独有的 `RoleLaunchOperation` deadline，经 Host composition-owned `ContainedGameRuntime` 的窄 private seam 请求 contained role launch，并只消费脱敏 outcome 继续 Stardew attestation/attachment/STOP/quarantine 语义。这里的 role 仅是 OS process role（`player_host`/`ai_client`），不是游戏内 NPC 或 AI companion；game runtime 持续时间由 lifecycle termination/STOP/crash 决定，不是 timeout。仅保留 transport/handshake wait budgets 与该 invocation deadline；只有 `launch_role` 携带 `RoleLaunchOperation` deadline，arm/contain/recover 仅在 wire 要求时携带各自 transport/operation wait budget，且不代表 launch deadline 或 game lifetime。bootstrap timeout、browser admission expiry、owner/attempt expiry 不得复用为 role-launch deadline；每个非 launch budget 必须有独立 failure model 与 owner：arm 由 generic runtime/Guardian operation 持有，bounded wait 结果是 `arm unavailable` 且不得 launch；contain 由 generic runtime/Guardian cleanup 持有，bounded wait 结果是 `containment uncertain`/quarantine，永不成功；recover 由 Guardian recovery state machine 持有，bounded wait 结果是 `recovery unavailable`/held 且旧 lease 仍为 authority。这些只是 transport/operation waits，不是 game lifetime 或 launch deadline。它属于 `host/src/games/stardew/{lifecycle,launch,bridge}`，其中 Stardew process-owner 的当前物理路径是 `host/src/games/stardew/lifecycle/{stardew-process-implementations.ts,stardew-player-host-process-owner.ts,stardew-ai-client-process-owner.ts}`；任何旧 `host/src/stardew-*` 路径仅是 migration-before 状态，不是当前 task target。不得直接取得或导入 Windows Guardian pipe、token、Job、PID、handle、native launch plan 或 Desktop raw transport；`host/src/containment/runtime/core/contained-game-runtime.ts` 也不得导入 Stardew、SMAPI、Farmhand、Mod、catalog、action、installation locator 或 Stardew recipe；generic runtime implementation 只能由 composition 导入。目录落地或迁移必须同步更新本 domain 文档与相关 directory-local README；不得添加 alias、re-export 或并行路径。`bootstrap/{entry,wire,roots}` 与 `composition` 只装配已命名的 private seam。各目录落地时的本地 `README.md` 必须定义 `Owns`、`Does not know`、`Dependency direction`、`Placement and move rule` 与 `Required verification`；本次不创建 README。该跨游戏 direction 由 [ADR-0007](../../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md) 定义。

Host-native picker 只用于首次 registration 或用户显式 reselection。setup 只 strict-admit 并发布 locator registration，不创建 attempt 或保留 picker-time capability 作为 launch 输入。每次 production、release 或 control 的 `game.launch` 都由 bootstrap owner 原子 prepare-and-bind，随后消耗该 request 的 Player Host bootstrap reservation reservation 并进入 Stage B；只在 staged Player Host native effect 前才从同一 registration 的 locator request-local fresh-admit；RoleLaunchOperation deadline 不得在此之前创建，也不得使用 bootstrap/admission/attempt expiry。新的 `AdmittedStardewInstallation` 仅在唯一 `StardewProductionLifecycleCoordinator` 的私有闭包中交付。cabin confirm 在 materialized AI Client native effect 前必须对同一 request 作第二次独立 fresh-admit；opaque capability 不跨请求、replay、attempt 或重启。coordinator 仍是 Player Host/AI Client、attachment、Game enter、STOP、disconnect、quarantine 和反向 teardown 的唯一 owner。旧 `integrations/stardew/action-development` profile 不能导入、消费或作为该 registration 的 fallback。

control 在没有 registration 时只返回 `setup_needed` 或 `unavailable`，不启动替代路径，也不改变已发布 `equip_tool` 的 production authority 或 behavior。registration 的 active pointer 只指向 guardian/bootstrap authority，不是 cleanup 或 containment truth；只有 guardian settlement proof 证明 exact attempt 已 containment 后，registration 才可回到 `ready`。安装失效、移动、reparse 改变或 desktop binding 不匹配时拒绝并要求显式 reselection。

## Mod authority

Mod 的 action registrations、read-only operation registrations 和 live enabled policy 生成唯一 immutable capability surface。它控制 hello、snapshot、advertisement、execution availability、read availability 和 discovery。Host registry、schema、tool 和 catalog 都只是 restrictive projection，不能从存在 bridge route、schema 或 tool wrapper 反向发布 operation。

游戏线程在 mutation 前重新检查 scope、player policy、catalog revision、deadline、idempotency、cancel 和实时游戏前置条件，并通过目标版本原生入口执行。read-only operation 不执行 native mutation，也不创建 execution receipt；它仍必须在 Mod 游戏线程通过当前 authenticated scope、live capability/policy、attachment generation 和 world 可读性检查。

## `observe_scene`：公开只读场景观察契约

本节将 `observe_scene` ratify 为 Stardew 的公开 `read_only` operation，并已正式 publish（2026-09-19 Stardew integration/release owner 显式决策，见 Read-only publication gate 末行）。它是一次由 Agent/受限消费者显式请求的、当前 world 的 bounded typed observation，不是 Game Action、Body Program node、任务完成事实或交互本身。该 ratification 固定公开契约与责任边界；publication 证据见下节 gate 记录。

### Operation contract

认证 bridge 使用 `observe_scene_request` / `observe_scene_result` 传递以下公开数据契约；对应的 Mod wire DTO identity 是 `ObserveSceneRequestPayload` / `ObserveSceneResultPayload`。它们是只读 operation 的 typed wire projection，不是 `execution_request`、execution receipt 或 Body Program message。

```ts
interface ObserveSceneArgs {
  /** 可选的整数半径；省略时为 15 瓦片，最大为 30 */
  radius?: number;
}

interface ObserveSceneAffordance {
  /** 绑定本次 observation 的 opaque ref；不是实体句柄或持久 ID */
  ref: string;
  kind: "npc" | "chest" | "crop" | "forage" | "door" | "machine";
  name: string;
  distance: number;
  direction: "North" | "South" | "East" | "West" | "CurrentTile";
  actionHint?: string;
}

interface ObserveSceneResult {
  /** 当前 observation 的 opaque identity；每次成功观察都重新生成 */
  observationId: string;
  currentLocation: string;
  currentRegion: string;
  affordances: readonly ObserveSceneAffordance[];
  summary: string;
  isPartial: boolean;
  truncatedReason?: string;
}
```

`radius` 只改变当前查询的感知范围；它不授予行动权限，也不改变世界或玩家 policy。`affordances` 最多 20 项，按 Mod 固定的优先级与稳定 tie-break 裁剪。`summary` 是玩家语义摘要，不是机器 authority；`ref`、名称、坐标和 `actionHint` 都不能替代 consumer 自己所需的 fresh game-thread identity、范围、所有权、policy 或 postcondition 检查。每次成功的 observation 都产生新的 observation identity；结果不含 execution identity、receipt、evidence、completion claim、credential、transport token 或 prompt。

### Owner、capability、policy 与 consumer ownership

- 本 current Stardew domain owner 负责记录该 contract；运行时 operation owner 是 Mod 的游戏线程。Mod registration 是 `observe_scene` 的唯一 membership、identity/version、`read_only` kind、参数/结果 descriptor 与 live availability source。Mod 的 live enabled policy 和 capability revision 决定它是否可被当前 authenticated session 查询；Host 不得仅因收到了 `observe_scene_request` 就把它视为可用。
- `BridgeSession`/bridge 只负责 authenticated scope、wire DTO 校验、请求转发以及 observation/ref 的当前 activation 生命周期；scene provider/projection 负责从游戏线程读取和有界投影真实 world facts。它们都不能铸造 capability、policy 或 interaction 权限。
- Agent 可见 operation 只能是 Mod 当前 published/read-enabled capability、Host 能够创建的 typed restrictive projection 与显式玩家 policy 的交集。Progressive disclosure 只能隐藏它，不能授予它。Host registry、schema、tool、catalog 和 bridge forwarding 不能增加、重解释或替换 Mod policy。
- `observe_scene` 是只读消费者边界的终点：它返回普通当前回合 tool result，不写 receipt/journal、不会自动开始 Agent turn、不会创建 task/RuntimeFact/Memory，也不会写 Chat history 或 Magic Context。Host 只做认证、边界校验和传输。
- `ref` 只能交给一个由 Mod 单独发布、且 descriptor 明确声明 observation-bound target 的 interaction/navigation consumer。该 consumer 必须在游戏线程重新解析 ref 并检查当前 scope、observation identity、实时位置/范围、所有权、policy、revision、deadline、cancel 和 action-specific postcondition；Host、Agent 或 `observe_scene` 不得按名称、坐标或“最相似对象”静默替换失效 ref。本文不发布名为 `interact` 的新 action，也不把 `actionHint` 当作 action membership 或授权。

### Observation/ref lifecycle

`ref` 是当前 authenticated world binding 内的短时 opaque 引用，绑定 `{lifecycle activation, bridge/attachment generation, observation identity, current location, movement sequence}`；它不是 durable data、credential、native entity handle 或跨 session identity。

1. **Movement：** 伴侣发生任何 tile 位移、跨地图 warp、location 改变或 world unload 前，旧 observation 的所有 ref 全量失效。下一次 observation 必须创建新的 identity；不能在旧 ref 失效后按名称或坐标 fallback。
2. **Disconnect：** bridge disconnect、owner close、attachment loss、scope mismatch 或 world 变为不可读时，立即关闭 observation store 并使该 activation 的全部 ref 失效。只读请求不能在断线期间排队等待后继续消费旧 ref。
3. **Reconnect：** reconnect 建立新的 authenticated attachment/generation，即使仍指向同一个登记 world binding，也不会恢复旧 observation store、旧 callback 或旧 ref。恢复只可先完成 fresh observation，再由消费者提交新 ref；不会自动 replay 旧交互或任务。
4. **Generation/lifecycle：** bridge generation、lifecycle activation、save/world/companion binding 或 Mod observation runtime 改变时，旧 generation 的 ref 永不跨代可用。新 generation 必须重新通过 scope、capability/policy 和 world-readability admission；未知或无法匹配的 ref fail closed。

### ObservationBinding v1

`ObservationBinding/v1` 是把一次 `observe_scene` 中发现的动态实体交给另一个已发布 action 的唯一短时绑定形状。绑定对象的 keys **必须且只能是** `observationId` 与 `ref`：

```ts
interface ObservationBindingV1 {
  observationId: string;
  ref: string;
}
```

`observationId` 是 `ObserveSceneResult.observationId`，`ref` 是同一结果中 affordance 的 opaque ref；两者都不是名称、坐标、持久 ID、native handle、执行 identity 或授权。任何额外 key（包括 `kind`、`name`、坐标、revision 或 action hint）都使 binding malformed。Agent、Host 和 bridge 不得从名称、坐标、最相似对象或另一 observation 合成或替换 binding。

ObservationBinding 是 **action-specific opt-in**，不是通用 action 参数。只有 Mod registration/descriptor 明确声明接受 `ObservationBinding/v1`、声明允许的目标语义并独立通过 publication gate 的 action 才能接收它；未 opt-in 的 action 必须拒绝该 binding，不能因为 Host schema、tool wrapper、catalog 或 bridge forwarding 而获得 opt-in。即使 action opt-in，binding 也只提供候选目标，不跳过该 action 原有的 scope、player policy、revision、deadline、cancel、世界前置条件或 action-specific postcondition 检查。本文不因此发布新的 interaction action，也不改变任何既有 action 的 published 状态。

Opt-in action 必须在 Mod 游戏线程、native dispatch **之前**按以下顺序重新验证 exact binding：

1. 验证当前 authenticated scope、lifecycle/attachment generation、world readability、action live capability/policy、revision、deadline 与 cancel；`observationId` 必须属于当前 activation 的 observation store，且与 `ref` 精确配对。
2. 用 `ref` 重新解析当前 target-version native entity，并重新读取其实时地图、位置、可用性、所有权/本地玩家限制、交互范围与 action-specific 条件。不得信任 observation 中捕获的坐标、名称、kind 或旧实体引用；实体移动、消失、替换、离开范围或不再满足条件都必须 fail closed。
3. 只有全部检查成功才允许 action 的原生入口；执行后仍须由 action 自己验证 postcondition、receipt/evidence 与 cleanup。任一 binding 检查失败都不得产生 native mutation、success、completion claim 或通过旧 binding 重试。

Binding 失败使用稳定 typed error code，不以名称/坐标 fallback 或静默重观察掩盖：

- `observation_binding_not_supported`：action 未声明 action-specific opt-in；
- `observation_binding_malformed`：keys 不精确为 `observationId`/`ref`，或值不符合 opaque identity 约束；
- `observation_binding_stale`：observation/ref 未知、已被 movement/warp/new observation 取代，或 activation/generation、scope 不匹配；
- `observation_binding_target_unavailable`：当前 native entity 已消失、替换、不可读或不再归属于允许的玩家/world；
- `observation_binding_target_out_of_range`：实体仍可解析但实时距离/地图范围不满足该 action；
- `observation_binding_precondition_failed`：动态实体已解析，但 action-specific policy、revision、deadline、cancel 或其他前置条件失败。

这些 codes 只分类拒绝原因，不创建 receipt，不授予 retry 权限，也不把未知 native side effect 解释为未发生。`observation_binding_stale` 尤其不能通过旧 `ref` 重送；消费者必须先取得 fresh observation，再由 action 重新提交新的 exact binding。

Opt-in action 的成功 result **可以**附带可选的 `piggybackedScene?: ObserveSceneResult`。该 attachment 必须来自同一 action 完成后的 target-version 游戏线程 fresh read，并拥有新的 `observationId` 及只属于它的 refs；不得复用 action 前 observation、把旧 scene 当作 postcondition、或由 Host 拼接 scene。缺少 fresh read、world 不可读或 payload ceiling 无法满足时省略该字段而不是返回 stale scene。`piggybackedScene` 只是下一次请求的观察材料，不是 capability、receipt、evidence、完成事实或自动 continuation；movement、disconnect、generation 变化仍按本节 lifecycle 规则立即使其 refs 失效。

### ObservationBinding v1 publication gate

ObservationBinding contract 的存在不等于任何 action 已发布。Agent-facing publication 必须同时闭合以下独立门禁：

1. `ObserveSceneResult.observationId`、每个 affordance 的 `ref`、`ObservationBindingV1` 的 exact-key 形状、opt-in action descriptor、typed error codes 与可选 `piggybackedScene` projection 在 Mod registration、hello/advertisement、authenticated bridge 和 Host restrictive projection 之间保持 parity；只有 Mod live capability/policy 能授予 membership/opt-in，Host 不能补齐或扩大它。
2. 目标版本游戏线程测试必须证明 exact-key 校验、observation/ref 配对、动态 native entity revalidation、movement/warp/new-observation/disconnect/reconnect/generation invalidation、entity disappearance/replacement、实时范围与 action precondition 拒绝，以及所有拒绝路径零 native mutation。测试还必须证明 `piggybackedScene` 仅在 action 完成后 fresh 生成、使用新 observation identity，并遵守 scene 的条目与 UTF-8 ceiling。
3. 正式 `native_ai_farmhand_multiplayer` topology 中，必须有 Agent 显式 `observe_scene` → 已发布 opt-in action 的 target-version live evidence，覆盖至少一个合法动态实体成功路径和 stale/out-of-range/target-unavailable 失败路径，并记录 scope/policy/revision/deadline/cancel、receipt/evidence/postcondition、teardown/cleanup 与失败分类。native-local/direct route、Preview、fixture、mock、Host-only test、source/API inspection 或人工报告不能替代该证据。
4. Stardew integration/release owner 必须完成与 `observe_scene` read-only gate、ordinary Navigation mutation gate 分离的 review，并作出显式 publish decision。未闭合前，binding 及 `piggybackedScene` 只能作为 `live-ineligible` contract reference；既不能让 action 接收 binding，也不能因 bridge 已能转发 payload、descriptor 存在或代码返回字段而声称已发布。
   **2026-09-19 gate record：** `observe_scene` read-only publish decision 已作出（见下节），`piggybackedScene` 与 `ObservationBindingV1` 随 `pickup_forage.sceneTarget` opt-in 链在 target-version native-local live 中验证；任何新 opt-in action 仍须独立通过本 gate 第 3 条的正式 topology live evidence 才能接收 binding。

### UTF-8 payload ceiling owner

`observe_scene` 的 Mod-owned scene projection/serializer 是结果 payload ceiling 的唯一 owner：规范化、紧凑 JSON 的 UTF-8 编码结果必须 `<= 2048` bytes，且 `affordances <= 20`。该上限适用于 `observe_scene_result` 的 typed result payload；外层 authenticated bridge frame 的 transport limit 由 bridge/protocol owner 单独负责，不能用它放宽本 operation 的 payload 上限。Mod 必须在发送前按固定优先级和 tie-break 裁剪，并在发生条目或字节裁剪时设置 `isPartial: true` 与有界 `truncatedReason`；不得静默丢项。Host、schema、tool 或 consumer 不能二次截断、提高上限、拼接摘要或把超限结果推断为完整 observation。

### Read-only publication gate

`observe_scene` 的 public contract ratification 不等于 publication。Mod/adapter 仍拥有 capability membership 与 live policy，Host 只拥有 restrictive projection；Stardew integration/release owner 负责按当前 release model 保存证据并作出明确 publish decision。进入 Agent-facing published capability 前，必须满足以下独立门禁：

1. Mod registration、descriptor、live enabled policy、capability revision、hello advertisement 与 authenticated bridge projection 对 `observe_scene` 保持单一来源和 parity；Host 只保留 restrictive projection，不能用缺失的 Mod registration、静态 schema 或 direct route 补齐 publication。
2. 目标版本游戏线程测试覆盖 authenticated scope、owner thread、live capability/policy、attachment generation、radius/entry/UTF-8 bounds、partial/truncated signaling、movement/disconnect/reconnect/generation ref invalidation，并证明零 native mutation、零 execution receipt/journal、零自动 task/context/Memory projection。
3. 正式 `native_ai_farmhand_multiplayer` production topology 中，以 Agent 显式请求开始，取得 bounded current-world result，并由合法 interaction/navigation consumer（若该 consumer 已独立发布）按 observation-bound ref 进行 fresh recheck；必须记录 target-version live world/readability、consumer boundary、teardown/cleanup 和失败分类。native-local/direct gate、Preview、fixture、mock、source/API inspection、Host-only test 或人工报告不能替代该证据。
4. 完成与 ordinary Navigation mutation gate 分离的独立 review 和显式 publish decision。未闭合前，`observe_scene` 的契约可被引用，但 capability 必须保持 `live-ineligible`/不可见；不能因为 bridge 已能转发 `observe_scene_request` 或代码存在 payload type 就声称已发布。
   **2026-09-19 gate record：** 该显式 publish decision 已作出（见下段），`observe_scene` 自本日起进入 Agent-facing published capability，不再保持 `live-ineligible`。

**2026-09-19 publish decision（Stardew integration/release owner）：** `observe_scene` 正式发布为 Agent-facing read-only capability。证据：Mod registration/descriptor/live enabled policy/hello advertisement 单一来源（`FarmhandActionDefinitions.R("observe_scene", "world_perception")`、`ModConfig.PublishedActions`/`PublishedFamilies` 含 `world_perception`、`ModConfig.ActionFamily` 映射）与 Host restrictive projection `stardew_observe_scene` parity（`5673696`、`a107e2c`、`bb5e3d6`）；游戏线程 focused tests 覆盖 authenticated scope、owner thread、live capability/policy、radius/entry/UTF-8 bounds、partial/truncated、movement/disconnect/reconnect/generation invalidation 且零 native mutation/zero receipt（`SceneObservationTests` 8 + `NavigationReadOnlySessionTests` 11 + `b0e8963`、`674439a`）；target-version native-local live 端到端链 `observe_scene → observationId+ref → pickup_forage.sceneTarget`（`d72e59e`、`63284ab`）。后续正式 `native_ai_farmhand_multiplayer` production topology live run（合法 interaction consumer fresh recheck 的正式拓扑证据）仍作为 future release evidence 补充登记，不撤销本 read-only publication。

## 经验证的 Body Program

`FarmhandBodyProgramController` 是 Mod 游戏线程上已验证 action program 的机械 continuation owner。Agent 声明有限 typed DAG；它选择 action、依赖和语义目标。Controller 从 ready set 确定性选择 ready node（包括 dependency-free source node 和 successor），不规划、搜索、扩图、循环、重试不确定 mutation 或生成玩家文本。

每个待启动 node 都走同一 authenticated Host fresh-admission state machine。对 source node，Controller 从 accepted graph 的 dependency-free ready set 确定性选择；对 successor，Controller 先确认前置 node 的 terminal `succeeded` receipt、action-specific postcondition、持久化 typed `RuntimeFact`、guard 与 typed binding。两者均先 durable-record Controller-named exact `NodeAdmissionChallenge`；Host 只对该 tuple fresh-admit并返回一次性 grant，不能选择节点、改图、改参数或产生事实。Mod 对 exact STOP/catalog/policy/args/resources recheck 后 CAS `awaiting_host_admission → host_admitted` 并消费 grant；该 CAS precedes native dispatch and is every node admission's linearization point。Host unavailable 使 node 保持 `admission_unavailable`，不是 `not_accepted` 或 gameplay failure；确定拒绝才产生 `rejected/expired`。STOP 或 redirect fence 关闭 program epoch 后，Controller 不得启动新 node；尚未启动 node 变为 cancelled/skipped，已写出但结果不明的 node 走同 lineage receipt recovery。

稳定 product/continuity/Stardew scope 下，Mod-owned `BodyProgramJournal/v1` 是 accepted program graph、node state、RuntimeFact、resource ownership、STOP fence 和 node execution identity 的唯一 durable authority。Host journal 只保存 exact-node dispatch/admission transport tuple、binding、historical Host owner/epoch、grant correlation和 transport uncertainty，不能推进 graph、重建 program、取得 resource 或拥有 STOP。BodyProgramJournal 缺失、损坏或 identity mismatch 时 Controller fail-closed/quarantine。

现有 `StardewBodyController` 继续是本地 movement/path driver；它不是 program scheduler。program/node 及恢复细节由 [ADR-006](../../adr/006-verified-body-programs.md) 定义。

## Body Program pipeline messages

Verified Body Program 通过 versioned、scope-bound 的 program messages 运行，而不是通过一个最终返回值完成：`program_verify` 是纯验证报告，`program_submit` 是 Mod durable accept/reject，`program_status` 是 addressed snapshot，`program_events` 是带 monotonic cursor 的 Mod-authoritative event projection。Host 只做认证转发；不得从单 action receipt、全局 `latestReceipt` 或 Host cache 合成 program state。重连通过 `programId` 和 cursor 从 Mod journal 恢复，不能补写历史 Pi tool result。

## 同一 action lineage 的恢复

Host 在 bridge 写入前持久化同一 logical action 的查询材料；Mod 是 native execution 与 receipt 的唯一事实来源。Host journal 只记录原始 request、scope、binding tuple、transport 状态与原始 runtime owner/epoch，不生成、推断或修改 receipt。

journal 文件按稳定的产品/continuity/Stardew scope 重新打开。每条记录保留产生该 dispatch 时的 `ownerId` 和 `epoch`，但这些 runtime-local STOP/cancellation facts 不是文件身份，也不会在新 Host 中重新成为当前 runtime authority。

Control start 只是非权威 intent：它只包含固定 `scenarioId: "equip_tool_control"` 与有界 run/correlation/deadline/cancellation 字段，不包含 action ID、slot/arguments、admitted revision、`requestId`、`idempotencyKey` 或 journal tuple。Host fixture preparation 与 authenticated attachment 完成后，runner 才在进程内选择既有 published action、派生合法 slot/arguments、读取 live revision，并在其 admission 内 mint request/idempotency 材料、先持久化 journal tuple，随后 dispatch。

runner 在 dispatch 后被强制退出时，adapter 只记录 `actionOutcome: indeterminate` 和 `terminalCode: recovery_incomplete`；它不查询、恢复或重试。唯一 recovery owner 是既有 Host-owned 的下一次 fresh lifecycle activation：它以新的 lifecycle owner 建立 fresh authenticated binding，重新打开稳定 scope journal，并由 `StardewExecutionRecoverySupervisor` 仅用原 `{requestId, idempotencyKey}` 查询 Mod receipt。T1 必须在 T2 前证明并命名该既有 activation 的真实 composition entrypoint；若不存在，实施保持 interface-blocked，不得发明第二个 recovery owner。恢复不通过普通 admission，也不重发 action。

`prepared → sent_unknown → recovery_pending → terminal_settled | recovery_required` 的每次状态转换必须先持久化。`receipt_not_found`、binding 或 scope 不匹配、过期、malformed response、query failure 与持久化失败都进入 `recovery_required` 并保留材料；它们不证明 Mod 未接受请求。收到匹配 Mod receipt 后仍须走既有严格 receipt、action-specific postcondition 与 fresh observation 路径。

## 当前状态

- action platform 与部分 M1–M10 action 已有局部 closure；这不等于完整 Game release。
- installation registration **已闭合**(2026-09-27)。durable Host-private record/selector **已存在**:`host/src/stardew-installation-registration.internal.ts`(487 行,`gamebuddy-stardew-installation-registration/v1`,`ready|invalid`、opaque `locator`、`activeAttempt.bootstrapCorrelation`、`revision`,owner transaction 含 `bindPreparedPointer`/`releaseSettledPointer`/marker),并有 12 项 focused test(11 pass,1 skip:本机不允许符号链接)。生产接线齐全:coordinator 消费 `readStardewInstallationRegistration`(`stardew-production-lifecycle-coordinator.internal.ts:19`),composer core 的 prepare-**bind** 已接入生产(`stardew-private-bootstrap-composer.core.ts` → `prepareAndBindOwnedRegistrationAttempt`)。
  - **settlement-release 已在 2026-09-27 接入生产**(提交 `2a34f2d`/`624a657`):通用 `ContainedGameRuntime` 新增受保护终态 `settle()`,其合法条件为"每一个真正 launched 的 role 都已 contained",因此 ordinary close/AI crash/controller EOF 无法到达平台结算;具名 `game.endgame` 操作是唯一能驱动两 role contained 后铸 proof 并释放 pointer 的路径。owner.json 的 `finalizeControlledContained` 推进权已从已删除的 legacy facade 收归 composition。
  - **`productInstallationId` 由 owner 决议(2026-09-26)正式废除**:生产代码、测试与 `handoff-action-nav.md` 始终只绑定 `{ rootLayoutVersion: 1 }` 并拒绝携带该字段的记录,plan 是唯一仍在要求它的地方;该要求已从 plan 删除。
  - **Gate 证据**:gate 1–9 均有 focused 证据(3 prepare-and-bind 覆盖 4/4 crash 窗口;4 settlement 含 4 项负向断言;5 三个准入点各自 fresh capability;6 Windows 两进程矩阵无 skip;7–9 既有);gate 10 现也成立:seam checker 在 `dc2e0d1` 后检查全部非测试 `host/src` 模块(16 → 200 files),使 plan 点名的扁平 producer 真正被覆盖。
  - **两项独立 review 已返回且无未决 blocker**:`design/reviews/registration-authority-review.md`(settlement/recovery/redaction,9 项 findings,含 3 项 HIGH,已由 `13dcb5a`/`ec81ee2`/`e483234`/`d746de4`/`a601ea1` 处置;F5 由 owner 判定为 over-reporting 并以四条线证明不可达;F6/F7 acknowledge)与 `design/reviews/registration-topology-review.md`(`NO BLOCKER`,7 项 findings,已由 `0504f65`/`dc2e0d1`/`3485dbf`/`e61e6d0` 处置)。plan 状态已由 owner 授权从 `draft` 改为 `current`。
  - 因此 registration **已闭合**,`TASK-STARDEW-PRODUCT-LAUNCH-TOPOLOGY-CONSOLIDATION` 的激活条件不再被 registration 阻塞。
- bootstrap containment 已闭合(2026-09-26,见 [TASK-STARDEW-BOOTSTRAP-CONTAINMENT-RECOVERY](../../tasks/active/stardew-bootstrap-containment-recovery.md)):atomic Job containment、lease/EOF 处理、生产角色所有权委托(两个 process owner 改为纯类型模块,生产经 `ContainedGameRuntime` 委托,无 direct-spawn fallback)与 12 项 Windows 安全矩阵均有证据;两个独立审查(native-security + lifecycle-recovery)无 blocker,审查发现的两个真实缺陷已修复并记录(ordinary close 不再 contain Player——否则会终止本应存活的 non-kill-on-close Player Job;item 8 补当前-SID 断言并 mutation 验证)。
  - **不要把该闭合读成“guardian crash recovery 已可用”。** native guardian 的 `recover_attempt`/`recovery` 启动模式、Desktop supervisor/broker 的 recovery 中继、以及 durable recovery CAS 转移均已实现并有各自证据,但把它们串起来的 **Host 侧 orchestration 生产者缺失**,且该缺口在本条之前就无生产调用者。当前行为是 **fail-closed 但不可恢复**:guardian 崩溃后 Player Job 按策略存活、`owner.json` 停留非终态、后继启动因保留 marker 而被拒绝(设计要求的保守结果),但没有任何路径能让该 attempt 重新变为终态。完整证据表与两个未接线的具体位置见 containment task 的 “Residual recorded 2026-09-27” 条目;该缺口与本次拓扑清理正交。
- bootstrap containment 已闭合;installation registration 也已于 2026-09-27 闭合(见上一条):全部 named gates 有 focused 证据,两项独立 review 已返回且无未决 blocker,plan 状态经 owner 授权更新。`TASK-STARDEW-PRODUCT-LAUNCH-TOPOLOGY-CONSOLIDATION` 的 Tasks 1–6 因此不再被 registration 阻塞 —— 其剩余前置需在该 task 自身核对(而非本条)。`StardewProductionLifecycleCoordinator` 仍是唯一产品 owner,native-local direct route 仍只作待移除的 characterization。
- `equip_tool` 已完成 `equip_tool/v2` 迁移并发布为平台控制，是已知可用的 v2 语义 selector 契约（public argument 为 canonical semantic `tool`：axe/pickaxe/hoe/watering_can/fishing_rod/weapon/scythe/shears/milk_pail/pan；`slot` 仅为 Mod 私有机械细节，不再属于 Host、Agent tool schema 或公开 action contract）。其生产 authority/behavior 是不可变前提：Mod handler、catalog 和 live policy 均以 v2 为准，Host tool action ID、`tool` arguments 与 visibility、同一 logical action 的 receipt semantics（`tool_equipped`/`already_equipped` + `tool/before/expected/after` evidence）以及 release status 均不得回退回 v1 `slot` 形态（旧 v1 残留已删除，提交 `ac481e0`/`b8641a6`）。候选平台 run 的失败只记录为 Platform fact，不改变该发布事实。
- Action Development Control Runner 通过与 production/release 相同的 active Stardew installation runtime registration 启动：它不读取、导入或 fallback 到旧 `integrations/stardew/action-development` profile。future non-browser control 只调用与 browser flow 相同的 private lifecycle core，不构造 browser admission、DTO、cookie 或 CSRF authority。开始 envelope 和有界 final result 是纯数据，不能携带 pipe、token、PID、path、generation、journal、recovery 或 fixture capability。
- control start 只携带固定 `scenarioId: "equip_tool_control"` 与有界 run/correlation/deadline/cancellation intent；action ID、`tool`/arguments、admitted revision、`requestId`、`idempotencyKey` 和 journal tuple 均由 Host runner 在唯一 coordinator 的 fixture preparation、authenticated attachment 与 live snapshot 后选择、派生或 mint。没有 registration 时，它只返回 `setup_needed` 或 `unavailable`。
- 现有 native-local live owner 是待删除的 migration source；cutover 时原子移除，不保留 diagnostic/live fallback。
- 实施状态、文档审查门和 control scenario 的证据由活动任务 [TASK-STARDEW-ACTION-DEVELOPMENT-PLATFORM-CONVERGENCE](../../tasks/active/stardew-action-development-platform-convergence.md) 跟踪。
- onboarding 和 target-version live open-gameplay gate 仍按活动任务推进;它们不创建另一条 registration 或 coordinator 路径。installation registration 已于 2026-09-27 闭合(见上一条)。ordinary Navigation 已独立完成自身 live gate 并正式发布(publication 决策 2026-09-19;`live-verified + published`,见架构文档阶段 5),不借 BodyProgram 路径发布。`observe_scene` 已在本 current owner 中 ratify 并正式发布为 Agent-facing `read_only` capability(2026-09-19 publish decision,evidence 见 Read-only publication gate 记录);它仍是只读 observation,不创建 receipt、不进入 Body Program、不授予交互权限。

### 现存 authority 冲突与后续 owner 决策

- 生产 source 当前已有 authenticated `BridgeSession.TryObserveScene`、`observe_scene_request`/`observe_scene_result` DTO 与 bridge schema 路径，但当前 `FarmhandActionCatalog` registration 尚未把 `observe_scene` 纳入 Mod capability membership，且该 direct session route 不能单独证明 live policy admission。因此 source/route presence 是 characterization，不是 publication；后续实现必须先补齐 Mod registration 与 policy projection，再按上文 gate 决定是否发布。
- [`stardew-spatial-perception-and-destination-search.md`](../../architecture/stardew-spatial-perception-and-destination-search.md) 已于 2026-09-19 从 `draft` 转为 `current`（六个实施阶段全部闭合，Navigation 与 `observe_scene` 均已正式发布、`equip_tool/v2` 迁移与 v1 物理删除完成）；其中对 `observe_scene` 的契约描述与本 current owner 一致，不再存在候选/draft 提升问题。
- [`ADR-006`](../../adr/006-verified-body-programs.md) 冻结 ordinary Navigation 的独立 pipeline 边界：Navigation 已独立完成自身 live gate 并正式发布（2026-09-19，不通过 BodyProgram 路径发布，也不借其 tracer/journal/receipt 声称 closure），但该 ADR 没有为 `observe_scene` 授予 publication，也不能把本只读 operation 接入 Body Program。若未来要把场景观察与 ordinary Navigation、interaction 或 Body Program 绑定，必须由相应 current owner 另行作出边界和 publish 决策。
- community connector 是后续外部进程边界，不替代第一方 Stardew 路径。


## Player world survival and reconnect clarification

[Game session survival simplification](../../tasks/active/game-session-survival-and-reconnect-simplification.md) supersedes the incompatible role-lifetime assumption for Player Host. AI crash、默认 GameBuddy close、controller EOF 和 AI disconnect 只停止 AI authority，并保留 GameBuddy-started Player Host/game world；Player role 不得配置为因 Guardian 最后 handle close 而被杀死。该 supersession 取代旧的双 role `KILL_ON_JOB_CLOSE`、close/EOF 杀死 Player 以及 Player recovery 语义，不是 compatibility mode 或 fallback。Player recovery remains unavailable：恢复不得打开、终止或声称 containment；AI cleanup 也不能清除 parent fence 或允许 successor。Ordinary GameBuddy close 不等于 `End Game`；explicit endgame 是独立 authenticated lifecycle operation，只有该操作可以终止 Player 并投影 `gameended`。Creation-time containment 与 AI cleanup/recovery 仍由 [Design 102](../../102_STARDEW_BOOTSTRAP_CONTAINMENT_RECOVERY_DESIGN.md) 负责。

Disconnect 停止新 actions；已 accepted 的 short step 可到安全边界，unknown 不得投影为 completed/cancelled，也不得 blind retry。Resume 只做新 activation 的 binding attachment、observation 和 Game-owned companion conversation runtime resync，不重新打开、同步或接管独立 Chat surface，也不自动 autorun old task；fresh Game instruction 只授权 Game actions。attachment 只保留足以确认登记 world binding 的既有握手事实，不为旧 activation 的自然结束追加 invalidation proof；AI process 的重建或复用是该 activation 的内部实现选择。`ready-actions-paused` 仅表示 world sync 与 conversation 可用而 action paused；AI unavailable 为 `unavailable`，authoritative game exit 才是 `gameended`。UI 走 coordinator attachment → state provider → browser contract → composed browser → React；该 Resume operation 在完整 wiring 与测试前标记 `not wired`。

安装/update integrity、selected-version startup、session-instance connection、action preconditions、stale-controller/execution-conflict/secret protections 继续有效。旧 recovery CAS 仅按其 process-ownership/settlement 责任复核，不得被解释为 old-task resumption authority。

## Game Session Resume binding-owner 边界

Resume 是私有 binding 恢复操作，不是游戏发现机制。玩家从 Game 列表选择或断线后自动恢复时，持久化 `gameSessionId` 只解析到该 session 已登记的 GameBuddy-owned world binding；解析失败或 binding 不匹配即为 binding 验证失败。Resume 不得扫描进程、窗口标题、PID、路径、save 或启动时间来发现或猜测目标，不得「找到任意可连接进程」，也不得外部 attach 玩家自行启动的同类游戏或其他 session 的 world；过渡 `PRODUCT_INTEGRATION_CATALOG → STARDEW_INTEGRATION_LAUNCHER → createKnownSemanticGameFacadeFromOperatorConfig()` attach 不构成 Resume 的外部游戏发现或通用绑定机制。

Stardew-specific 文件（save、`modsPath`、日志、target-version 入口原料）只是该 activation 私有的机械输入，由唯一 coordinator/adapter 在确定 target-version launch 或读取 world 状态时按需消费；它们不是通用 Resume identity，不得提升到 session/browser contract 的持久化字段，也不得在 Resume 时重新成为候选源或证明来源。

Resume 的 authority 由三者共同成立：live owner/Mod 对 fresh connected world 的归属确认响应、持久化的登记 binding、以及可读的 fresh observation。每个 activation 建立全新 connection authority：AI process/bridge/controller 的重建或复用是当前 activation 的内部实现选择，旧 activation 的 memory capability/callback 不延续，也无需为其追加失效证明；旧 activation 结束后不保留可复用的 connection、pipe/token、launch 或 session authority。Resume 只恢复 binding attachment、observation 与 Game-owned companion conversation runtime resync，绝不 replay 旧 action/task，也不把旧 task 当作 fresh Game instruction；旧 recovery CAS 仅按 process-ownership/settlement 责任处理 unknown effect，不是 task resumption authority。

binding 验证失败时，session 投影为不可 Resume 的 `unavailable`（不投影 ready 或 gameended）；前端必须显示安全分类并提供玩家 `Retry`、`Cancel` 与 `Start new game`。`Start new game` 创建新的 Game session/world binding，不改写或删除旧 session，不继承旧 world identity、action 或 task authority，也不复用失败 binding 的 Stardew-specific 私密输入。

第三方 Game integrations 由通用 selected-integration seam 支持：`GameSession`/world binding 窄接口（创建新 world、按 opaque binding 重新连接、完成足以确认 binding 归属的最小 attachment handshake、fresh observation、报告 world mismatch/gameended）面向已发布 integrations 选择，第三方与第一方同样只允许访问自己登记的 binding，不得扫描进程或外部 attach。该支持不推广草稿 community connector runtime：community connector 仍是后续外部进程边界，不替代第一方 Stardew 路径，也不能复用或制造第一方 topology 的 pipe、token、profile、launch generation、manifest 或 session authority。
