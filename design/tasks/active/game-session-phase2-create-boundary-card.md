---
id: CARD-GAME-SESSION-PHASE2-CREATE-BOUNDARY
type: boundary-card
status: active
owner: product-runtime
---

# Game Session Phase 2 Create flow 前置边界卡（`game.create` / `game.resume.cancel`）

> 本卡是 Phase 2 Create flow 的 contract/owner 设计层边界冻结（步骤 B，主 checkout）。
> 全部产出为**只读审计 + 边界卡文档**；本卡不写任何 production 源码实现，不提交（no commit），不运行任何进程管理命令（纪律：绝不按名称 kill node）。
> 关联 authority：`design/tasks/active/game-session-survival-and-reconnect-simplification.md`（task lane）、`design/105_GAME_SESSION_SURVIVAL_RECONNECT_IMPLEMENTATION_PLAN.md`（Slice 0–4）、`design/domains/stardew/integration.md`、`design/architecture/product-surfaces.md`、`design/architecture/continuity-and-memory.md`。

## 1. 目的与范围

Resume 失败时 UI 需要 **Retry / Cancel / Start new game**（design/105 Slice 3 BDD、task lane §16）。当前 backend 无 `game.create`/`game.start_new_game` 指令，也无 resume cancel 指令。Start new game 只能创建**新的 Game session/world binding**，绝不能静默替代 Resume（design 语义，task lane §16）。

本卡冻结三件事：

1. **`game.create` 指令的最小严格 schema**（command 字段、idempotency、redacted result vocabulary）与 owner 侧语义；
2. **连续性与 world binding 创建的两阶段时序**（persist binding intent → integration 创建 world binding + 初始 observation 完成 bind；失败不留可 Resume 半记录，沿用 Slice 0 store 规则）；
3. **Cancel 的最小 backend seam**（`game.resume.cancel` 独立操作，不并入 create flow）。

已就绪的前置（Slice 0 持久化）不做任何迁移：`production_game_session_world_binding`（register/read/terminal）+ `production_game_session_metadata`（pending/resumable/failed）+ coordinator facade（`createGameSessionMetadata`/`completeGameSessionBinding`/`failGameSessionCreation`/`registerGameSessionWorldBinding`/`markGameSessionWorldBindingTerminal`/`read*`/`listResumableGameSessions`）。

## 2. 现状审计（引用 file:line）

### 2.1 Browser contract — `host/src/game-browser-contract/index.ts`

| 事实 | 引用 |
|---|---|
| 已声明 operation ids：`game.prerequisites.read/setup`、`game.instances.read`、`game.state.read`、`game.launch`、`game.attach`、`game.stop`、`game.resume`、`game.reopen`、`game.disconnect`、`game.diagnostics.read`、`game.stardew.cabins.read/confirm`；**无 `game.create`、无 `game.resume.cancel`、无 session 列表 op** | :328–342 |
| `game.resume` wire schema：`apiVersion + idempotencyKey + expectedAttachmentGeneration`（strict，`additionalProperties:false`）；result `accepted / attached / unavailable` | :257–261, :270–277 |
| `game.reopen` result 是单值 literal `reopened`（cancel 单值 result 的先例） | :279–295 |
| `GameSessionResumeCommandV1` 只是 type-only 扩展（携带 `gameSessionId`），**不是 wire schema**；wire 保持 session-less | :508–516 |
| 既有 problem codes 覆盖 `idempotency_conflict / idempotency_in_progress / game_unavailable / game_operation_in_progress / game_attachment_conflict / game_runtime_unavailable / game_storage_unavailable`，可全部复用 | :42–61 |
| `game.attach` 已声明（`GameAttachCommandV1Schema` :245–249）但 composed browser **未挂载** attach route（见 2.2）——legacy declared-but-unmounted，Create/Resume 不依赖它 | :245–249 |

### 2.2 Composed browser — `host/src/composed-reference-game-browser.ts`

| 事实 | 引用 |
|---|---|
| 已挂载 routes：`prerequisites/setup`、`launch`、`stop`、`resume`、`reopen`、`disconnect`；**无 create、无 attach、无 cancel route** | :92–98, :550–557 |
| `game.resume` handler：admission → strict schema check → callback → result 必须通过 frozen `GameResumeResultV1Schema`，否则 `ControlledStateError`（不伪造成功） | :957–977 |
| 未挂载 op 的 route 返回 404 `not_found`；operation id ↔ callback 的 exact mismount guard（profile 声明与 options 不一致即抛错，防错挂） | :679–693, :958–959 |
| per-op 错误码映射（`gameResumeProblemCode` 等把 coordinator 内部错误映射到 contract problem codes） | :230–240, :248–254 |

### 2.3 Coordinator — `host/src/stardew-production-lifecycle-coordinator.internal.ts`

