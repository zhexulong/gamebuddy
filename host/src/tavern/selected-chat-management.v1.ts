export type ChatManagementRoute = Readonly<{
  id: "chat-management-read" | "chat-management-rename" | "chat-draft-read" | "chat-draft-save" | "chat-draft-discard";
  method: "GET" | "PUT" | "DELETE";
  path: string;
  authentication: "session" | "session-csrf";
}>;

/**
 * Narrow, versioned player-facing Chat management surface. It intentionally
 * exposes only title metadata; lifecycle operations stay outside this slice.
 */
export const SELECTED_CHAT_MANAGEMENT_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_chat_management_v1",
  routes: Object.freeze([
    Object.freeze({ id: "chat-management-read", method: "GET", path: "/chat-management", authentication: "session" }),
    Object.freeze({
      id: "chat-management-rename",
      method: "PUT",
      path: "/chat-management/title",
      authentication: "session-csrf",
    }),
    Object.freeze({ id: "chat-draft-read", method: "GET", path: "/chat-draft", authentication: "session" }),
    Object.freeze({ id: "chat-draft-save", method: "PUT", path: "/chat-draft", authentication: "session-csrf" }),
    Object.freeze({ id: "chat-draft-discard", method: "DELETE", path: "/chat-draft", authentication: "session-csrf" }),
  ] satisfies readonly ChatManagementRoute[]),
});

export function chatManagementRouteEnabled(routeId: string): boolean {
  return SELECTED_CHAT_MANAGEMENT_V1.routes.some((route) => route.id === routeId);
}

export function selectedChatManagementBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly ChatManagementRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_CHAT_MANAGEMENT_V1.schemaVersion,
      id: SELECTED_CHAT_MANAGEMENT_V1.id,
    }),
    routes: SELECTED_CHAT_MANAGEMENT_V1.routes,
  });
}
