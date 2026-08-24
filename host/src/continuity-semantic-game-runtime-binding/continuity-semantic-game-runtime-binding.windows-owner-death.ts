import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProductionGameOwner } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  mintWindowsOwnerDeathVerification,
  type WindowsOwnerDeathOutcome,
  type WindowsOwnerDeathVerification,
} from "./continuity-semantic-game-runtime-binding.windows-owner-death.internal.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 5_000;
const MAX_QUERY_OUTPUT_BYTES = 256;
const OWNER_LINE = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,19})\r?\n$/;

export type WindowsOwnerDeathVerifier = Readonly<{
  verify(owner: ProductionGameOwner): Promise<WindowsOwnerDeathVerification>;
}>;

/**
 * Production owner-death evidence comes only from a fresh Windows OS query.
 * The verifier intentionally reports no optimistic outcome: unavailable,
 * reused PID, malformed output, and query ambiguity all fail closed.
 */
export function createWindowsOwnerDeathVerifier(): WindowsOwnerDeathVerifier {
  return Object.freeze({
    async verify(owner: ProductionGameOwner): Promise<WindowsOwnerDeathVerification> {
      if (process.platform !== "win32") return mintWindowsOwnerDeathVerification(owner, "unavailable");
      const outcome = await queryOwner(owner);
      return mintWindowsOwnerDeathVerification(owner, outcome);
    },
  });
}

async function queryOwner(owner: ProductionGameOwner): Promise<WindowsOwnerDeathOutcome> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$expectedProcessId = ${owner.ownerPid}`,
    "$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $expectedProcessId)",
    "if ($null -eq $processRecord) { exit 17 }",
    "$creationTicks = ([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks",
    "[Console]::Out.WriteLine(([string]$processRecord.ProcessId + '|' + [string]$creationTicks))",
  ].join("; ");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_QUERY_OUTPUT_BYTES, encoding: "utf8" },
    );
    if (result.stderr.length !== 0) return "ambiguous";
    const match = OWNER_LINE.exec(result.stdout);
    if (!match) return "ambiguous";
    if (Number(match[1]) !== owner.ownerPid) return "mismatch";
    return match[2] === owner.ownerProcessStartIdentity ? "alive" : "mismatch";
  } catch (error: unknown) {
    // PowerShell's explicit missing-process exit is the sole positive death
    // result. Every other process/query error remains unavailable.
    return isMissingProcessExit(error) ? "proven_dead" : "unavailable";
  }
}

function isMissingProcessExit(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 17;
}