| 事实 | 引用 |
|---|---|
| `StardewProductionLifecycleActivationOwner` 现有 seam：`bindBrowserAdmissionIssuer / activate / setupPlayerHost / launchPlayerHost / readPrivateActivationSnapshot / readCabinChoices / confirmCabinChoice / resume / reopenActionAuthority / stopGame / disconnectGame`；**无 create、无 cancel** | :131–190, :1232–1244 |
| `resume`：browser admission → idempotency map（tuple：browserSessionId + gameSessionId + expectedAttachmentGeneration）→ 单激活互斥（live lease ⇒ `stardew_game_runtime_unavailable`）→ **单一 resumed world**（不同 session 即 `stardew_game_resume_idempotency_conflict`）→ generation 规则（resume ≥2 且严格递增，不复用初始 activation 的 0/1）→ `worldBindingResolver.resolveWorldBinding(gameSessionId)`（失败 ⇒ `unavailable`，无 activation） | :1109–1192, :1128–1138, :1143–1148 |
| `attachResumedWorld`：fresh activation 机械（arm AI → bridge/materializer/facade → `runEnter` → `activateCommittedIngress`）；`attachmentConnectionStatus="connected_idle"` 且 `actionAuthorityStatus="paused"`（ready-actions-paused） | :1046–1107 |
| **无 resume cancel seam**：`resumePromise` 只在 close drain 中被 await（:1255–1257）；retry 循环只在 `isClosing()` 时退出；`disconnectGame`/`stopGame` 都要求 live facade+lease，不能用作 reconnect 取消 | :1050–1107, :977–1002, :1246–1327 |
| `closeStaleAttachment` / `closePartialAttachment`：清理 stale failed attachment 与部分 facade 的既有机械（cancel 可复用） | :1004–1029 |
| `consumeBrowserAdmission` 的 expectedOperation 联合目前是 `cabin_read/cabin_confirm/game_setup/game_launch/game_stop/game_resume/game_reopen/game_disconnect`；create/cancel 需并入该联合 | :655–659 |

### 2.4 Durable store（Slice 0 已就绪）— `host/src/continuity-semantic-store/continuity-semantic-production-store.ts`

| 事实 | 引用 |
|---|---|
| relation：`production_game_session_metadata`（pending rev1 / resumable rev2 / failed rev2|3，`creation_request_id` UNIQUE，`continuity_identity_id` 可空 FK）与 `production_game_session_world_binding`（registered rev1 / terminal rev2，`operation_id` UNIQUE） | :481–482 |
| 类型：`ProductionGameSessionMetadata` 只含 `gameSessionId / integrationId / continuityIdentityId / status / revision`；binding 只含 `gameSessionId / integrationId / bindingRef / status / revision` | :332–370 |
| `createGameSessionMetadata`：按 `creationRequestId` 幂等（同请求返回旧行；payload 变化 ⇒ `game_session_creation_conflict`）；`continuityIdentityId` 只能是 bootstrap principal 的 continuityId 或 null；store mint `gameSessionId`（UUID hex） | :4441–4469, :4450–4451, :4460 |
| `transitionGameSessionMetadata`：pending→resumable 要求已注册 binding；pending→failed 在有 binding 行时拒绝（两种失败路径互斥，store 强制） | :4470–4507 |
| `registerGameSessionWorldBinding`：仅 pending metadata、按 `operationId` 幂等、同 session 只一条 | :4539–4577 |
| `markGameSessionWorldBindingTerminal`：单事务内 binding registered→terminal(rev2) **且** metadata resumable→failed(rev3) | :4600–4639 |
| `listResumableGameSessions`：只列 `status='resumable'` 且 binding `registered` 的 session（孤儿 pending 行永不可 Resume） | :4524–4538 |
| coordinator facade 已转发行（幂等/close-reject 测试在册）：`createGameSessionMetadata` 等 | coordinator.internal :1300–1313, :2911–2954；provisioning :350–376 |

### 2.5 Integration-private resolver / materializer

| 事实 | 引用 |
|---|---|
| `stardew-owned-farmhand-game-world-binding-resolver.internal.ts`：**只读** `resolveWorldBinding(gameSessionId)`（`missing_or_foreign` / `terminal`），`INTEGRATION_ID="stardew"`；**无 create world binding seam** | :4–5, :38–40, :56–66, :74–82 |
| `stardew-owned-farmhand-game-session-materializer.internal.ts`：消费已认证的 `StardewPrivateFarmhandBridgeConnection`（scope/pipe/token/launchGeneration）→ facade；**不做世界创建** | :14–19, :36–88 |
| 生产 wiring：`createStardewProductionLifecycleCoordinator(manifest, folderPicker, shared.game)` → resolver 由 `createStardewWorldBindingResolverFromGameAuthority` 构造 | dialogue-web-main :126–138；coordinator :356–366 |

### 2.6 State provider / UI / composition

