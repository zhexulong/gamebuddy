import { readFile } from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ActionPolicy, visibleActionsFromModCatalog } from "./action-registry.js";
import type { CompanionIntegration } from "./integration-types.js";
import type { ActionRegistration, ExecutionReceipt, Snapshot } from "./protocol.js";

export type KnowledgeRule = Readonly<{
  id: string;
  integrationId: string;
  gameVersion: string;
  capability: string;
  text: string;
  topicId?: string;
  actionId?: string;
  targetKind?: string;
  location?: string;
  kind?: "rule" | "procedure" | "precondition" | "failure_recovery" | "postcondition" | "constraint" | "live_fact";
  applicability?: string;
  evidenceType?: "verified_probe" | "target_assembly" | "maintainer_note";
  provenance?: string;
  nextObservations?: readonly string[];
  actionContractHash?: string;
}>;
export type KnowledgeBundle = Readonly<{
  bundleVersion: 1;
  integrationId: string;
  gameVersion: string;
  rules: readonly KnowledgeRule[];
}>;
export type KnowledgeQuery = Readonly<{
  capability?: string;
  topicId?: string;
  actionId?: string;
  targetKind?: string;
  location?: string;
  query?: string;
}>;
export type KnowledgeDecision = Readonly<{
  kind: "supported" | "unknown" | "unavailable";
  reasonCode: string;
  rules: readonly KnowledgeRule[];
}>;
export type KnowledgeToolDetails = Readonly<
  KnowledgeDecision & {
    snapshotRevision: number | null;
    liveCapability: boolean;
    query: KnowledgeQuery;
    nextObservations: readonly string[];
  }
>;
export type KnowledgeCatalogDetails = Readonly<{
  gameVersion: string | null;
  topics: readonly Readonly<{
    topicId: string;
    actionIds: readonly string[];
    targetKinds: readonly string[];
    locations: readonly string[];
  }>[];
}>;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Parse a Host-owned knowledge file without allowing it to become authority. */
export function parseKnowledgeBundle(value: unknown, expectedGameVersion?: string): KnowledgeBundle {
  if (
    !isRecord(value) ||
    value.bundleVersion !== 1 ||
    value.integrationId !== "stardew" ||
    typeof value.gameVersion !== "string" ||
    !VERSION_ID.test(value.gameVersion)
  ) {
    throw new Error("invalid_knowledge_bundle");
  }
  const gameVersion = value.gameVersion;
  if (expectedGameVersion !== undefined && gameVersion !== expectedGameVersion)
    throw new Error("knowledge_game_version_mismatch");
  if (!Array.isArray(value.rules) || value.rules.length > 256) throw new Error("invalid_knowledge_rules");
  const rules = value.rules.map((valueRule) => {
    if (!isRecord(valueRule)) throw new Error("invalid_knowledge_rule");
    const rule = valueRule;
    if (
      typeof rule.id !== "string" ||
      !OPAQUE_ID.test(rule.id) ||
      rule.integrationId !== "stardew" ||
      rule.gameVersion !== gameVersion ||
      typeof rule.capability !== "string" ||
      !OPAQUE_ID.test(rule.capability) ||
      typeof rule.text !== "string" ||
      rule.text.length === 0 ||
      rule.text.length > 4_096 ||
      !optionalOpaque(rule.topicId) ||
      !optionalOpaque(rule.actionId) ||
      !optionalOpaque(rule.targetKind) ||
      !optionalLocation(rule.location) ||
      !optionalRuleKind(rule.kind) ||
      !optionalBoundedText(rule.applicability, 512) ||
      !optionalEvidenceType(rule.evidenceType) ||
      !optionalBoundedText(rule.provenance, 512) ||
      !optionalStringArray(rule.nextObservations, 8, 256) ||
      !optionalHash(rule.actionContractHash)
    ) {
      throw new Error("invalid_knowledge_rule");
    }
    const topicId = typeof rule.topicId === "string" ? rule.topicId : undefined;
    const actionId = typeof rule.actionId === "string" ? rule.actionId : undefined;
    const targetKind = typeof rule.targetKind === "string" ? rule.targetKind : undefined;
    const location = typeof rule.location === "string" ? rule.location : undefined;
    const kind = typeof rule.kind === "string" ? (rule.kind as KnowledgeRule["kind"]) : undefined;
    const applicability = typeof rule.applicability === "string" ? rule.applicability : undefined;
    const evidenceType =
      typeof rule.evidenceType === "string" ? (rule.evidenceType as KnowledgeRule["evidenceType"]) : undefined;
    const provenance = typeof rule.provenance === "string" ? rule.provenance : undefined;
    const nextObservations = Array.isArray(rule.nextObservations) ? (rule.nextObservations as string[]) : undefined;
    const actionContractHash = typeof rule.actionContractHash === "string" ? rule.actionContractHash : undefined;
    return Object.freeze({
      id: rule.id,
      integrationId: "stardew" as const,
      gameVersion,
      capability: rule.capability,
      text: rule.text,
      ...(topicId === undefined ? {} : { topicId }),
      ...(actionId === undefined ? {} : { actionId }),
      ...(targetKind === undefined ? {} : { targetKind }),
      ...(location === undefined ? {} : { location }),
      ...(kind === undefined ? {} : { kind }),
      ...(applicability === undefined ? {} : { applicability }),
      ...(evidenceType === undefined ? {} : { evidenceType }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(nextObservations === undefined ? {} : { nextObservations: Object.freeze([...nextObservations]) }),
      ...(actionContractHash === undefined ? {} : { actionContractHash }),
    });
  });
  const ids = new Set<string>();
  for (const rule of rules)
    if (ids.has(rule.id)) throw new Error("duplicate_knowledge_rule");
    else ids.add(rule.id);
  return Object.freeze({
    bundleVersion: 1 as const,
    integrationId: "stardew" as const,
    gameVersion,
    rules: Object.freeze(rules),
  });
}

export async function loadKnowledgeBundle(path: string, expectedGameVersion?: string): Promise<KnowledgeBundle> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_bundle_read_failed");
  }
  return parseKnowledgeBundle(value, expectedGameVersion);
}

