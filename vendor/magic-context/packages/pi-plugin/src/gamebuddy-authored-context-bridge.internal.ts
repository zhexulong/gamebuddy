import {
  __gamebuddyReplaceAuthoredMaterialization,
  __gamebuddyClearAuthoredMaterialization,
  __gamebuddyReadAuthoredMaterialization,
  materializeGameBuddyAuthoredStableCatalog,
  validateGameBuddyAuthoredStableCatalog,
  type GameBuddyAuthoredStableCatalog,
  type GameBuddyAuthoredStablePlanProjection,
  type GameBuddyAuthoredStableSourceRef,
  type GameBuddyChatContextScope,
} from "./gamebuddy-stable-context-source";

export type TavernAuthoredContextRuntimeCapability = Readonly<{
  prepare(transientPreflightId: string): GameBuddyAuthoredStablePlanProjection;
  assertInstall(durableTurnId: string, refs: readonly GameBuddyAuthoredStableSourceRef[]): void;
  clear(): Promise<void>;
}>;
const ids = (v: string, field: string) => { if (!/^[A-Za-z0-9._-]{1,128}$/.test(v)) throw new Error(`invalid_${field}`); };
const sameScope = (left: GameBuddyChatContextScope, right: GameBuddyChatContextScope): boolean =>
  left.continuityId === right.continuityId &&
  left.sessionId === right.sessionId &&
  left.surface === right.surface &&
  left.threadId === right.threadId &&
  left.profile.profileId === right.profile.profileId &&
  left.profile.revision === right.profile.revision &&
  left.profile.canonicalHash === right.profile.canonicalHash;
type CapabilityEntry = { readonly scope: GameBuddyChatContextScope; readonly materialization: ReturnType<typeof materializeGameBuddyAuthoredStableCatalog>; active: boolean };
const capabilityEntries = new WeakMap<object, CapabilityEntry>();

function mintCapability(scope: GameBuddyChatContextScope, materialization: ReturnType<typeof materializeGameBuddyAuthoredStableCatalog>): TavernAuthoredContextRuntimeCapability {
  const entry: CapabilityEntry = { scope, materialization, active: true };
  let capability!: TavernAuthoredContextRuntimeCapability;
  const assertCurrent = (): void => {
    if (!entry.active) throw new Error("gamebuddy_authored_context_cleared");
    if (__gamebuddyReadAuthoredMaterialization(scope.sessionId) !== entry.materialization) throw new Error("gamebuddy_authored_context_stale_superseded");
  };
  capability = Object.freeze({
    prepare(id) { ids(id, "transient_preflight_id"); assertCurrent(); return Object.freeze({ sourceRefs: Object.freeze(entry.materialization.sources.map(({ content: _, budgetTokens: __, provenance: ___, ...ref }) => Object.freeze(ref))), stableTokenCount: entry.materialization.budgetTokens }); },
    assertInstall(turnId, refs) { ids(turnId, "durable_turn_id"); assertCurrent(); const expected = entry.materialization.sources.map(({ content: _, budgetTokens: __, provenance: ___, ...ref }) => ref); if (refs.length !== expected.length || refs.some((r, i) => JSON.stringify(r) !== JSON.stringify(expected[i]))) throw new Error("gamebuddy_authored_context_plan_mismatch"); },
    async clear() { if (!entry.active) return; entry.active = false; __gamebuddyClearAuthoredMaterialization(scope.sessionId, entry.materialization); },
  });
  capabilityEntries.set(capability as object, entry);
  return capability;
}

export function publishGameBuddyAuthoredStableCatalog(scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability {
  const existing = __gamebuddyReadAuthoredMaterialization(scope.sessionId);
  if (existing !== undefined && !sameScope(existing.scope, scope)) throw new Error("gamebuddy_authored_context_scope_conflict");
  const checked = validateGameBuddyAuthoredStableCatalog(catalog, scope);
  const materialization = materializeGameBuddyAuthoredStableCatalog(checked, scope);
  __gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialization);
  return mintCapability(scope, materialization);
}

/** Construction-private atomic replacement. Only the current capability may replace its exact mount. */
export function replaceGameBuddyAuthoredStableCatalog(currentCapability: TavernAuthoredContextRuntimeCapability, scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability {
  const entry = capabilityEntries.get(currentCapability as object);
  if (entry === undefined || !entry.active || !sameScope(entry.scope, scope) || __gamebuddyReadAuthoredMaterialization(scope.sessionId) !== entry.materialization) throw new Error("gamebuddy_authored_context_replacement_rejected");
  const checked = validateGameBuddyAuthoredStableCatalog(catalog, scope);
  const materialization = materializeGameBuddyAuthoredStableCatalog(checked, scope);
  // Validate the complete replacement before invalidating the current capability.
  // The registry remains unchanged if catalog validation/materialization fails.
  entry.active = false;
  __gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialization);
  return mintCapability(scope, materialization);
}
/* Replacement invalidates the old capability before installing the new one. */