| 事实 | 引用 |
|---|---|
| `GameBrowserStateV1` 无任何 session 身份字段（无 `gameSessionId`、无 session 列表） | index.ts :181–202 |
| `game-browser-state-provider.ts` 只投影 lifecycle/attachment/launchReadiness 三源 | :44–94 |
| **B 路径 gap**：`tavern/composed-reference-game-static-shell-composition.ts` 的 `lifecycleActivationBindingSink` 类型与 handler options **未 wire `gameResume`**（profile 声明了 `game.resume`，guard 会拒绝 mismount）——coordinator-owned 端到端路径明确 not wired（task lane Slice 3） | static-shell :50–63, :95–120；game-browser :679–693；dialogue-web-main :101–106 |
| dialogue-web API client：`resumeGame` 严格 exact-key 校验（无 session 字段）、frozen result 校验 | `dialogue-web/src/composed-reference-game-browser-api.ts` :595–607, :330–343 |
| React：generation-bound resume、per-generation idempotency key、bounded authoritative reread；**无 Cancel 按钮、无 Start new game 表单、无 session 列表 UI** | `dialogue-web/src/components/ComposedReferenceGameApp.tsx` :58, :674–754, :797–870 |

### 2.7 文档 authority（设计层现行条款）

| 条款 | 出处 |
|---|---|
| Create 由 Game UI 提交 strict command，Host GameSession owner 创建 session/world binding；只消费**已发布 integration** 与玩家明确选择的 continuity binding；**不接收 Desktop bootstrap 的 rootLayout/dataRoot/principal/authorityGeneration/native facts** | task lane :20–24; product-surfaces :79 |
| 后端只在 integration + 请求的 continuity binding + 新 world binding 都成功持久化后投影可 Resume；失败显示可重试/取消状态，不投影 ready，不留可误 Resume 半成品 | task lane :18, :113–117；105 plan Slice0 :75–76 |
| Start new game 创建新 session/world binding，可重新选择 continuity binding；旧 session 的 world/action/task 不迁移；不得扫描/guess 外部游戏 | task lane :16, :117；integration.md :216–218 |
| Resume 是唯一恢复操作；cancel 收束当前 reconnect epoch，retry 创建新 attempt identity；`ready-actions-paused` 仅表示 sync 成功、action 暂停 | task lane :90–92；105 plan Slice2 :136–139 |
| 验证预算：保留能改变产品/安全决策的检查（session/world binding 防错连、store CAS 防并发/不确定写、action identity 现状不动）；不新增 hash/signature/generation/lease/attestation 证明层；不保留无可指认事故的 checks | 105 plan :26, :30–43 |

## 3. 冻结决策

### D1 — `game.create` 最小严格 schema（wire + result）

```ts
// host/src/game-browser-contract/index.ts（frozen draft，本卡为权威草案）
const SAFE_ID = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]{1,128}$" });

export const GameCreateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,                        // literal 1
  idempotencyKey: IdempotencyKey,                // 复用既有 22-char base64url key
  integrationId: SAFE_ID,                        // 已发布 integration 的公开 id；composition-owned registry 校验
  continuityIdentityId: Type.Union([SAFE_ID, Type.Null()]), // 玩家显式选择；null = 默认不绑定
});

export const GameCreateResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Union([
    Type.Literal("accepted"),                    // 已受理、仍在 bind/observe
    Type.Literal("attached"),                    // binding + 初始 observation + 第一 activation 完成
    Type.Literal("unavailable"),                 // 失败；无任何可 Resume 半记录
  ]),
  // 仅 interpretive projection：handle 的每次使用都必须经 store 重验证；
  // 它不是证明、不携带 native 事实。null ⇔ status === "unavailable"。
  gameSessionId: Type.Union([SAFE_ID, Type.Null()]),
});
```

冻结要点：

1. **command 不含** `expectedAttachmentGeneration`（create 时不存在 attachment）、不含 `gameSessionId`（store mint）、不含任何 bootstrap/native/launch 字段（D6 topology 强制）。
2. **与 resume 不同，wire 自带 coordinator 所需的全部 owner 事实**（integrationId、continuityIdentityId），因此 create **不需要** `GameSessionResumeCommandV1` 式的 type-only 扩展；`creationRequestId` 由 coordinator 在其 idempotency 槽内 mint（`game.create` 的 store 幂等键不是 browser key，是 coordinator ownership）。
3. **幂等**：coordinator 内存 map（与 `gameResumes` 同构）keyed by browser `idempotencyKey`，tuple = `(browserSessionId, integrationId, continuityIdentityId)`；同 key 同 tuple → 同一 promise/result（重复 create 返回同一 session）；tuple 变化 → `idempotency_conflict`。跨 coordinator 重启后 browser session 本身重建（fresh auth），旧 key 不继续生效（与 resume 现状一致，105 Slice3 :159 只要求去重防并发/陈旧命令）。
4. **result `gameSessionId` 用宽松 SAFE_ID 而非 canonical base64url format**：store mint 的 UUID hex（32 chars）不一定满足 base64url canonical 约束；该字段是 opaque durable session 引用（身份，非证明），每次使用由 coordinator 经 store 重验证（对应 105 审计表 "session/world binding" 事实族，owner = Game session owner + selected integration）。
5. **新增 operation id**：`"game.create"`、`"game.resume.cancel"` 加入 `GAME_BROWSER_OPERATION_IDS_V1` 与 `GameOperationId` union；**不新增 problem code**（复用 `invalid_request / idempotency_conflict / idempotency_in_progress / game_operation_in_progress / game_unavailable / game_attachment_conflict / game_runtime_unavailable / game_storage_unavailable`）。