function optionalOpaque(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && OPAQUE_ID.test(value));
}
function optionalLocation(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128);
}
function optionalBoundedText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= max);
}
function optionalRuleKind(value: unknown): boolean {
  return (
    value === undefined ||
    value === "rule" ||
    value === "procedure" ||
    value === "precondition" ||
    value === "failure_recovery" ||
    value === "postcondition" ||
    value === "constraint" ||
    value === "live_fact"
  );
}
function optionalEvidenceType(value: unknown): boolean {
  return (
    value === undefined || value === "verified_probe" || value === "target_assembly" || value === "maintainer_note"
  );
}
function optionalStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= maxItems &&
      value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength))
  );
}
function optionalHash(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Version-bound rules are advisory knowledge only. Current world viability and
 * any result remain separate Mod-provided snapshot/receipt facts.
 */
export function decideCapability(
  bundle: KnowledgeBundle,
  snapshot: Snapshot,
  capability: string,
  gameVersion: string,
  registrations: readonly ActionRegistration[] = [],
): KnowledgeDecision {
  return decideKnowledge(bundle, snapshot, { capability }, gameVersion, undefined, registrations);
}

export function decideKnowledge(
  bundle: KnowledgeBundle,
  snapshot: Snapshot,
  query: KnowledgeQuery,
  gameVersion: string,
  policy: ActionPolicy = { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
  registrations: readonly ActionRegistration[] = [],
): KnowledgeDecision {
  if (bundle.bundleVersion !== 1 || bundle.integrationId !== "stardew" || bundle.gameVersion !== gameVersion)
    return { kind: "unknown", reasonCode: "knowledge_bundle_not_applicable", rules: [] };
  const visibleActions = visibleActionsFromModCatalog(registrations, snapshot.capabilities, policy);
  const visibleActionIds = new Set(visibleActions.map((entry) => entry.actionId));
  if (query.capability !== undefined && !snapshot.capabilities.includes(query.capability))
    return { kind: "unavailable", reasonCode: "capability_not_declared", rules: [] };
  if (query.actionId !== undefined && !visibleActionIds.has(query.actionId))
    return { kind: "unavailable", reasonCode: "action_not_available", rules: [] };
  const normalized = query.query?.trim().toLocaleLowerCase();
  const rules = bundle.rules.filter(
    (rule) =>
      rule.integrationId === bundle.integrationId &&
      rule.gameVersion === gameVersion &&
      visibleActionIds.has(rule.actionId ?? rule.capability) &&
      (query.capability === undefined || rule.capability === query.capability) &&
      (query.topicId === undefined || rule.topicId === query.topicId) &&
      (query.actionId === undefined || rule.actionId === query.actionId) &&
      (query.targetKind === undefined || rule.targetKind === query.targetKind) &&
      (query.location === undefined || rule.location === undefined || rule.location === query.location) &&
      (normalized === undefined ||
        normalized.length === 0 ||
        `${rule.text} ${rule.applicability ?? ""} ${rule.provenance ?? ""}`.toLocaleLowerCase().includes(normalized)),
  );
  if (rules.length === 0) return { kind: "unknown", reasonCode: "knowledge_not_available", rules: [] };
  const sorted = [...rules].sort(
    (left, right) => scoreKnowledgeRule(right, query, snapshot) - scoreKnowledgeRule(left, query, snapshot),
  );
  return { kind: "supported", reasonCode: "knowledge_available", rules: sorted };
}

function scoreKnowledgeRule(rule: KnowledgeRule, query: KnowledgeQuery, snapshot: Snapshot): number {
  let score = rule.evidenceType === "verified_probe" ? 30 : rule.evidenceType === "target_assembly" ? 20 : 10;
  if (rule.actionId !== undefined && rule.actionId === query.actionId) score += 12;
  if (rule.targetKind !== undefined && rule.targetKind === query.targetKind) score += 8;
  if (rule.location === snapshot.location) score += 6;
  return score;
}

export function knowledgeCatalog(
  bundle: KnowledgeBundle | undefined,
  gameVersion: string | undefined,
  snapshot: Snapshot | null,
  policy: ActionPolicy = { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
  registrations: readonly ActionRegistration[] = [],
): KnowledgeCatalogDetails {
  if (bundle === undefined || gameVersion === undefined || snapshot === null || bundle.gameVersion !== gameVersion)
    return { gameVersion: gameVersion ?? null, topics: [] };
  const topics = new Map<string, { actionIds: Set<string>; targetKinds: Set<string>; locations: Set<string> }>();
  const visibleActionIds = new Set(
    visibleActionsFromModCatalog(registrations, snapshot.capabilities, policy).map((entry) => entry.actionId),
  );
  for (const rule of bundle.rules) {
    if (rule.topicId === undefined || !visibleActionIds.has(rule.actionId ?? rule.capability)) continue;
    const topic = topics.get(rule.topicId) ?? { actionIds: new Set(), targetKinds: new Set(), locations: new Set() };
    if (rule.actionId !== undefined) topic.actionIds.add(rule.actionId);
    if (rule.targetKind !== undefined) topic.targetKinds.add(rule.targetKind);
    if (rule.location !== undefined) topic.locations.add(rule.location);
    topics.set(rule.topicId, topic);
  }
  return {
    gameVersion,
    topics: [...topics.entries()].map(([topicId, values]) => ({
      topicId,
      actionIds: [...values.actionIds].sort(),
      targetKinds: [...values.targetKinds].sort(),
      locations: [...values.locations].sort(),
    })),
  };
}

/**
 * Mount version-bound advisory rules without creating game authority.
 * The Agent supplies only a capability name; Host-owned version and live
 * Mod snapshot facts decide whether the rules are applicable.
 */
export function createStardewKnowledgeTools(
  integration: CompanionIntegration,
  policy: ActionPolicy = { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
) {
  const result = (details: KnowledgeToolDetails) => ({
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  });
  const knowledge = defineTool({
    name: "stardew_game_knowledge",
    label: "Stardew Gameplay Knowledge",
    description:
      "Read version-bound, context-aware Stardew guidance. Live Mod capability and snapshot facts remain authoritative.",
    parameters: Type.Object({
      capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      topicId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      targetKind: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      location: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
    execute: async (_toolCallId, params) => {
      const snapshot = integration.state.snapshot;
      const gameVersion = integration.gameVersion;
      const query: KnowledgeQuery = params;
      if (!integration.state.connected || snapshot === null)
        return result({
          kind: "unknown",
          reasonCode: "integration_not_ready",
          rules: [],
          snapshotRevision: null,
          liveCapability: false,
          query,
          nextObservations: [],
        });
      if (integration.knowledge === undefined || gameVersion === undefined)
        return result({
          kind: "unknown",
          reasonCode: "knowledge_not_mounted",
          rules: [],
          snapshotRevision: snapshot.revision,
          liveCapability: query.capability === undefined || snapshot.capabilities.includes(query.capability),
          query,
          nextObservations: [],
        });
      const decision = decideKnowledge(
        integration.knowledge,
        snapshot,
        query,
        gameVersion,
        policy,
        integration.state.catalogRegistrations ?? [],
      );
      return result({
        ...decision,
        snapshotRevision: snapshot.revision,
        liveCapability: query.capability === undefined || snapshot.capabilities.includes(query.capability),
        query,
        nextObservations: [...new Set(decision.rules.flatMap((rule) => rule.nextObservations ?? []))].slice(0, 8),
      });
    },
  });
  const catalog = defineTool({
    name: "stardew_knowledge_catalog",
    label: "Stardew Knowledge Catalog",
    description: "List applicable knowledge topics and filters. It never exposes unavailable capability authority.",
    parameters: Type.Object({}),
    execute: async () => {
      const details = knowledgeCatalog(
        integration.knowledge,
        integration.gameVersion,
        integration.state.snapshot,
        policy,
        integration.state.catalogRegistrations ?? [],
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
  return [catalog, knowledge] as const;
}

export function createStardewKnowledgeTool(integration: CompanionIntegration, policy?: ActionPolicy) {
  return createStardewKnowledgeTools(integration, policy)[1];
}

/** A presentation state never upgrades accepted/running or a text claim to success. */
export function formatExecutionForPlayer(receipt: ExecutionReceipt | null): string {
  if (receipt === null) return "没有正在进行或已完成的游戏执行记录。";
  switch (receipt.state) {
    case "succeeded":
      return receipt.evidence === null
        ? `执行结果尚未证实：${receipt.reasonCode}。`
        : `执行已完成：${receipt.reasonCode}。`;
    case "accepted":
      return `已接受执行，尚未完成：${receipt.reasonCode}。`;
    case "running":
    case "meaningful_progress":
      return `正在执行：${receipt.reasonCode}。`;
    case "blocked":
      return `执行受阻：${receipt.reasonCode}。`;
    case "cancelled":
      return `执行已取消：${receipt.reasonCode}。`;
    case "failed":
    case "expired":
    case "invalidated":
    case "rejected":
    case "uncertain":
    case "partially_succeeded":
      return `执行未成功完成：${receipt.reasonCode}。`;
  }
}
