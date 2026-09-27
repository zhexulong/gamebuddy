---
id: ADR-0007
type: adr
status: current
owner: architecture
---

# ADR-0007：通用 Contained Game Runtime 与游戏自有启动授权

## 决定

Host 私有 composition 为已准入的游戏 attempt 提供一个跨游戏的 `ContainedGameRuntime`。它消费一次性、不可序列化、仅在同一私有 composition 内有效的游戏自有启动授权，并只投影脱敏的 launch/containment outcome。

`ContainedGameRuntime` 负责平台 containment：authenticated platform session、arm、role launch、contain、Host EOF、平台 recovery transport、redacted receipt 与关闭顺序。Windows Guardian 是其 Windows platform adapter；它不是 Stardew domain owner。唯一窄的 game-facing contract 是 `host/src/containment/runtime/contract/game-runtime.ts`。Stardew supplies a typed/private authorization producer capability containing game-owned facts; it never supplies `Uint8Array` native private frame bytes across this seam. The game-facing producer does not supply native private-frame bytes. It supplies only a typed, private authorization capability whose game-owned facts remain inside the composition closure; the runtime privately derives, encodes, and consumes the native frame. The resulting opaque authorization remains an internal runtime capability。其实现 `host/src/containment/runtime/core/contained-game-runtime.ts` 是 Host 私有实现，只能由 `host/src/composition` 导入并装配；composition 可以导入并装配一个明确选定的 game adapter，但 public/browser/runner 不得导入 composition。generic `bootstrap/**` 与 `containment/runtime/**` 不得导入任何 game；`games/stardew` 只能导入 contract，绝不能导入 `runtime/core`、auth transport、bootstrap roots、Desktop、Guardian、Windows 或 native。

这里的 role 仅表示 OS process role：`player_host` 或 `ai_client`，不是游戏内 NPC，也不是 AI companion。Game runtime 的持续时间由 lifecycle termination、显式 STOP 或崩溃决定，不是 timeout。系统只保留 transport/handshake wait budgets，以及一个在 lifecycle 完成 fresh admission 与其他 launch preconditions、决定实际 launch 之后创建的、每次 invocation 独立的 `RoleLaunchOperation` deadline。只有 `launch_role` 携带该 deadline；`arm`、`contain_role`、`recover_attempt` 只在其 wire 明确要求时携带各自 transport/operation wait budget，且这些 budget 既不是 launch deadline，也不是 game lifetime。具体地，arm budget owner 是 generic runtime/Guardian operation，bounded wait 结果是 `arm unavailable` 且不得 launch；contain budget owner 是 generic runtime/Guardian cleanup，bounded wait 结果是 `containment uncertain`/quarantine，永不成功；recover budget owner 是 Guardian recovery state machine，bounded wait 结果是 `recovery unavailable`/held 且旧 lease 仍为 authority。这些是 transport/operation waits，不是 game lifetime 或 launch deadline。bootstrap timeout、browser admission expiry、owner/attempt expiry 不得复用为 launch deadline；每个非 launch budget 必须有独立 owner 与 failure model：arm 由 generic runtime/Guardian operation 持有，bounded wait 结果是 `arm unavailable` 且不得 launch；contain 由 generic runtime/Guardian cleanup 持有，bounded wait 结果是 `containment uncertain`/quarantine，永不成功；recover 由 Guardian recovery state machine 持有，bounded wait 结果是 `recovery unavailable`/held 且旧 lease 仍为 authority。这些只是 transport/operation waits，不是 game lifetime 或 launch deadline。

`RoleLaunchOperation` 是 Host 私有 composition 的边界对象：Host composition owns `ContainedGameRuntime`，game lifecycle 只收到窄的 private seam。该 seam 不传递 raw session、pipe、PID、Job、token 或 path，也不通过 global registry/daemon/browser handoff 连接；不设 fallback。role launch deadline 只约束该次 role-launch invocation，不约束整个 game runtime lifetime。

每个游戏 lifecycle 仍是唯一产品 owner。它在已有 lifecycle 临界点持有并决定 installation admission、game-specific role recipe、reservation、operation deadline、attestation、STOP、recovery 语义与产品状态。游戏 lifecycle 只在这些事实已通过其既有检查后，经私有 producer callback 交给 runtime；它不直接取得 Job、PID、pipe、token、handle、native launch plan 或平台 adapter。

