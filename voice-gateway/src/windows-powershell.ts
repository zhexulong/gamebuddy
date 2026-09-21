import { join } from "node:path";

/**
 * Absolute Windows PowerShell 5.1 executable path derived from SystemRoot.
 *
 * The Desktop supervisor delivers a child-only minimal environment that has
 * no PATH, and `powershell.exe` lives under
 * `System32\WindowsPowerShell\v1.0\` — outside the fixed directories
 * CreateProcess searches by default. Spawning the bare name therefore fails
 * in the production child even though it works in an interactive shell.
 * SystemRoot is part of the frozen minimal environment, so deriving the
 * absolute path keeps the child environment narrow while making the spawn
 * deterministic.
 */
export function resolvePowerShellExecutable(systemRoot = process.env.SystemRoot): string {
  if (systemRoot === undefined || systemRoot.trim().length === 0) {
    throw new Error("windows_powershell_system_root_missing");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}