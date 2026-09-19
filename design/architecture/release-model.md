---
id: ARCH-RELEASE-MODEL
type: architecture
status: current
owner: release-engineering
---

# 发布与验证模型

## 证据层级

- **静态检查：** schema、类型、import boundary 和 artifact composition。
- **确定性测试：** 纯逻辑、协议、状态机、幂等和恢复行为。
- **集成测试：** 真实模块 composition 与进程边界。
- **真实环境验收：** 目标版本、正式 topology 和生产入口。
- **玩家发布：** 安装、onboarding、UI、恢复、诊断和完整体验。

高层证据可以包含低层检查，但低层证据不能替代高层发布声明。

## Game Action 完成

一个 action 只有在同一 task/request/execution 上同时具备 `succeeded` receipt、非空 evidence 和 action-specific postcondition 时，才能投影为权威完成。完成审查必须追踪 ingress、validation、admission、typed native dispatch、terminal receipt、fresh postcondition、teardown 和 runner closure。

## 最小证据与验证预算

验证应服务于具体的发布或产品决定，不是额外的仪式化证明层。每项 gate 只保留能改变该决定的最低成本事实，并注明 owner 与失败含义：

- 安装、更新和选定版本启动检查发行物完整性与版本选择；这类检查不在每次 session Resume、action 或普通消息中重复传播。
- Game Resume 只重新确认所选 session 的 GameBuddy-owned world binding、已有且必要的 attachment handshake 和当前 world observation，用于避免误连与错误状态判断；不扫描或猜测其他进程，也不要求证明每个旧内存对象已经失效。Resume 不因“需要重新启动 AI”而增加一套独立证明。
- action gate 保留游戏线程的 scope、policy、revision、deadline、idempotency、cancel 和实时前置条件，因为这些事实直接决定一次 native mutation 是否允许。
- receipt/postcondition 保留用于区分 transport 成功、真实游戏结果和未知副作用；durable transaction/CAS 只用于存在并发写入、重试或 uncertain side effect 的 owner。
- OS containment 只验证 role 的进程归属、Player 存续和明确 teardown；不以额外 hash、signature 或跨层 proof 重复证明同一个 OS 结果。

没有独立事故、业务决策或 owner 的 hash、signature、generation、proof、lease、CAS、重复 attestation 不得新增。现有机制要在对应 active task 中逐项归类为保留、合并或删除；静态/测试 evidence 只能证明实际覆盖的事实，不能因为 evidence 数量增加而提升发布等级。

## Harness 边界

测试与 live attestation 只能观察生产 authority。Harness 可以设置外部进程 timeout 防止自动化挂起；该 timeout 不进入产品任务，也不被解释为游戏结果。

### Platform control live

`equip_tool` 的已发布 production authority/behavior 是不可变前提：Mod handler、catalog 和 live policy，Host tool action ID、arguments 与 visibility，同一 logical action 的 receipt semantics，以及 release status 均不得改变。明确的 no-diff behavioral guard 必须保护这些可观察事实；不得以实现引用、文件身份或 hash 快照替代该 guard。

依照 [ADR-0008](../adr/0008-converged-production-kernel-and-game-spi.md)，平台彻底废除原 `integrations/stardew/action-development` 的双轨测试台与独立 runner 结构，将控制运行全面收敛至单一生产内核与 `GameAdapter` SPI。动作控制验证直接作为生产流水线的一等公民执行，不建立平行运行时，也不改变已发布动作的生产行为。

### 统一安装注册

Production Game 与 release/control 必须共同使用同一个 Host-owned Stardew installation registration、fresh admission 和 `StardewProductionLifecycleCoordinator`；control 只能请求该既有 authority 进行一次运行，不能建立平行 registration、重新 admission 路径或 coordinator。setup 在首次注册或玩家显式 reselection 时才可通过 native folder picker 接收不可信候选目录、立即严格 admission 并仅发布 registration，不创建 attempt。`game.launch` 才开始一个 attempt：bootstrap owner 原子 prepare-and-bind，随后消耗该 request 的 Phase A reservation 并进入 Stage B；只在 Stage C native effect 前 request-local fresh-admit。cabin confirm 在 Stage D native effect 前必须为该 exact request 第二次独立 fresh-admit。普通 release/control run 不得再次唤起 picker，也不得把 picker、候选路径或选择权下放给 browser、Devkit、adapter 或 release harness。

