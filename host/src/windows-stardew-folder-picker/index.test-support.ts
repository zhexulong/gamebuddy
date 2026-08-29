import { createPickerCapability, type SpawnPicker, type WindowsStardewFolderPickerCapability } from "./internal.js";
/** Test-compilation-only mint. */
export function createTestWindowsStardewFolderPicker(spawnPicker: SpawnPicker, timeoutMs?: number): WindowsStardewFolderPickerCapability {
  return createPickerCapability({ executable: "test-only-helper", spawnPicker, allowNonWindows: true, timeoutMs });
}
