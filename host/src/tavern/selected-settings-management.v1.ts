export type SettingsManagementRoute = Readonly<{
  id: "settings-profiles" | "game-status";
  method: "GET";
  path: string;
  authentication: "session" | "session-csrf";
}>;

/**
 * Separate versioned management capability profile. This intentionally does
 * not amend selected_l3_v1: only these explicitly declared routes may mount.
 */
export const SELECTED_SETTINGS_MANAGEMENT_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_settings_management_v1",
  routes: Object.freeze([
    Object.freeze({ id: "settings-profiles", method: "GET", path: "/settings/profiles", authentication: "session" }),
    /** Read-only player-safe projection sourced only from Host lifecycle state. */
    Object.freeze({ id: "game-status", method: "GET", path: "/game/status", authentication: "session" }),
  ] satisfies readonly SettingsManagementRoute[]),
});

export function settingsManagementRouteEnabled(routeId: string): boolean {
  return SELECTED_SETTINGS_MANAGEMENT_V1.routes.some((route) => route.id === routeId);
}

/** Safe browser-facing declaration of this separately versioned route profile. */
export function selectedSettingsManagementBootstrapModel(): Readonly<{
  profile: Readonly<{ schemaVersion: number; id: string }>;
  routes: readonly SettingsManagementRoute[];
}> {
  return Object.freeze({
    profile: Object.freeze({
      schemaVersion: SELECTED_SETTINGS_MANAGEMENT_V1.schemaVersion,
      id: SELECTED_SETTINGS_MANAGEMENT_V1.id,
    }),
    routes: SELECTED_SETTINGS_MANAGEMENT_V1.routes,
  });
}
