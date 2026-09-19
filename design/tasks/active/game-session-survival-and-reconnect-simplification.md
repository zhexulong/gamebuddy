---
id: TASK-GAME-SESSION-SURVIVAL-RECONNECT-SIMPLIFICATION
type: task
status: active
owner: product-runtime
---

# Game session survival 与 reconnect 简化实施计划

> 本任务是实现计划；其 close/crash 与 reconnect 决定由各 current owner 文档分别承接，且只替换其中不兼容的规则。无关的 containment、action、credential 和 release requirements remain in force。本文档 lane 只更新文档，未修改 source、native、live fixture 或测试。

## 目标与已批准决定

AI crash 或默认 GameBuddy close 不得结束玩家正在玩的游戏，包括由 GameBuddy 启动的 Player Host。玩家世界由游戏进程持有，和创建者无关；因此不再在恢复前要求玩家再次确认。明确的 endgame/退出游戏是独立产品操作，必须显式触发并拥有独立确认与清理语义。

Game session 的产品语义与 Chat thread 的 Resume 相同：Game session 是持久化记录，Game activation 是一次打开实例，world binding 是选定 Game integration 创建并登记的游戏实例关联。中断后自动尝试、GameBuddy 重新打开后的 Resume 以及 Game 列表中的 Resume 都使用同一条 resume pipeline。Resume 先连接原 session 已登记的 GameBuddy-owned world；无法连接时，前端显示安全分类并让玩家选择 Retry、Cancel 或 Start new game。Start new game 创建新的 Game session/world binding，不能静默替代 Resume。多游戏与第三方 integration 是现行架构要求：通用 contract 与 adapter 契约必须保持 integration-neutral，任何已发布 integration 都应能实现同一契约。Attach existing game 是独立的未来 enrollment 操作，不是 Resume 的 fallback；本迭代 Resume 只使用已登记的 GameBuddy-owned binding。本迭代不支持 multi-instance 并行 activation。

Game session 创建必须在前端明确呈现并收集：选定的已发布 Game integration、可选的 continuity identity 绑定及其长期 Memory 影响、创建/绑定进度和失败结果。后端只在 integration、请求的 continuity binding 和新的 world binding 都成功持久化后投影可 Resume。该模型是跨游戏的；Stardew adapter 只实现 integration-specific 创建、绑定、足以确认登记 binding 归属的最小 attachment handshake、world observation 和 game-ended 判定。已有 hello/authentication 可在该 attachment 边界复用，但不为 Resume 另造证明层；Stardew 字段不得提升到通用 session/browser contract。

GameSession `Create` 与 `Resume` 属于 Phase 2 的 UI-driven owner flow：

- `Create` 由 Game UI 提交 strict command，Host GameSession owner 创建新的 session/world binding，并只消费已发布 integration 与玩家明确选择的 continuity binding；它不接收 Desktop bootstrap 的 root layout、`dataRoot`、`principal`、`authorityGeneration` 或 native launch facts。
- `Resume` 由 Game UI 或统一自动 Resume trigger 提交已有 session identity；owner 只尝试其登记 world binding，建立新的 activation attachment 并同步 observation/conversation，不恢复旧 task/action authority。
- owner 可将没有登记 binding 的新记录归类为 `fresh`，将具有可尝试登记 binding 的记录归类为 `known`；该分类是 GameSession durable lifecycle 事实，不是 bootstrap、principal 或 authority generation。

Phase 1 仅由正式 Desktop bootstrap 完成 runtime admission、Host child/session authentication 和 Host 长生命周期 product composition handoff；它不选择 integration，也不创建 GameSession。

恢复只恢复 GameBuddy 的 AI authority 与 attachment，不恢复旧 task：

- Resume 为每次打开创建新的 activation attachment，并执行当前 observation/chat resync；它不自动重新运行旧 task，也不把旧 task 当作 fresh instruction。绑定检查只防止连接到错误 session/world，不是对旧 activation 内存对象逐个作失效证明。
- 新的 Game instruction 仅授权本次明确的 Game actions；它不自动授权 arbitrary Chat、Resume 或旧任务续跑。跨进程或持久化边界只保留会改变执行决定的 identity/revision/lineage 事实。
- disconnect 立即停止新 actions；持续安全停止，允许已接受的 short step 在安全边界完成；状态未知时不得声称 completed、cancelled，也不得 blind retry。
- 稳定产品状态准确投影为 `disconnected`、`reconnecting`、`syncing`、`ready-actions-paused`、`unavailable`、`gameended`；用户可显式 cancel/retry。`ready-actions-paused` 表示游戏仍在、AI action authority 暂停，不表示 endgame。

