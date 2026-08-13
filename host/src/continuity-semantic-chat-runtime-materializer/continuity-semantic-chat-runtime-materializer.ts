/**
 * Construction-zone Chat runtime materializer. Its only production factory is
 * Host-owned here; no caller can inject a runtime constructor or presentation.
 */
import { createCompanionRuntime, type RuntimeSession } from "../runtime.js";
import { prepareExactChatRuntimeConstruction } from "../continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import {
  materializeAndPublishChatStableContext,
  materializeExactChatRuntime,
  type ChatRuntimeDisposal,
  type ChatRuntimeMaterializer,
  type MaterializedChatRuntime,
} from "./continuity-semantic-chat-runtime-materializer.internal.js";

/** The mounted materialization product remains an internal production-chain type. */
export type { ChatRuntimeDisposal, ChatRuntimeMaterializer };

/**
 * The sole production Chat runtime path. Construction remains Host-owned and
 * the stable source is intentionally published only after Pi supplies its
 * actual session identity.
 */
export function createHostChatRuntimeMaterializer(): ChatRuntimeMaterializer {
  return Object.freeze({
    async materialize(reservation, permit): Promise<MaterializedChatRuntime> {
      return materializeExactChatRuntime(reservation, permit, async (execution) => {
        const { construction, runtime } = await createMaterializedChatRuntime(execution, permit);
        const disposal = await materializeAndPublishChatStableContext(
          runtime,
          runtime.session,
          async () => {
            const piSessionId = runtime.sessionManager.getSessionId();
            if (typeof piSessionId !== "string" || piSessionId.length === 0)
              throw new Error("pi_session_binding_unavailable");
            return construction.materializeStableContextForPiSession(piSessionId);
          },
        );
        return Object.freeze({ ...disposal, runtimeSession: runtime });
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
): Promise<MaterializedChatRuntimeResult> {
  const construction = await prepareExactChatRuntimeConstruction(execution, permit);
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
  );
  return Object.freeze({ construction, runtime });
}
