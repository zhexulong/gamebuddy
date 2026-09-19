---
id: ARCH-PRODUCT-SURFACES
type: architecture
status: current
owner: product-runtime
---

# 产品界面与生命周期

## 决定

Chat 和 Game 是两个可以同时运行的独立产品界面。任何一方都不能拥有、暂停、关闭、接管或恢复另一方。

## Chat

Chat 拥有：

- 角色、Persona、Scenario、Greeting 和 World Info 选择；
- Chat thread、turn、draft、swipe/branch 和 presentation；
- provider/model/credential preferences；
- Chat 自己的启动、停止、恢复和错误显示。

Chat 不拥有 Game world、capability、receipt 或 action state。

## Game

Game 拥有：

- 游戏安装、启动和 attachment 生命周期；
- live observation、capability catalog、玩家 action policy；
- typed action execution、receipt、postcondition、停止和恢复；
- 游戏专属诊断与运行状态。

Game 不拥有 Chat raw history 或 Chat presentation state。

## 共享 Memory

只有在两个界面明确绑定到同一 continuity identity 时，才共享受治理的长期 Memory。实时 Game world、Chat raw history、credential 和运行时 capability 保持隔离。

## 玩家控制

普通自然语言输入可以引导 Agent，但可证明的立即停止或改令使用产品控制通道：`/stop` 收束当前 epoch；`/redirect <text>` 在停止成功后原子提交 replacement text。

## GameBuddy close 与恢复（由 [TASK-GAME-SESSION-SURVIVAL-RECONNECT-SIMPLIFICATION](../tasks/active/game-session-survival-and-reconnect-simplification.md) 细化）

AI crash 或默认 GameBuddy close 只停止 AI authority，并保留正在运行的 Player Host/game world；即使 Player Host 由 GameBuddy 启动，也不因 controller/Guardian close 被间接终止。explicit endgame 是独立 authenticated 操作，只有它可以结束玩家游戏并投影 `gameended`。

断开连接停止新 actions，允许已接受的 short step 到安全边界完成；未知结果保持 unknown，不得声称完成、取消或 blind retry。Resume 是 Game session 的统一恢复操作：它可以由断线后的自动尝试、重新打开 GameBuddy 或玩家在 Game 列表中选择 Resume 触发，但所有触发方式都走同一条 session/world binding 流程。Resume 只恢复 Game-owned companion conversation runtime 和只读 observation，不触碰独立 Chat surface，不自动运行旧 task；fresh Game instruction 只授权 Game actions。`ready-actions-paused` 仅表示 world sync 和 conversation 可用而 action paused；AI unavailable 为 `unavailable`，authoritative game exit 才是 `gameended`。状态由 coordinator → attachment/state provider → browser contract → composed browser → React 投影；该走线完成前保持 `not wired`，不建立 parallel reconnect API。

## Product-input contract 与方案 A presentation contract

- **Bootstrap/composition：** bootstrap 只完成 runtime admission，并初始化、承载和关闭 long-lived Host composition；不决定 GameSession、activation 或 selected integration。`dataRoot` 是 storage partition，不是 product identity；bootstrapId、generation、rootLayout 不能替代 semantic identity。
- **Semantic authority/session owner：** principal、authorityGeneration 及 deployment-level semantic authority provisioning 由现有 Host owner/contract 决定；缺失 authority 时不得创造 `local_default` principal，known startup 不自动递增 authorityGeneration。GameSession owner 单独负责 session、activation、world binding 与 `fresh`/`known` 分类。
- **Published artifact/picker：** `programRoot` 不自动等同 published artifact root；复用现有 generation admission/published capability 与 Host runtime admission。Stardew picker 复用 Host-native folder picker，路径只在 composition-private callback 中作为 untrusted candidate，立即 strict-admit 并在 pre-spawn 前 fresh recheck；browser 不接收或暴露路径。
- **Presentation startup/close：** 方案 A 完成前继续使用现有 one-loopback-listener 与 typed narrow projection，不强行新增 WebSocket、固定 `127.0.0.1`、随机端口或第二 listener。close 停止新工作后尽力 drain，close/drain 失败须传播且不得伪造成功。正常 GameBuddy close 不默认 STOP/终止 Player world；`End Game` 是独立 authenticated operation。

