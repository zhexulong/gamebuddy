import { win32 } from "node:path";

import { normalizeWindowsPath, WINDOWS_DRIVE_ROOTS } from "../windows-stardew-installation-discovery/internal.js";

/**
 * The Microsoft Store / PC Game Pass channel: the two folders the Xbox app installs Stardew Valley
 * into, and the difference between them.
 *
 * A player who bought the game on PC Game Pass has no Steam library entry and no GOG registry
 * record, so both older channels are silent on their machine and the setup panel used to say no
 * installation was found - a statement about a machine the Host had never actually looked at.
 * This source is the channel that looks, and its failures carry its own name so the reply says
 * which search could not run.
 *
 * The two layouts are not interchangeable:
 *
 * - `<drive>:\Program Files\ModifiableWindowsApps\Stardew Valley` is the mods-enabled install.
 *   SMAPI's own `build/find-game-folder.targets` probes exactly this path on each drive and says
 *   why it cannot use the Xbox app's registry entry - that entry names the internal readonly path
 *   (`C:\Program Files\WindowsApps\Mutable\<package id>`) rather than the mods-enabled one. A
 *   player can choose the install DRIVE but not the path on it, which is what makes deriving the
 *   folder per drive correct instead of a guess.
 * - `<drive>:\XboxGames\Stardew Valley\Content` is the same game installed without mod support.
 *   The executable is really there, but SMAPI installs itself beside that executable and rewrites
 *   the game's assembly, and this folder is not the one that permits it. Offering it would send a
 *   Game Pass player to install a mod loader that cannot work there, which is worse than saying
 *   honestly that this copy cannot host the Companion Mod - so the folder is reported by name
 *   (`microsoft-store-install-not-mod-enabled`) and never offered.
 */
const MODS_ENABLED_LAYOUT: readonly string[] = Object.freeze([
  "Program Files",
  "ModifiableWindowsApps",
  "Stardew Valley",
]);

/** The layout the Xbox app uses for a title the player has not installed with mods enabled. */
const DEFAULT_LAYOUT: readonly string[] = Object.freeze(["XboxGames", "Stardew Valley", "Content"]);

export type StardewMicrosoftStoreDiscoveryDiagnostic =
  | "microsoft-store-unavailable"
  | "microsoft-store-root-unreadable"
  | "microsoft-store-install-not-mod-enabled";

export type StardewMicrosoftStoreSourceFacts = Readonly<{
  /** Mods-enabled install roots the game executable was actually found in. */
  roots: readonly string[];
  diagnostics: readonly StardewMicrosoftStoreDiscoveryDiagnostic[];
}>;

export type StardewMicrosoftStoreSource = Readonly<{ read(): Promise<StardewMicrosoftStoreSourceFacts> }>;

type StardewWindowsMicrosoftStoreSourceInput = Readonly<{
  platform?: NodeJS.Platform;
  /**
   * The drive roots both layouts are derived from. The production default is the bounded sweep
   * Steam's own known locations already use; it is injectable because every branch of this channel
   * must be provable on a machine with no Store install, which is the machine CI runs on.
   */
  driveRoots?: readonly string[];
  /**
   * `probeStardewGameRoot`, supplied by the caller rather than imported.
   *
   * This module is read by the game's own discovery module, so importing that probe back would be
   * a cycle in everything that reads the real module graph. Required, not defaulted: a source that
   * offered a folder it never looked in would put a row on the panel for a game that is not there,
   * and a required parameter makes that a compile error instead of a wrong sentence on screen.
   */
  probe: (installRoot: string) => Promise<Readonly<{ readable: boolean; gameExecutable: boolean }>>;
}>;

/**
 * Read-only proposal source for Microsoft Store installations. It proposes candidate roots and
 * never admits, registers or launches one, exactly as the Steam and GOG sources do.
 */
export function createWindowsMicrosoftStoreInstallationSource(
  input: StardewWindowsMicrosoftStoreSourceInput,
): StardewMicrosoftStoreSource {
  const platform = input.platform ?? process.platform;
  const driveRoots = input.driveRoots ?? WINDOWS_DRIVE_ROOTS;
  return Object.freeze({
    read: async (): Promise<StardewMicrosoftStoreSourceFacts> => {
      if (platform !== "win32")
        return Object.freeze({
          roots: Object.freeze([]),
          diagnostics: Object.freeze(["microsoft-store-unavailable"] as const),
        });
      const diagnostics = new Set<StardewMicrosoftStoreDiscoveryDiagnostic>();
      const roots: string[] = [];
      // The offerable layout is read first so a drive carrying both reports the install the player
      // can actually use, whatever order the diagnostic set ends up in.
      for (const [layout, modEnabled] of [
        [MODS_ENABLED_LAYOUT, true],
        [DEFAULT_LAYOUT, false],
      ] as const) {
        for (const driveRoot of driveRoots) {
          const root = normalizeWindowsPath(win32.join(driveRoot, ...layout));
          // Both layouts are built from a drive root and fixed components, so an unnormalizable
          // one is not a fact about the machine and has nothing to report.
          if (root === undefined) continue;
          let probe: Awaited<ReturnType<StardewWindowsMicrosoftStoreSourceInput["probe"]>>;
          try {
            probe = await input.probe(root);
          } catch {
            diagnostics.add("microsoft-store-root-unreadable");
            continue;
          }
          if (!probe.readable) {
            // "Could not look" is not "no game here", the same distinction the shared probe draws.
            diagnostics.add("microsoft-store-root-unreadable");
            continue;
          }
          // A layout that holds no game is a guess that landed on nothing, and keeps Steam's
          // known-location policy: a guess is not a named source and reports no failure of its own.
          if (!probe.gameExecutable) continue;
          if (!modEnabled) {
            diagnostics.add("microsoft-store-install-not-mod-enabled");
            continue;
          }
          roots.push(root);
        }
      }
      return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze([...diagnostics]) });
    },
  });
}
