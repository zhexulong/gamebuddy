---
id: ARCH-SYSTEM-OVERVIEW
type: architecture
status: current
owner: architecture
---

# 系统架构

## 主要组件

```text
Player
├─ Chat UI ─────→ Chat service ─────→ Pi Chat session
└─ Game UI ─────→ Game lifecycle ───→ Pi Game session
                                       │
                                       ├─ private game LaunchAuthorization
                                       ▼
                              ContainedGameRuntime
                                       │
                                       ▼
                         platform containment adapter
                                       │
                                       ▼
                               Game integration adapter
                                       │
                                       ▼
                               authenticated local bridge
                                      │
                                      ▼
                              game-owned Mod / Connector
                                      │
                                      ▼
                              native game transition
```

Chat 和 Game 可以并行运行。它们共享 Host 基础设施和在同一 continuity identity 下受治理的长期 Memory，但各自拥有独立的生命周期、raw state 和恢复路径。Game session、Game activation 与 Game world binding 也是独立层次：activation 结束不删除可恢复 session，Resume 只尝试该 session 已登记的 GameBuddy-owned world；Start new game 创建新的 session/world binding，不扫描或接入外部游戏。新 activation 是否复用仍在的 AI 进程或按 integration authority 创建新的 AI 进程，是实现选择，不构成额外 Resume 语义。

## 权威来源

- **玩家设置和产品生命周期：** GameBuddy Host。
- **Chat thread、turn 和 presentation commit：** ChatThreadStore 及其私有 composition。
- **Continuity 与长期 Memory：** fresh semantic SQLite。
- **Game capability、world state、mutation 和 postcondition：** 游戏集成与游戏线程。
- **传输：** bridge 只传递消息，不证明权限或成功。
- **验收：** runner 和测试观察生产路径，不创建生产事实。

## Desktop bootstrap、long-lived composition 与 product-input contract（当前权威；实现 pending）

正式 Desktop bootstrap 是唯一的 Host 产品 composition root。它完成已准入 Desktop generation、root layout、Host child/session authentication，并初始化、承载和最终关闭唯一的 long-lived Host composition；认证后的 `DesktopGuardianSession` 只能沿 composition 私有闭包中的 typed capability 交给 lifecycle。game lifecycle 不接收 raw session、pipe、token、PID、Job、handle、path 或 native frame，只接收窄的生命周期/containment 能力和脱敏结果。`host/src/composition` 是该正式 root 的私有装配 seam，不是第二个产品入口。

Bootstrap 只负责 runtime admission 和 long-lived composition boundary，不决定 GameSession、Game activation、world binding 或 selected Game integration。`dialogue-web-main` 是 browser/product helper：它可以在迁移完成前装配既有 Chat/browser listener 及只读 Game projection，但不得独立构造 Stardew lifecycle root、认证或持有 `DesktopGuardianSession`，也不得通过第二 entry、global session registry、daemon 或 browser handoff 取得这些能力。selected integration 只能在 Phase 2 的 UI-driven GameSession owner 中按 published integration contract 选择；Desktop 不因 Stardew 是首个 consumer 而获得 Stardew-specific authority。

每次 role launch 的 `RoleLaunchOperation` deadline/budget 由 game lifecycle 在 fresh installation admission、reservation 及其余 launch preconditions 通过、并作出本次 launch 决定后创建；它只约束该次 invocation。bootstrap、browser admission、owner/attempt expiry 和 game lifetime 都不得被冒充或复用为该 deadline。上述 composition-root 收敛及 helper 降级目前仍是 **pending**，不能作为已完成的 Desktop/Game 发布证据。

### 四项 contract（方案 A）

1. **Long-lived bootstrap/composition boundary：** bootstrap 先消费现有 generation/root admission 与 Host child authentication，再创建并持有 Host-owned 的长生命周期 composition。它不能从 `dataRoot`、`bootstrapId`、generation、root layout 或 browser input 推导产品 identity，也不能创建 GameSession、activation 或 selected integration。Host composition 是否能在缺失 semantic authority 时执行 deployment-level fresh initialization，必须由既有 semantic-authority owner/contract 明确允许；本组 contract 不添加前置条件、迁移或隐式初始化。
2. **Semantic authority/session owner：** `HostDeploymentManifest` 与现有 semantic authority owner 提供 canonical principal、authority generation、deployment identity 及 authority provisioning 规则；`dataRoot` 只是 storage partition。`bootstrapId`、generation、`rootLayout` 和 bootstrap 生命周期都不是 semantic identity 的替代品。缺失 authority 时不得创造 `local_default` principal；`known` startup 也不得自动 `authorityGeneration++`。GameSession owner 负责 session、activation、world binding 与 `fresh`/`known` 分类，且不接受 root layout、dataRoot 或 native launch facts。
3. **Published artifact/picker seam：** `programRoot` 是注册的安装 storage partition，不得无条件解释为 published artifact root。实际运行物必须复用现有 Host publisher 的 generation admission、`host-runtime-admission/v1` 与 published capability/closure；不得引入第二 artifact verifier、system runtime、任意路径或 fallback。Stardew installation setup/reselection 复用现有 Host-owned native folder picker；picker 返回的路径是 composition-private untrusted candidate，必须立即 strict-admit 并在 pre-spawn callback 前 fresh recheck identity，browser contract 永不接收或回显路径。
4. **Presentation startup/close：** Phase 1/2 完成并验证后，presentation wiring 才迁入 composition-owned startup；它复用现有 one-loopback-listener 与 typed narrow browser projection，不强行新增 WebSocket、固定 `127.0.0.1`、随机端口或第二 listener/entry。startup 只在 composition admission 成功后发布既有一次性 presentation handoff。close 先停止接受新 presentation work，再尽力 drain 并按 owner 顺序关闭；任一 close/drain 失败必须向调用方传播并保持失败状态，不能伪造成功。正常 GameBuddy/presentation close 只停止 AI authority，不隐式 STOP 或结束 Player/game world；`End Game` 是独立 authenticated operation。

