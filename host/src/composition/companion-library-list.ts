/**
 * Companion library list assembly for the one management surface.
 *
 * The mounted companion is always also present in the library artifact store,
 * so the list must splice it in exactly once: the always-current entry is
 * prepended, and the remaining library entries carry the current one filtered
 * out by its own `companionId`. Without that filter the current companion
 * renders twice with the same handle and name.
 *
 * When the mounted identity profile is unreadable there is nothing to prepend
 * (a defense-in-depth path, never the normal one), so the library copy is kept
 * rather than dropped: the companion must never vanish from the list.
 */
export type CompanionListEntry = Readonly<{ handle: string; name: string; isCurrent: boolean }>;

export function mergeMountedCompanionList(
  companions: readonly Readonly<{ companionId: string; name: string }>[],
  currentCompanionId: string,
  mountedName: string | undefined,
  handleFor: (companionId: string) => string,
): readonly CompanionListEntry[] {
  const mounted =
    mountedName === undefined
      ? undefined
      : Object.freeze({ handle: handleFor(currentCompanionId), name: mountedName, isCurrent: true });
  const libraryEntries = companions
    .filter((companion) => mounted === undefined || companion.companionId !== currentCompanionId)
    .map((companion) =>
      Object.freeze({
        handle: handleFor(companion.companionId),
        name: companion.name,
        isCurrent: companion.companionId === currentCompanionId,
      }),
    );
  return mounted === undefined ? Object.freeze(libraryEntries) : Object.freeze([mounted, ...libraryEntries]);
}
