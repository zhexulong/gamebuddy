import type { ChildProcess } from "node:child_process";

export type WindowsReparseInspectorCapability = object;
export type SpawnHelper = (command: string, args: readonly string[]) => ChildProcess;
export type InspectorState = Readonly<{
  spawnHelper: SpawnHelper;
  executable: string;
  inspectOnNonWindows?: boolean;
}>;

/**
 * The capability's state travels on the capability itself, under a symbol taken from
 * the GLOBAL symbol registry, rather than in a module-local registry.
 *
 * A module-local registry cannot work here. The production build holds two instances
 * of this module: the artifact builder imports the staged adapter file and mints a
 * capability, while the browser build's config loader bundles its own copy of the
 * same module. A WeakSet/WeakMap registry is per instance, so the second copy could
 * not recognise the first copy's capability, `inspectorState` answered undefined, and
 * every path inspection was refused with `windows_reparse_inspection_unavailable` -
 * a build failure that had nothing to do with the path being inspected.
 *
 * `Symbol.for` is registry-global, so both instances resolve the same key. The
 * property is non-enumerable and non-configurable on a frozen object, so the
 * capability still enumerates, spreads, and serialises as the empty object callers
 * see today, and no helper path or raw function is reachable by ordinary means.
 */
const INSPECTOR_STATE = Symbol.for("gamebuddy.windows-reparse-inspector.state.v1");

function isInspectorState(value: unknown): value is InspectorState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Partial<InspectorState>;
  if (typeof state.executable !== "string") return false;
  if (typeof state.spawnHelper !== "function") return false;
  const inspectOnNonWindows = state.inspectOnNonWindows;
  return inspectOnNonWindows === undefined || typeof inspectOnNonWindows === "boolean";
}

export function createInspectorCapability(state: InspectorState): WindowsReparseInspectorCapability {
  if (!isInspectorState(state)) throw new TypeError("windows_reparse_inspector_state_invalid");
  const capability: Record<symbol, unknown> = {};
  Object.defineProperty(capability, INSPECTOR_STATE, {
    value: Object.freeze({ ...state }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(capability);
}

export function inspectorState(capability: WindowsReparseInspectorCapability | undefined): InspectorState | undefined {
  if (capability === undefined || capability === null || typeof capability !== "object") return undefined;
  const state = (capability as Record<symbol, unknown>)[INSPECTOR_STATE];
  return isInspectorState(state) ? state : undefined;
}
