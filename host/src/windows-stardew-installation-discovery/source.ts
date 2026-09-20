import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { normalizeWindowsPath, parseLibraryFoldersVdf, STEAM_METADATA_MAX_BYTES, type DiscoveryDiagnostic } from "./internal.js";

const execFileAsync = promisify(execFile);
type SourceRoot = readonly ["steam-registry" | "steam-vdf", string];
export type StardewSteamSourceFacts = Readonly<{
  roots: readonly SourceRoot[];
  diagnostics: readonly DiscoveryDiagnostic[];
}>;
export type StardewSteamSource = Readonly<{ read(): Promise<StardewSteamSourceFacts> }>;
export type StardewWindowsSteamSourceInput = Readonly<{
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  readRegistryRoots?: () => Promise<readonly string[]>;
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
  const result = await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", STEAM_REGISTRY_SCRIPT], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  if (result.stderr.trim() !== "") throw new Error("registry-unavailable");
  const roots: unknown = JSON.parse(result.stdout.trim());
  if (!Array.isArray(roots) || roots.length > 3 || !roots.every((root) => typeof root === "string" && root.length <= 32767)) throw new Error("registry-unavailable");
  return roots;
}

function uniqueRoots(roots: readonly SourceRoot[]): readonly SourceRoot[] {
  const seen = new Set<string>();
  return Object.freeze(roots.filter(([, root]) => {
    const key = root.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((entry) => Object.freeze(entry)));
}

/**
 * Composition-private, read-only proposal source: fixed registry installation
 * values → libraryfolders.vdf. No disk scan, admission, registration or launch.
 */
export function createWindowsSteamInstallationSource(input: StardewWindowsSteamSourceInput = {}): StardewSteamSource {
  const platform = input.platform ?? process.platform;
  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const readRegistryRoots = input.readRegistryRoots ?? readWindowsSteamRegistryRoots;
  return Object.freeze({
    read: async (): Promise<StardewSteamSourceFacts> => {
      if (platform !== "win32") return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze(["source-unavailable"] as const) });
      const diagnostics = new Set<DiscoveryDiagnostic>();
      let registryRoots: readonly SourceRoot[];
      try {
        registryRoots = uniqueRoots((await readRegistryRoots()).map((value): SourceRoot => {
          const root = normalizeWindowsPath(value);
          if (root === undefined) throw new Error("registry-unavailable");
          return ["steam-registry", root];
        }));
      } catch {
        return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze(["registry-unavailable", "source-unavailable"] as const) });
      }
      if (registryRoots.length === 0) return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze(["registry-unavailable", "source-unavailable"] as const) });
      const roots: SourceRoot[] = [...registryRoots];
      for (const [, steamRoot] of registryRoots) {
        let vdf: string;
        const metadataPath = win32.join(steamRoot, "steamapps", "libraryfolders.vdf");
        if (metadataPath.length > 32767) { diagnostics.add("vdf-malformed"); diagnostics.add("source-unavailable"); continue; }
        try { vdf = await read(metadataPath); }
        catch { diagnostics.add("vdf-unreadable"); diagnostics.add("source-unavailable"); continue; }
        if (Buffer.byteLength(vdf, "utf8") > STEAM_METADATA_MAX_BYTES) { diagnostics.add("vdf-malformed"); diagnostics.add("source-unavailable"); continue; }
        try {
          for (const root of parseLibraryFoldersVdf(vdf)) roots.push(["steam-vdf", root]);
        } catch { diagnostics.add("vdf-malformed"); diagnostics.add("source-unavailable"); }
      }
      return Object.freeze({ roots: uniqueRoots(roots), diagnostics: Object.freeze([...diagnostics]) });
    },
  });
}