安全目标仍是 accidental stale controller、execution conflict、secret 泄露和跨会话混淆；同一 Windows user 下的恶意软件不在本任务 threat model。保留安装/update integrity、selected-version startup、session-instance connection、action-precondition checks。移除同一 job 内每个 operation 重复的 artifact proof；不得移除真正需要的身份、scope、revision、deadline、idempotency、cancel 或 game-state checks。每项保留的检查必须能指出具体事故、权威 owner 和运行边界；没有独立事故的 hash、signature、generation、proof、lease、CAS 或重复 attestation 不得新增，已有机制按 owner 逐项合并或删除。普通 close/断线后仅在仍有持久化或跨进程事实需要判断时重新读取，不为已随 activation 结束而不可用的内存 callback/capability 增加失效探查。

## Desktop bootstrap 与生命周期 ownership（当前权威；实现 pending）

正式 Desktop bootstrap 是唯一的 Host 产品 composition root：它认证 `DesktopGuardianSession`，初始化并承载 long-lived Host composition，并只经 composition 私有闭包中的 typed capability 将其交给 lifecycle。Bootstrap 不决定 semantic `principal`/`authorityGeneration`、GameSession、activation、`fresh`/`known` 或 selected integration；`dataRoot` 只是 storage partition，不能替代 semantic identity，缺失 authority 不得创建 `local_default`，known startup 不自动 `authorityGeneration++`。`dialogue-web-main` 仅为 browser/product helper，不能独立创建 Stardew lifecycle root、建立第二 session 或通过 registry/browser handoff 取回 session。raw pipe、token、PID、Job、handle、path、native frame 和 session facts 不进入 lifecycle、browser、public DTO、日志、manifest 或 durable state。

Presentation startup/close 仍沿现有 composition-owned one-loopback-listener 与 typed narrow projection；不新增 WebSocket、固定 `127.0.0.1`、随机端口或第二 listener。close 停止新工作后尽力 drain，close/drain 失败必须传播且不得伪造成功。Stardew lifecycle 继续拥有产品启动、attachment、STOP、recovery 与状态语义；它仅在 fresh admission、reservation 与其他 launch preconditions 通过且明确决定 launch 后，创建本次 invocation 的 `RoleLaunchOperation` deadline/budget。bootstrap timeout、browser admission expiry、owner/attempt expiry 与 game lifetime 不是该 deadline，不得被复用或发明。此 composition-root/handoff 收敛仍为 **pending**，不改变本任务的 Player survival、AI close 或 Resume 规则，也不构成发布完成证明。

**方案 A 阶段迁移：** Phase 1 完成 runtime admission、Host child authentication、root-layout revalidation 和 long-lived composition；Phase 2 由 UI strict command 驱动 GameSession Create/Resume，owner 决定 session/activation/world binding 与 selected integration。两阶段和 presentation startup/close verification 完成后，才将 browser/presentation wiring 纳入正式 composition-owned startup，删除 `host/src/dialogue-web-main.ts` 及其 entry/import，不保留 wrapper、alias、registry、第二 entry 或 fallback。

**下一实现切片（pending）：** `desktop/GameBuddy.Desktop/Program.cs`、`RuntimeSupervisor.cs`、`DesktopHostBootstrapBroker.cs`、`GuardianSupervisor.cs` 及对应 Desktop tests；`host/src/bootstrap/entry/desktop-host-entry.internal.ts`、`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`、`host/src/composition/desktop-host-composition.ts`、`host/src/stardew-production-lifecycle-coordinator.internal.ts`、`host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`、`host/src/dialogue-web-main.ts` 及 focused tests。

## Ceremonial verification audit

下表是文档层的 incident→authority→boundary→keep/merge/remove 审计；不新增 API、协议字段或证明层。

