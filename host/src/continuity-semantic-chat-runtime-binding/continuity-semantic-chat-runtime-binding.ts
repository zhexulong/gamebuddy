/**
 * Chat binding construction accepts only the deployment boundary's immutable
 * manifest snapshot. It never accepts a path or loads deployment state.
 */
export {
  type ChatRuntimeBinding,
  createChatRuntimeBinding,
  type OpaqueChatRuntimeBindingToken,
  type ReservedChatRuntimeMaterialization,
} from "./continuity-semantic-chat-runtime-binding.internal.js";