Stardew 是第一个 consumer，不是 runtime 的定义。`equip_tool`、`till_soil` 和其他已发布 action 的 Mod handler、descriptor、policy、receipt 与 postcondition 不因这项架构迁移改变。

## 正式 Desktop root 与 lifecycle handoff（当前权威；实现 pending）
正式 Desktop bootstrap 是唯一的 Host 产品 composition root。它先认证 Desktop 子进程所对应的 `DesktopGuardianSession`，再将 session 绑定到 composition 私有闭包中的 typed capability，并初始化、承载和最终关闭 long-lived Host composition；该 capability 只交给选定 game lifecycle 的私有装配。Bootstrap 只做 runtime admission/composition handoff，不决定 `principal`、`authorityGeneration`、`fresh`/`known`、GameSession、activation 或 selected integration；这些由现有 Host semantic-authority owner、长生命周期 product composition 与 UI 驱动的 GameSession owner 分别决定。当前不新增 `ProductInputProducer` 抽象。`dataRoot` 是 storage partition，不是 product identity；bootstrapId、generation、rootLayout 不能替代 semantic identity。
该决定禁止 global session registry、daemon、跨进程 browser handoff、第二 lifecycle/session construction path，以及 raw pipe、token、PID、Job、handle、path 或 session facts 泄漏到 game、browser、public DTO、日志、manifest 或 durable record。缺失 deployment-level semantic authority 时不得创造 `local_default` principal；known startup 不自动推进 `authorityGeneration`，具体 fresh initialization 只有在既有 owner/contract 允许时才可发生。`HostDeploymentManifest` 是 Host-owned 的完整部署与 composition 输入；多游戏和第三方 integration 仍通过同一 integration-neutral typed contract 接入，正式 Desktop root 不包含 Stardew-specific policy。
`dialogue-web-main` 仅是 browser/product helper，不得独立创建 Stardew lifecycle root、认证或持有该 session；正常 GameBuddy close 不默认 STOP 或终止 Player/game world，`End Game` 是独立 authenticated operation。presentation wiring 迁移前继续复用现有 one-loopback-listener 与 typed narrow projection，不强行引入 WebSocket、固定 `127.0.0.1`、随机端口或第二 listener；close/drain 失败必须传播，不能伪造成功。
Stardew lifecycle 仍是产品 owner：它在 fresh installation admission、reservation 和其他 launch preconditions 完成并作出 launch decision 后，创建本次 invocation 专属的 `RoleLaunchOperation` deadline/budget；不得从 bootstrap timeout、browser admission expiry、owner/attempt expiry 或 game lifetime 发明、继承或复用 deadline。上述 root 收敛及 handoff 仍为 **pending**，未构成实现或发布完成证明。

落地分两阶段：Phase 1 完成 Desktop runtime admission、Host child authentication、root-layout revalidation 与长生命周期 Host product composition；Phase 2 由 Game UI 通过 strict command 驱动 GameSession Create/Resume，owner 决定 `fresh`/`known` 生命周期分类并调用 selected integration。最终采用方案 A：Phase 1/2 验证完成后，将 browser/presentation wiring 纳入正式 composition-owned startup，删除 `dialogue-web-main` 及其 entry/import，不保留 wrapper、alias、registry、第二 entry 或 fallback。

**下一实现切片（pending）：** Windows Desktop owner 负责 `desktop/GameBuddy.Desktop/Program.cs`、`RuntimeSupervisor.cs`、`DesktopHostBootstrapBroker.cs`、`GuardianSupervisor.cs` 与对应 Desktop tests；Host composition/lifecycle owner 负责 `host/src/bootstrap/{entry,wire}`、`host/src/composition/desktop-host-composition.ts`、`host/src/stardew-production-lifecycle-coordinator.internal.ts`、`host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`、`host/src/dialogue-web-main.ts` 及其 focused tests。验收必须证明唯一正式 root、私有 typed handoff、helper 不创建 lifecycle root，以及无 registry/第二 entry/raw leakage/deadline fallback；不修改 action contract 或引入兼容路径。

## Interface

### Shape B seam (frozen)