### D2 — 两阶段时序与失败路径（continuity + world binding）

**Phase 1 — persist binding intent**（store，幂等）：

```
createGameSessionMetadata({ creationRequestId, integrationId, continuityIdentityId })
→ pending rev1 + minted gameSessionId（store :4441–4469）
```

**Phase 2 — integration 创建 world binding + 初始 observation 完成 bind**：

```
a. selected integration 私有 seam（新冻结窄 seam，见 D6）
   createWorldBinding(gameSessionId, 该 integration 私有的 worldRequest) → { bindingRef }
b. registerGameSessionWorldBinding({ gameSessionId, integrationId, bindingRef, operationId })
   → registered rev1（store :4539–4577；operationId 由 coordinator mint 并存入 create idempotency 记录）
c. completeGameSessionBinding({ creationRequestId, gameSessionId, expectedRevision: 1 })
   → resumable rev2（store :4470–4507 的 CAS）
d. 第一 activation：arm AI（generation 1；初始 activation 拥有 0/1，resume 从 ≥2 开始，
   沿用 coordinator :1134–1138 规则）→ materialize → runEnter → activateCommittedIngress（初始 observation）→
   attachmentGeneration = 1、connectionStatus = connected_idle、actionAuthorityStatus = paused
   （ready-actions-paused；只有 game.reopen 能重开）
```

**失败路径（Slice 0 规则，不留可 Resume 半记录）**：

| 失败点 | 收束动作 | store 结果 |
|---|---|---|
| phase 1 失败或 register 之前 | `failGameSessionCreation({creationRequestId, gameSessionId, expectedRevision: 1})` | pending→failed rev2，无 binding 行（store :4470–4507） |
| register 之后（observation/complete/attach 失败） | `markGameSessionWorldBindingTerminal({gameSessionId, integrationId, expectedRevision: 1, operationId})` | binding terminal rev2 + metadata failed rev3（单事务，store :4629–4634） |

冻结要点：

- 两条失败路径互斥且由 store 强制（`transitionGameSessionMetadata` 对 failed 目标在有 binding 行时拒绝，:4493–4495）——**任何时刻都不存在既 failed 又有 registered binding 的行**。
- **crash 遗留的孤儿 pending 行**（phase 1 后进程死亡）永不会被 `listResumableGameSessions` 列出（JOIN binding registered，:4524–4538）；本迭代不做清理任务（非目标）。
- `game.create` 的 phase 2 复用 coordinator 既有 fresh-activation 机械（`attachResumedWorld` 同构路径 :1046–1107），但**不设置** resumedGameSessionId（它不是 resume）；create 与 resume 是两条独立指令，共享同一个"单激活"互斥（D4）。

### D3 — Cancel 的最小 backend seam（独立 `game.resume.cancel`）

**决策**：Cancel 是**独立 operation**，不并入 create flow，也不复用 `game.disconnect`/`game.stop`（二者都要求 live facade+lease，coordinator :993–994；而 cancel 的语义恰是「reconnect epoch 尚未建立 live attachment 时终止它」）。

```ts
export const GameResumeCancelCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration, // 精确钉住当前 attempt（与 resume 同一 tuple 纪律）
});
export const GameResumeCancelResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Literal("cancelled"), // 单值 literal 先例：game.reopen "reopened"（index.ts :292–295）
});
```

Coordinator 内部 seam（`activationOwner.cancelResume(admission, command)`，frozen draft）：

1. `consumeBrowserAdmission(admission, "game_resume_cancel", …)`；idempotency map（tuple = browserSessionId + expectedAttachmentGeneration）。
2. 前提：存在 in-flight resume（`resumePromise !== undefined`）且 generation 匹配；否则 fail closed（不静默成功，前端只在 reconnecting/syncing 状态展示 Cancel）。
3. 置 resume cancel epoch；`attachResumedWorld` 的 retry 循环（:1065–1086）在每次 `waitForFarmhandBridgeRetry` 前检查并终止。
4. `abandonFarmhandAiClientActivation`（收束已 armed 的 AI activation，沿用既有机械）；`closePartialAttachment`（关闭部分 facade，:1004–1013）。
5. `resumePromise` 终结为 `cancelled`；`gameResumes` 记录 terminal（同 key replay → 同一 `cancelled`，不复制旧 action identity）。
6. 状态投影：`attachmentConnectionStatus = "disconnected"`、`actionAuthorityStatus = "unavailable"`；`attachmentGeneration` 保持 armed 值（后续 retry = 新 attempt identity，generation +1，与现有 failed-resume retry 测试语义一致，coordinator test :2967–2994）。
7. **Player 世界与 durable 状态完全不动**：cancel ≠ endgame（不产生 `gameended`）、≠ creation failure（不标记 binding terminal、不改 metadata status）；session 保持可 Resume。

