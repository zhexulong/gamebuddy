import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createCompanionPresentationTools, type PresentationRuntime } from "./presentation.js";
import { createInternalRuntimeCore, type CompanionIdentity, type CompanionModelConfig, type RuntimeSession } from "./runtime-core.js";
import { createWorldBookTools, type WorldBookBinding } from "./worldbook.js";
import type { IdentityProfile } from "./identity-profile.js";

/** Baseline Chat-owned tools used by the Phase 0B isolation contract. */
export const CHAT_PHASE_0B_ALLOWED_TOOL_NAMES = Object.freeze(["companion_status"]);

export type CreateChatCompanionRuntimeOptions = Readonly<{
  identity: CompanionIdentity;
  root?: string;
  modelConfig?: CompanionModelConfig;
  presentation?: PresentationRuntime;
  initialProfile?: IdentityProfile;
  surfaceSessionId?: string;
  worldBook?: WorldBookBinding;
  internalMagicContextFeatureTestOverride?: Readonly<{
    memoryEnabled?: boolean;
    historianEnabled?: boolean;
    historianExecuteThresholdTokens?: number;
    historianExecuteThresholdPercentage?: number;
  }>;
}>;

/** Creates the Chat surface with only Chat-owned presentation and World Book tools. */
export async function createChatCompanionRuntime(options: CreateChatCompanionRuntimeOptions): Promise<RuntimeSession> {
  const status = defineTool({
    name: "companion_status", label: "Companion Status", description: "Report local Companion Host status.", parameters: Type.Object({}),
    execute: async () => {
      const details = { host: "ready", integrationId: null, connected: false, capabilities: [], snapshotRevision: null, latestReceiptState: null, latestReasonCode: null } as const;
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
  const worldBookTools = options.worldBook === undefined ? [] : createWorldBookTools(options.worldBook);
  const presentationTools = options.presentation === undefined ? [] : createCompanionPresentationTools(options.presentation);
  return createInternalRuntimeCore({
    identity: options.identity, root: options.root, modelConfig: options.modelConfig, initialProfile: options.initialProfile,
    surfaceSessionId: options.surfaceSessionId, surface: "chat", internalMagicContextFeatureTestOverride: options.internalMagicContextFeatureTestOverride,
    toolComposition: {
      tools: [status, ...worldBookTools, ...presentationTools], actionRegistryRevision: "offline", actionPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
      knowledge: { mounted: false, gameVersion: null, bundleVersion: null }, gameplaySubagentModel: null,
      worldBook: options.worldBook?.metadata ?? null, presentation: options.presentation?.profile ?? null,
    },
  });
}
