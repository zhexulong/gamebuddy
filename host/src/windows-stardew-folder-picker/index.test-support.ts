import { createPickerCapability, type SpawnPicker, type WindowsStardewFolderPickerCapability } from "./internal.js";
/** Test-compilation-only mint. */
export function createTestWindowsStardewFolderPicker(spawnPicker: SpawnPicker, timeoutMs?: number): WindowsStardewFolderPickerCapability {
  return createPickerCapability(timeoutMs === undefined
    ? { executable: "test-only-helper", spawnPicker, allowNonWindows: true }
    : { executable: "test-only-helper", spawnPicker, allowNonWindows: true, timeoutMs });
}