### D4 — 单激活互斥与 Start new game 准入

- `game.create` 准入沿用 resume 的互斥：live lease（`stardew_game_runtime_unavailable`）、in-flight resume 或 in-flight create ⇒ `game_operation_in_progress`（105 plan :25 无 multi-instance 并行 activation；coordinator :1128–1129）。
- 产品时序上 Start new game 按钮只出现在 **Resume 失败/取消后的状态**（无 live world），因此该互斥不阻断正常路径；Create 与 Resume 并存时是 UI 层级的选择（`Resume existing game` vs `Start new game`），不是 backend 并行。

### D5 — B 依赖链与 reopen 衔接

- **B 链**：coordinator `activationOwner.{createGameSession, cancelResume}` → `tavern/composed-reference-game-static-shell-composition.ts` 的 `lifecycleActivationBindingSink`（扩展类型与 handler options；**必须同时补齐当前缺口的 `gameResume` 布线**，否则 mismount guard 拒绝启动，game-browser :679–693）→ `composed-reference-game-browser.ts`（新 `GAME_CREATE_PATH = /api/composed-reference-game/v1/game/create`、`GAME_RESUME_CANCEL_PATH = …/game/resume/cancel` + mismount guard + per-op problem mapper）→ `dialogue-web/src/composed-reference-game-browser-api.ts`（`createGameSession` / `cancelResume` exact-key client）→ `ComposedReferenceGameApp.tsx`（Start new game 表单：integration 选择 + continuity 勾选；Resume 阶段的 Cancel 按钮；按 generation 去重）。
- **reopen 依赖链**：create 完成即以 actions paused 结束（ready-actions-paused 语义）；`game.reopen`（语义不变，`expectedAttachmentGeneration = 当前 generation`）是唯一重开路径。Acceptance 必须显式 trace `create → reopen` 的前置/后置关系。
- **session 选择投影（Slice 3 依赖，本卡只登记不冻结实现）**：`GameBrowserStateV1` 当前无 session 身份（index.ts :181–202），`Resume existing game` 列表需要 redacted session list 投影（owned path：state provider + schema 的 additive v1 扩展）。create 返回的 `gameSessionId` handle 是本卡唯一冻结的 session 引用入口。

### D6 — 所需 topology / authority

- **一个 durable authority**：既有 fresh semantic SQLite（`production_game_session_metadata` + `production_game_session_world_binding`，store :481–482）。**不建第二 DB/JSON store**；coordinator facade 已转发（:2911–2954），不新增 authority 方法。
- **Host GameSession owner** = 现有 lifecycle coordinator（Stardew product owner），经注入的 `SemanticGameProductionAuthority` 消费 store facade；迁移 era 的 `dialogue-web-main.ts` 只是 browser/product helper（task lane :39，正式 Desktop composition 收敛仍 pending，不影响本卡 seam）。
- **新的 integration-private 窄 seam（冻结声明，不在本卡实现）**：

```ts
// 与 stardew-owned-farmhand-game-world-binding-resolver 同层的新 seam（frozen draft）
// 只消费 opaque (gameSessionId, integrationId, worldRequest)；输出 opaque bindingRef（[A-Za-z0-9_-]{1,256}）
type CreateWorldBindingSeam = Readonly<{
  createWorldBinding(
    input: Readonly<{ gameSessionId: string; integrationId: string; worldRequest: unknown }>,
  ): Promise<Readonly<{ bindingRef: string }>>;
}>;
```

  Stardew 的 `createWorldBinding` 实现（新建 world/save 并保证「已完成游戏世界创建」才是合法 binding ref）属于后续 integration 任务（105 Slice 1 Stardew 连接之后）；本卡只冻结通用 seam 与调用顺序。**fake 第二 integration 必须能实现同一 seam**（105 Slice0 :79 多游戏验收）。
- **composition 注入**：published-integration registry（窄 capability：`isPublishedGameIntegration(id)`，基于 `PRODUCT_INTEGRATION_CATALOG` 派生，`integration-catalog-product.ts`）——`game.create` 校验 `integrationId` 只能过 registry；（与 legacy `createKnownSemanticGameFacadeFromOperatorConfig` 过渡 attach 无关，integration.md :16）。
- **redaction**：browser/React 只消费 state provider + composed browser 的窄 projection；create/cancel 的 wire 与 durable 记录永不含路径、PID、Job、pipe、token、native frame、launch 事实（105 plan :70；task lane :20–24）。

