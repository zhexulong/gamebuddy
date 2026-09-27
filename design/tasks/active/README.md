---
id: TASKS-ACTIVE-INDEX
type: task
status: active
owner: documentation
---

# 活动任务

- [Stardew Bootstrap Containment and Recovery](stardew-bootstrap-containment-recovery.md) — Task 1–4 closed 2026-09-26; one recorded residual (Host-side crash-recovery orchestration absent, so the system is fail-closed but not recoverable).
- [Stardew Action Development Platform Convergence](stardew-action-development-platform-convergence.md)
- [Stardew Product Launch Topology Consolidation（active）](stardew-product-launch-topology-consolidation.md) — activation granted 2026-09-27 (`design/reviews/topology-activation-review.md`).
- [Stardew Loop Closure（机制覆盖 + 完整闭环）](stardew-loop-closure-implementation.md) — active; supersedes `stardew-gameplay-loop-closure-implementation.md`; B 层（生产拓扑）blocked-by launch topology。
- [开放玩法发布](open-gameplay-release.md)
- [Chat MVP](chat-mvp.md)
- [Chat run audit 与 release verdict](chat-run-audit-and-release-verdict.md) — active; owner 已裁定取消 operator record，并把语义质量/长程记忆评估降为 audit 测量而非硬门；Task 1–6 实现与文档修正待完成。
- [Chat/Tavern Context Engine 解耦](chat-tavern-context-engine-decoupling.md) — active; decisions frozen, implementation open; Slice 1 contract discovery is not closed.
- [Game session survival 与 reconnect 简化](game-session-survival-and-reconnect-simplification.md) — active, implementation pending; current design adds cross-game Game-session creation/world-binding and unified Resume before Stardew-specific reconnect wiring. First mutation slice still proves GameBuddy-owned Player survival with a disposable process fixture.
- [流式语音网关实施计划](voice-gateway-streaming-submodule.md) — active; 已拆分独立仓库 pi-koe 并完成协议 v2 冻结、下行流式朗读与 Desktop 生产链；整体发布仍 BLOCKED（L5 玩家门禁未执行）。