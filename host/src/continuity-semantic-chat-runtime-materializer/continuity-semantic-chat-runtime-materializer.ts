/**
 * Construction-zone Chat runtime materializer. Its only production factory is
 * Host-owned here; no caller can inject a runtime constructor or presentation.
 */

import { prepareExactChatRuntimeConstruction } from "../continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import { createCompanionRuntime, type RuntimeSession } from "../runtime.js";
import {
  type ChatRuntimeDisposal,
  type ChatRuntimeMaterializer,
  type MaterializedChatRuntime,
  materializeAndPublishChatStableContext,
  materializeExactChatRuntime,
} from "./continuity-semantic-chat-runtime-materializer.internal.js";

/** The mounted materialization product remains an internal production-chain type. */
export type { ChatRuntimeMaterializer };

/**
 * The sole production Chat runtime path. Construction remains Host-owned and
 * the stable source is intentionally published only after Pi supplies its
 * actual session identity.
 */
export type HostChatRuntimeMaterializerOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
}>;

export function createHostChatRuntimeMaterializer(
  options: HostChatRuntimeMaterializerOptions = {},
): ChatRuntimeMaterializer {
  return Object.freeze({
    async materialize(reservation, permit): Promise<MaterializedChatRuntime> {
      return materializeExactChatRuntime(reservation, permit, async (execution) => {
        const { construction, runtime } = await createMaterializedChatRuntime(execution, permit, options);
        const disposal = await materializeAndPublishChatStableContext(runtime, runtime.session, async () => {
          const piSessionId = runtime.sessionManager.getSessionId();
          if (typeof piSessionId !== "string" || piSessionId.length === 0)
            throw new Error("pi_session_binding_unavailable");
          return construction.materializeStableContextForPiSession(piSessionId);
        });
        return Object.freeze({
          ...disposal,
          runtimeSession: runtime,
        });
      });
    },
  });
}

type MaterializedChatRuntimeResult = Readonly<{
  construction: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>>;
  runtime: RuntimeSession;
}>;

/** Private typed positional adapter constrains createCompanionRuntime drift. */
async function createMaterializedChatRuntime(
  execution: Parameters<typeof prepareExactChatRuntimeConstruction>[0],
  permit: Parameters<typeof prepareExactChatRuntimeConstruction>[1],
  options: HostChatRuntimeMaterializerOptions,
): Promise<MaterializedChatRuntimeResult> {
  const construction = await prepareExactChatRuntimeConstruction(execution, permit, options);
  const runtime = await createCompanionRuntime(
    construction.identity,
    construction.runtimeRoot,
    undefined,
    construction.modelConfig,
    undefined,
    construction.presentation,
    false,
    undefined,
    construction.surfaceSessionId,
    undefined,
    "chat",
    undefined,
    undefined,
    construction.tavernNarrativeGateNonceSha256,
  );
  return Object.freeze({ construction, runtime });
}