### Bootstrap 与 Host composition 的输入所有权

Desktop bootstrap 的 Phase 1 负责 selected generation/root admission、Host child authentication、root-layout fresh revalidation 以及 long-lived Host composition handoff。它不决定或生成 Host 产品的 `principal`、`authorityGeneration`、`fresh`/`known` 生命周期模式或 selected Game integration；这些事实分别由 Host 的部署/身份与 semantic authority owner、以及 UI 驱动的 GameSession owner 决定。bootstrap 不接收 `ProductInputProducer`，当前设计也不新增该抽象。

`HostDeploymentManifest` 是 Host-owned 的完整部署与产品 composition 输入，不是只为测试方便传递的 fixture。它保留其声明的部署拓扑、canonical runtime root、principal、bootstrap operation 与 authority-generation 事实，并由 Host composition 在创建长生命周期 owner 前加载、校验和冻结。Desktop bootstrap handoff 中的 `gamebuddy-windows-root-layout/v1` 只描述受保护的程序、数据、operational 与 presentation 分区；`dataRoot` 是一个存储分区，不等同于 continuity、principal、authority generation、GameSession 或其他完整 authority。任何 authority initialization、fresh/known 处理和 generation 变更都必须继续由现有 owner/contract 决定。

### 分阶段落地与 dialogue-web-main 迁移

1. **Phase 1 — runtime admission + long-lived composition：** Desktop formal entry 完成 selected generation/root admission、Host child authentication、root fresh revalidation 和 typed `DesktopGuardianSession` handoff；Host composition 随后创建并承载唯一长生命周期 product composition。该阶段不选择 Game integration，不创建 GameSession/activation/world binding，也不把 browser helper 变成第二 root。
2. **Phase 2 — UI-driven GameSession：** Game UI 通过 strict browser command 请求 GameSession Create 或 Resume。Host GameSession owner 使用玩家明确选定的 published integration、可选 continuity binding 和既有 world binding；Create/Resume、`fresh`/`known` 与 activation 语义不由 bootstrap、manifest root layout、`dataRoot` 或 `dialogue-web-main` 决定。
3. **最终迁移方案 A：** 只有在 Phase 1 的正式 Host composition、Phase 2 的 UI-driven GameSession、presentation startup/close 及对应 verification 全部完成后，才把既有 browser listener/presentation wiring 迁入 composition-owned startup。然后删除 `host/src/dialogue-web-main.ts` 及其 entry/import，清理其唯一 caller 和测试；不保留 wrapper、alias、second entry、global registry、browser handoff 或 fallback。迁移前 `dialogue-web-main` 只能作为待删除的 browser/product helper，不能承担 lifecycle root、session authority 或独立 close authority。

### 下一实现切片（pending）

1. **正式 Desktop root 与 session handoff（Windows Desktop owner）：** `desktop/GameBuddy.Desktop/Program.cs`、`desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`、`desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`、`desktop/GameBuddy.Desktop/GuardianSupervisor.cs`、`host/src/bootstrap/entry/desktop-host-entry.internal.ts`、`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`、`host/src/composition/desktop-host-composition.ts`；验证使用对应 Desktop broker/supervisor tests、`host/src/bootstrap/entry/desktop-host-entry.internal.test.ts` 与 `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.test.ts`。
2. **选定 lifecycle 与 helper 收敛（Stardew/product owners）：** `host/src/stardew-production-lifecycle-coordinator.internal.ts`、`host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`、`host/src/dialogue-web-main.ts` 及 `host/src/stardew-production-lifecycle-coordinator.internal.test.ts`；将 lifecycle root 的唯一创建移入正式 composition，并令 helper 仅消费窄 projection/产品服务。不得新增 registry、第二 entry、raw session handoff 或默认 deadline。

## 运行原则

Host 启动受限 Pi session，只加载显式产品工具。Game Agent 读取 live observation 和当前 action catalog，选择一个 typed action；Host 和游戏侧分别重新执行准入检查，Mod 在游戏线程调用原生入口，并返回最终回执和 postcondition。Agent 在下一步行动前读取 fresh observation。

## 扩展边界

第一方 Stardew adapter 与 Host 在同一产品代码库中。Host private composition 中的 `ContainedGameRuntime` 是跨游戏的 containment infrastructure：它只消费游戏 lifecycle 在其私有 admission/reservation/recipe/deadline 临界点生成的一次性启动授权，负责平台 role launch、containment、EOF/recovery transport 与脱敏 outcome；它不选择安装、解释游戏 recipe 或拥有 Game 产品状态。游戏 lifecycle 仍是安装、启动、attachment、STOP、恢复和 action 语义的唯一产品 owner。Windows Guardian 是 platform adapter，不是 Stardew domain owner。完整约束见 [ADR-0007](../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md)。

物理 seam 固定为 `host/src/bootstrap/{entry,wire,roots}`、`host/src/containment/{auth,receipt,windows}`、`host/src/games/stardew/{lifecycle,launch,bridge}` 与 `host/src/composition`。各目录落地时的本地 `README.md` 定义 `Owns`、`Does not know`、`Dependency direction`、`Placement and move rule` 与 `Required verification`；本次不创建 README。未来游戏只实现自己的 private launch-authorization producer 与 receipt adapter，复用 containment seam，不复制或导入 Stardew composition。
