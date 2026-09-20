import { readFile } from "node:fs/promises";
import { StardewDiscoverySession, normalizeBoundCandidates, parseAppManifest, parseLibraryFoldersVdf, type DiscoveryDiagnostic, type StardewInstallationCandidate } from "./internal.js";

export type StardewInstallationDiscoveryProviderResult = Readonly<{ candidates: readonly StardewInstallationCandidate[]; diagnostics: readonly DiscoveryDiagnostic[] }>;
export type StardewInstallationDiscoveryProvider = Readonly<{ discover(): Promise<StardewInstallationDiscoveryProviderResult>; confirm(candidateId: string): string; reset(): void }>;
const registryBrand = Symbol("verified-steam-registry");
export type StardewVerifiedSteamRegistry = Readonly<{ readonly brand: symbol; steamLibraryRoot: string }>;
export type StardewInstallationDiscoveryProviderInput = Readonly<{
  registry?: StardewVerifiedSteamRegistry;
  libraryFoldersVdfPath?: string;
  readFile?: (path: string) => Promise<string>;
}>;

/** Composition-private provider: only opaque candidates cross its boundary. */
export function createStardewInstallationDiscoveryProvider(input: StardewInstallationDiscoveryProviderInput): StardewInstallationDiscoveryProvider {
  const session = new StardewDiscoverySession();
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  return Object.freeze({ reset: () => session.reset(), confirm: (candidateId: string) => session.consume(candidateId), discover: async () => {
    const diagnostics: DiscoveryDiagnostic[] = [];
    const roots: Array<readonly ["steam-registry" | "steam-vdf", string]> = [];
    if (input.registry === undefined && input.libraryFoldersVdfPath === undefined) diagnostics.push("source-unavailable");
    const addRoot = async (source: "steam-registry" | "steam-vdf", steamLibraryRoot: string) => {
      const installRoot = `${steamLibraryRoot}\\steamapps\\common\\Stardew Valley`;
      try {
        const manifest = await read(`${steamLibraryRoot}\\steamapps\\appmanifest_413150.acf`);
        if (parseAppManifest(manifest) === null) { diagnostics.push("invalid-app-manifest"); return; }
        roots.push([source, installRoot]);
      } catch { diagnostics.push("invalid-app-manifest"); }
    };
    if (input.registry !== undefined) {
      if (input.registry.brand !== registryBrand) diagnostics.push("registry-unavailable");
      else await addRoot("steam-registry", input.registry.steamLibraryRoot);
    }
    if (input.libraryFoldersVdfPath !== undefined) {
      let vdf: string;
      try { vdf = await read(input.libraryFoldersVdfPath); } catch { diagnostics.push("vdf-unreadable"); vdf = ""; }
      if (vdf !== "") {
        try { for (const root of parseLibraryFoldersVdf(vdf)) await addRoot("steam-vdf", root); }
        catch { diagnostics.push("vdf-malformed"); }
      }
    }
    const candidates = normalizeBoundCandidates(session, roots);
    if (candidates.length === 0) diagnostics.push("no-candidates");
    return Object.freeze({ candidates, diagnostics: Object.freeze(diagnostics) });
  } });
}