Durable registration 只保存 Host-private 的 locator、schema/revision/state 与 desktop binding。它不得保存 opaque `AdmittedStardewInstallation`、identity chain、executable 或任何已admit identity facts；这些均只能在每次 `game.launch` 中由 bootstrap owner 原子 prepare-and-bind、消耗 Phase A reservation 后，以仅用于 Stage C native effect 前 request-local fresh-admit 的新进程内 opaque capability 形成，且不跨 request、attempt、replay 或重启。registration 也不得保存 picker 原始候选、bridge endpoint/token/config、session、进程/PID/job、guardian 或 launch generation、runtime journal/recovery state，或任何 fixture/debug/run 字段。registration 的 active pointer 仅关联 guardian/bootstrap authority，绝非 cleanup 或 containment truth；只有 guardian settlement proof 确认 exact attempt containment 后才可回到 `ready`。每次 `game.launch` 中 coordinator 必须由这份 registration fresh reread，并仅在 Stage C native effect 前 request-local fresh-admit；bridge、生命周期、authenticated attachment、receipt/journal/recovery 和 teardown 均为该次 lifecycle activation 的短暂 Host-owned authority，不是 registration 或 release/control authority。

旧 `action-development` profile 不再是安装或 lifecycle authority：其中的安装 locator 必须由显式首次注册/重选写入上述 durable registration，但不迁入任何 admitted identity或可观察路径字段；fixture、debug、scenario 和 disposable-save 字段只能进入 attempt-local control input/record，并在 run 结束后失效。release/control 只可消费有界 registration readiness/reference 和结果事实，不能读取或发布安装路径，也不拥有 installation、bridge 或 lifecycle authority。

依照 [ADR-0008](../adr/0008-converged-production-kernel-and-game-spi.md)，测试与控制运行彻底废除旧有的 32KB JSON stdin/stdout 跨进程管道、generic child seam、文件租约、Proof 自签名与 `StardewActionDevelopmentRunPort`。测试直接通过 In-Process Fixture 注入生产 Coordinator 与 `GameAdapter` SPI，验证真实的端到端流水线：
`Admission -> Execute -> Receipt -> Postcondition -> Containment`。

测试执行不维护平行的调度机制，其流水线阶段固定为：
1. **External factual preflight：** 静态检查环境、安装注册有效性及前置条件；
2. **Offline/disposable save prerequisite prepare：** 在启动游戏进程与 Bridge 之前，准备测试专用的可丢弃存档或固定环境前置；
3. **Coordinator launch & authenticated attachment：** 调用生产协调器拉起游戏角色并完成安全通信通道挂载（依托 [ADR-0007](../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md) 的 `ContainedGameRuntime` 提供进程生命周期与 Job 守护）；
4. **Admission & Execute：** 经由生产 `GameAdapter` 注入 Fixture Input 派发动作，执行生产级别的参数校验、准入、幂等记录与 Native 派发；
5. **Receipt & Postcondition：** 接收游戏 Native 终态回执（Receipt），并由 Action 专属 Verifier 读取游戏世界最新状态进行确定性后置校验（Postcondition）；
6. **Teardown & Containment：** Coordinator 关闭通信通道，`ContainedGameRuntime` 执行进程终止收拢与脱敏会话结算；
7. **Fixture restore & cleanup outcome：** 恢复测试环境与临时存档，输出最终执行记录。

`actionOutcome`、`harnessOutcome` 与 `cleanupOutcome` 必须分别记录。测试框架与 SDK 不得篡改生产 Receipt，也不得引入内部自签名 Proof 替代真实的业务事实。cleanup 失败可以使整个 control run 失败，但不得抹除已存在的权威 action fact。最小 run record 只用于该次控制运行，绝不驱动产品 publication。

cutover 必须原子删除 native-local live route，不保留 diagnostic/live fallback；已由新路径替代的旧 owner 应删除。外部 Guardian 的实现不属于本任务；registration 必须遵守本节的统一 Host-owned 边界。实施与证据要求遵循 [ADR-0007](../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md) 与 [ADR-0008](../adr/0008-converged-production-kernel-and-game-spi.md)。

## 产品里程碑

- **Action live gate：** 证明一个具体 action 的正式执行路径。
- **Open Game release：** 证明玩家 prompt 驱动的生产 Game loop 与完整 Stardew 玩家路径。
- **Browser Preview：** 证明浏览器形态的产品流程。
- **Desktop Player Release：** 还必须完成 Windows shell、installer、update、onboarding 和完整 Chat/Game journey。
- **陪玩体验硬门：** 正式 Stardew AI Farmhand 的玩家体验验收；单项 action、Portfolio 或 Tavern evidence 不能替代。

## Action 测试与 Trace 设计原则

