import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  mintWindowsOwnerDeathVerification,
  type OwnerDeathSubject,
  type WindowsOwnerDeathOutcome,
  type WindowsOwnerDeathVerification,
} from "./continuity-semantic-owner-death.internal.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 5_000;
const MAX_QUERY_OUTPUT_BYTES = 256;
const OWNER_LINE = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,18})\r?\n$/;

type WindowsOwnerQueryResult = Readonly<{ stdout: string; stderr: string }>;
type WindowsOwnerQueryExecutor = (owner: OwnerDeathSubject) => Promise<WindowsOwnerQueryResult>;

export type WindowsOwnerDeathVerifier = Readonly<{
  verify(owner: OwnerDeathSubject): Promise<WindowsOwnerDeathVerification>;
}>;
export type WindowsOwnerDeathVerifierOptions = Readonly<{
  platform?: NodeJS.Platform;
  executeOwnerQuery?: WindowsOwnerQueryExecutor;
}>;

/** Production evidence comes only from a fresh Windows OS owner query. */
export function createWindowsOwnerDeathVerifier(options: WindowsOwnerDeathVerifierOptions = {}): WindowsOwnerDeathVerifier {
  const platform = options.platform ?? process.platform;
  const executeOwnerQuery = options.executeOwnerQuery ?? executeWindowsOwnerQuery;
  return Object.freeze({
    async verify(owner: OwnerDeathSubject): Promise<WindowsOwnerDeathVerification> {
      if (platform !== "win32") return mintWindowsOwnerDeathVerification(owner, "unavailable");
      return mintWindowsOwnerDeathVerification(owner, await queryOwner(owner, executeOwnerQuery));
    },
  });
}

async function queryOwner(owner: OwnerDeathSubject, executeOwnerQuery: WindowsOwnerQueryExecutor): Promise<WindowsOwnerDeathOutcome> {
  try {
    const result = await executeOwnerQuery(owner);
    if (result.stderr.length !== 0) return "ambiguous";
    const match = OWNER_LINE.exec(result.stdout);
    if (!match) return "ambiguous";
    if (Number(match[1]) !== owner.ownerPid) return "mismatch";
    return match[2] === owner.ownerProcessStartIdentity ? "alive" : "mismatch";
  } catch (error: unknown) {
    return isMissingProcessExit(error) ? "proven_dead" : "unavailable";
  }
}

async function executeWindowsOwnerQuery(owner: OwnerDeathSubject): Promise<WindowsOwnerQueryResult> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$expectedProcessId = ${owner.ownerPid}`,
    "$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $expectedProcessId)",
    "if ($null -eq $processRecord) { exit 17 }",
    "$creationTicks = ([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks",
    "[Console]::Out.WriteLine(([string]$processRecord.ProcessId + '|' + [string]$creationTicks))",
  ].join("; ");
  return execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_QUERY_OUTPUT_BYTES, encoding: "utf8" },
  );
}

function isMissingProcessExit(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 17;
}
