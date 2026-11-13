import { readFile } from "node:fs/promises";
import {
  type DiscoveryDiagnostic,
  normalizeBoundCandidates,
  normalizeWindowsPath,
  parseAppManifest,
  STEAM_METADATA_MAX_BYTES,
  type StardewCandidateModLoader,
  StardewDiscoverySession,
  type StardewInstallationCandidate,
  WINDOWS_PATH_MAX_LENGTH,
} from "./internal.js";
import type { StardewSteamSource } from "./source.js";

export type StardewInstallationDiscoveryProviderResult = Readonly<{
  candidates: readonly StardewInstallationCandidate[];
  diagnostics: readonly DiscoveryDiagnostic[];
}>;
export type StardewInstallationDiscoveryProvider = Readonly<{
  discover(): Promise<StardewInstallationDiscoveryProviderResult>;
  confirm(candidateId: string): string;
  reset(): void;
}>;
type StardewInstallationDiscoveryProviderInput = Readonly<{
  source?: StardewSteamSource;
  gog?: StardewGogInstallRootSource;
  microsoftStore?: StardewMicrosoftStoreInstallRootSource;
  readFile?: (path: string) => Promise<string>;
  /**
   * Reports whether a verified root holds a mod loader. Declared structurally for the same reason the GOG arm's
   * probe is: this module is imported by the game's own discovery module, so importing it back would be a cycle in
   * everything that reads the real module graph.
   *
   * Required. Measured: a call site that omitted it produced `missing` for a folder whose own probe said
   * `smapi: true`, which reads as "the product checked and found no loader" - the one claim this field must never
   * make on a guess. A required parameter makes that a compile error instead of a wrong sentence on screen.
   */
  probe: (installRoot: string) => Promise<Readonly<{ readable: boolean; smapi: boolean }>>;
}>;

/**
 * A non-Steam proposal source, plus the one fact that turns a proposal into a candidate.
 *
 * The two halves travel together because GOG's input shape differs from Steam's in both
 * directions. GOG already names install roots (`<library>\Stardew Valley`), so nothing here
 * binds a library root to an app manifest the way Steam's arm does; and two of its roots are
 * unconditional default layouts, so a proposal alone is a guess - issuing it unverified would
 * offer a Steam-only player a row naming a game that is not on their machine.
 *
 * The proposal source is read structurally (`stardew-game-install/gog-source.ts`) rather than
 * imported: that module's own discovery entry already imports this one, and a type-only edge
 * back would be a cycle in everything that reads the real module graph.
 */
type StardewGogInstallRootSource = Readonly<{
  read(): Promise<Readonly<{ roots: readonly string[]; diagnostics: readonly DiscoveryDiagnostic[] }>>;
  /** `probeStardewGameRoot` - the same probe every other installation decision reads. */
  probe(installRoot: string): Promise<Readonly<{ readable: boolean; gameExecutable: boolean }>>;
}>;
export type { StardewGogInstallRootSource };

/**
 * The Microsoft Store proposal source (`stardew-game-install/microsoft-store-source.ts`), read
 * structurally for the same reason as the GOG one: that module is read by the game's own discovery
 * module, so importing it back would be a cycle in everything that reads the real module graph.
 *
 * It carries no probe seam because it has already probed: a Store candidate is only proposed when
 * the game executable was really found in it, and a copy in the layout no mod loader can run in
 * reaches this arm as a named diagnostic instead of a root.
 */
type StardewMicrosoftStoreInstallRootSource = Readonly<{
  read(): Promise<Readonly<{ roots: readonly string[]; diagnostics: readonly DiscoveryDiagnostic[] }>>;
}>;
export type { StardewMicrosoftStoreInstallRootSource };

type StardewSourceRoots = Readonly<{
  roots: readonly (readonly [StardewInstallationCandidate["source"], string, StardewCandidateModLoader])[];
  diagnostics: readonly DiscoveryDiagnostic[];
}>;

