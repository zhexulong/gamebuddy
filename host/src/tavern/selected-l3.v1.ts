export type SelectedL3Route = Readonly<{
  id: string;
  method: "GET" | "POST";
  path: string;
  flow: string;
  authentication: "none" | "session" | "session-csrf";
}>;

export type SelectedL3NavigationItem = Readonly<{
  id: string;
  flow: string;
  routeId: string;
}>;

/**
 * The versioned, runtime-facing capability authority for the selected Tavern
 * L3 release. Routes absent from this profile must not be mounted by Host.
 * `path` is descriptive for parameterized routes; the server owns their
 * strict parser and authentication enforcement.
 */
export const SELECTED_L3_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_l3_v1",
  must: Object.freeze([
    "companion-library",
    "manage-chats",
    "new-companion",
    "new-chat",
    "persona-scenario-greeting-selection",
    "effect-aware-causal-guard",
    "worldbook-catalog-binding",
    "character-worldbook-chat-import-export",
    "authenticated-reconnect",
    "memory-management",
  ]),
  later: Object.freeze([
    "response-regenerate-swipe-edit",
    "branch-checkpoint",
    "worldbook-full-editor",
    "background-sprite",
    "visual-novel-layout",
  ]),
  unsupported: Object.freeze([
    "group-chat",
    "multi-buddy-runtime",
    "talkativeness",
    "prompt-manager",
    "preset-workbench",
    "extensions",
    "scripts",
    "macros",
    "regex",
    "html-runtime",
  ]),
  flows: Object.freeze([
    "dialogue-session",
    "authenticated-reconnect",
    "companion-library",
    "manage-chats",
    "new-companion",
    "new-chat",
    "worldbook-catalog-binding",
    "character-worldbook-chat-import-export",
    "effect-aware-causal-guard",
    "memory-management",
  ]),
  navigation: Object.freeze([
    Object.freeze({ id: "library", flow: "companion-library", routeId: "library" }),
    Object.freeze({ id: "manage-chats", flow: "manage-chats", routeId: "manage-chats" }),
    Object.freeze({ id: "new-companion", flow: "new-companion", routeId: "new-companion" }),
    Object.freeze({ id: "new-chat", flow: "new-chat", routeId: "new-chat-selections" }),
    Object.freeze({ id: "worldbook", flow: "worldbook-catalog-binding", routeId: "worldbook-read" }),
    Object.freeze({ id: "imports", flow: "character-worldbook-chat-import-export", routeId: "imports" }),
  ] satisfies readonly SelectedL3NavigationItem[]),
  routes: Object.freeze([
    Object.freeze({
      id: "bootstrap",
      method: "POST",
      path: "/bootstrap",
      flow: "dialogue-session",
      authentication: "none",
    }),
    Object.freeze({
      id: "refresh",
      method: "GET",
      path: "/refresh",
      flow: "authenticated-reconnect",
      authentication: "session",
    }),
    Object.freeze({
      id: "memories-read",
      method: "GET",
      path: "/memories",
      flow: "memory-management",
      authentication: "session",
    }),
    Object.freeze({
      id: "memories-create",
      method: "POST",
      path: "/memories",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-update",
      method: "POST",
      path: "/memories/update",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-archive",
      method: "POST",
      path: "/memories/archive",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-restore",
      method: "POST",
      path: "/memories/restore",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-pin",
      method: "POST",
      path: "/memories/pin",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-unpin",
      method: "POST",
      path: "/memories/unpin",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-merge",
      method: "POST",
      path: "/memories/merge",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-delete-entry",
      method: "POST",
      path: "/memories/delete-entry",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "memories-exclude-source",
      method: "POST",
      path: "/memories/exclude-source",
      flow: "memory-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "events",
      method: "GET",
      path: "/events",
      flow: "dialogue-session",
      authentication: "session",
    }),
    Object.freeze({
      id: "message",
      method: "POST",
      path: "/message",
      flow: "dialogue-session",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "stop",
      method: "POST",
      path: "/stop",
      flow: "dialogue-session",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "static",
      method: "GET",
      path: "/<static-asset>",
      flow: "dialogue-session",
      authentication: "none",
    }),
    Object.freeze({
      id: "library",
      method: "GET",
      path: "/library",
      flow: "companion-library",
      authentication: "session",
    }),
    Object.freeze({
      id: "manage-chats",
      method: "GET",
      path: "/manage-chats",
      flow: "manage-chats",
      authentication: "session",
    }),
    Object.freeze({
      id: "open-chat",
      method: "POST",
      path: "/open-chat",
      flow: "manage-chats",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "new-companion-read",
      method: "GET",
      path: "/new-companion",
      flow: "new-companion",
      authentication: "session",
    }),
    Object.freeze({
      id: "new-companion",
      method: "POST",
      path: "/new-companion",
      flow: "new-companion",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "new-chat-selections",
      method: "GET",
      path: "/new-chat/selections",
      flow: "new-chat",
      authentication: "session",
    }),
    Object.freeze({
      id: "new-chat",
      method: "POST",
      path: "/new-chat",
      flow: "new-chat",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "worldbook-read",
      method: "GET",
      path: "/worldbook",
      flow: "worldbook-catalog-binding",
      authentication: "session",
    }),
    Object.freeze({
      id: "worldbook-bind",
      method: "POST",
      path: "/worldbook",
      flow: "worldbook-catalog-binding",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "imports",
      method: "POST",
      path: "/imports",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "import-review-read",
      method: "GET",
      path: "/imports/:importId/review",
      flow: "character-worldbook-chat-import-export",
      authentication: "session",
    }),
    Object.freeze({
      id: "import-review",
      method: "POST",
      path: "/imports/:importId/review",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "import-confirm-new-companion",
      method: "POST",
      path: "/imports/:importId/confirm-new-companion",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "import-export",
      method: "GET",
      path: "/imports/:importId/export",
      flow: "character-worldbook-chat-import-export",
      authentication: "session",
    }),
    Object.freeze({
      id: "interchange-import",
      method: "POST",
      path: "/interchange/import",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "interchange-chat-export",
      method: "POST",
      path: "/interchange/chat/export",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "interchange-worldbook-export",
      method: "POST",
      path: "/interchange/worldbook/export",
      flow: "character-worldbook-chat-import-export",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "retry-response",
      method: "POST",
      path: "/retry-response",
      flow: "effect-aware-causal-guard",
      authentication: "session-csrf",
    }),
  ] satisfies readonly SelectedL3Route[]),
});

export type SelectedL3RouteId = (typeof SELECTED_L3_V1.routes)[number]["id"];

export function selectedL3RouteEnabled(routeId: string): boolean {
  return SELECTED_L3_V1.routes.some((route) => route.id === routeId && SELECTED_L3_V1.flows.includes(route.flow));
}

export function selectedL3BootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  navigation: readonly SelectedL3NavigationItem[];
  flows: readonly string[];
}> {
  return Object.freeze({
    profile: Object.freeze({ schemaVersion: SELECTED_L3_V1.schemaVersion, id: SELECTED_L3_V1.id }),
    flows: SELECTED_L3_V1.flows,
    navigation: SELECTED_L3_V1.navigation,
  });
}
