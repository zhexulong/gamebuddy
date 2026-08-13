import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  materializeAndPublishChatStableContext,
  materializeExactChatRuntime,
  type ChatRuntimeDisposal,
  type ChatRuntimeMaterializer,
  type ChatRuntimeStableContextLifecycle,
} from "./continuity-semantic-chat-runtime-materializer.internal.js";

/** Test-build-only runtime factory. Production has no caller-injectable factory seam. */
export type TestChatStableContextRuntime = ChatRuntimeDisposal & ChatRuntimeStableContextLifecycle;

/** Complete test-only path for publication/reverse-disposal behavior. */
export function createTestChatStableContextMaterializer(
  factory: (input: Readonly<{
    execution: ChatRuntimeBindingExecution;
    permit: ProductionChatRuntimePermit;
  }>) => Promise<Readonly<{
    runtime: TestChatStableContextRuntime;
    materializeStableContext: () => Promise<unknown>;
  }>>,
): ChatRuntimeMaterializer {
  if (typeof factory !== "function") throw new Error("invalid_chat_runtime_materializer_factory");
  return Object.freeze({
    materialize(reservation, permit) {
      return materializeExactChatRuntime(reservation, permit, async (execution) => {
        const prepared = await factory(Object.freeze({ execution, permit }));
        return materializeAndPublishChatStableContext(
          prepared.runtime,
          prepared.runtime.session,
          prepared.materializeStableContext,
        );
      });
    },
  });
}

export function createTestChatRuntimeMaterializer(
  factory: (input: Readonly<{
    execution: ChatRuntimeBindingExecution;
    permit: ProductionChatRuntimePermit;
  }>) => Promise<ChatRuntimeDisposal>,
): ChatRuntimeMaterializer {
  if (typeof factory !== "function") throw new Error("invalid_chat_runtime_materializer_factory");
  return Object.freeze({
    materialize(reservation, permit) {
      return materializeExactChatRuntime(reservation, permit, (execution) =>
        factory(Object.freeze({ execution, permit })),
      );
    },
  });
}
