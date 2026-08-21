import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { assertIntegrationModule, DEFAULT_INTEGRATION_ACTION_POLICY, type IntegrationActionPolicy } from "./integration-module.js";
import { type IntegrationConnection } from "./integration-types.js";
import { GameplayTaskSubagent } from "./gameplay-task-subagent.js";
import { actionRegistryRevision } from "./run-manifest.js";
import { createCompanionPresentationTools, type PresentationRuntime } from "./presentation.js";
import { createWorldBookTools, type WorldBookBinding } from "./worldbook.js";
import { createInternalRuntimeCore, resolveRuntimePaths, type CompanionIdentity, type CompanionModelConfig, type RuntimeSession } from "./runtime-core.js";

export const companionStatusTool = createCompanionStatusTool();

export type GameRuntimeSession = RuntimeSession & Readonly<{ gameplaySubagent?: GameplayTaskSubagent }>;
export type CreateGameCompanionRuntimeOptions = Readonly<{
  identity: CompanionIdentity; root?: string; integration?: IntegrationConnection; modelConfig?: CompanionModelConfig;
  actionPolicy?: IntegrationActionPolicy; presentation?: PresentationRuntime; gameplaySubagentEnabled?: boolean;
  surfaceSessionId?: string; worldBook?: WorldBookBinding;
}>;
function gateIntegrationTool(tool: ToolDefinition, connection: IntegrationConnection): ToolDefinition {
  return { ...tool, execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    if (connection.executionGate?.executable === false) throw new Error("integration_not_ready");
    return tool.execute(toolCallId, params, signal, onUpdate, ctx);
  } };
}
export function createCompanionStatusTool(integration?: IntegrationConnection): ToolDefinition {
  return defineTool({ name: "companion_status", label: "Companion Status", description: "Report the local Companion Host and mounted game integration status.", parameters: Type.Object({}), execute: async () => {
    const details = integration === undefined ? undefined : integration.module.status(integration);
    const fullDetails = { host: "ready", integrationId: integration?.scope.integrationId ?? null, connected: details?.connected ?? false, capabilities: details === undefined ? [] : [...details.capabilities], snapshotRevision: details?.snapshotRevision ?? null, latestReceiptState: details?.latestReceiptState ?? null, latestReasonCode: details?.latestReasonCode ?? null } as const;
    return { content: [{ type: "text" as const, text: JSON.stringify(fullDetails) }], details: fullDetails };
  } });
}
/** Creates the Game surface with the existing integration/action/subagent composition. */
export async function createGameCompanionRuntime(options: CreateGameCompanionRuntimeOptions): Promise<GameRuntimeSession> {
  const { integration } = options;
  if (integration !== undefined) { assertIntegrationModule(integration.module, integration.scope.integrationId); integration.module.assertIdentityBinding(integration, options.identity); }
  const module = integration?.module;
  const policy = options.actionPolicy === undefined ? module?.defaultPolicy ?? DEFAULT_INTEGRATION_ACTION_POLICY : module === undefined ? options.actionPolicy : module.parsePolicy(options.actionPolicy);
  const toolSet = integration === undefined ? undefined : module!.createToolSet({ connection: integration, knowledge: integration.knowledge, gameVersion: integration.gameVersion, policy });
  const integrationTools = toolSet === undefined ? [] : [...toolSet.observation, ...toolSet.actions, ...toolSet.knowledge].map((tool) => gateIntegrationTool(tool, integration!));
  const worldBookTools = options.worldBook === undefined ? [] : createWorldBookTools(options.worldBook, integration === undefined ? undefined : module!.worldScope(integration) ?? undefined);
  const presentationTools = options.presentation === undefined ? [] : createCompanionPresentationTools(options.presentation);
  const gameplaySubagent = options.gameplaySubagentEnabled === true ? integration !== undefined && options.modelConfig !== undefined ? new GameplayTaskSubagent(resolveRuntimePaths(options.identity, options.root, options.surfaceSessionId), integration, policy) : (() => { throw new Error("gameplay_subagent_requires_model_and_integration"); })() : undefined;
  const gameplayTools = gameplaySubagent === undefined ? [] : [gateIntegrationTool(gameplaySubagent.createDelegateTool(), integration!)];
  const runtime = await createInternalRuntimeCore({ identity: options.identity, root: options.root, modelConfig: options.modelConfig, surfaceSessionId: options.surfaceSessionId, surface: "game", toolComposition: {
    tools: [createCompanionStatusTool(integration), ...integrationTools, ...worldBookTools, ...presentationTools, ...gameplayTools], actionRegistryRevision: actionRegistryRevision(module?.actionCatalog.entries ?? []), actionPolicy: policy,
    knowledge: module === undefined ? { mounted: false, gameVersion: null, bundleVersion: null } : module.knowledgeMetadata({ connection: integration, knowledge: integration?.knowledge, gameVersion: integration?.gameVersion }), gameplaySubagentModel: gameplaySubagent?.modelConfig ?? null, featureFlags: { gameplaySubagent: gameplaySubagent !== undefined }, worldBook: options.worldBook?.metadata ?? null, presentation: options.presentation?.profile ?? null,
  } });
  return gameplaySubagent === undefined ? runtime : Object.freeze({ ...runtime, gameplaySubagent });
}
