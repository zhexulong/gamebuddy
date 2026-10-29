import { readFile } from "node:fs/promises";
import {
  StardewDiscoverySession,
  normalizeBoundCandidates,
  normalizeWindowsPath,
  parseAppManifest,
  WINDOWS_PATH_MAX_LENGTH,
  STEAM_METADATA_MAX_BYTES,
  type DiscoveryDiagnostic,
  type StardewInstallationCandidate,
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
  readFile?: (path: string) => Promise<string>;
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

type StardewSourceRoots = Readonly<{
  roots: readonly (readonly [StardewInstallationCandidate["source"], string])[];
  diagnostics: readonly DiscoveryDiagnostic[];
}>;

/** Composition-private provider: only opaque candidates cross its boundary. */
export function createStardewInstallationDiscoveryProvider(
  input: StardewInstallationDiscoveryProviderInput = {},
): StardewInstallationDiscoveryProvider {
  const session = new StardewDiscoverySession();
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const source = input.source;
  const gog = input.gog;

  /** Steam's arm: a library root becomes an install root only through this game's app manifest. */
  const readSteamRoots = async (): Promise<StardewSourceRoots> => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<readonly ["steam-registry" | "steam-vdf" | "known-location", string]> = [];
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
          roots.push([sourceKind, installRoot]);
        } catch {
          diagnostics.push("invalid-app-manifest");
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
    const roots: Array<readonly [StardewInstallationCandidate["source"], string]> = [];
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
      roots.push(["gog", normalized]);
    }
    return Object.freeze({ roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
  };

  return Object.freeze({
    reset: () => session.reset(),
    confirm: (candidateId: string) => session.consume(candidateId),
    discover: async () => {
      // Both sources are read before either is offered, so one source's failure can never
      // abort the other's candidates. GOG is appended after Steam deliberately: deduplication
      // keeps the FIRST proposal of a folder, so a folder both sources name is attributed to
      // Steam - the sole channel that proves the game is there through its own app manifest.
      const [steam, gogFacts] = await Promise.all([readSteamRoots(), readGogRoots()]);
      const diagnostics: DiscoveryDiagnostic[] = [...steam.diagnostics, ...gogFacts.diagnostics];
      const candidates = normalizeBoundCandidates(session, [...steam.roots, ...gogFacts.roots]);
      if (candidates.length === 0) diagnostics.push("no-candidates");
      return Object.freeze({ candidates, diagnostics: Object.freeze(diagnostics) });
    },
  });
}
