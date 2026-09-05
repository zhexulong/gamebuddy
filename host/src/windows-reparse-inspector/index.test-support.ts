import type { ChildProcess } from "node:child_process";

import {
  createInspectorCapability,
  type SpawnHelper,
  type WindowsReparseInspectorCapability,
} from "./internal.js";

/** Test-compilation-only capability factory; production entry neither imports nor exposes it. */
export function createTestWindowsReparseInspector(spawnHelper: SpawnHelper): WindowsReparseInspectorCapability {
  return createInspectorCapability({ executable: "test-only-helper", inspectOnNonWindows: true, spawnHelper });
}

/** Test-compilation-only child factory type used by focused protocol tests. */
type TestWindowsReparseHelper = (...args: Parameters<SpawnHelper>) => ChildProcess;
