import { mkdir, writeFile } from "node:fs/promises";
import { win32 } from "node:path";

import type { DesktopHostReclamationStepOutcome } from "../../composition/desktop-host-reclamation.js";

/**
 * The one diagnostic a Desktop Host launch leaves behind for an operator when it
 * does not end cleanly.
 *
 * It is written as one small JSON document under
 * `<operationalRoot>\host-exit\host-exit-<utc>-<pid>.json`, i.e. beside the
 * deployment manifest the Desktop already owns under the validated
 * `%LOCALAPPDATA%\GameBuddy\operational` root. It is a DIAGNOSTIC, not durable
 * product state: nothing reads it back into the running product, and an operator
 * or a support run may delete it at any time.
 *
 * Every field is a bounded token or a number BY CONSTRUCTION: the exit reason,
 * the per-step outcomes, the process id and the time. It deliberately carries no
 * path, no bridge pipe name or token, no provider credential, no player text and
 * no stack, so it can be handed to an operator without a second redaction pass.
 */
export const DESKTOP_HOST_EXIT_RECORD_SCHEMA = "gamebuddy-desktop-host-exit-record/v1";

/** The directory name under the operational root; the launcher/docs name this same literal. */
export const DESKTOP_HOST_EXIT_RECORD_DIRECTORY = "host-exit";

export type DesktopHostExitKind = "incomplete_exit" | "crash";

export type DesktopHostExitRecordStep = Readonly<{
  step: string;
  status: string;
  failure: string | null;
}>;

export type DesktopHostExitRecord = Readonly<{
  schema: typeof DESKTOP_HOST_EXIT_RECORD_SCHEMA;
  version: 1;
  kind: DesktopHostExitKind;
  reason: string;
  pid: number;
  recordedAtUnixMs: number;
  steps: readonly DesktopHostExitRecordStep[];
}>;

const boundedToken = /^[a-z][a-z0-9_.:-]{1,159}$/;

/** Whether one value is already in the only shape the record may carry. */
export function isBoundedExitToken(value: string): boolean {
  return boundedToken.test(value);
}

/**
 * Builds the record. Any value that is not already a bounded token is replaced
 * rather than copied, so a caller cannot smuggle a path, a credential or player
 * text into the diagnostic through a step name or a failure code.
 */
export function buildDesktopHostExitRecord(
  input: Readonly<{
    kind: DesktopHostExitKind;
    reason: string;
    pid: number;
    recordedAtUnixMs: number;
    steps: readonly DesktopHostReclamationStepOutcome[];
  }>,
): DesktopHostExitRecord {
  return Object.freeze({
    schema: DESKTOP_HOST_EXIT_RECORD_SCHEMA,
    version: 1,
    kind: input.kind,
    reason: isBoundedExitToken(input.reason) ? input.reason : "desktop_host_exit_unattributed",
    pid: input.pid,
    recordedAtUnixMs: input.recordedAtUnixMs,
    steps: Object.freeze(
      input.steps.map((outcome) =>
        Object.freeze({
          step: isBoundedExitToken(outcome.step) ? outcome.step : "unknown_step",
          status: outcome.status,
          failure: outcome.failure !== null && isBoundedExitToken(outcome.failure) ? outcome.failure : null,
        }),
      ),
    ),
  });
}

/** The one file name a record gets; the UTC stamp sorts chronologically and the pid disambiguates. */
export function desktopHostExitRecordFileName(record: DesktopHostExitRecord): string {
  const stamp = new Date(record.recordedAtUnixMs).toISOString().replace(/[:.]/g, "-");
  return `host-exit-${stamp}-${record.pid}.json`;
}

/**
 * Writes one record and returns its path, or null when it could not be written.
 * A diagnostic that cannot be written is never allowed to become a second
 * failure of the exit it describes, so this never throws.
 */
export async function writeDesktopHostExitRecord(
  directory: string,
  record: DesktopHostExitRecord,
): Promise<string | null> {
  const path = win32.join(directory, desktopHostExitRecordFileName(record));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    return path;
  } catch {
    return null;
  }
}

/** Builds and writes in one call; the two halves above stay separately testable. */
export async function recordDesktopHostExit(
  directory: string,
  input: Readonly<{
    kind: DesktopHostExitKind;
    reason: string;
    pid: number;
    recordedAtUnixMs: number;
    steps: readonly DesktopHostReclamationStepOutcome[];
  }>,
): Promise<string | null> {
  return await writeDesktopHostExitRecord(directory, buildDesktopHostExitRecord(input));
}
