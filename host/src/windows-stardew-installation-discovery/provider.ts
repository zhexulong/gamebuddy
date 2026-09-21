import { readFile } from "node:fs/promises";
import { StardewDiscoverySession, normalizeBoundCandidates, normalizeWindowsPath, parseAppManifest, WINDOWS_PATH_MAX_LENGTH, STEAM_METADATA_MAX_BYTES, type DiscoveryDiagnostic, type StardewInstallationCandidate } from "./internal.js";
import type { StardewSteamSource } from "./source.js";

export type StardewInstallationDiscoveryProviderResult = Readonly<{ candidates: readonly StardewInstallationCandidate[]; diagnostics: readonly DiscoveryDiagnostic[] }>;
export type StardewInstallationDiscoveryProvider = Readonly<{ discover(): Promise<StardewInstallationDiscoveryProviderResult>; confirm(candidateId: string): string; reset(): void }>;
type StardewInstallationDiscoveryProviderInput = Readonly<{
  source?: StardewSteamSource;
  readFile?: (path: string) => Promise<string>;
}>;

/** Composition-private provider: only opaque candidates cross its boundary. */
export function createStardewInstallationDiscoveryProvider(input: StardewInstallationDiscoveryProviderInput = {}): StardewInstallationDiscoveryProvider {
  const session = new StardewDiscoverySession();
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const source = input.source;
  return Object.freeze({ reset: () => session.reset(), confirm: (candidateId: string) => session.consume(candidateId), discover: async () => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<readonly ["steam-registry" | "steam-vdf", string]> = [];
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
      const addRoot = async (sourceKind: "steam-registry" | "steam-vdf", steamLibraryRoot: string) => {
        const normalizedLibraryRoot = normalizeWindowsPath(steamLibraryRoot);
        if (normalizedLibraryRoot === undefined) { diagnostics.push("invalid-app-manifest"); return; }
        const installRoot = `${normalizedLibraryRoot}\\steamapps\\common\\Stardew Valley`;
        const manifestPath = `${normalizedLibraryRoot}\\steamapps\\appmanifest_413150.acf`;
        if (installRoot.length > WINDOWS_PATH_MAX_LENGTH || manifestPath.length > WINDOWS_PATH_MAX_LENGTH) { diagnostics.push("invalid-app-manifest"); return; }
        try {
          const manifest = await read(manifestPath);
          if (Buffer.byteLength(manifest, "utf8") > STEAM_METADATA_MAX_BYTES) { diagnostics.push("invalid-app-manifest"); return; }
          if (parseAppManifest(manifest) === null) { diagnostics.push("invalid-app-manifest"); return; }
          roots.push([sourceKind, installRoot]);
        } catch { diagnostics.push("invalid-app-manifest"); }
      };
      for (const [sourceKind, steamLibraryRoot] of facts.roots) await addRoot(sourceKind, steamLibraryRoot);
    }
    const candidates = normalizeBoundCandidates(session, roots);
    if (candidates.length === 0) diagnostics.push("no-candidates");
    return Object.freeze({ candidates, diagnostics: Object.freeze(diagnostics) });
  } });
}
