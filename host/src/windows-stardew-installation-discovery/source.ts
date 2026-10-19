import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import {
  normalizeWindowsPath,
  parseLibraryFoldersVdf,
  STEAM_METADATA_MAX_BYTES,
  type DiscoveryDiagnostic,
} from "./internal.js";

const execFileAsync = promisify(execFile);
type SourceRoot = readonly ["steam-registry" | "steam-vdf" | "known-location", string];
type StardewSteamSourceFacts = Readonly<{
  roots: readonly SourceRoot[];
  diagnostics: readonly DiscoveryDiagnostic[];
}>;
export type StardewSteamSource = Readonly<{ read(): Promise<StardewSteamSourceFacts> }>;
type StardewWindowsSteamSourceInput = Readonly<{
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  readRegistryRoots?: () => Promise<readonly string[]>;
  readKnownLocationRoots?: () => Promise<readonly string[]>;
}>;

// Read only the three Steam installation values, never account or user metadata.
// JSON and explicit UTF-8 preserve non-ASCII paths independently of the OEM codepage.
const STEAM_REGISTRY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$locations = @(
  @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default, 'Software\\Valve\\Steam', 'SteamPath'),
  @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry32, 'SOFTWARE\\Valve\\Steam', 'InstallPath'),
  @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64, 'SOFTWARE\\Valve\\Steam', 'InstallPath')
)
$roots = @()
foreach ($location in $locations) {
  $base = $null
  $key = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location[0], $location[1])
    $key = $base.OpenSubKey($location[2], $false)
    if ($null -ne $key) {
      $value = $key.GetValue($location[3], $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -ne $value) {
        if ($key.GetValueKind($location[3]) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'steam_registry_value_invalid' }
        $roots += [string]$value
      }
    }
  } finally {
    if ($null -ne $key) { $key.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}
ConvertTo-Json -InputObject @($roots) -Compress
`;

async function readWindowsSteamRegistryRoots(): Promise<readonly string[]> {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const result = await execFileAsync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", STEAM_REGISTRY_SCRIPT],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
  if (result.stderr.trim() !== "") throw new Error("registry-unavailable");
  const roots: unknown = JSON.parse(result.stdout.trim());
  if (
    !Array.isArray(roots) ||
    roots.length > 3 ||
    !roots.every((root) => typeof root === "string" && root.length <= 32767)
  )
    throw new Error("registry-unavailable");
  return roots;
}

function uniqueRoots(roots: readonly SourceRoot[]): readonly SourceRoot[] {
  const seen = new Set<string>();
  return Object.freeze(
    roots
      .filter(([, root]) => {
        const key = root.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((entry) => Object.freeze(entry)),
  );
}

/**
 * The bounded Steam client locations a Windows machine can hold without a
 * registry entry: the two default Program Files installation directories and
 * one `Steam` directory at the root of each drive. It is a fixed list, never a
 * recursive disk walk, and the registry remains the authoritative locator.
 */
const STEAM_KNOWN_LOCATION_LEAF = "Steam";
function readWindowsSteamKnownLocationRoots(): readonly string[] {
  const roots: string[] = [];
  for (const directory of [
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    process.env.ProgramFiles ?? "C:\\Program Files",
  ])
    roots.push(win32.join(directory, STEAM_KNOWN_LOCATION_LEAF));
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") roots.push(`${letter}:\\${STEAM_KNOWN_LOCATION_LEAF}`);
  return roots;
}

/**
 * Composition-private, read-only proposal source: fixed registry installation
 * values, plus a bounded known-location fallback, → libraryfolders.vdf. No
 * recursive disk scan, admission, registration or launch.
 */
export function createWindowsSteamInstallationSource(input: StardewWindowsSteamSourceInput = {}): StardewSteamSource {
  const platform = input.platform ?? process.platform;
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const readRegistryRoots = input.readRegistryRoots ?? readWindowsSteamRegistryRoots;
  const readKnownLocationRoots = input.readKnownLocationRoots ?? readWindowsSteamKnownLocationRoots;
  return Object.freeze({
    read: async (): Promise<StardewSteamSourceFacts> => {
      if (platform !== "win32")
        return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze(["source-unavailable"] as const) });
      const diagnostics = new Set<DiscoveryDiagnostic>();
      let registryValues: readonly string[];
      try {
        registryValues = await readRegistryRoots();
      } catch {
        registryValues = [];
      }
      // Per-value normalization: one malformed registry value never aborts discovery of the others.
      const registryRoots: SourceRoot[] = [];
      for (const value of registryValues) {
        const root = normalizeWindowsPath(value);
        if (root === undefined) continue;
        registryRoots.push(["steam-registry", root]);
      }
      const uniqueRegistryRoots = uniqueRoots(registryRoots);
      const roots: SourceRoot[] = [...uniqueRegistryRoots];
      if (uniqueRegistryRoots.length === 0) {
        // The registry is the authoritative Steam locator. When it names no
        // client, a bounded known-location probe is the fallback; a guessed
        // location that is not a readable Steam client is skipped silently,
        // because a guess is not a named source and must not report a failure
        // of its own.
        diagnostics.add("registry-unavailable");
        const knownRoots: SourceRoot[] = [];
        for (const value of await readKnownLocationRoots()) {
          const root = normalizeWindowsPath(value);
          if (root === undefined) continue;
          knownRoots.push(["known-location", root]);
        }
        for (const [source, steamRoot] of uniqueRoots(knownRoots)) {
          const metadataPath = win32.join(steamRoot, "steamapps", "libraryfolders.vdf");
          if (metadataPath.length > 32767) continue;
          let vdf: string;
          try {
            vdf = await read(metadataPath);
          } catch {
            continue;
          }
          if (Buffer.byteLength(vdf, "utf8") > STEAM_METADATA_MAX_BYTES) continue;
          let libraryRoots: string[];
          try {
            libraryRoots = parseLibraryFoldersVdf(vdf);
          } catch {
            continue;
          }
          roots.push([source, steamRoot]);
          for (const root of libraryRoots) roots.push(["steam-vdf", root]);
        }
        if (roots.length === 0) diagnostics.add("source-unavailable");
      } else {
        for (const [, steamRoot] of uniqueRegistryRoots) {
          let vdf: string;
          const metadataPath = win32.join(steamRoot, "steamapps", "libraryfolders.vdf");
          if (metadataPath.length > 32767) {
            diagnostics.add("vdf-malformed");
            diagnostics.add("source-unavailable");
            continue;
          }
          try {
            vdf = await read(metadataPath);
          } catch {
            diagnostics.add("vdf-unreadable");
            diagnostics.add("source-unavailable");
            continue;
          }
          if (Buffer.byteLength(vdf, "utf8") > STEAM_METADATA_MAX_BYTES) {
            diagnostics.add("vdf-malformed");
            diagnostics.add("source-unavailable");
            continue;
          }
          try {
            for (const root of parseLibraryFoldersVdf(vdf)) roots.push(["steam-vdf", root]);
          } catch {
            diagnostics.add("vdf-malformed");
            diagnostics.add("source-unavailable");
          }
        }
      }
      return Object.freeze({ roots: uniqueRoots(roots), diagnostics: Object.freeze([...diagnostics]) });
    },
  });
}