| Incident | Authority | Boundary | Keep / merge / remove |
|---|---|---|---|
| 错误 role 归属、Player world 被错误终止 | 创建时 containment 与 GameBuddy-owned process ownership | native process creation、Job 归属和明确 teardown | 保留创建时 containment/process ownership；合并同一边界的重复 artifact proof；移除把 Resume 证明或 post-hoc proof 当作 OS ownership 的重复层 |
| 并发 settlement 或可能已产生副作用但结果未知 | durable transaction/CAS 与 receipt/postcondition owner | action terminal、settlement 或 uncertain-effect recovery | 仅为真实 settlement/uncertain side effect 保留 CAS；合并同一 owner 的重复 CAS；移除把 CAS 当作通用生命周期或 Resume 证明的仪式 |
| Resume 误连其他 session/world 或错误状态 | Game session owner、登记 world binding、既有 attachment handshake 与 fresh observation | 新 activation 的 Resume binding/observation 边界 | 保留 binding、既有握手和 observation；合并重复 identity 检查；移除或不新增 Resume 的 hash/signature/generation/lease/attestation proof |
| Stardew provisioning publication/readiness 被误判 | 现有 Stardew provisioning 的 manifest、advertisement、response、fixture 与必要持久化 owner | provisioning publication/readiness 边界，与 Resume 分开 | 单独审计现有 Stardew provisioning HMAC/signatures 的 owner、用途和失败含义；合并 provisioning 内重复检查；不将其提升为 Resume proof |

## 现状审计（窄范围）

| 现状 | 处理 |
|---|---|
| `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs:37` 为两个 role Job 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；最后一个 Guardian handle 关闭会杀死成员，即使 coordinator 跳过 explicit player kill。 | 冻结 Player Host 使用 non-kill-on-close Job，AI Client 保持 kill-on-close；不得引入 no-job fallback。不得以“skip kill”作为 survival 证明。 |
| `host/src/stardew-player-host-process-owner.ts` 与 `host/src/stardew-ai-client-process-owner.ts` 仍暴露直接 spawn/kill 形状；`stardew-production-lifecycle-coordinator.internal.ts` 同时装配两个 owner。 | 同一 mutation 必须同步更新 coordinator、两个 direct Node owner 和 Guardian path；不能只改 coordinator 或只改 Guardian。旧 recovery CAS 先分类职责（containment ownership vs task continuation），再决定保留的最小 lease/single-controller 设计。 |
| `design/adr/0007...`、`design/tasks/active/stardew-bootstrap-containment-recovery.md` 及 release model 把双 Job kill-on-close 与全量 containment 作为旧前提。 | 由本任务的 owner update 替换冲突的 survival 规则；历史 archive 不改，仅由 current 文档指向 superseding task。Shape B、窄 contract、Guardian 不成为 daemon/framework 的规则继续有效。 |
| `game.resume` 已在 `game-browser-contract/index.ts` 声明并在 `composed-reference-game-browser.ts` 以严格 mismount guard 挂载；composed 测试已证明 authenticated one-shot resume、frozen typed outcomes、forged-callback 拒绝与 unmounted-route 不可用（exact-auth/projection-liveness 为已完成前置证据）。durable GameSession metadata owner facade 已位于 `continuity-semantic-production-coordinator.internal.ts`（`createGameSessionMetadata`/`completeGameSessionBinding`/`failGameSessionCreation`/`readGameSessionMetadata`/`listResumableGameSessions`）。`host/src/local-stardew-bridge.ts` 有 retry 注释；`host/src/production-game-task-ingress.internal.ts` 是 one-shot task ingress。 | 继续沿 attachment → state provider → composed browser → React 完成走线；不能增加 parallel browser API。STOP epoch 可复用；旧 task identity 不复用。 |
| 下一步 blocker：durable Game-session metadata owner facade 已定位；integration-private world-binding resolver 与其最终 composition/owner consumer 尚未定位。 | 代码审计先定位 resolver 与最终 consumer，再冻结 Slice 0 的精确 API 名；定位前只承诺窄 seam（create/resume world binding、observation、capability、terminal-world-state），不发明实现，不另造证明层。 |

### 保留/简化/移除决策

