import { type ExecutionReceipt, type Snapshot } from "./protocol.js";

export type KnowledgeRule = Readonly<{ id: string; integrationId: string; gameVersion: string; capability: string; text: string }>;
export type KnowledgeBundle = Readonly<{ bundleVersion: 1; integrationId: string; gameVersion: string; rules: readonly KnowledgeRule[] }>;
export type KnowledgeDecision = Readonly<{ kind: "supported" | "unknown" | "unavailable"; reasonCode: string; rules: readonly KnowledgeRule[] }>;

/**
 * Version-bound rules are advisory knowledge only. Current world viability and
 * any result remain separate Mod-provided snapshot/receipt facts.
 */
export function decideCapability(bundle: KnowledgeBundle, snapshot: Snapshot, capability: string, gameVersion: string): KnowledgeDecision {
  if (bundle.bundleVersion !== 1 || bundle.integrationId !== "stardew" || bundle.gameVersion !== gameVersion) return { kind: "unknown", reasonCode: "knowledge_bundle_not_applicable", rules: [] };
  if (!snapshot.capabilities.includes(capability)) return { kind: "unavailable", reasonCode: "capability_not_declared", rules: [] };
  const rules = bundle.rules.filter((rule) => rule.integrationId === bundle.integrationId && rule.gameVersion === gameVersion && rule.capability === capability);
  return rules.length === 0 ? { kind: "unknown", reasonCode: "knowledge_not_available", rules: [] } : { kind: "supported", reasonCode: "knowledge_available", rules };
}

/** A presentation state never upgrades accepted/running or a text claim to success. */
export function formatExecutionForPlayer(receipt: ExecutionReceipt | null): string {
  if (receipt === null) return "没有正在进行或已完成的游戏执行记录。";
  switch (receipt.state) {
    case "succeeded": return receipt.evidence === null ? `执行结果尚未证实：${receipt.reasonCode}。` : `执行已完成：${receipt.reasonCode}。`;
    case "accepted": return `已接受执行，尚未完成：${receipt.reasonCode}。`;
    case "running": case "meaningful_progress": return `正在执行：${receipt.reasonCode}。`;
    case "blocked": return `执行受阻：${receipt.reasonCode}。`;
    case "cancelled": return `执行已取消：${receipt.reasonCode}。`;
    case "failed": case "expired": case "invalidated": case "rejected": case "uncertain": case "partially_succeeded": return `执行未成功完成：${receipt.reasonCode}。`;
  }
}
