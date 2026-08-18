export type PersonaManagementRoute = Readonly<{
  id: "persona-management-read" | "persona-management-create";
  method: "GET" | "POST";
  path: "/persona-management";
  authentication: "session" | "session-csrf";
}>;

/**
 * Versioned, deliberately narrow Persona-management surface. It projects the
 * existing player-scoped service only; it does not expose artifact identities,
 * editing, scenario, greeting, or World Info controls.
 */
export const SELECTED_PERSONA_MANAGEMENT_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_persona_management_v1",
  routes: Object.freeze([
    Object.freeze({
      id: "persona-management-read",
      method: "GET",
      path: "/persona-management",
      authentication: "session",
    }),
    Object.freeze({
      id: "persona-management-create",
      method: "POST",
      path: "/persona-management",
      authentication: "session-csrf",
    }),
  ] satisfies readonly PersonaManagementRoute[]),
});

export function personaManagementRouteEnabled(routeId: string): boolean {
  return SELECTED_PERSONA_MANAGEMENT_V1.routes.some((route) => route.id === routeId);
}

export function selectedPersonaManagementBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly PersonaManagementRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_PERSONA_MANAGEMENT_V1.schemaVersion,
      id: SELECTED_PERSONA_MANAGEMENT_V1.id,
    }),
    routes: SELECTED_PERSONA_MANAGEMENT_V1.routes,
  });
}
