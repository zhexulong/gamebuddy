import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  brandRuntimeOwnerIdentity,
  type OpaqueRuntimeOwnerIdentity,
} from "./continuity-semantic-game-runtime-binding.internal.js";
import {
  brandWindowsRuntimeOwnerIdentityPort,
  type WindowsRuntimeOwnerIdentityPort,
} from "./continuity-semantic-game-runtime-binding.windows-owner-identity.internal.js";

export type { WindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.internal.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 5_000;
const MAX_QUERY_OUTPUT_BYTES = 256;
const OWNER_PROOF_LINE = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,19})\r?\n$/;

/**
 * Creates the production Host-TCB owner-proof port. The proof comes from the
 * operating system's immutable creation-time record for this exact Node
 * process; PID alone and wall-clock values are deliberately insufficient.
 */
export function createWindowsRuntimeOwnerIdentityPort(): WindowsRuntimeOwnerIdentityPort {
  return brandWindowsRuntimeOwnerIdentityPort({
    createCurrentProcessOwnerIdentity: async (): Promise<OpaqueRuntimeOwnerIdentity> => {
      if (process.platform !== "win32") throw new Error("windows_runtime_owner_identity_required");
      const processId = process.pid;
      if (!Number.isSafeInteger(processId) || processId <= 0)
        throw new Error("windows_runtime_owner_identity_required");
      const proof = await queryCurrentProcessCreationIdentity(processId);
      if (proof.processId !== processId) throw new Error("windows_runtime_owner_identity_mismatch");
      return brandRuntimeOwnerIdentity(proof);
    },
  });
}

async function queryCurrentProcessCreationIdentity(
  expectedProcessId: number,
): Promise<Readonly<{ processId: number; creationTime100ns: string }>> {
  // `expectedProcessId` is an already validated safe integer, so it is the
  // only interpolation in this otherwise fixed PowerShell program.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$expectedProcessId = ${expectedProcessId}`,
    "$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $expectedProcessId)",
    "if ($null -eq $processRecord) { throw 'process_not_found' }",
    "$creationTicks = ([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks",
    "[Console]::Out.WriteLine(([string]$processRecord.ProcessId + '|' + [string]$creationTicks))",
  ].join("; ");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_QUERY_OUTPUT_BYTES,
        encoding: "utf8",
      },
    );
    if (result.stderr.length !== 0) throw new Error("unexpected_windows_owner_identity_stderr");
    const match = OWNER_PROOF_LINE.exec(result.stdout);
    if (!match) throw new Error("invalid_windows_owner_identity_output");
    const processId = Number(match[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0 || match[2] === undefined)
      throw new Error("invalid_windows_owner_identity_output");
    return Object.freeze({ processId, creationTime100ns: match[2] });
  } catch {
    throw new Error("windows_runtime_owner_identity_query_failed");
  }
}