| 范畴 | 保留 | 简化 | 移除/禁止 |
|---|---|---|---|
| Player process | GameBuddy-owned Player Host、session-instance identity、safe ownership transfer | Player role 不因 controller/Guardian close 被杀；explicit endgame 单独 cleanup | 默认 close/crash 的 player kill；要求再次确认世界是否存在 |
| AI process | AI kill-on-close、AI authority stop、stale-controller fencing | AI disconnect 只 drain AI，Player 继续 | AI crash 触发 Player teardown |
| recovery | 仅保留确实保护 process ownership、并发 settlement 或未知副作用的 owner 事实 | Resume 以新 activation 重新绑定；内存对象结束随 owner 自然发生 | 用旧 task journal 自动恢复执行；blind replay/retry；为旧 callback/capability 增加失效探查 |
| proof | install/update、selected version、错误 session/world 绑定防护、action preconditions、未知副作用的 receipt/postcondition | 在同一边界合并重复 artifact/identity proof；让每项检查记录事故、owner、边界和失败含义 | 没有独立事故或决策边界的 hash、signature、generation、proof、lease、CAS、重复 attestation；为已结束 activation 的内存对象做失效探查 |
| UX state | 六个稳定状态、cancel/retry | 自动 observation/chat resync | 以 `ready` 掩盖 action paused、用 disconnected 表示 gameended |

## 最小设计

### 生命周期与 ownership

1. Player Host 进程由 GameBuddy-owned coordinator 通过现有 composition/Guardian topology 启动；其 process world lease 与 AI authority lease 分离。Game session/world binding 属于选定 Game integration 的跨游戏窄接口，不能把 Stardew owner facts 提升到通用 session owner。
2. 冻结 Player role 使用 non-kill-on-close Job。AI role 使用 kill-on-close Job；不提供 no-job fallback。
3. 正常 GameBuddy close、AI crash、控制连接 EOF：停止 AI authority，关闭 bridge/controller，保留 Player Host 及其游戏 world；不调用 Player terminate，也不因最后 Guardian handle close 间接终止 Player。
4. explicit endgame（前端可标为“退出当前游戏”）：单独 authenticated control，经 coordinator 在游戏仍可正常退出时执行 graceful game exit，再关闭 bridge 并完成 cleanup，最后 settlement 为 `gameended`；只有无法进行正常退出的明确终止路径才可 force-kill，不能把 force-kill 当作默认等价路径，也不伪造 save 成功承诺。它不是 close 的副作用，也不等同于删除 Game session；旧 session/history 可以保留，但已结束的 world binding 不可 Resume，只能由玩家明确选择 Start new game。
5. Resume 由新 activation 尝试已登记的 world binding；跨进程/持久化的 session-instance 或 revision 只在防止错误绑定、并发命令或未知副作用时检查。旧 activation 结束后不需要额外证明其内存对象失效。unknown effect reconciliation 不得阻塞只读 observation/conversation sync，但新 activation 不得恢复 execution，绝不 replay old attempt。connection failure 时 action outcome 为 `unknown`，不自动重发。

### 状态与操作

`game.resume` 是唯一 Game 恢复操作；自动重连只是自动触发一次 Resume attempt，不建立 parallel reconnect API。`disconnected → reconnecting → syncing → ready-actions-paused` 是恢复中的合法路径。Resume 失败时投影安全分类并让前端提供 Retry、Cancel 和 Start new game；Start new game 创建新的 Game session/world binding，不复用旧 world 或 action authority。`ready-actions-paused` 仅表示 Resume/world sync 已成功、Game-owned companion conversation runtime 可用、但 action authority 暂停；AI unavailable 必须是 `unavailable`。只有 authoritative game exit 才是 `gameended`；不得用 `unavailable` 表示已结束。Resume 只执行能改变错误绑定、实时观察或业务状态决定的最小检查；不为自然结束的 activation 追加 invalidation proof。

reconnect 的固定顺序是：新 session-instance 认证 → snapshot/observation sync → Game-owned companion conversation runtime resync → publish state。这里的 conversation resync 绝不重新打开、同步、接管或恢复独立 Chat surface。它不读取旧 task ingress，不创建 action envelope，不调用 native mutation。cancel 收束当前 reconnect epoch；retry 创建新的 reconnect attempt，不复制旧 action identity。

