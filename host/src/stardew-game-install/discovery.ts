import { lstat } from "node:fs/promises";
import { win32 } from "node:path";

import { createStardewInstallationDiscoveryProvider } from "../windows-stardew-installation-discovery/index.js";
import { createWindowsSteamInstallationSource } from "../windows-stardew-installation-discovery/index.js";
import { normalizeWindowsPath } from "../windows-stardew-installation-discovery/internal.js";
import { createWindowsGogInstallationSource } from "./gog-source.js";

export const STARDEW_GAME_EXECUTABLE_FILE = "Stardew Valley.exe";
export const STARDEW_SMAPI_EXECUTABLE_FILE = "StardewModdingAPI.exe";

type StardewGameInstallSource = "steam" | "gog" | "chosen";

export type StardewGameRootProbe = Readonly<{ gameExecutable: boolean; smapi: boolean }>;

type StardewGameInstallation = Readonly<{
  source: StardewGameInstallSource;
  installRoot: string;
  gameExecutable: string;
  smapiExecutable: string | null;
}>;

type StardewGameDiscoveryDiagnostic =
  | "steam-unavailable"
  | "steam-root-unverified"
  | "gog-unavailable"
  | "gog-metadata-unreadable"
  | "gog-metadata-malformed"
  | "chosen-root-invalid"
  | "chosen-root-not-a-stardew-install"
  | "candidate-not-a-stardew-install";

export type StardewGameInstallationResolution =
  | Readonly<{
      kind: "resolved";
      installation: StardewGameInstallation;
      diagnostics: readonly StardewGameDiscoveryDiagnostic[];
    }>
  | Readonly<{
      kind: "choice_required";
      installations: readonly StardewGameInstallation[];
      diagnostics: readonly StardewGameDiscoveryDiagnostic[];
    }>
  | Readonly<{ kind: "not_found"; diagnostics: readonly StardewGameDiscoveryDiagnostic[] }>;

export type StardewGameInstallationResolverInput = Readonly<{
  steamInstallRoots: readonly string[];
  gogInstallRoots: readonly string[];
  sourceDiagnostics: readonly StardewGameDiscoveryDiagnostic[];
  probe: (installRoot: string) => Promise<StardewGameRootProbe>;
  chosenInstallRoot?: string;
}>;

function isRegularFile(path: string): Promise<boolean> {
  return lstat(path).then(
    (state) => state.isFile(),
    () => false,
  );
}

/** Reports only whether the two executables are present; it never reveals or admits the path. */
export async function probeStardewGameRoot(installRoot: string): Promise<StardewGameRootProbe> {
  try {
    const [gameExecutable, smapi] = await Promise.all([
      isRegularFile(win32.join(installRoot, STARDEW_GAME_EXECUTABLE_FILE)),
      isRegularFile(win32.join(installRoot, STARDEW_SMAPI_EXECUTABLE_FILE)),
    ]);
    return Object.freeze({ gameExecutable, smapi });
  } catch {
    return Object.freeze({ gameExecutable: false, smapi: false });
  }
}

function installationFrom(
  source: StardewGameInstallSource,
  installRoot: string,
  probe: StardewGameRootProbe,
): StardewGameInstallation {
  return Object.freeze({
    source,
    installRoot,
    gameExecutable: win32.join(installRoot, STARDEW_GAME_EXECUTABLE_FILE),
    smapiExecutable: probe.smapi ? win32.join(installRoot, STARDEW_SMAPI_EXECUTABLE_FILE) : null,
  });
}

function notFound(diagnostics: readonly StardewGameDiscoveryDiagnostic[]): StardewGameInstallationResolution {
  return Object.freeze({ kind: "not_found" as const, diagnostics: Object.freeze([...diagnostics]) });
}

/**
 * Decides which installation the launcher may use. A player-chosen directory is
 * authoritative and never falls back to a default, so a wrong pick reads as a
 * named refusal instead of silently selecting a different installation. With no
 * choice, every discovered root is probed and exactly one installed game
 * resolves; several installed games require an explicit choice rather than a
 * guess.
 */
export async function resolveStardewGameInstallation(
  input: StardewGameInstallationResolverInput,
): Promise<StardewGameInstallationResolution> {
  const diagnostics: StardewGameDiscoveryDiagnostic[] = [...input.sourceDiagnostics];

  if (input.chosenInstallRoot !== undefined) {
    const normalized = normalizeWindowsPath(input.chosenInstallRoot);
    if (normalized === undefined) {
      diagnostics.push("chosen-root-invalid");
      return notFound(diagnostics);
    }
    const probe = await input.probe(normalized);
    if (!probe.gameExecutable) {
      diagnostics.push("chosen-root-not-a-stardew-install");
      return notFound(diagnostics);
    }
    return Object.freeze({
      kind: "resolved" as const,
      installation: installationFrom("chosen", normalized, probe),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  const installations: StardewGameInstallation[] = [];
  const seen = new Set<string>();
  for (const [source, roots] of [
    ["steam", input.steamInstallRoots],
    ["gog", input.gogInstallRoots],
  ] as const) {
    for (const root of roots) {
      const normalized = normalizeWindowsPath(root);
      if (normalized === undefined) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const probe = await input.probe(normalized);
      if (!probe.gameExecutable) {
        diagnostics.push("candidate-not-a-stardew-install");
        continue;
      }
      installations.push(installationFrom(source, normalized, probe));
    }
  }

  if (installations.length === 0) return notFound(diagnostics);
  if (installations.length === 1) {
    return Object.freeze({
      kind: "resolved" as const,
      installation: installations[0]!,
      diagnostics: Object.freeze(diagnostics),
    });
  }
  return Object.freeze({
    kind: "choice_required" as const,
    installations: Object.freeze(installations),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Host-owned discovery entry: Steam is read through the existing
 * registry/library/appmanifest provider, GOG through the GOG proposal source,
 * and an optional one-time player choice wins over both. Failures in one source
 * are named and never abort the other.
 */
export async function discoverStardewGameInstallation(
  input: Readonly<{ chosenInstallRoot?: string }> = {},
): Promise<StardewGameInstallationResolution> {
  const sourceDiagnostics: StardewGameDiscoveryDiagnostic[] = [];
  const steamInstallRoots: string[] = [];
  try {
    const provider = createStardewInstallationDiscoveryProvider({ source: createWindowsSteamInstallationSource() });
    const result = await provider.discover();
    for (const candidate of result.candidates) {
      try {
        steamInstallRoots.push(provider.confirm(candidate.candidateId));
      } catch {
        sourceDiagnostics.push("steam-root-unverified");
      }
    }
    if (result.diagnostics.includes("source-unavailable")) sourceDiagnostics.push("steam-unavailable");
  } catch {
    sourceDiagnostics.push("steam-unavailable");
  }

  let gogRoots: readonly string[] = [];
  try {
    const facts = await createWindowsGogInstallationSource().read();
    gogRoots = facts.roots;
    for (const diagnostic of facts.diagnostics) sourceDiagnostics.push(diagnostic);
  } catch {
    sourceDiagnostics.push("gog-unavailable");
  }

  return await resolveStardewGameInstallation({
    steamInstallRoots,
    gogInstallRoots: gogRoots,
    sourceDiagnostics,
    probe: probeStardewGameRoot,
    ...(input.chosenInstallRoot === undefined ? {} : { chosenInstallRoot: input.chosenInstallRoot }),
  });
}
