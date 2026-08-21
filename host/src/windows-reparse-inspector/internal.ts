export type WindowsReparseInspectorCapability = object;
export type CustomInspect = (path: string) => Promise<"regular" | "reparse"> | "regular" | "reparse";
export type InspectorState = Readonly<{
  customInspect?: CustomInspect;
}>;

const capabilities = new WeakSet<object>();
const states = new WeakMap<object, InspectorState>();

export function createInspectorCapability(state: InspectorState = {}): WindowsReparseInspectorCapability {
  const capability = Object.freeze({});
  capabilities.add(capability);
  states.set(capability, state);
  return capability;
}

export function inspectorState(capability: WindowsReparseInspectorCapability | undefined): InspectorState | undefined {
  return capability === undefined || !capabilities.has(capability) ? undefined : states.get(capability);
}
