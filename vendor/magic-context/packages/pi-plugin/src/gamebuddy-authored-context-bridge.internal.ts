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
export function publishGameBuddyAuthoredStableCatalog(scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability {
  const existing = __gamebuddyReadAuthoredMaterialization(scope.sessionId);
  if (existing !== undefined && !sameScope(existing.scope, scope))
    throw new Error("gamebuddy_authored_context_scope_conflict");
  const checked = validateGameBuddyAuthoredStableCatalog(catalog, scope);
  const materialization = materializeGameBuddyAuthoredStableCatalog(checked, scope);
  __gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialization);
  let active = true;
  const assertCurrent = (): void => {
    if (!active) throw new Error("gamebuddy_authored_context_cleared");
    if (__gamebuddyReadAuthoredMaterialization(scope.sessionId) !== materialization) {
      throw new Error("gamebuddy_authored_context_stale_superseded");
    }
  };
  const capability: TavernAuthoredContextRuntimeCapability = Object.freeze({
    prepare(id) {
      ids(id, "transient_preflight_id"); assertCurrent();
      return Object.freeze({ sourceRefs: Object.freeze(materialization.sources.map(({ content: _, budgetTokens: __, provenance: ___, ...ref }) => Object.freeze(ref))), stableTokenCount: materialization.budgetTokens });
    },
    assertInstall(turnId, refs) {
      ids(turnId, "durable_turn_id");
      assertCurrent();
      // A publication replacement supersedes every capability minted for the
      // previous revision. Do not let an old closed-over value install stale refs.
      // The renderer owner deliberately exposes no session lookup; this identity
      // check is performed by the capability itself.
      const expected = materialization.sources.map(({ content: _, budgetTokens: __, provenance: ___, ...ref }) => ref);
      if (refs.length !== expected.length || refs.some((r, i) => JSON.stringify(r) !== JSON.stringify(expected[i]))) throw new Error("gamebuddy_authored_context_plan_mismatch");
    },
    async clear() { if (!active) return; active = false; __gamebuddyClearAuthoredMaterialization(scope.sessionId, materialization); },
  });
  return capability;
}
