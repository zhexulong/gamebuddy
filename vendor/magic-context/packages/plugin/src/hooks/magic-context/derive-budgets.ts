/**
 * Budget derivation
 *
 * Two scaling bases, two clamps. Replaces the old static
 * `compartment_token_budget` setting which tried to serve both roles
 * and scaled with neither model.
 *
 *   - triggerBudget: scales with (main model × executeThreshold).
 *     Drives size-based historian triggers (`tail_size`, `commit_clusters`).
 *     "How big can the uncompartmentalized tail get before we force
 *     historian to run." This is anchored to the MAIN model's usable
 *     working space, not its total context.
 *
 *   - historianChunkTokens: scales with the HISTORIAN model's context.
 *     The raw-history window historian processes per call. Different
 *     scaling basis because historian is a single-shot summarizer bound
 *     by its own context, not the main session's pressure math.
 */

import { getSdkContextLimit } from "../../shared/models-dev-cache";

// 5% of (main_context × execute_threshold) is the "working usable × 5%" basis.
// This preserves the legacy static behavior for 1M × 40% (60K tail_size ≈ 15%
// of usable) while fixing the small-context regression where the old 60K tail
// threshold was 72% of usable on 128K × 65%.
const TRIGGER_BUDGET_PERCENTAGE = 0.05;
const TRIGGER_BUDGET_MIN = 5_000;
const TRIGGER_BUDGET_MAX = 50_000;

const HISTORIAN_CHUNK_PERCENTAGE = 0.25;
const HISTORIAN_CHUNK_MIN = 8_000;
const HISTORIAN_CHUNK_MAX = 50_000;

const DEFAULT_HISTORIAN_CONTEXT_FALLBACK = 128_000;

/**
 * Budget basis for size-based historian triggers (tail_size, commit_clusters).
 * Anchored to the MAIN model's usable working space, not its total context.
 *
 * @param mainContextLimit Main session model's context window (tokens).
 * @param executeThresholdPercentage The effective execute threshold (0-100).
 */
export function deriveTriggerBudget(
    mainContextLimit: number,
    executeThresholdPercentage: number,
): number {
    if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
        return TRIGGER_BUDGET_MIN;
    }
    // Callers resolve executeThresholdPercentage through resolveExecuteThreshold(),
    // which caps at MAX_EXECUTE_THRESHOLD (80). We still guard against negative
    // inputs so derived budgets never go upside-down, but the upper clamp is
    // not needed and was dead defensively.
    const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
    const usable = mainContextLimit * thresholdFraction;
    const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
    return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

/**
 * Raw-history chunk budget for historian's own context window.
 * Historian formats tool calls as compact `TC:` summaries and drops tool results,
 * so a 50K-token chunk typically represents far more raw messages than its token
 * count implies. The max is tuned around that compression.
 *
 * @param historianContextLimit Historian model's context window (tokens).
 */
export function deriveHistorianChunkTokens(historianContextLimit: number): number {
    if (!Number.isFinite(historianContextLimit) || historianContextLimit <= 0) {
        return HISTORIAN_CHUNK_MIN;
    }
    const derived = Math.round(historianContextLimit * HISTORIAN_CHUNK_PERCENTAGE);
    return Math.max(HISTORIAN_CHUNK_MIN, Math.min(HISTORIAN_CHUNK_MAX, derived));
}

/**
 * Resolve the historian model's context limit for chunk budget sizing.
 *
 * Behavior:
 *   - If `historianModelOverride` is a full `provider/model-id` → use that model's
 *     context directly. This honors explicit user intent.
 *   - If the override is set but lacks `/` (e.g. `"llama3-32k"`) → warn and use
 *     the conservative default, since we can't look up a model without a
 *     provider and silently guessing would produce an incorrect chunk size.
 *   - If no override (or the model is unknown to models.dev / opencode.json
 *     custom providers) → 128K conservative default.
 *
 * Context limits are resolved through `getSdkContextLimit`, which reads
 * OpenCode's SDK-resolved provider config (models.dev + snapshot + opencode.json
 * overrides + auth-plugin caps), bounded to a sane range.
 */
export function resolveHistorianContextLimit(historianModelOverride?: string): number {
    // Explicit override with full provider/model form — user intent wins.
    if (typeof historianModelOverride === "string" && historianModelOverride.includes("/")) {
        const [providerID, ...rest] = historianModelOverride.split("/");
        const modelID = rest.join("/");
        if (providerID && modelID) {
            const limit = getSdkContextLimit(providerID, modelID);
            if (typeof limit === "number" && limit > 0) return limit;
        }
        return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
    }

    // Malformed override (no provider prefix): surface at log level, not a crash,
    // and use the conservative default for chunk-budget derivation.
    if (typeof historianModelOverride === "string" && historianModelOverride.trim() !== "") {
        // eslint-disable-next-line no-console
        console.warn(
            `[magic-context] historian.model "${historianModelOverride}" lacks provider prefix ("provider/model-id"); using the default context limit for chunk-budget derivation.`,
        );
    }

    return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
}