### Game session、activation 与 world binding

Game session 是跨游戏的持久化产品记录，类似 Chat thread；Game activation 是一次打开该 session 的运行实例；world binding 是由选定 Game integration 创建并登记的、可脱敏投影的游戏实例关联。三者不能混为一谈：关闭 GameBuddy 结束 activation，不删除可恢复的 session；退出当前游戏结束 world，但不自动删除 session 历史。

创建新的 Game session 不是一个只生成空 ID 的前端动作。前端必须让玩家明确选择并显示：

- 已发布的 Game integration（例如 Stardew 或未来其他游戏），不能输入任意 adapter 名称；
- 是否绑定一个 continuity identity；默认不绑定，选择绑定必须由玩家明确确认，且只共享受治理的长期 Memory，不共享 Chat raw history；
- 创建结果与阶段状态：创建中、等待游戏实例、可 Resume、不可用或已结束。

后端的完整链路是：`Game UI → strict browser command → Host GameSession owner → selected Game integration adapter → GameBuddy-owned world creation/attachment → minimum binding handshake and current observation → durable session/world binding → redacted projection`。集成可以在这个边界内使用已有的 hello/authentication，但不得把额外的证明元数据提升到通用 session contract。Session 只有在选定 integration、请求的 continuity binding 和新的 GameBuddy-owned world binding 成功持久化后，才能投影为可 Resume；失败只能投影为不可用/可重试，不能伪造 ready。

`Create` 与 `Resume` 是 UI 驱动的 GameSession owner 操作，不是 Desktop bootstrap 的输入或结果：

- `Create` 接收严格的 UI intent（已发布 integration、可选 continuity binding 和创建选项），创建新的 GameSession 与新的 world binding；它不接受 `dataRoot`、完整 deployment manifest、principal、authority generation、安装路径、PID、pipe、token 或任意 native launch fact。
- `Resume` 只接收已登记 GameSession 的 opaque identity，重新打开该 session 的 activation，并由 selected integration 尝试其登记的 world binding；它不把 `fresh`/`known` 当成 bootstrap 选择，也不自动复用旧 activation 的 action authority。
- `fresh` 与 `known` 仅是 owner 对 durable GameSession 记录的生命周期分类：`fresh` 表示没有可复用的登记 world binding，`known` 表示存在可尝试的登记 binding；两者不表示 principal、authority generation 或 bootstrap 状态。

Host 长生命周期 product composition 在 runtime admission 成功后创建并持有 Host-owned session owners、Chat/Game product services 与 selected integration registry；Desktop bootstrap 只完成 runtime admission，不替它们作产品选择。

Resume 只尝试被选定 session 已登记的 GameBuddy-owned world binding。它禁止扫描任意游戏进程、根据窗口标题/PID/路径/启动时间猜测、自动接入用户外部启动的游戏或把另一个 session 的 world 当作候选。绑定失败时前端明确显示“无法连接原来的游戏”，并提供重试、取消和 `Start new game`；Start new game 创建新的 Game session/world binding，不改写旧 session，不继承旧 action authority。Game adapter 负责定义跨游戏接口（创建新 world、按 opaque binding 重新连接、完成足以确认绑定归属的最小 attachment handshake、fresh observation、报告 world mismatch/gameended）；Stardew 只实现该接口，不能把 Stardew 字段提升到通用 browser/session contract。

Create/Resume 的 owner contract 明确禁止把 Desktop bootstrap 的 `dataRoot`、`HostDeploymentManifest`、principal 或 authority generation 当作 UI input。Bootstrap admission、Host long-lived composition、GameSession owner 与 selected integration 是四个不同边界：bootstrap 先完成 runtime admission；Host composition 再创建长生命周期 services；Game UI 才能请求 Create/Resume；integration 只实现被选定的 world binding。