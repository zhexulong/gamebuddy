---
id: ADR-0008
type: adr
status: current
owner: architecture
supersedes: ADR-006-STARDEW-ACTION-DEVELOPMENT-CONTROL-LIVE-OWNER
---

# ADR-0008：单一生产内核、GameAdapter SPI 与动作轻量 SDK 收敛

## 决定

1. **废除动作测试台双轨制：** 彻底废除动作开发原有的独立跨进程测试台机制。删除 32KB JSON stdin/stdout 跨进程流控管道、删除 `RunPort`（如 `StardewActionDevelopmentRunPort`）与跨进程调度代理、删除进程内 Proof 自签名（proof self-signing）与凭据链，以及基于文件的运行租约与锁。
2. **统一单一生产执行流水线：** 动作测试与线上运行共享同一套生产内核状态机。测试直接调用生产环境的 `GameAdapter` 接缝与 `Coordinator`，以结构化 Fixture Input（如前置存档状态）替代真实的玩家输入，验证真实的端到端流水线：`Admission -> Execute -> Receipt -> Postcondition -> Containment`。
3. **收敛跨游戏守护至 ContainedGameRuntime：** 依托 [ADR-0007](0007-contained-game-runtime-and-game-owned-launch-authorization.md) 的 `ContainedGameRuntime`，由平台统一负责进程级 Containment、Job 对象绑定、会话管理、Host EOF 级联终止及脱敏结果投递。各个具体游戏仅负责自身的产品生命周期决策，不维护独立的进程守护逻辑。
4. **确立标准化 GameAdapter SPI：** 在 `host/src/games/` 确立标准化的游戏适配器服务提供者接口（Service Provider Interface, SPI）。游戏适配器封装具体游戏的生命周期协调、启动授权生成、Bridge 通信协议与 Native 动作接缝。星露谷（Stardew Valley）作为首个 SPI 实现以验证该接缝，为后续接入第二款游戏及社区扩展游戏（遵循 [ADR-0003](0003-use-out-of-process-community-connectors.md)）确立解耦模式。
5. **轻量化动作开发套件：** 将 `@gamebuddy/game-action-devkit` 瘦身为纯净的无状态开发辅助库，仅提供 Action Schema 校验、离线断言工具与 Mock Bridge 测试夹具，不再承担跨进程监督、32KB 协议封包或测试台调度职责。

## 背景与问题

在先前的设计与 [ADR-006](006-stardew-action-development-control-live-owner.md) 中，为了隔离开发期的动作验证与正式生产环境，引入了 Devkit 通用子进程监督接缝（`process-supervisor`）、32KB 单行 JSON start envelope 管道、`StardewActionDevelopmentRunPort` 调度端口以及进程内 Proof 自签名链。

该设计在演进中暴露出显著的过度工程与架构割裂：
- **双轨实现导致验证失真：** 测试台环境与生产 Host 拥有不同的启动和调度拓扑，导致在测试台中验证通过的动作难以完全保证在生产环境 `StardewProductionLifecycleCoordinator` 下的行为一致性。
- **防御性过度工程（Ritualistic Validation）：** 在受控测试环境内维持 32KB 封包限制、进程内自签名 Proof 与文件租约，并没有对应的真实威胁模型，徒增复杂度和维护负担，违反架构极简原则。
- **多游戏扩展受阻：** 动作开发逻辑与特定游戏（星露谷）过度耦合，缺乏清晰标准的游戏抽象接口，阻碍了后续支持第二款游戏与跨游戏复用。

## 架构与核心规范

### 1. 单一生产流水线与 Fixture 注入

测试环境与生产环境不再维护两套执行引擎。验证动作时，测试代码直接在进程内组装生产 Host 的组合根或调用 `GameAdapter` SPI：

```text
生产链路: 玩家指令 / Agent Intent ──┐
                                     ├──> Admission ──> Execute ──> Receipt ──> Postcondition ──> Containment
测试链路: 确定性 Fixture Input  ─────┘
```

- **Admission（准入）：** 对动作请求参数、当前世界状态前提与并发互斥进行校验，分配一次性执行标识与幂等凭证。
- **Execute（执行）：** 通过游戏 Bridge 发送强类型动作指令至游戏主线程 Native 模块。
- **Receipt（回执）：** 收集 Native 模块返回的结构化执行回执，包括终态状态码、变更事实与证据上下文。
- **Postcondition（后置校验）：** 重新读取游戏世界最新状态，确定性比对状态变化，断言动作真实副作用达成。
- **Containment（守护回收）：** 执行结束或发生异常时，统一由 `ContainedGameRuntime` 执行会话结算、资源清理与进程收拢。

