import type { ChildProcess } from "node:child_process";

export type WindowsStardewFolderPickerCapability = object;
export type SpawnPicker = (command: string, args: readonly string[]) => ChildProcess;
export type PickerState = Readonly<{ executable: string; spawnPicker: SpawnPicker; allowNonWindows?: boolean; timeoutMs?: number }>;
const capabilities = new WeakSet<object>();
const states = new WeakMap<object, PickerState>();
export function createPickerCapability(state: PickerState): WindowsStardewFolderPickerCapability {
  const capability = Object.freeze({}); capabilities.add(capability); states.set(capability, state); return capability;
}
export function pickerState(capability: WindowsStardewFolderPickerCapability): PickerState | undefined {
  return capabilities.has(capability) ? states.get(capability) : undefined;
}
