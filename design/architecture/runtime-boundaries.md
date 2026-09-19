---
id: ARCH-RUNTIME-BOUNDARIES
type: architecture
status: current
owner: runtime
---

# Runtime 边界

## Pi session

GameBuddy 使用内嵌 Host/SDK runtime 和 GameBuddy-owned 数据目录。产品运行不能调用或依赖用户系统中已有的 `pi` 安装、session、配置、extensions、skills、prompts 或认证文件。

Host 以默认无工具模式启动 session，再显式加载产品工具。Shell、文件、Git、网络和 coding-agent 工具不进入 Companion runtime。

Production Chat 必须仅由内嵌的 GameBuddy-owned Host/SDK runtime 按 **v3-only fresh-root provisioning** 挂载：provisioning gate 要求 Host lifecycle owner 先在新的 runtime root 中创建空的 v3 Chat authority，再从当前 source 组成的 production artifact 挂载 v3 Chat storage source/path；stale generated staging output 不得作为 mount 依据。v2 Chat data 不得进入 production authority：禁止迁移、import、adopt、dual-read、dual-write、fallback 或 read-repair。若存在运行中的 pre-release v2 authority，provisioning gate 必须先 drain，再 remount v3，且不得传输数据。

## Manifest

### 语义 authority

`HostDeploymentManifest` 是 Host-owned 的完整部署与 composition 输入，携带既有 canonical principal、authority generation、runtime root 与 bootstrap operation 等声明事实；bootstrapId、generation、rootLayout 和 `dataRoot` 都不能代替 semantic identity。`dataRoot` 只是 storage partition，不自动产生 product identity。缺失 semantic authority 时是否允许 deployment-level fresh initialization，必须由现有 authority owner/contract 明确规定；本边界不创造 `local_default` principal、不引入 fallback，也不把 known startup 自动解释为 `authorityGeneration++`。

`CompanionRunManifest` 是 Host 拥有的脱敏恢复边界。它记录身份、版本、模型、registry/policy、已加载工具、知识、profile、presentation 和 feature flags，不保存 prompt、secret、hidden reasoning 或 raw audio。恢复时 fingerprint 不匹配即拒绝。

## Capability binding

运行时 capability 使用由 Host TCB 创建、不可伪造、一次性且有明确关闭顺序的 binding。Facade consumer 不能获得 authority-bearing token，也不能通过随机 ID 或回调参数制造 runtime identity。

## 控制通道

STOP/redirect 的 pipe endpoint 和 token 由 launcher 每次启动时以短生命周期环境变量注入。它们不进入 operator config、continuity、run manifest 或稳定 identity，也不通过 stdout 或文件发布。

## 失败原则

缺失 launch generation、非法 control 值、过期 scope/deadline、失效 binding 或恢复 fingerprint 不匹配时，runtime 验证失败即拒绝。