The game-facing contract exposes only a typed/private game-facts producer capability. It never exposes `Uint8Array`, native private-frame bytes, or any other platform-frame representation. Host composition privately binds the selected game producer to the platform encoder/private launch transport and the authenticated session. The generic runtime core owns one-shot authorization, role/deadline binding, serialization, terminal states, and redacted outcomes; it does not know or interpret game facts. Platform/auth modules alone handle native frame bytes. This preserves independent Chat/Game lifecycles and does not introduce a global registry, daemon, browser handoff, fallback, hash, signature, or redundant gate.

The former `Uint8Array` producer and deferred launch plan are migration-before material only. They are not a compatibility path, public contract, fallback, or parallel production authority and must be removed before the Shape B implementation is accepted.

### Physical placement and migration rules

`host/src/containment/runtime/contract/game-runtime.ts` 是唯一 game-facing contract，保持稳定、窄、无平台事实。`host/src/containment/runtime/core/contained-game-runtime.ts` 是 implementation-private，只能由 `host/src/composition` 直接导入；任何其他 caller 必须经 composition 装配。Stardew imports are limited to the contract and its own `host/src/games/stardew/**` modules. Moving or renaming either path requires updating this ADR and the directory-local ownership rules atomically; no compatibility alias, re-export, or parallel path may be introduced.

该 module 的 caller-facing interface 保持深且窄：

```text
Game lifecycle private launch boundary
  → create one per-invocation RoleLaunchOperation after fresh admission/preconditions
  → ContainedGameRuntime.launchRole(role: ContainmentRole, operation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer): Promise<RedactedRoleLaunchOutcome>
  → redacted role-launch outcome

Game lifecycle private containment boundary
  → ContainedGameRuntime.containRole(role)
  → redacted containment outcome
```

`RoleLaunchOperation` 是 private、per-invocation 的 Host composition 对象，由 game lifecycle 在 fresh admission/preconditions 完成且作出 launch decision 后创建；只有 `launch_role` 携带其 deadline。`TypedPrivateGameAuthorizationProducer` 只接收并使用 typed private game facts 或 capability，绝不接收或返回 `Uint8Array` native frame bytes；composition 在 private closure 中把 producer 绑定到 platform encoder/private launch transport。

普通 launch request（`executable`、`cwd`、`args`、`env`、PID 或 Job）不是 interface。Stardew supplies a typed/private authorization producer capability containing game-owned facts; the runtime privately derives, encodes, and consumes the native frame. The resulting opaque authorization remains an internal runtime capability. Mint, consume, native private frame and platform transport are implementation facts; they不得成为 public DTO、JSON、日志、journal、manifest、browser/control ingress 或可由 deep import 调用的 factory。

## 强制依赖方向

稳定物理 seam 使用下列目录（目录名固定）：

```text
host/src/bootstrap/{entry,wire,roots}
host/src/containment/{auth,receipt,windows}
host/src/games/stardew/{lifecycle,launch,bridge}
host/src/composition
```

每个上述目录在落地时都以目录本地 `README.md` 定义 `Owns`、`Does not know`、`Dependency direction`、`Placement and move rule` 与 `Required verification`；本 ADR 不在本次工作创建这些 README。

允许：

```text
games/stardew/{lifecycle,launch,bridge} → containment/runtime/contract/game-runtime.ts only
composition → containment/runtime/core/contained-game-runtime.ts + one selected game adapter + bootstrap/private platform modules
bootstrap/{entry,wire,roots} → composition/private platform assembly only
public/browser/runner → never composition
```

禁止：

```text
bootstrap/**, containment/runtime/** → 任一 game integration、Stardew、Mod、action、installation/admission 或游戏 recipe
games/stardew/** → runtime/core、containment auth transport、Desktop、Guardian、Windows、Win32/native 或任何 raw IPC/pipe/token/Job/PID/path
browser、Preview、Portfolio、operator/control runner、ordinary main entry → containment private seam
```

### 唯一已记录的游戏层→bootstrap 例外

上一条禁令对 `bootstrap roots` 有一个、且仅有一个已批准例外，它由两个可执行门（`tools/check-host-game-physical-seam.mjs` 与 `.dependency-cruiser.host-production.cjs`）同时强制：

```text
games/stardew/lifecycle/stardew-private-bootstrap-composer.internal → bootstrap/roots/stardew-private-mod-profile-staging
```

理由：该模块只提供 staged Mod profile 的 provenance 构造（无 process、transport、pipe、token 或 launch 权限），其唯一消费者是生命周期的 bootstrap composer，且它被注入到 game 层而非由 game 层选择。这是允许的窄 provenance contract，不是第二套 launch 或 containment 权威。任何其它 `games/** → bootstrap/**` 边仍然禁止。