### D7 — stop rules（实现者）

实现任意 slice 前遇到以下任一情况即 stop 并上报，不得自行发明 seam：

- 选定 integration 无法在不扫描/不猜测的情况下完成 world creation（沿用 105 :183 的 Resume stop rule 扩展到 Create）；
- 需要第二个 durable store、第二 authority 或把 bootstrap/launch/native 事实引入通用 wire/durable 记录；
- cancel 需要终止 Player、标记 binding terminal 或改变 metadata status（cancel 语义被破坏）；
- create 幂等或 attachment generation 纪律无法在不新增 proof/lease/attestation 层的前提下维持；
- 需要重新打开/接管独立 Chat surface 才能完成初始 observation 或 conversation resync。

### D8 — Validation budget（incident → owner → boundary；沿用 105 :26, :30–43 审计门）

| 保留项 | 防止的事故 | authority owner | boundary | failure 含义 |
|---|---|---|---|---|
| store：`creationRequestId` 幂等 + payload 一致性（:4453–4458） | 重复/冲突的 create 生成两个 session | store | create write | 冲突即拒绝，绝不静默改行 |
| store：pending→resumable 要求 registered binding；→failed 拒绝有 binding（:4490–4495） | failed 与 registered 并存的可 Resume 半记录 | store | binding CAS | 冲突抛错，无部分写 |
| store：`markGameSessionWorldBindingTerminal` 单事务 binding+metadata（:4629–4634） | endgame/失败后 binding 仍可 Resume | store | terminal transition | 失败即整体失败，不伪造撤销 |
| coordinator：create/resume 单激活互斥（:1128–1129） | multi-instance 并行 activation / 并发跨 session 命令 | lifecycle coordinator | browser command 准入 | `game_operation_in_progress` / `stardew_game_runtime_unavailable` |
| coordinator：generation 严格递增（:1134–1138） | 陈旧 attach 覆盖新 activation | lifecycle coordinator | browser command 准入 | `stardew_game_attachment_generation_conflict` |
| coordinator：resume cancel 只认 in-flight attempt 的精确 generation | 取消错了 epoch / 陈旧取消污染新 attempt | lifecycle coordinator | cancel admission | fail closed |
| integration：resolve/create 只消费 opaque bindingRef（resolver :56–66） | 跨 session/world 错连、扫描/猜测 | selected integration | attachment 边界 | `missing_or_foreign` / `terminal` |
| composed browser：frozen result schema + unmounted 404 + mismount guard（:679–693, :957–977） | 伪造成功、错挂 route、类型漂移 | composed browser | HTTP 边界 | `not_found` / `ControlledStateError` |

**不新增**：hash、signature、generation-proof、lease、attestation、CAS 用于非并发内存转换、旧 activation 内存对象失效探查、create/cancel 的 artifact proof。既有 action admission/receipt/postcondition 链条不动（本卡不触碰 action 层）。

## 4. Boundary 摘要

### User-visible result

Resume 失败状态提供 **Retry / Cancel / Start new game** 三个明确选项。Start new game 打开 Create 表单（选定已发布 Game integration、可选 continuity binding 及其长期 Memory 影响说明），提交后看到创建/绑定/观察进度与失败结果；成功的新 Game session 可 Resume（integrity/continuity/binding 三要素持久化后才投影）、action 处于 ready-actions-paused，仅经 `game.reopen` 重开。Cancel 停止当前 reconnect epoch：玩家世界不受影响、session 保持可 Resume、不会有陈旧 reconnect 稍后完成。任何 create 失败都投影可重试的失败状态，不投影 ready，不留下可误 Resume 的半记录。

### In scope（本卡冻结的 seam 与规则）

- `game.create` wire/result schema、幂等、单激活准入、两阶段时序与失败收束；
- `game.resume.cancel` wire/result schema 与 coordinator 内部收束（retry 循环终止、AI activation abandon、partial facade close、状态投影、幂等）；
- integration-private `createWorldBinding` 窄 seam 声明与调用顺序；
- composed browser / static shell / dialogue-web client / React 的 owned-path 草案与接线缺口（`gameResume` not wired）登记；
- B 依赖链与 `game.reopen` 前后置关系；
- 验收（Given/When/Then）与验证预算。

### Non-goals（明确不做）

- **不实现** Stardew 世界创建（`createWorldBinding` 的 Stardew 实现、新 save/world 原生机械）——后续 integration 任务；
- 不实现 `Resume existing game` 列表的 session 投影与 UI（Slice 3 依赖，本卡只登记 owned path）；
- 不写任何 production 源码（本卡只读审计 + 文档冻结）；
- 不改 Mod/native、不引入第二 store、不新增 parallel resume API（自动重连仍触发同一个 `game.resume` attempt）；
- 不清理 crash 遗留孤儿 pending 行（本迭代无 cleanup 任务）；
- `game.attach`（declared-but-unmounted）与 legacy operator attach 不参与 create/resume；
- 不新增任何 proof/attestation/lease 层。

