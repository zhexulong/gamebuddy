export type CharacterDetailRoute = Readonly<{
  id: "character-detail-read";
  method: "GET";
  path: "/library/:handle";
  authentication: "session";
}>;

/**
 * Versioned browser projection for the existing read-only companion-detail
 * domain. The path parameter is an ephemeral Host-session handle, never a
 * companion or continuity identifier.
 */
export const SELECTED_CHARACTER_DETAIL_V1 = Object.freeze({
  schemaVersion: 1,
  id: "selected_character_detail_v1",
  routes: Object.freeze([
    Object.freeze({ id: "character-detail-read", method: "GET", path: "/library/:handle", authentication: "session" }),
  ] satisfies readonly CharacterDetailRoute[]),
});

export function characterDetailRouteEnabled(routeId: string): boolean {
  return SELECTED_CHARACTER_DETAIL_V1.routes.some((route) => route.id === routeId);
}
