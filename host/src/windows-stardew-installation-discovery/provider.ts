import { readFile } from "node:fs/promises";
import { StardewDiscoverySession, normalizeBoundCandidates, parseAppManifest, type DiscoveryDiagnostic, type StardewInstallationCandidate } from "./internal.js";
import type { StardewSteamSource } from "./source.js";

export type StardewInstallationDiscoveryProviderResult = Readonly<{ candidates: readonly StardewInstallationCandidate[]; diagnostics: readonly DiscoveryDiagnostic[] }>;
export type StardewInstallationDiscoveryProvider = Readonly<{ discover(): Promise<StardewInstallationDiscoveryProviderResult>; confirm(candidateId: string): string; reset(): void }>;
export type StardewInstallationDiscoveryProviderInput = Readonly<{
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
        const installRoot = `${steamLibraryRoot}\\steamapps\\common\\Stardew Valley`;
        try {
          const manifest = await read(`${steamLibraryRoot}\\steamapps\\appmanifest_413150.acf`);
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
