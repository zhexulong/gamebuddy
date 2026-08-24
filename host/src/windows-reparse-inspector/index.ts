import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { createInspectorCapability, inspectorState, type WindowsReparseInspectorCapability } from "./internal.js";

export type { WindowsReparseInspectorCapability } from "./internal.js";

/** Mints the build-only capability. */
export async function createBuildWindowsReparseInspector(): Promise<WindowsReparseInspectorCapability> {
  return createInspectorCapability();
}

/** Mints the published-artifact capability from its fixed internal helper. */
export async function createPublishedWindowsReparseInspector(
  hostArtifactRoot: string,
): Promise<WindowsReparseInspectorCapability> {
  if (!isAbsolute(hostArtifactRoot)) throw unavailable();
  return createInspectorCapability();
}

/** Inspects an absolute path through a capability minted by one of the fixed policy constructors. */
export async function inspectWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<"regular" | "reparse"> {
  if (!isAbsolute(absolutePath)) throw unavailable();
  const state = inspectorState(capability);
  if (state === undefined) throw unavailable();
  try {
    if (state.customInspect) return await state.customInspect(absolutePath);
    const stats = await lstat(absolutePath);
    return stats.isSymbolicLink() ? "reparse" : "regular";
  } catch {
    throw unavailable();
  }
}

/** Rejects paths reported as reparse points by the inspector. */
export async function assertNoWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<void> {
  if ((await inspectWindowsReparse(capability, absolutePath)) === "reparse") throw unavailable();
}

function unavailable(): Error {
  return new Error("windows_reparse_inspection_unavailable");
}
