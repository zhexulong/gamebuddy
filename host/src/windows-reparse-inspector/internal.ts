import type { ChildProcess } from "node:child_process";

export type WindowsReparseInspectorCapability = object;
export type SpawnHelper = (command: string, args: readonly string[]) => ChildProcess;
export type InspectorState = Readonly<{
  spawnHelper: SpawnHelper;
  executable: string;
  inspectOnNonWindows?: boolean;
}>;

const capabilities = new WeakSet<object>();
const states = new WeakMap<object, InspectorState>();

export function createInspectorCapability(state: InspectorState): WindowsReparseInspectorCapability {
  const capability = Object.freeze({});
  capabilities.add(capability);
  states.set(capability, state);
  return capability;
}

export function inspectorState(capability: WindowsReparseInspectorCapability | undefined): InspectorState | undefined {
  return capability === undefined || !capabilities.has(capability) ? undefined : states.get(capability);
}
