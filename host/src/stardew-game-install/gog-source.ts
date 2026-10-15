import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

import { normalizeWindowsPath } from "../windows-stardew-installation-discovery/internal.js";

const execFileAsync = promisify(execFile);

const GOG_GAME_NAME = "Stardew Valley";
const GOG_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const GOG_REGISTRY_ENTRY_MAX = 4096;
const WINDOWS_PATH_MAX_LENGTH = 32_767;

type StardewGogDiscoveryDiagnostic = "gog-unavailable" | "gog-metadata-unreadable" | "gog-metadata-malformed";

export type StardewGogRegistryGame = Readonly<{ gameName: string; path: string }>;

type StardewGogSourceFacts = Readonly<{
  roots: readonly string[];
  diagnostics: readonly StardewGogDiscoveryDiagnostic[];
}>;

export type StardewGogSource = Readonly<{ read(): Promise<StardewGogSourceFacts> }>;

type StardewWindowsGogSourceInput = Readonly<{
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  readRegistryGames?: () => Promise<readonly StardewGogRegistryGame[]>;
  programDataRoot?: string;
}>;

/**
 * The two GOG install layouts a player most often has. Each holds the game in a
 * `Stardew Valley` child directory; GOG's own Galaxy library setting and the
 * per-game registry entries below add the player's actual locations.
 */
const GOG_DEFAULT_LIBRARY_ROOTS: readonly string[] = Object.freeze([
  "C:\\Program Files (x86)\\GOG Galaxy\\Games",
  "C:\\GOG Games",
]);

// Read only the two GOG game-identity values, never account or Galaxy user
// metadata. JSON and explicit UTF-8 preserve non-ASCII paths independently of
// the OEM codepage.
const GOG_REGISTRY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$locations = @(
  @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64, 'SOFTWARE\\GOG.com\\Games'),
  @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry32, 'SOFTWARE\\GOG.com\\Games')
)
$games = @()
foreach ($location in $locations) {
  $base = $null
  $gamesKey = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location[0], $location[1])
    $gamesKey = $base.OpenSubKey($location[2], $false)
    if ($null -ne $gamesKey) {
      foreach ($name in $gamesKey.GetSubKeyNames()) {
        $game = $null
        try {
          $game = $gamesKey.OpenSubKey($name, $false)
          if ($null -ne $game) {
            $gameName = $game.GetValue('gameName', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $installPath = $game.GetValue('path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($null -ne $gameName -and $null -ne $installPath) {
              $games += @{ gameName = [string]$gameName; path = [string]$installPath }
            }
          }
        } finally {
          if ($null -ne $game) { $game.Dispose() }
        }
      }
    }
  } finally {
    if ($null -ne $gamesKey) { $gamesKey.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}
ConvertTo-Json -InputObject $games -Compress
`;

async function readWindowsGogRegistryGames(): Promise<readonly StardewGogRegistryGame[]> {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const result = await execFileAsync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", GOG_REGISTRY_SCRIPT],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
  if (result.stderr.trim() !== "") throw new Error("registry-unavailable");
  const parsed = parseGogRegistryGames(safeParseJson(result.stdout.trim()));
  if (parsed === undefined) throw new Error("registry-unavailable");
  return parsed;
}

function safeParseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function isRegistryGame(value: unknown): value is StardewGogRegistryGame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.gameName === "string" &&
    record.gameName.length > 0 &&
    typeof record.path === "string" &&
    record.path.length > 0
  );
}

/**
 * GOG's registry writer emits one object for a single installed game and an
 * array for several, so both shapes are accepted rather than treating one of
 * them as a corrupt registry.
 */
export function parseGogRegistryGames(value: unknown): readonly StardewGogRegistryGame[] | undefined {
  if (Array.isArray(value)) {
    if (value.length > GOG_REGISTRY_ENTRY_MAX) return undefined;
    return Object.freeze(
      value.filter(isRegistryGame).map((entry) => Object.freeze({ gameName: entry.gameName, path: entry.path })),
    );
  }
  if (isRegistryGame(value)) return Object.freeze([Object.freeze({ gameName: value.gameName, path: value.path })]);
  return undefined;
}

/** Returns the normalized library roots named by a GOG Galaxy config, or undefined when malformed. */
export function parseGogGalaxyLibraryRoots(source: string): readonly string[] | undefined {
  const value = safeParseJson(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const libraryPath = (value as Record<string, unknown>).libraryPath;
  if (libraryPath === undefined || libraryPath === null) return Object.freeze([]);
  if (typeof libraryPath !== "string") return undefined;
  const normalized = normalizeWindowsPath(libraryPath);
  return normalized === undefined ? undefined : Object.freeze([normalized]);
}

/**
 * Read-only proposal source for GOG installations: GOG's own library setting,
 * its per-game registry entries, and the two default install layouts. It
 * proposes candidate roots only and never admits, registers, or launches one.
 */
export function createWindowsGogInstallationSource(input: StardewWindowsGogSourceInput = {}): StardewGogSource {
  const platform = input.platform ?? process.platform;
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const readRegistryGames = input.readRegistryGames ?? readWindowsGogRegistryGames;
  const programDataRoot = input.programDataRoot ?? process.env.ProgramData ?? "C:\\ProgramData";
  return Object.freeze({
    read: async (): Promise<StardewGogSourceFacts> => {
      if (platform !== "win32")
        return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze(["gog-unavailable"] as const) });
      const diagnostics = new Set<StardewGogDiscoveryDiagnostic>();
      const roots: string[] = [];
      for (const libraryRoot of GOG_DEFAULT_LIBRARY_ROOTS) roots.push(win32.join(libraryRoot, GOG_GAME_NAME));

      const metadataPath = win32.join(programDataRoot, "GOG.com", "Galaxy", "config", "config.json");
      if (metadataPath.length > WINDOWS_PATH_MAX_LENGTH) {
        diagnostics.add("gog-metadata-malformed");
      } else {
        let config: string | undefined;
        try {
          config = await read(metadataPath);
        } catch {
          diagnostics.add("gog-metadata-unreadable");
        }
        if (config !== undefined) {
          if (Buffer.byteLength(config, "utf8") > GOG_METADATA_MAX_BYTES) {
            diagnostics.add("gog-metadata-malformed");
          } else {
            const libraryRoots = parseGogGalaxyLibraryRoots(config);
            if (libraryRoots === undefined) diagnostics.add("gog-metadata-malformed");
            else for (const libraryRoot of libraryRoots) roots.push(win32.join(libraryRoot, GOG_GAME_NAME));
          }
        }
      }

      let registryGames: readonly StardewGogRegistryGame[];
      try {
        registryGames = await readRegistryGames();
      } catch {
        registryGames = Object.freeze([]);
        diagnostics.add("gog-metadata-unreadable");
      }
      for (const game of registryGames) if (game.gameName === GOG_GAME_NAME) roots.push(game.path);

      const normalized: string[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        const candidate = normalizeWindowsPath(root);
        if (candidate === undefined) {
          diagnostics.add("gog-metadata-malformed");
          continue;
        }
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(candidate);
      }
      return Object.freeze({ roots: Object.freeze(normalized), diagnostics: Object.freeze([...diagnostics]) });
    },
  });
}
