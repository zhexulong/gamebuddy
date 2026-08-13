export type ContentManagementRoute = Readonly<{
  id:
    | "scenario-management-read"
    | "scenario-management-create"
    | "greeting-management-read"
    | "greeting-management-create";
  method: "GET" | "POST";
  path: "/scenario-management" | "/greeting-management";
  authentication: "session" | "session-csrf";
}>;

/**
 * Versioned safe surface for authored Scenario and Greeting Set records.
 * It intentionally contains only list/readback and one-time creation; edit,
 * delete, World Info, connection, and artifact internals are not capabilities.
 */
export const SELECTED_CONTENT_MANAGEMENT_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_content_management_v1",
  routes: Object.freeze([
    Object.freeze({
      id: "scenario-management-read",
      method: "GET",
      path: "/scenario-management",
      authentication: "session",
    }),
    Object.freeze({
      id: "scenario-management-create",
      method: "POST",
      path: "/scenario-management",
      authentication: "session-csrf",
    }),
    Object.freeze({
      id: "greeting-management-read",
      method: "GET",
      path: "/greeting-management",
      authentication: "session",
    }),
    Object.freeze({
      id: "greeting-management-create",
      method: "POST",
      path: "/greeting-management",
      authentication: "session-csrf",
    }),
  ] satisfies readonly ContentManagementRoute[]),
});

export function contentManagementRouteEnabled(routeId: string): boolean {
  return SELECTED_CONTENT_MANAGEMENT_V1.routes.some((route) => route.id === routeId);
}

export function selectedContentManagementBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly ContentManagementRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_CONTENT_MANAGEMENT_V1.schemaVersion,
      id: SELECTED_CONTENT_MANAGEMENT_V1.id,
    }),
    routes: SELECTED_CONTENT_MANAGEMENT_V1.routes,
  });
}
