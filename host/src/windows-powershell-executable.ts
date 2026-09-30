import { join } from "node:path";

/**
 * Resolve the Windows PowerShell executable by absolute path.
 *
 * Several Host modules run a fixed PowerShell program (WMI process-identity
 * probes, the named-mutex sidecar, the companion control helper). Resolving a
 * bare `powershell.exe` through PATH is fragile for two independent reasons:
 *
 * - Windows caps a single environment variable at ~8191 characters. An inherited
 *   PATH that already exceeds the cap makes every `shell: true` (or PATH-resolved)
 *   launch fail with "not recognized", which surfaces as an unattributable
 *   child-exit code rather than the missing executable.
 * - A deliberately reduced PATH (a gate, a CI child, a service account) simply
 *   may not include the PowerShell directory.
 *
 * `SystemRoot` is the documented location of the installed PowerShell; without
 * it there is no safe guess and callers must fail with their own bounded code
 * rather than silently falling back to PATH.
 */
export function resolveWindowsPowerShell(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir;
  if (typeof systemRoot !== "string" || systemRoot.length === 0) return undefined;
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
