---
id: TASK-CHAT-SELECTIVE-LOREBOOK-M1
type: task-plan
status: active
owners:
  - chat
  - memory
specs:
  - domains/chat/overview.md
  - architecture/context-memory-and-lorebook-architecture.md
---

# Chat 选择性 Lorebook（Task 6）— M1

## 状态

**release-candidate capability；Task 6 gate 未通过。** 本任务是独立的 selective Lorebook 发布候选能力，不是 Chat Core 的 blocker，也不改变 Chat Core 的发布状态。当前 claim 尚未实现或发布；只有本任务的 gate 闭合后，才能宣称 selective Lorebook claim。

## 目标

为 Chat 提供 per-turn selective Lorebook：每轮依据 accepted player text 与 existing bounded visible tail 对 Host-owned World Info 做 deterministic selection，并在 provider 调用前形成 reference-only durable turn plan（durable-before-provider，可 replay）；该轮 `m[1]` 只由 Magic Context 自己的 native context pipeline 物化。

## 当前问题

- 既有 stable WorldBook binding（always-on path，如 `lorebook_constant`）经 Host canonical snapshot 与 typed source / render extension 进入稳定 `m[0]`，不处理每轮变化的按情境激活内容。
- 每轮按上下文选择 World Info entry，需要把「本轮输入」交给 context owner 在本轮构建时处理；现有 Magic Context 基座没有 pipeline-integrated immutable turn input / source extension seam，无法让 reference-only plan 作为本轮输入进入原生 pipeline 并物化进 `m[1]`。
- 当前通用 pipeline 缺少把 immutable turn input / contributor source（包括 reference-only plan）交给原生 materializer 的 contract；应在既有 context extension/materialization pipeline 上补这个通用 contract，而不是为 Lorebook、Memory、Game 或其它领域建立专用 `m[1]` injection API、install API 或 mutator。
- 缺少该通用 contract 时不能以 Host fallback 补齐：Host/provider 不得直接写 `m[1]`，Host 不得拼接 prompt，也不得写 Magic Context SQLite；重新扫描或进程内临时选择也不符合 durable-before-provider / replay。

## 已决定边界

- **stable vs selective 分离**：always-on premise 继续走 stable `m[0]`；Task 6 只做 selective per-turn `m[1]`，不改变 stable binding。
- **Host**：拥有 canonical World Info、revision/hash、selection 输入，产出 deterministic reference-only durable turn plan。
- **ChatThreadStore**：只存 `durableTurnId`、refs、revision/hash/order/provenance，不存正文。
- **provider / replay**：只消费 plan，不重新扫描或选择。
- **Magic Context**：复用既有 context extension/materialization pipeline，拥有 source validation、`m[1]` 的 materialization / lifecycle / cache / cursor / fold / replay / cleanup，并独占其 SQLite 写入。
- **selection 输入上限**：accepted player text + existing bounded visible tail，不扫描全量历史。

## 非目标

- regex、recursion、randomness / probability、timed effects、vector / embedding / model selection。
- Host-side prompt / `m[1]` assembly；stable `m[0]` mutation；Host 写 Magic Context SQLite。
- Game / browser projection；Task 5 terminal callback（不属于 Task 6 的实现或验收）。
- v2→v3 cutover / migration / fallback / dual read-write。

## Task 6 gate

1. 在既有 Magic Context context extension/materialization pipeline 上提供通用 contributor/source contract，使 immutable turn input / reference-only plan 可作为该轮输入进入原生 pipeline；不得新增 Lorebook、Memory、Game 等领域专用 `m[1]` API。
2. embedded GameBuddy-owned runtime acceptance 证据闭合，即在 GameBuddy 锁定的 Magic Context 分叉上端到端证明物化、`m[0]` 稳定与 replay 一致，留下可审查证据。
3. 本任务的 Chat/Tavern live evidence gate 闭合：按发布证据规范完成一次主 live run，并按需完成少量 failure/recovery runs；证据以脱敏 input/context/provider/output/lifecycle projection 为中心。

任一条件缺失，Task 6 claim 保持未通过并 fail closed；只阻断 selective Lorebook claim，不阻断 Chat Core，也不实现 Host fallback。

## 验收场景（Task 6 gate 闭合后）

1. 相同 accepted player text + existing bounded visible tail + 相同 WorldBook revision 下，选择结果（entry 集合与顺序）确定且一致。
2. 在没有独立且合法触发的 Magic Context fold / HARD materialization 时，该轮 `m[1]` 只由 Magic Context pipeline 从 plan 物化，`m[0]` 字节不变；Host / provider 不重扫、不重选。若发生合法 fold / HARD materialization，验收必须分别证明 fold 的既有契约，不能把该独立变化归因于 selective Lorebook。
3. Host restart / replay：仅凭 `durableTurnId` 与 refs 重建同一 plan，不重扫 World Info、不依赖进程内状态。
4. ChatThreadStore 不含 World Info 正文；无 `assertVolatileInstall` 一类外部调用点。
5. 本任务 non-goal 语义（regex、probability、timed effects 等）不进入实现与测试。

## release 处置

- Task 5（stable binding 的 release slice）使用 next-accept activation barrier，与本任务解耦。
- Task 6 作为独立 release-candidate capability 发布；只有 Task 6 gate 的全部条件闭合，才可发布 selective Lorebook claim。
- Chat Core 不是 Task 6 的 blocker，Chat Core 的 release 结论也不替代本任务 gate；本任务未通过时不得把 selective Lorebook 写成已实现或已发布。
- 禁止 stable `m[0]` fallback、Host prompt 拼接、Host 直接写 `m[1]` 或 Magic Context SQLite；checkbox 不表示已实现。

## evidence 要求

每个验收场景对应可审查证据：deterministic selection 测试、replay 一致测试、`m[0]` 字节稳定测试、ChatThreadStore 无正文字段断言、通用 contributor/source contract 的 runtime acceptance，以及 Chat/Tavern 的一次主 live run 和少量 failure/recovery runs（如需要）。live 证据应围绕脱敏 input/context/provider/output/lifecycle projection，并明确记录 artifact/profile/runtime identity 与 gate verdict；不得以静态 prerequisite、source/contract 检查或单元测试冒充 live evidence。当前 gate 尚未闭合，不产生 release pass。
