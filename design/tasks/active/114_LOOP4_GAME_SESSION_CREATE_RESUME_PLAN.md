---
id: LOOP4-GAMESESSION-CREATE-RESUME-BOUNDARY
type: boundary-freeze
status: frozen-with-create-seam-blocked
owner: release-engineering
---

# Loop 4：GameSession Create / Resume 边界冻结

## Owner 与 topology

`SemanticGameProductionAuthority` 是唯一 durable GameSession authority；coordinator 只消费其窄 facade，不创建第二个 store。Stardew integration 的 private `CreateWorldBindingSeam` 是唯一允许创建新 world/save 并返回 opaque `bindingRef` 的 owner；当前 production 尚未提供该实现，因此 production `game.create` 必须保持 `unavailable`，不得伪造 binding 或成功。save/world 的实际 ownership 属于该 integration/native Game runtime，不属于 browser、coordinator 或 Preview。

## Create durable protocol

创建严格按以下顺序执行：

1. `createGameSessionMetadata` 写入 pending intent（authority mint `gameSessionId`）。
2. private world-creation seam 创建 world/save，只返回 opaque `bindingRef`；不得泄露路径、PID、Job、pipe/token 或 native launch facts。
3. `registerGameSessionWorldBinding` 写入 registered binding。
4. `completeGameSessionBinding` 将 metadata 变为 resumable。
5. 首次 activation 仅在前述 durable steps 成功后运行；首个 authenticated bridge/observation sync 由 coordinator 的既有 activation/materializer chain 负责。actions 默认 paused，必须新的显式 Game instruction/reopen 才恢复。

world creation、binding persistence 或首个 activation/observation 任一步失败都不得返回 attached/ready。注册前失败将 pending metadata 置 failed 且不留 binding；注册后失败将 binding 标为 terminal，并在同一 durable failure path 将 metadata 置 failed。failure path 自身若无法持久化，必须 terminal error/quarantine，不能声称 clean unavailable。

## Cleanup 与 close

coordinator close/unmount 只停止其 AI authority、activation 与 attachment，并等待既有 teardown；不得删除 durable GameSession、save/world 或凭猜测清理外部进程。未完成 create 在 close 前停止并按上述 durable failure 规则收束；close 竞态不能伪造成功。只有明确 authenticated end-game operation 才能终止 Player world/save（Loop 5 范围），普通 close、AI/runtime failure、EOF 不得终止它。

## Resume boundary

Resume 只解析 authority 中已登记、非 terminal 的 `(gameSessionId, integrationId, bindingRef)`；绝不扫描 PID、路径、窗口或 save files，也不盲目重建 world。恢复必须 fresh authentication 与 observation sync，创建新的 attachment generation；authority/action state 初始保持 paused，不自动 replay、重试或恢复旧 task/action。过期、foreign、terminal、stale tuple 或 attach 失败均 fail-closed，并保持可见的 disconnected/unavailable 状态。

## Explicit endgame 与 recovery

Recovery 只恢复 AI authority/attachment（在 fresh authentication + observation sync 后），不恢复旧 task/action，也不接管 Chat。Player world 存活与 AI lifecycle 分离；显式 authenticated end-game 是唯一正常终止 world/save 的入口。未知 native 结果不得假称完成、取消或盲重试；任何需要 Loop 5 Guardian/Player survival 的动作不在本 Loop 的 create/resume 成功门内。

## Production seam status

当前 closed production factory 已将同一 `game` authority 传入 coordinator；`createWorldBindingSeam` 仍明确为 `undefined`，因为真实 Stardew world/save producer 尚不存在。provider 通过四参数 closed factory 间接获得该 composition，不能注入 fake seam；test-support 的 fake seam 仅用于测试 wiring/order/rollback。不得为解除 `stardew_game_world_creation_unavailable` 而新增伪造或第二套 authority。
