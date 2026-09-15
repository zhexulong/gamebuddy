import type { ProductionGameSessionWorldBinding } from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";

const INTEGRATION_ID = "stardew";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Integration-private reader contract for world binding resolution.
 * Accepting an async function instead of a full store or coordinator authority
 * keeps the resolver seam testable without the Windows mutex or coordinator
 * machinery, while production wires it through the game authority's
 * readGameSessionWorldBinding.
 */
export type WorldBindingReader = (
  input: Readonly<{ gameSessionId: string; integrationId: string }>,
) => Promise<ProductionGameSessionWorldBinding | null>;

/**
 * Typed outcome for an integration-private world binding resolve attempt.
 * The bindingRef is opaque — the resolver never interprets its content.
 * - `missing_or_foreign`: no binding for this (gameSessionId, integrationId)
 *   pair, or the session belongs to a different integration.
 * - `terminal`: the binding was marked terminal; the world is no longer
 *   available for resume.
 */
export type StardewWorldBindingResolveOutcome = Readonly<
  | { ok: true; binding: ProductionGameSessionWorldBinding }
  | { ok: false; reason: "missing_or_foreign" | "terminal" }
>;

/**
 * Integration-private Stardew world binding resolver.
 * It consumes only the frozen opaque bindingRef from the semantic SQLite store.
 * It never scans PIDs, paths, windows, save files, or startup time.
 * It introduces no second store, second authority, generation, lease, CAS,
 * or proof layer.
 */
export type StardewWorldBindingResolver = Readonly<{
  resolveWorldBinding(gameSessionId: string): Promise<StardewWorldBindingResolveOutcome>;
}>;

/**
 * Creates a Stardew-private world binding resolver over the given reader.
 * The reader is expected to delegate to
 * `SemanticGameProductionAuthority.readGameSessionWorldBinding`.
 *
 * Use `createStardewWorldBindingResolverFromGameAuthority` for production
 * composition where the full game authority is available.
 */
export function createStardewWorldBindingResolver(
  readBinding: WorldBindingReader,
): StardewWorldBindingResolver {
  if (typeof readBinding !== "function")
    throw new Error("invalid_stardew_world_binding_resolver_reader");
  return Object.freeze({
    resolveWorldBinding: async (gameSessionId: string): Promise<StardewWorldBindingResolveOutcome> => {
      if (typeof gameSessionId !== "string" || !SAFE_ID_PATTERN.test(gameSessionId))
        return Object.freeze({ ok: false, reason: "missing_or_foreign" });
      const binding = await readBinding({
        gameSessionId,
        integrationId: INTEGRATION_ID,
      });
      if (binding === null) return Object.freeze({ ok: false, reason: "missing_or_foreign" });
      if (binding.status === "terminal") return Object.freeze({ ok: false, reason: "terminal" });
      return Object.freeze({ ok: true, binding });
    },
  });
}

/**
 * Production composition convenience wrapper that adapts the full
 * SemanticGameProductionAuthority into the resolver's required reader.
 */
export function createStardewWorldBindingResolverFromGameAuthority(
  game: SemanticGameProductionAuthority,
): StardewWorldBindingResolver {
  if (typeof game?.readGameSessionWorldBinding !== "function")
    throw new Error("invalid_stardew_world_binding_resolver_authority");
  return createStardewWorldBindingResolver(
    (input) => game.readGameSessionWorldBinding(input),
  );
}