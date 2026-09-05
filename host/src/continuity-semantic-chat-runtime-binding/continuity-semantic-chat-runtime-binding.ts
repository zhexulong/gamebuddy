/**
 * Chat binding construction accepts only the deployment boundary's immutable
 * manifest snapshot. It never accepts a path or loads deployment state.
 */
import { createChatRuntimeBinding } from "./continuity-semantic-chat-runtime-binding.internal.js";

export { createChatRuntimeBinding };
export type { ChatRuntimeBinding } from "./continuity-semantic-chat-runtime-binding.internal.js";