/** Composition-private provider: only opaque candidates cross its boundary. */
export function createStardewInstallationDiscoveryProvider(
  input: StardewInstallationDiscoveryProviderInput,
): StardewInstallationDiscoveryProvider {
  const session = new StardewDiscoverySession();
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  /**
   * Whether a verified root holds a mod loader, as the candidate reports it.
   *
   * A probe that throws, cannot look, or answers nothing is `missing`: the only defensible claim is what was
   * actually observed, and an unread folder is not a folder known to be ready.
   */
  const modLoaderFor = async (installRoot: string): Promise<StardewCandidateModLoader> => {
    try {
      const probe = await input.probe(installRoot);
      return probe.readable && probe.smapi ? "present" : "missing";
    } catch {
      return "missing";
    }
  };
  const source = input.source;
  const gog = input.gog;
  const microsoftStore = input.microsoftStore;

  /** Steam's arm: a library root becomes an install root only through this game's app manifest. */
  const readSteamRoots = async (): Promise<StardewSourceRoots> => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<
      readonly ["steam-registry" | "steam-vdf" | "known-location", string, StardewCandidateModLoader]
    > = [];
    if (source === undefined) {
      diagnostics.push("source-unavailable");
    } else {
      let facts: Awaited<ReturnType<StardewSteamSource["read"]>>;
      try {
        facts = await source.read();
      } catch {
        facts = { roots: [], diagnostics: ["source-unavailable"] };
      }
      diagnostics.push(...facts.diagnostics);
      const addRoot = async (
        sourceKind: "steam-registry" | "steam-vdf" | "known-location",
        steamLibraryRoot: string,
      ) => {
        const normalizedLibraryRoot = normalizeWindowsPath(steamLibraryRoot);
        if (normalizedLibraryRoot === undefined) {
          diagnostics.push("invalid-app-manifest");
          return;
        }
        const installRoot = `${normalizedLibraryRoot}\\steamapps\\common\\Stardew Valley`;
        const manifestPath = `${normalizedLibraryRoot}\\steamapps\\appmanifest_413150.acf`;
        if (installRoot.length > WINDOWS_PATH_MAX_LENGTH || manifestPath.length > WINDOWS_PATH_MAX_LENGTH) {
          diagnostics.push("invalid-app-manifest");
          return;
        }
        try {
          const manifest = await read(manifestPath);
          if (Buffer.byteLength(manifest, "utf8") > STEAM_METADATA_MAX_BYTES) {
            diagnostics.push("invalid-app-manifest");
            return;
          }
          if (parseAppManifest(manifest) === null) {
            diagnostics.push("invalid-app-manifest");
            return;
          }
          roots.push([sourceKind, installRoot, await modLoaderFor(installRoot)]);
        } catch (error) {
          // Absence is not invalidity: a library that does not hold this game has no manifest, and calling that an
          // invalid manifest made an ordinary scan read as a fault.
          const code = (error as { code?: string } | null)?.code;
          diagnostics.push(code === "ENOENT" || code === "ENOTDIR" ? "library-without-game" : "invalid-app-manifest");
        }
      };
      for (const [sourceKind, steamLibraryRoot] of facts.roots) await addRoot(sourceKind, steamLibraryRoot);
    }
    return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
  };

  /**
   * GOG's arm: the source's roots are already install roots, so each is offered once the probe
   * says the game is in it. A root the probe could not look at is named, never silently dropped
   * (`probeStardewGameRoot` reports `readable` for exactly this distinction); a root the probe
   * read and found empty is the guess that landed on nothing, and keeps Steam's known-location
   * policy - a guess that found no game is not a failure to report.
   */
  const readGogRoots = async (): Promise<StardewSourceRoots> => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<readonly [StardewInstallationCandidate["source"], string, StardewCandidateModLoader]> = [];
    if (gog === undefined)
      return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
    let facts: Awaited<ReturnType<StardewGogInstallRootSource["read"]>>;
    try {
      facts = await gog.read();
    } catch {
      return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(["gog-unavailable"] as const) });
    }
    diagnostics.push(...facts.diagnostics);
    for (const root of facts.roots) {
      const normalized = normalizeWindowsPath(root);
      if (normalized === undefined) {
        diagnostics.push("gog-metadata-malformed");
        continue;
      }
      let probe: Awaited<ReturnType<StardewGogInstallRootSource["probe"]>>;
      try {
        probe = await gog.probe(normalized);
      } catch {
        diagnostics.push("gog-metadata-unreadable");
        continue;
      }
      if (!probe.readable) {
        diagnostics.push("gog-metadata-unreadable");
        continue;
      }
      if (!probe.gameExecutable) continue;
      roots.push(["gog", normalized, await modLoaderFor(normalized)]);
    }
    return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
  };

  /**
   * The Microsoft Store arm: the source has already probed every drive's two layouts, so its roots
   * are install roots and its diagnostics are its own named failures - including the copy it found
   * in the layout that cannot load a mod loader. Only the loader fact is added here, exactly as for
   * a GOG candidate.
   */
  const readMicrosoftStoreRoots = async (): Promise<StardewSourceRoots> => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<readonly [StardewInstallationCandidate["source"], string, StardewCandidateModLoader]> = [];
    if (microsoftStore === undefined)
      return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
    let facts: Awaited<ReturnType<StardewMicrosoftStoreInstallRootSource["read"]>>;
    try {
      facts = await microsoftStore.read();
    } catch {
      return Object.freeze({
        roots: Object.freeze(roots),
        diagnostics: Object.freeze(["microsoft-store-unavailable"] as const),
      });
    }
    diagnostics.push(...facts.diagnostics);
    for (const root of facts.roots) roots.push(["microsoft-store", root, await modLoaderFor(root)]);
    return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
  };

  return Object.freeze({
    reset: () => session.reset(),
    confirm: (candidateId: string) => session.consume(candidateId),
    discover: async () => {
      // Every source is read before any is offered, so one source's failure can never abort
      // another's candidates. The order is the attribution order: deduplication keeps the FIRST
      // proposal of a folder, so a folder both Steam and another channel name stays with Steam -
      // the sole channel that proves the game is there through its own app manifest.
      const [steam, gogFacts, microsoftStoreFacts] = await Promise.all([
        readSteamRoots(),
        readGogRoots(),
        readMicrosoftStoreRoots(),
      ]);
      const diagnostics: DiscoveryDiagnostic[] = [
        ...steam.diagnostics,
        ...gogFacts.diagnostics,
        ...microsoftStoreFacts.diagnostics,
      ];
      const candidates = normalizeBoundCandidates(session, [
        ...steam.roots,
        ...gogFacts.roots,
        ...microsoftStoreFacts.roots,
      ]);
      if (candidates.length === 0) diagnostics.push("no-candidates");
      return Object.freeze({ candidates, diagnostics: Object.freeze(diagnostics) });
    },
  });
}
