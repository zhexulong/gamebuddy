import {
  createFreshSemanticProductionAuthorityFromDeploymentManifest,
  createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { ProductionSagaReadback } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { type HostDeploymentManifest, loadHostDeploymentManifest } from "../deployment-manifest.js";
import { createManifestDerivedInitialChatExactContentPort } from "../tavern/initial-chat-exact-content-port.js";

/** No holder, raw authority, store identity, or mutex escapes the Dialogue facade. */
export type UnmountedDialogueSemanticFacade = Readonly<{
  authority: "SEMANTIC";
  initializeInitialChat(): Promise<ProductionSagaReadback>;
  resumeInitialChat(): Promise<ProductionSagaReadback | null>;
  close(): Promise<void>;
}>;
export type UnmountedDialogueInitialChatResumeFacade = Readonly<{
  authority: "SEMANTIC";
  resumeInitialChat(): Promise<ProductionSagaReadback | null>;
  close(): Promise<void>;
}>;

export async function createUnmountedDialogueSemanticFacade(
  input: Readonly<{ manifestPath: string }>,
): Promise<UnmountedDialogueSemanticFacade> {
  const manifest = await onlyManifest(input);
  const semantic = await createFreshSemanticProductionAuthorityFromDeploymentManifest(manifest);
  const content = createManifestDerivedInitialChatExactContentPort(manifest);
  return Object.freeze({
    authority: "SEMANTIC" as const,
    initializeInitialChat: () => semantic.initializeInitialChat(content),
    resumeInitialChat: () => semantic.resumeInitialChatWithContent(content),
    close: once(() => semantic.close()),
  });
}

/**
 * Explicit crash-recovery composition. It performs known-open only; unlike the
 * fresh Dialogue composition it cannot create a new authority or probe/fallback.
 */
export async function createUnmountedDialogueInitialChatResumeFacade(
  input: Readonly<{ manifestPath: string }>,
): Promise<UnmountedDialogueInitialChatResumeFacade> {
  const manifest = await onlyManifest(input);
  const semantic = await createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(manifest);
  const content = createManifestDerivedInitialChatExactContentPort(manifest);
  return Object.freeze({
    authority: "SEMANTIC" as const,
    resumeInitialChat: () => semantic.resumeInitialChatWithContent(content),
    close: once(() => semantic.close()),
  });
}
function once(work: () => Promise<void>) {
  let result: Promise<void> | undefined;
  return () => (result ??= work());
}
async function onlyManifest(value: unknown): Promise<HostDeploymentManifest> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { manifestPath?: unknown }).manifestPath !== "string"
  )
    throw new Error("invalid_deployment_semantic_composition_input");
  return loadHostDeploymentManifest((value as { manifestPath: string }).manifestPath);
}