### 领域不变量

- `playerWorldSurvivesControllerCrash`: controller/AI authority terminal 与 Player world survival 可同时成立。
- `disconnectStopsAdmission`: disconnect 后不再接受新 action；accepted short step 只能到安全停止点。
- `unknownIsNotTerminal`: unknown 永不映射为 completed/cancelled，且不触发 blind retry。
- `freshInstructionAuthorizesGameOnly`: 新 instruction 的 scope/action policy/revision/deadline/identity checks 不扩大 Chat/reconnect authority。
- `explicitEndgameIsSeparate`: close/crash 永不调用 endgame transition；退出当前 world 不自动删除 Game session，但该 world binding 进入不可 Resume 的 terminal 状态。
- `stateProjectionIsTruthful`: browser/React 只能消费 coordinator attachment/state provider 的窄 projection。

## BDD 与实施分片

### Slice 0 — Game session creation and binding contract（设计/产品前置）

**Slice 0 implementation note:** The semantic SQLite authority now owns one private `production_game_session_world_binding` relation and exposes typed owner methods for register/read/terminal transitions. The relation stores only the exact session/integration pair, a constrained opaque `bindingRef`, operation identity, status, and revision; it is not an attachment or observation proof. A session is listed resumable only after a registered binding exists and the existing observation/attachment owner completes its separate success decision.

**User-visible result：** 玩家可以在 Game UI 明确选择已发布的 Game integration、可选 continuity identity 绑定，并看到创建/绑定/失败状态；成功的 Game session 具有可 Resume 的登记 world binding。

**跨游戏契约：** `GameSession` 保存 session identity、selected integration identity、可选 continuity binding、activation/world-binding projection 和产品状态；它不保存路径、PID、Job、pipe、token、native frame、游戏专属 launch facts 或 action authority。Game integration adapter 提供 `createWorldBinding`、`resumeWorldBinding`、必要时完成最小 attachment handshake、`readObservation`、`readCapabilities` 和 `readTerminalWorldState` 等窄能力，具体签名由实现计划在定位 integration-private world-binding resolver 与其最终 composition/owner consumer 后冻结（当前 blocker）；durable Game-session metadata owner facade 已定位，定位 resolver/最终 consumer 前仅承诺窄 seam，并复用已完成的 exact-auth/projection-liveness 证据进行验证。已有 hello/authentication 可在 attachment 边界复用，不为 Resume 另造 proof；adapter 的私有事实不进入 browser schema。

**BDD：**
- Given 玩家在前端选择已发布 integration 与可选 continuity binding，when 创建请求成功完成 integration-specific world creation、binding 持久化与初始 observation，then UI 显示可 Resume 的 Game session。
- Given 任一 integration 的 world binding 创建、持久化或初始 observation 失败，then UI 显示可重试/取消的失败状态，不投影 ready，不留下可误 Resume 的半成品。
- Given Resume，when 原 session 已登记的 world binding 无法验证，then UI 显示 Retry、Cancel 和 Start new game；不扫描或接入外部同类游戏。
- Given Start new game，then 创建新的 Game session/world binding，并可由玩家重新选择 continuity binding；旧 session 的 world/action/task 不迁移。

**Producer → consumer → verifier：** Game UI strict command → Host GameSession owner → selected Game integration adapter → durable session/world binding + redacted state provider → browser schema/UI；contract tests、fresh-root persistence tests、adapter contract tests 和跨游戏 fake adapter 验证。

**Non-goals：** 不实现 Stardew reconnect、Shape B、native Guardian、Chat resume、Attach existing game（独立未来 enrollment 操作，非 Resume fallback）或 multi-instance 并行 activation；本 Slice 只冻结跨游戏 contract 和前端可见流程。

### Slice 1 — Player survival（第一 mutation card）

**依赖：** 无 runtime feature 依赖；先完成 source audit 和 deterministic process fixture。必须使用 GameBuddy-owned disposable process fixture，不得 external dummy。

