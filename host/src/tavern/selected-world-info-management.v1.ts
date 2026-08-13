export type WorldInfoManagementRoute = Readonly<{
  id:
    | "managed-world-info-read"
    | "managed-world-info-create"
    | "managed-world-info-update"
    | "managed-world-info-bindings-read"
    | "managed-world-info-attach";
  method: "GET" | "POST" | "PUT";
  path:
    | "/managed-world-info"
    | "/managed-world-info/:publicTitle"
    | "/managed-world-info/bindings"
    | "/managed-world-info/attach";
  authentication: "session" | "session-csrf";
}>;

/** Versioned, public-only World Info management surface. */
export const SELECTED_WORLD_INFO_MANAGEMENT_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_world_info_management_v1",
  routes: Object.freeze([
    Object.freeze({
      id: "managed-world-info-read",
      method: "GET",
      path: "/managed-world-info",
      authentication: "session",
    }),
    Object.freeze({
      id: "managed-world-info-create",
      method: "POST",
      path: "/managed-world-info",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "managed-world-info-update",
      method: "PUT",
      path: "/managed-world-info/:publicTitle",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "managed-world-info-bindings-read",
      method: "GET",
      path: "/managed-world-info/bindings",
      authentication: "session",
    }),
    Object.freeze({
      id: "managed-world-info-attach",
      method: "POST",
      path: "/managed-world-info/attach",
      authentication: "session-csrf",
    }),
  ] satisfies readonly WorldInfoManagementRoute[]),
});

export function worldInfoManagementRouteEnabled(routeId: string): boolean {
  return SELECTED_WORLD_INFO_MANAGEMENT_V1.routes.some((route) => route.id === routeId);
}

export function selectedWorldInfoManagementBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly WorldInfoManagementRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_WORLD_INFO_MANAGEMENT_V1.schemaVersion,
      id: SELECTED_WORLD_INFO_MANAGEMENT_V1.id,
    }),
    routes: SELECTED_WORLD_INFO_MANAGEMENT_V1.routes,
  });
}
