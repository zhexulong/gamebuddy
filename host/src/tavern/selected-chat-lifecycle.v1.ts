export type ChatLifecycleRoute = Readonly<{
  id: "chat-lifecycle-active-list" | "chat-lifecycle-archive";
  method: "GET" | "POST";
  path: string;
  authentication: "session" | "session-csrf";
}>;

/**
 * Independent lifecycle profile. It deliberately does not extend the legacy
 * title/draft profile: this first production slice can list active rows and
 * archive one non-active, non-Game-origin row only.
 */
export const SELECTED_CHAT_LIFECYCLE_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_chat_lifecycle_v1",
  routes: Object.freeze([
    Object.freeze({
      id: "chat-lifecycle-active-list",
      method: "GET",
      path: "/chat-lifecycle",
      authentication: "session",
    }),
    Object.freeze({
      id: "chat-lifecycle-archive",
      method: "POST",
      path: "/chat-lifecycle/archive",
      authentication: "session-csrf",
    }),
  ] satisfies readonly ChatLifecycleRoute[]),
});

export function chatLifecycleRouteEnabled(routeId: string): boolean {
  return SELECTED_CHAT_LIFECYCLE_V1.routes.some((route) => route.id === routeId);
}

export function selectedChatLifecycleBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly ChatLifecycleRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_CHAT_LIFECYCLE_V1.schemaVersion,
      id: SELECTED_CHAT_LIFECYCLE_V1.id,
    }),
    routes: SELECTED_CHAT_LIFECYCLE_V1.routes,
  });
}
