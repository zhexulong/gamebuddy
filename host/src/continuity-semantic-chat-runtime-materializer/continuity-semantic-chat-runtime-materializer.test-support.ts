import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  type ChatRuntimeDisposal,
  type ChatRuntimeMaterializer,
  materializeExactChatRuntime,
} from "./continuity-semantic-chat-runtime-materializer.internal.js";


export function createTestChatRuntimeMaterializer(
  factory: (
    input: Readonly<{
      execution: ChatRuntimeBindingExecution;
      permit: ProductionChatRuntimePermit;
    }>,
  ) => Promise<ChatRuntimeDisposal>,
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