注：`containment/runtime/core` 与 `containment auth transport` 对游戏层**没有任何例外** —— 它们在图中的豁免槽位已随退役 seam 删除（见提交 `3b12a18`、`3485dbf`、`0504f65`、`dc2e0d1`），此列表是权威。

## 可执行反侵蚀门

在上述物理 seam 落地的同一实现任务中，违反分层必须失败：

- `dependency-cruiser` 与 source-bound tests：TypeScript 静态 import direction/cycle，以及 dynamic import/require、private export、authorization mint/consume、raw process facts、Node direct spawn 与 artifact closure gate；
- `ArchUnitNET`：只在实际稳定的 C# namespace seam 出现后，验证 generic platform namespace/assembly 对游戏 namespace/type 的禁止依赖；
- Windows integration tests：证明真实的 process semantics，包括 authorization one-shot、role/attempt/deadline binding、Guardian EOF cancel、containment 与 redacted outcome。

Knip 只发现迁移后无 consumer 的旧模块/exports/dependencies 候选；它不证明分层、capability、动态加载或跨进程行为，不能作为此 ADR 的通过证据。

## 后果

- 新游戏仅实现自己的 admission、recipe、reservation、每次 invocation 的 `RoleLaunchOperation` deadline、typed/private authorization producer 与 receipt-to-lifecycle adapter；只导入 `game-runtime.ts`，不复制或导入 Guardian/session/EOF/containment 编排。
- 现有 `StardewDesktopGuardianBootstrapComposition`、Stardew-specific Desktop session holder、deferred byte callback 只是待替换过渡草稿，不得成为跨游戏 template。
- 现有 Stardew Stage C/D direct Node role spawn 必须在 runtime 与 Stardew adapter 同一原子切换中删除；不得保留 fallback 或并存 production authority。


## Superseding clarification: validation budget

本 ADR 的一次性授权、跨进程 session/attachment、role containment 和 action 前置条件只在它们改变具体安全或业务决定时成立。它们不是要求为同一事实建立多层证明链：

- 发行物来源、完整性和选定版本只在安装、更新和启动边界检查；不要把相同的 hash、signature 或 artifact proof 复制到每个 role、session、action 或普通消息。
- Game session Resume 只需由当前 Game integration 依据已登记的 world binding 确认实例归属，并在新 attachment 上完成必要的 hello/observation；不扫描进程，也不为已经随 activation 结束的内存 capability 追加失效探查。
- `ContainedGameRuntime` 只保留其自身需要的 one-shot authorization、role launch/containment 和 transport failure semantics。任何额外 generation、fingerprint、lease、CAS、proof 或 attestation 必须由 owner 指出独立事故和业务决策，否则应在实现任务中合并或删除。
- `Windows integration tests` 验证真实的 OS/process 语义，而不是用更多测试层或自签名 proof 重复描述同一个 OS 结果。测试数量、证据字段数量和内部 metadata 数量都不能单独提升发布等级。

该预算规则不移除真正改变决策的检查：例如错误 Game/session 绑定、错误版本启动、可能产生 native 副作用的 action admission、未知副作用的 receipt/postcondition，以及确有并发或不确定写入的 durable transaction。它要求每项检查在 owner 文档或 active task 中注明事故、权威来源、边界和失败含义；无法注明的检查不得继续扩张。

## Superseding clarification: Player role survival

本 ADR 中关于 role containment 的一般接口、窄 contract、一次性授权和 AI authority 规则继续有效；但双 role 均使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 不再是 Player role 的产品前提。依据 [TASK-GAME-SESSION-SURVIVAL-RECONNECT-SIMPLIFICATION](../tasks/active/game-session-survival-and-reconnect-simplification.md)，Player Host 固定使用经实现验证的 non-kill-on-close Job；不提供 no-job fallback。AI Client 才保留 kill-on-close。默认 GameBuddy close、AI crash 与 controller EOF 停止 AI，不结束 Player/world；explicit endgame 独立授权，并在可用时执行 graceful game exit；force-kill 不是默认等价路径，也不伪造 save 成功承诺。Guardian 仍可拥有 OS containment authority，但不得把 last-handle close 变成 implicit endgame。