测试与生产的唯一差异仅在于指令输入的来源（Fixture 注入 vs. 玩家/Agent 输入），端到端流水线本身保持完全一致。

### 2. 标准化 GameAdapter SPI

在 `host/src/games/` 下确立面向多游戏的规范化 SPI：

```text
host/src/games/
├── README.md               # 统一 SPI 规范与依赖边界
├── stardew/                # 星露谷实现（首个适配器）
│   ├── lifecycle/          # 生命周期与状态机协调
│   ├── launch/             # 游戏专属启动参数与环境构建
│   ├── bridge/             # Mod 通信协议与 Native 动作接缝
│   └── README.md
└── <game_name>/            # 第二款游戏及未来游戏适配器
    ├── lifecycle/
    ├── launch/
    ├── bridge/
    └── README.md
```

每个 GameAdapter 必须实现以下职责：
- **Lifecycle Coordination：** 维护游戏专属的状态机（未就绪、运行中、暂停、错误等），管理安装路径校验与前置准备；
- **Launch Authorization Producer：** 构建符合 ADR-0007 规范的私有启动授权 Producer，交由 `ContainedGameRuntime` 调度真实进程；
- **Native Bridge & Action Dispatch：** 维护与游戏进程/Mod 之间的通信协议通道，处理动作派发与回执解析；
- **State Observation & Postcondition：** 暴露读取游戏当前世界快照的能力，用于状态判定与动作后置条件核验。

GameAdapter 不得实现操作系统级别的进程树管理、Job 对象注入或强制杀死逻辑，这些职责全部收敛于底层 `ContainedGameRuntime`。

### 3. @gamebuddy/game-action-devkit 职责收敛

`@gamebuddy/game-action-devkit` 剥离所有运行时调度与监督代码，收敛为轻量无状态 SDK：
- **Action Schema 校验：** 提供标准化 JSON Schema，校验动作描述符（action manifest）、输入参数与回执结构；
- **断言工具库：** 提供对 Receipt、Evidence 与 Postcondition 的语义断言辅助函数；
- **Mock Bridge 夹具：** 提供用于单元测试的轻量内存级 Bridge 模拟器，使动作开发者能够在脱离真实游戏时编写确定性单测。

## 被废除与拒绝的设计

1. **废除 ADR-006 双轨测试架构：**
   - 本 ADR 明确废除并替代 [ADR-006-STARDEW-ACTION-DEVELOPMENT-CONTROL-LIVE-OWNER](006-stardew-action-development-control-live-owner.md)；
   - 彻底废除 `StardewActionDevelopmentRunPort` 接口及其跨进程或进程内调度代理；
   - 彻底废除 32KB JSON stdin/stdout 跨进程流控管道与工作简报封包（work-brief）；
   - 彻底删除进程内 Proof 自签名机制与文件租约锁。
2. **拒绝在测试环境中构建平行 Coordinator：**
   - 不允许为测试或 Devkit 构建第二套简化版的生命周期协调器，测试必须直接实例化并驱动真实的生产协调器与 GameAdapter。
3. **拒绝由测试套件直接操控底层 OS 进程：**
   - 测试用例不得绕过 `ContainedGameRuntime` 自行调用 Node 的 `child_process.spawn` 启动受管游戏进程。

## 后果与迁移

- **降低拓扑分歧：** 减少测试台与生产环境之间的调度差异，使动作测试能够在真实的生产生命周期与适配器逻辑下运行。但需注意：单项 Action 测试通过只能证明契约与本地流水线正确性，不能替代高层环境与完整开放玩法体验的验收（遵守发布模型证据层级）。
- **解耦多游戏边界：** 确立清晰的平台守护与游戏适配边界。星露谷作为首个实现验证该接缝，后续第二款游戏接入时只需实现游戏私有的 `GameAdapter`，无需重复编写通用的进程守护与跨进程流控逻辑。
- **SDK 纯净化：** `@gamebuddy/game-action-devkit` 成为无平台运行时副作用的开发辅助库，降低工具链维护成本。
- **发布规范一致：** 现行发布模型 [release-model.md](../architecture/release-model.md) 同步移除旧有的双轨测试台与 32KB 管道描述，与本 ADR 确立的单一生产接缝保持一致。