**变更文件：**
- `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs`
- `host/native/windows-bootstrap-guardian/WindowsRoleLauncher.cs`
- `host/native/windows-bootstrap-guardian/Program.cs`
- `host/src/stardew-player-host-process-owner.ts`
- `host/src/stardew-ai-client-process-owner.ts`
- `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`
- corresponding focused tests under `host/native/windows-bootstrap-guardian/` and `host/src/*process-owner.test.ts`, `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`

**BDD：**
- Given coordinator launched a GameBuddy-owned disposable Player fixture and AI fixture, when AI authority crashes, then Player fixture remains alive and its world marker remains readable while AI is contained.
- Given normal GameBuddy close, when Guardian control/last handle closes, then Player remains alive because its role policy is non-kill-on-close/no-job, and no implicit endgame fact is emitted.
- Given explicit endgame, when authenticated coordinator control is accepted, then Player is terminated once and only then state becomes `gameended`.
- Given an unknown Player action result during controller loss, then result is `unknown`, no completed/cancelled projection and no retry.

**命令：** `cd host; pnpm run build:test`; `node --test --test-concurrency=1 <focused dist-test files>`; Windows-only live fixture command named by the existing Guardian test runner. Missing Windows fixture is `blocked`, never pass. Do not run live Stardew.

### Slice 2 — Ownership/recovery simplification

**依赖：** Slice 1 policy proof; existing `stardew-private-bootstrap-composer` tests. Inventory each CAS/lease field by responsibility. Keep only the CAS needed to exclude an executable stale controller and to serialize settlement; remove task-resumption interpretation. Prove successor can attach fresh without old action replay.

**Likely files:** `host/src/stardew-private-bootstrap-composer*.ts`, `host/src/stardew-bootstrap-guardian.private*.ts`, lifecycle/owner tests, and existing Guardian protocol tests. No new daemon, framework, registry, or durable task-resume store.

### Slice 3 — State/reconnect vertical path

**依赖：** Slice 1 and session-instance contract; existing Game browser schemas.

**Files:** `host/src/games/stardew/lifecycle/**`, `host/src/game-browser-contract/index.ts`, `host/src/composed-browser-contract/**`, `host/src/local-stardew-bridge.ts`, `host/src/production-game-task-ingress.internal.ts`, then the existing React consumer path (locate exact component before mutation).

**BDD：** reconnect auto-observes and chat-resyncs; reconnect does not launch old task; new instruction authorizes only Game action; cancel/retry settle; all six statuses are projected accurately. The composed browser seam (exact-auth/projection-liveness) is already wired and tested; the coordinator-owned end-to-end vertical path is explicitly `not wired` until this path from coordinator resume pipeline through React is present.

### Slice 4 — Documentation/release evidence

Update release gate and runbook evidence after Slices 1–3. This task does not claim player release, companion gate, generational metadata, or live Stardew action completion.

## Verification matrix

| Concern | Required evidence |
|---|---|
| Survival | GameBuddy-owned disposable process fixture proves Player survives normal close, AI crash, and last Guardian handle close |
| Endgame | authenticated explicit operation terminates Player once; close/crash cannot produce it |
| Stale controller | old session-instance cannot issue action or endgame after transfer |
| Unknown | lost response remains unknown/recovery-required; no replay |
| Reconnect | fresh session binding, observation/chat sync, no old task autorun |
| Security | install/update integrity, selected-version startup, session-instance connection, action preconditions remain tested |
| Scope | no new daemon/framework; no external dummy; no generational metadata proposal activated |

## Owner links and status

Current behavior owners updated by this plan: [product surfaces](../../architecture/product-surfaces.md), [Stardew integration](../../domains/stardew/integration.md), [security/trust](../../architecture/security-and-trust-boundaries.md), [release model](../../architecture/release-model.md), and [ADR-0007](../../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md). Existing Guardian and topology tasks remain active/blocked where their predecessor gates apply; they must consume this task for the role-policy contradiction rather than independently reintroduce Player kill-on-close. History under `archive/` is untouched.

**Implementation status:** pending. No source/native/live/test mutation was made in this documentation lane. **Next blocker:** durable Game-session metadata owner facade 已定位；仍需定位 integration-private world-binding resolver 与其最终 composition/owner consumer（见现状审计与 Slice 0），再冻结 adapter 精确 API 名。
