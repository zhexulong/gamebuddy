/**
 * Construction-zone Chat runtime materializer. Its only production factory is
 * Host-owned here; no caller can inject a runtime constructor or presentation.
 */

import { createChatRuntimeConstructionInternal } from "../runtime-core.internal.js";
import {
  type ChatRuntimeDisposal,
  type ChatRuntimeMaterializer,
  type MaterializedChatRuntime,
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
        const { runtime, authoredContextCapability: capability, refreshAuthoredContext } = await createChatRuntimeConstructionInternal(execution, permit, options);
        let currentCapability = capability;
        const clearAuthoredContext = async (): Promise<void> => {
          await currentCapability.clear();
        };
        const refresh = async (current: typeof capability): Promise<typeof capability> => {
          if (current !== currentCapability) throw new Error("gamebuddy_authored_context_replacement_rejected");
          const next = await refreshAuthoredContext(current);
          currentCapability = next;
          return next;
        };
        const disposal = Object.freeze({
          session: runtime.session,
          authoredContextCapability: capability,
          clearAuthoredContext,
          ...(runtime.clearTavernNarrativeGateMarker === undefined
            ? {}
            : { clearTavernNarrativeGateMarker: runtime.clearTavernNarrativeGateMarker }),
        });
        return Object.freeze({
          ...disposal,
          runtimeSession: runtime,
          authoredContextCapability: capability,
          refreshAuthoredContext: refresh,
        });
      });
    },
  });
}