离线测试的目标是尽早发现**可以由 action contract、生产编排和已建模状态推导的问题**，而不是建立一个替代游戏运行时的模拟器。实现必须遵守以下范围：

- 优先复用现有的 action contract、adapter seam、coordinator、receipt/evidence validator、postcondition evaluator 和测试运行器；不新增平行 registry、completion authority 或跨游戏 gameplay DSL。
- 每个 mutation action 的离线测试至少应覆盖其已声明的参数边界、拒绝条件、admission、幂等/重复请求、取消或过期、receipt/evidence 关联以及 postcondition 判定。测试应调用生产代码；仅组装合成成功 receipt 或 snapshot 的测试，只能声明 wire/validator 覆盖，不能声明 action 成功路径覆盖。
- action-specific 的成功结果必须有对应的 action-specific verifier。没有 verifier 的 generic passing fallback 必须拒绝，不能因为结果结构合法就通过。
- 需要组合时序时，优先对现有生命周期实现增加少量 model/PBT 或故障排列测试，覆盖重复、乱序、commit 后不确定、断线恢复和清理失败等实际风险。只有具体缺陷或高风险组合证明需要时才增加模型；不以测试数量、模型复杂度或覆盖率作为目标。
- 当一个测试声称保护重要行为时，应以少量受控错误变体验证它确实会失败，例如删除 admission、重复 dispatch、丢失 evidence、使用旧 postcondition 或把不确定结果重试。mutation testing 是验证测试敏感性的工具，不是所有 action 的强制发布门。

## Trace 的用途与边界

Trace 是用于诊断和回归的结构化输入，不是第二个 authority。对已有生产执行产生的 trace，可以在不启动游戏的测试中重放解析、路由、receipt 合并、evidence 校验、postcondition 判定和 cleanup 状态；重放结果只能说明当前代码对已记录事实的解释是否发生变化，不能重新声明一次 live action 成功。

Trace 至少应保留同一 `task/request/execution` 的阶段关联和 action contract 版本，并按项目的数据边界脱敏。对 mutation action，成功样本应尽量包含：request/admission、terminal receipt、非空 action-specific evidence、fresh postcondition 和 cleanup outcome；失败样本应包含触发的阶段和终态。缺少这些字段的 trace 仍可用于局部 parser 测试，但不得被当作完整 action closure。

Trace 回归应优先使用真实生产路径已产生的样本，并可与 action-specific model 或 verifier 做差异比较；测试 fixture 可以产生测试输入，但不能伪造 production receipt、live evidence 或 publication。发现 trace 与当前 contract 矛盾时应失败并要求处理，不应静默降级为通过。

## 测试层次与按风险采用

对当前 action portfolio，建议按以下顺序补强，而不是一次性建设完整框架：

1. **现有测试修正：** 区分拒绝路径、wire/runner 测试和成功 action 路径；确保 generic passing fallback 不绕过 action-specific verifier。
2. **具体 action 的离线闭包：** 对返工风险最高或最近修改的 action，补齐生产编排、receipt/evidence、fresh postcondition 和 cleanup 的测试。
3. **共享生命周期性质：** 当重复、取消、乱序、commit 不确定或恢复缺陷出现时，使用现有 PBT 能力或最小模型测试覆盖该性质，并让反例可重放。
4. **Trace 回归：** 将已获得且符合数据边界的生产形状样本加入对应 verifier/parser 的回归测试；不要为了拥有 trace 而增加额外 live mutation。
5. **自动化真实运行：** 离线测试通过后，真实目标游戏运行仍只验证离线无法观察的游戏线程、当前 world 和 native 副作用；应优先无人值守，不要求人工操作，但仍遵守本文件的 Game Action 完成条件。

新游戏 adapter 可以复用第 3、4 层的生命周期和 trace 机械，但必须自行定义 action 的参数、world 语义、evidence、postcondition 和 cleanup。没有实际风险、生产消费者或失败证据时，不应预先抽取新的通用框架。


## GameBuddy close 的玩家世界存续

Action/运行时收束不等于 endgame。默认 close、AI crash 或 controller loss 必须停止 AI authority，同时保留 GameBuddy-owned Player Host 与其游戏世界；Player role 的 Job policy 必须证明不会因最后 Guardian handle close 而杀死成员。explicit endgame 在可用时采用 graceful game exit，force-kill 不是默认等价路径，且不得伪造 save 成功承诺。它是独立产品操作和证据项。disconnect 后不接受新 action，accepted short step 只到安全边界；未知结果不得作为完成、取消或重试依据。详见 [Game session survival simplification](../tasks/active/game-session-survival-and-reconnect-simplification.md)。