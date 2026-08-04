/**
 * Deterministic tier-decay curve (v2 cache architecture).
 *
 * Pure functions that select which paraphrase tier (P1..P4) renders for each
 * compartment, and which compartments are archived (P5, not rendered). These
 * REPLACE the LLM compressor and the per-compartment `compression_depth`
 * machinery: tier demotion is byte-deterministic at render time, driven by
 * compartment age, historian-emitted importance (semantically a *decay rate*),
 * and live budget pressure.
 *
 * This is a faithful implementation of the council-validated, empirically-
 * grounded model documented in `.alfonso/plans/decay-curve-formula.md`. The
 * hyperparameters, tier-cost constants, and log-cost boundary values come from
 * that document (boundaries derived from measured v8.3 Flash tier costs). The
 * model's invariants — age/importance monotonicity, finite demotion even at
 * importance 100, append stability, O(H) render cost, and budget self-tuning
 * across model/budget changes — were independently verified there.
 *
 * Anchor overlap (the archive-protection input `o`) is reserved for a future
 * release: anchors are not a reliable first-class storage primitive today (they
 * live inline in P4 text), so callers pass `0` and the archive predicate cleanly
 * reduces to `z >= Z4`. The parameter is kept so the wiring is ready when
 * anchor extraction lands.
 */

// === Hyperparameters (tuneable; council-recommended baselines) ===
/** Half-life (in compartments) for importance 50 at pressure 1. */
export const H50 = 24;
/** Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×). */
export const D = 25;
/** Max extra half-lives of P4 protection from full anchor overlap. */
export const G = 2;

// === Derived constants (from empirical tier costs — NOT tuneable by hand) ===
// Tier costs [c1..c5] = [322, 109, 35, 20, 5] (measured P1..P5 avg tokens,
// v8.3 Flash replay; P5 is the "[N archived]" placeholder cost). Z boundaries
// are the geometric means of adjacent costs in log-cost space (see formula §5).
export const Z1 = 0.201; // P1→P2
export const Z2 = 0.729; // P2→P3
export const Z3 = 1.322; // P3→P4
export const Z4 = 2.587; // P4→P5 (archive candidate)

/** Pressure floor: prevents div-by-zero and caps relaxation at 10×. */
export const P_FLOOR = 0.1;

/** Per-tier average token cost, indexed by tier number (1..5). Index 0 unused. */
export const TIER_COST = [0, 322, 109, 35, 20, 5] as const;

export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 * @param importance 1..100 (historian-emitted decay rate).
 * @param budgetPressure 0.10..∞ (computed once per pass via computeBudgetPressure).
 */
export function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    if (z < Z1) return 1;
    if (z < Z2) return 2;
    if (z < Z3) return 3;
    if (z < Z4) return 4;
    return 5;
}

/**
 * Whether a compartment should be archived (P5, not rendered). Anchor overlap
 * extends P4 protection by up to G half-lives; with `o = 0` (v2.0 default) this
 * reduces to `z >= Z4`.
 */
export function shouldArchive(
    compartmentIndex: number,
    importance: number,
    budgetPressure: number,
    anchorOverlap = 0,
): boolean {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);
    const o = Math.max(0, Math.min(1, anchorOverlap));

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    return z >= Z4 + G * o;
}

/**
 * Final rendered tier combining base tier + archive protection. Archived
 * compartments return 5; anchor-protected ones render at P4 (anchor-only)
 * instead of P5, preserving the topic until anchor overlap fades.
 */
export function renderedTier(
    compartmentIndex: number,
    importance: number,
    budgetPressure: number,
    anchorOverlap = 0,
): Tier {
    if (shouldArchive(compartmentIndex, importance, budgetPressure, anchorOverlap)) {
        return 5;
    }
    const base = tier(compartmentIndex, importance, budgetPressure);
    return Math.min(base, 4) as Tier;
}

/**
 * Compute budget pressure for a render pass in a single forward pass. Because
 * H ∝ 1/p, the count of compartments in each tier also scales as 1/p, so
 * C(p) ≈ C(1)/p; setting p = C(1)/B gives C(p) ≈ B. Overshoots up to ~30% at
 * very tight budgets (<8K) — use computeBudgetPressureTwoPass there.
 */
export function computeBudgetPressure(
    compartments: ReadonlyArray<{ index: number; importance: number }>,
    historyBudget: number,
): number {
    if (historyBudget <= 0) return 1;
    let naturalCost = 0;
    for (const c of compartments) {
        const naturalTier = tier(c.index, c.importance, 1.0);
        // Archived compartments render as an empty string, so charging the
        // historical P5 placeholder cost here creates phantom pressure from
        // bytes that will never appear in the prompt.
        naturalCost += naturalTier >= 5 ? 0 : TIER_COST[naturalTier];
    }
    return Math.max(P_FLOOR, naturalCost / historyBudget);
}

/**
 * Two-pass pressure for tight budgets — converges to within ~1% of budget at
 * ~2µs extra cost. Recompute actual cost at the single-pass pressure and, if it
 * still overshoots by >10%, scale pressure proportionally.
 */
export function computeBudgetPressureTwoPass(
    compartments: ReadonlyArray<{ index: number; importance: number }>,
    historyBudget: number,
): number {
    if (historyBudget <= 0) return 1;
    let p = computeBudgetPressure(compartments, historyBudget);
    let actualCost = 0;
    for (const c of compartments) {
        const actualTier = tier(c.index, c.importance, p);
        actualCost += actualTier >= 5 ? 0 : TIER_COST[actualTier];
    }
    if (actualCost > historyBudget * 1.1) {
        p = p * (actualCost / historyBudget);
    }
    return Math.max(P_FLOOR, p);
}
