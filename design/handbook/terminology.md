---
id: HANDBOOK-TERMINOLOGY
type: handbook
status: current
owner: architecture
---

# 术语表

| 术语 | 定义 | 不应混用 |
|---|---|---|
| Agent | 读取当前 Context、选择工具并推进玩家任务的模型运行体。 | 不等同于 Companion 产品或游戏角色。 |
| Companion | 玩家感知到的 GameBuddy 伙伴身份和体验。 | 不等同于某个 Host 进程。 |
| Host | 运行产品服务、Pi session、policy 和适配器协调逻辑的 GameBuddy 进程。 | 不拥有游戏世界事实。 |
| Game Action | 游戏集成发布的 typed 高层能力，由游戏侧执行并产生回执与 postcondition。 | 不称为 Agent Skill。 |
| Action Program | Agent 声明的有限 typed action DAG，包含 node、依赖、guard 和结果绑定；resource template 从 action identity、canonical args 与 typed bindings 派生符号资源需求，candidate JSON 不携带 raw resource claim 或资源控制指令。 | 候选 JSON 不是 executable capability，也不是通用 workflow 脚本。 |
| Design-time Verifier | 不读取或修改游戏世界的纯验证器；根据 action descriptor 检查 Action Program 的结构、类型、依赖和资源。 | 不代替游戏线程 fresh admission，也不证明目标存在或 action 会成功。 |
| Verified Body Program | Mod 使用当前 registration、policy 和实时事实接受后的内部 program。 | 不能由 Agent JSON、Host 或 Design-time Verifier 自称或铸造。 |
| Body Program Controller | 游戏线程上从 Verified Body Program ready set 确定性选择并启动 ready node（包括 source node 和 successor）的 embodied owner。 | 不规划、搜索、扩图、循环、重试不确定 mutation 或生成玩家文本。 |
| Runtime Fact | node receipt、postcondition 或 fresh observation 产生的 typed、lineage-bound 世界事实。 | 不等同于 raw evidence string、Agent 文本、global latest receipt 或 transport success。 |
| Operation Result | 一个 action node 的 receipt、postcondition verdict、typed RuntimeFact 与 terminal state 的完整结果。 | program 汇总不能重写 node action completion。 |
| Agent Skill | 给 Agent 使用的知识或工作流包。 | 不授予游戏执行权限。 |
| capability | 当前运行环境实际可以提供的能力。 | 不等同于玩家 policy 或测试场景清单。 |
| action catalog | 某一不可变 revision 下，游戏侧当前发布的 action 描述集合。 | 不是 Host 手写的第二份注册表。 |
| policy | 玩家和产品对已发布能力施加的执行规则。 | 不负责描述玩法语义。 |
| admission（执行准入） | mutation 前对 scope、revision、deadline、policy、幂等和实时前置条件的重新检查。 | 不等同于 schema parse。 |
| receipt（执行回执） | 游戏侧对一次具体执行给出的状态和关联信息。 | 模型文本不能替代回执。 |
| evidence（证据） | 支持某项验收结论的可检查事实。 | 测试证据不能铸造生产 authority。 |
| postcondition（后置条件） | mutation 后重新读取的 action-specific 权威状态。 | 不能只依赖“命令未报错”。 |
| continuity | 让同一身份在不同 invocation 中保持长期语义连续性的标识与存储边界。 | 不等同于 Chat raw history。 |
| Memory | 玩家可治理的长期语义记忆和交互片段。 | 不包含实时 Game world authority。 |
| surface（产品界面） | Chat 或 Game 这样拥有独立生命周期的产品交互面。 | 普通 UI 页面优先称“界面”。 |
| fail closed（验证失败即拒绝） | 缺失或无法验证关键事实时拒绝继续，而不是使用默认值放行。 | 不意味着所有非关键错误都崩溃。 |
| live gate（真实环境验收） | 在目标生产结构和真实依赖上执行的稀缺验收。 | 不等同于 fixture 或 static projection test。 |
| projection（只读映射） | 从权威来源生成、不能扩大权限或事实的对外视图。 | 映射不是新的 authority。 |

文档首次使用不常见英文术语时，应同时给出中文解释；代码类型、协议字段和产品专名保持原样。