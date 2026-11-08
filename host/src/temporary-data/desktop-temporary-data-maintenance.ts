import {
  type TemporaryDataClearPort,
  type TemporaryDataClearProbe,
  type TemporaryDataRootId,
  type TemporaryDataRootLayout,
  clearTemporaryData,
  inspectTemporaryData,
} from "./temporary-data-clear.js";

/**
 * The Host's own temporary-data maintenance handle: the one object the browser
 * surface can ask, over the management wire, without ever naming a path.
 *
 * `presentationServing` is the writer fact the clear needs and cannot read for
 * itself. The presentation admission is the component that owns the
 * presentation root, and it serves the browser for the whole Host lifetime, so
 * while it is serving, that root has an open writer and a clear of it is
 * refused by name. That makes the refusal reachable - a player who clears from
 * a live surface is told which root is busy - instead of a gate that can never
 * fire.
 */
export type TemporaryDataMaintenance = TemporaryDataClearPort &
  Readonly<{
    presentationServing(serving: boolean): void;
  }>;

/**
 * One identity reading per root, taken when the launch admitted them.
 *
 * The re-verification is a re-read of the same objects, not a second spelling
 * of the layout: a root that is now a different object - swapped, recreated, or
 * turned into a reparse point between admission and the clear - fails
 * `rootIdentityVerified`, and the clear refuses.
 */
export type TemporaryDataRootIdentity = Readonly<{ volumeIdentity: string; fileId: string; isReparsePoint: boolean }>;

export type TemporaryDataRootIdentityReader = (directory: string) => Promise<TemporaryDataRootIdentity>;

export async function createDesktopTemporaryDataMaintenance(
  layout: TemporaryDataRootLayout,
  readIdentity: TemporaryDataRootIdentityReader,
): Promise<TemporaryDataMaintenance> {
  const admitted = new Map<string, TemporaryDataRootIdentity>();
  // The two roots a clear can reach, plus the program root it only ever reads
  // to decide whether the updater is staging. The durable root is deliberately
  // not read here: nothing in this operation may name it.
  for (const directory of [layout.operationalRoot, layout.presentationRoot]) {
    admitted.set(directory, await readIdentity(directory));
  }
  let serving = false;
  const probe: TemporaryDataClearProbe = Object.freeze({
    openWriterRootIds: (): readonly TemporaryDataRootId[] => (serving ? ["presentation"] : []),
    rootIdentityVerified: async (): Promise<boolean> => {
      for (const [directory, identity] of admitted) {
        let current: TemporaryDataRootIdentity;
        try {
          current = await readIdentity(directory);
        } catch {
          return false;
        }
        if (
          current.volumeIdentity !== identity.volumeIdentity ||
          current.fileId !== identity.fileId ||
          current.isReparsePoint ||
          identity.isReparsePoint
        ) {
          return false;
        }
      }
      return true;
    },
  });
  return Object.freeze({
    inspect: async (requestedRootIds?: readonly string[]) =>
      await inspectTemporaryData(layout, probe, requestedRootIds),
    clear: async (requestedRootIds?: readonly string[]) => await clearTemporaryData(layout, probe, requestedRootIds),
    presentationServing: (next: boolean): void => {
      serving = next;
    },
  });
}