## 5. Acceptance（Given/When/Then — 含 reopen/B 依赖链）

- [ ] **A1 create 成功**：Given 玩家在前端选择已发布 integration 与明确的 continuity binding（或默认不绑定），when `game.create` 被准入，then ① store 持久化 pending intent（rev1）→ ② integration `createWorldBinding` 产出 opaque bindingRef 并 `registerGameSessionWorldBinding`（registered rev1）→ ③ `completeGameSessionBinding`（resumable rev2）→ ④ 第一 activation（generation 1）完成初始 observation，result = `{status:"attached", gameSessionId}`，UI 显示可 Resume 的 Game session；state 投影 attachment attached/connected_idle、actions paused。
- [ ] **A2 reopen 依赖链**：Given A1 完成，when 玩家提交 `game.reopen`（expectedAttachmentGeneration = 当前 generation），then 是唯一把 action authority 从 paused 重开为 active 的路径；独立 Chat 控制不变。
- [ ] **A3 失败无半记录**：Given 任一环节失败（world creation / register / observation / durable write），then 按 D2 表格收束（failed rev2 或 binding terminal rev2 + failed rev3），`listResumableGameSessions` 永不包含该 session，UI 显示可 retry 的失败状态且不投影 ready；不会留下可误 Resume 的 half-record。
- [ ] **A4 幂等/陈旧命令**：Given 同 idempotencyKey 重复 `game.create`，then 返回同一 promise/result 与同一 session；payload tuple（integrationId/continuityIdentityId/browserSession）变化 ⇒ `idempotency_conflict` fail closed。
- [ ] **A5 单激活互斥**：Given 存在 live attachment 或 in-flight resume/create，when `game.create` 提交，then `game_operation_in_progress` 拒绝；不存在 multi-instance 并行 activation。
- [ ] **A6 cancel 收束 reconnect epoch**：Given Resume 在 `reconnecting`/`syncing`（in-flight attempt，generation G 匹配），when `game.resume.cancel` 被准入，then ① retry 循环停止 ② armed AI activation abandon、部分 facade close ③ result `{status:"cancelled"}` ④ 投影 `disconnected`/`unavailable`，Player 世界存活，durable metadata/binding 不变，session 保持可 Resume，之后**没有任何陈旧 reconnect 完成**。
- [ ] **A7 cancel 后 retry**：Given A6，when 玩家 Retry，then 新 attempt identity（generation G+1）重新走 resume pipeline 并成功 attach；旧 action identity 不复用。
- [ ] **A8 B 链接线/缺口纪律**：Given static shell composition 声明 `game.create` / `game.resume.cancel`，then ① 对应 callback 必须同时接线（含补齐当前缺失的 `gameResume`），profile/options 不一致 ⇒ mismount 拒绝 ② unmounted route ⇒ 404 `not_found` ③ result/command 走 frozen schema，extra fields 与伪造 result 被拒 ④ dialogue-web client exact-key 校验 ⑤ React 按 generation 去重，Cancel 防陈旧完成，Retry 用新 attempt identity，独立 Chat 控制不变。
- [ ] **A9 跨游戏契约**：Given 一个 fake 第二 integration 实现同一 `createWorldBinding`/resume 窄 seam，then 相同 contract/持久化/UI 测试通过且通用 schema 无 Stardew 字段（multi-game 验收，105 Slice0 :79）。
- [ ] **A10 fresh-root 持久化**：Given 全新 fresh-root production authority，then A1/A3 的状态机（pending→resumable / pending→failed / binding terminal）与 `listResumableGameSessions` 过滤在真实 SQLite 上逐条成立（沿用现有 cooperation-idempotency/close-rejection 测试风格）。

## 6. Owned paths 草案

