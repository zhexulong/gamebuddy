import type { ChildProcess } from "node:child_process";

export type WindowsStaleLockReclaimerCapability = object;
export type SpawnHelper = (command: string, args: readonly string[]) => ChildProcess;
export type ReclaimerState = Readonly<{
  spawnHelper: SpawnHelper;
  executable: string;
  reclaimOnNonWindows?: boolean;
}>;

const capabilities = new WeakSet<object>();
const states = new WeakMap<object, ReclaimerState>();

export function createReclaimerCapability(state: ReclaimerState): WindowsStaleLockReclaimerCapability {
  const capability = Object.freeze({});
  capabilities.add(capability);
  states.set(capability, state);
  return capability;
}

export function reclaimerState(capability: WindowsStaleLockReclaimerCapability | undefined): ReclaimerState | undefined {
  return capability === undefined || !capabilities.has(capability) ? undefined : states.get(capability);
}