| 路径 | 变更范围（实现期，不在本卡执行） |
|---|---|
| `host/src/game-browser-contract/index.ts` | 新增 `GameCreateCommandV1Schema` / `GameCreateResultV1Schema` / `GameResumeCancelCommandV1Schema` / `GameResumeCancelResultV1Schema`（D1/D3 草案）；`GAME_BROWSER_OPERATION_IDS_V1` 与 `GameOperationId` 增补 `"game.create"`、`"game.resume.cancel"`；Contract/Validator/type 出口；不新增 problem code |
| `host/src/continuity-semantic-store/continuity-semantic-production-store.ts` | **无 schema 变更**（relation/facade 已覆盖 D2 全部转换）；仅补 focused fresh-root 测试（A10） |
| `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` + `continuity-semantic-production-coordinator.ts` | 无新 authority 方法（facade 已转发 :2911–2954）；如需面向 lifecycle 的窄 reader（list/read binding）已存在 |
| `host/src/stardew-owned-farmhand-game-world-binding-resolver.internal.ts` | 新增 integration-private `CreateWorldBindingSeam` 声明（D6）；Stardew 实现后续另立任务；`createStardewWorldBindingResolverFromGameAuthority` 不变 |
| `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts` | **不变**（create 的第一 activation 复用其 facade 构造 :36–88）；不改协议 |
| `host/src/stardew-production-lifecycle-coordinator.internal.ts` | `activationOwner` 新增 `createGameSession` / `cancelResume`（D1/D3 草案）；`consumeBrowserAdmission` expectedOperation 联合扩 `game_create` / `game_resume_cancel`；create 复用 fresh-activation 机械（generation 1）与失败收束（D2）；cancel epoch 接入 retry 循环；close drain 覆盖新 promise/map；对应 coordinator tests |
| `host/src/composed-reference-game-browser.ts` | 新增 `GAME_CREATE_PATH` / `GAME_RESUME_CANCEL_PATH`、handler、per-op problem mapper、mismount guard、frozen result 校验（照抄 resume handler 模式 :957–977）；options 类型增 `gameCreate` / `gameResumeCancel` |
| `host/src/tavern/composed-reference-game-static-shell-composition.ts` | `lifecycleActivationBindingSink` 类型与 handler options 增补 create/cancel/resume 接线（**同时补齐当前未 wire 的 `gameResume` 缺口**）；含 tests |
| `host/src/dialogue-web-main.ts` | gameProfile operationIds 增补 `"game.create"`、`"game.resume.cancel"`（:101–106） |
| `host/src/game-browser/game-browser-state-provider.ts` | （Slice 3 依赖，仅登记）redacted session list/handle 投影扩展，供 `Resume existing game` |
| `dialogue-web/src/composed-reference-game-browser-api.ts` | `createGameSession` / `cancelResume` exact-key client + frozen result 校验（照搬 :595–607 模式） |
| `dialogue-web/src/components/ComposedReferenceGameApp.tsx` | Start new game 表单（integration + continuity 选择）、Resume 阶段 Cancel 按钮、按 generation 去重、labels |
| 测试 | contract strict-extra-field/forged-result/unmounted-404；coordinator create/cancel 状态机；fresh-root persistence（A10）；composed browser；dialogue-web API/UI；fake 第二 integration adapter（A9） |

## 7. 与现有 Slice 0 / Slice 1 / reopen 的衔接点

- **Slice 0（durable + contract 前置）**：本卡是 Slice 0 的「消费方冻结」——store/facade/relations 已是前提（store :481–482, :4441–4639；coordinator :1300–1313, :2911–2954），create/cancel 只消费，不迁移、不双写、不 fallback（AGENTS.md 无兼容层条款；MEMORY #734 fresh semantic SQLite 单一权威）。
- **Slice 1（Player survival / integration resume authority）**：create 的 phase 2 复用既有 fresh-activation/launch authority（coordinator :1046–1107；Stage D 重新读安装 :1058–1060 不变）；cancel 与 create 失败都不触碰 Player Host（non-kill-on-close 角色策略），只 abandon armed AI activation；`worldBindingResolver` 只读纪律不破坏。
- **game.reopen**：create 完成后 actions paused；reopen（:1202–1230）语义与 schema 不变；A2 明确 create→reopen 前置/后置。
- **game.resume**：wire 保持 session-less（index.ts :508–516），generation ≥2 规则与单一 resumed session 纪律（:1130–1138）不变；create 不 set `resumedGameSessionId`；cancel 是 resume epoch 的唯一取消入口，automatic reconnect 触发同一个 resume attempt，无 parallel API。
- **既有 composed browser 证据**：exact-auth/projection-liveness/forged-callback/unmounted-404 测试在册（105 plan :48）；本卡新增 op 必须复用同一套 guard/校验纪律（A8）。

## 8. 验证预算与命令（实现期参考，本卡不执行）

- 契约层：`host` focused `node --test --test-concurrency=1`（game-browser-contract、composed-reference-game-browser、static-shell composition）；
- 持久化/权威层：continuity-semantic-production-store / coordinator focused tests（fresh-root、幂等、close-rejection、两阶段失败矩阵 A3/A10）；
- coordinator/UI：stardew-production-lifecycle-coordinator（create→attach、cancel→retry、单激活互斥）、dialogue-web API/UI tests；
- 无 live Stardew、无 SMAPI、无 provider call、无 runtime download；`pnpm build:test` / strict tsc 照常；
- 完成每片后：fresh review + diff inspect（沿用 105 :193 纪律）。

## 9. 状态声明

本卡是文档层设计冻结（步骤 B，contract/owner 层）：未修改任何 source/native/live fixture/test。实现按 105 Slice 顺序进行（Slice 0 完成、Slice 1 为下一 mutation card）；create/cancel 的精确代码 seam 以本卡 D1–D8 为权威草案，实现时若发现与现存货架（如 static-shell composition 的 resume 缺口、store 校验长尾）冲突，按 D7 stop rules 上报，不静默改语义。