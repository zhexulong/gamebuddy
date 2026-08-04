// Tiered target-headroom emergency tool-output drop (Phase 2).
//
// This is the EMERGENCY floor that replaces the old `dropAllTools` nuke at the
// 85% force-materialize pass. It is need-aware (tier-ordered) and target-driven
// (reclaim down to ~30% of working space) instead of need-blind ("drop all" /
// "older than X"). Selection is PURE here; the harness applies the returned
// plan (drop primitive + `updateTagStatus(...,"dropped")` + watermark persist),
// so OpenCode and Pi run identical selection logic.
//
// CACHE CONTRACT (see .alfonso/plans/ctx-reduce-phase2-v3.md):
//   - The caller MUST invoke this only on the ≥85% force-materialize pass (a
//     cache-busting pass, never a defer pass).
//   - Each tag is dropped AT MOST ONCE: candidates are gated on
//     `tagNumber > priorWatermark` AND `status==="active"`, and the watermark
//     advances past every dropped tag. So the number of drop-induced cache
//     busts over a session is bounded by the tool-tag count — no oscillation.
//   - All accounting is in TOKENS. Tags store BYTES, so we convert with the one
//     canonical estimator (`TOKENS_PER_BYTE`, shared with the Phase 1 nudge).

import { TOKENS_PER_BYTE } from "./ctx-reduce-nudge";

/** Reclaim target = fixedFloor + TARGET_FRACTION × (ceiling − fixedFloor). */
export const TARGET_FRACTION = 0.3;

/** Keep the newest `ceil(RESERVE × tierCount)` of T1/T2 as continuation context. */
export const TIER_RECENCY_RESERVE = 0.2;

/**
 * Don't bust the cache for a trivial reclaim. If the computed reclaim is at or
 * below this, the pass is a no-op (combined with the watermark, this prevents
 * 85%-94.9% oscillation).
 */
export const EMERGENCY_REARM_MIN_TOKENS = 2000;

export type Tier = 1 | 2 | 3;

// Tier keys are matched against the normalized (lowercased, `mcp_`-stripped)
// tool name. Verified against the production tag corpus: stored `tool_name`
// values are bare (`read`, `edit`, `bash`, …) with no `mcp_` prefix; the strip
// is defensive insurance for environments that surface MCP-prefixed names.
const T1_TOOLS = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom"]);
const T2_TOOLS = new Set(["edit", "write", "apply_patch", "grep", "glob", "aft_search"]);

/** Normalize a stored tool name for tier matching. */
function normalizeToolName(toolName: string | null): string {
    if (!toolName) return "";
    let name = toolName.toLowerCase();
    if (name.startsWith("mcp_")) name = name.slice(4);
    return name;
}

/**
 * Classify a tool into its drop tier. T1 (keep longest) = navigation/structure
 * the agent re-uses; T2 (medium) = edit-class continuation context; T3 (drop
 * first) = everything else (the default — bash, ctx_reduce, inspect, web, …).
 */
export function resolveToolTier(toolName: string | null): Tier {
    const name = normalizeToolName(toolName);
    if (T1_TOOLS.has(name)) return 1;
    if (T2_TOOLS.has(name)) return 2;
    return 3;
}

/** Minimal tag shape the planner needs (subset of TagEntry, harness-agnostic). */
export interface EmergencyDropTag {
    tagNumber: number;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    toolName: string | null;
    byteSize: number;
    /** Tool-arg bytes — `drop()` removes the invocation too, so these reclaim. */
    inputByteSize: number;
    reasoningByteSize: number;
}

/**
 * Bytes a drop actually reclaims for a tool tag: output + invocation args +
 * preceding reasoning (the drop primitive removes all tool occurrences and
 * clears the thinking parts). Used for BOTH the fixedFloor tail sum and the
 * per-tag reclaim accumulator so they can never disagree (a mismatch is how
 * the planner under-evicts into overflow).
 */
function tagReclaimBytes(tag: EmergencyDropTag): number {
    return tag.byteSize + tag.inputByteSize + tag.reasoningByteSize;
}

export interface EmergencyDropPlan {
    /** Whether the caller should perform any drop this pass. */
    shouldDrop: boolean;
    /** Tool tag numbers to drop, in eviction order (T3→T2→T1, oldest-first). */
    tagNumbers: number[];
    /** Reclaim target in tokens (for logging). */
    reclaimTokens: number;
    /** Human-readable reason (no-op explanation or drop summary), for logs. */
    reason: string;
}

export function estimateEmergencyDropReclaimTokens(tag: EmergencyDropTag): number {
    return Math.round(tagReclaimBytes(tag) * TOKENS_PER_BYTE);
}

/**
 * Plan a tiered target-headroom emergency drop. Pure: returns the ordered set of
 * tool tag numbers to drop plus the new watermark; the caller applies them.
 *
 * fixedFloor is derived as `currentTotalInputTokens − Σ(active floor-tag tokens)`.
 * Tags cover exactly the live-tail content (messages, tool outputs, files,
 * reasoning); system, tool defs, and m[0]/m[1] are untagged. So this difference
 * IS `system + toolDefs + (primary ? m0 + m1 : 0)` — the irreducible prefix —
 * with no extra plumbing, and it self-adjusts for subagents (no m0/m1 in their
 * total) by construction.
 *
 * The two tag sets serve DIFFERENT contracts and must not be conflated:
 * - `floorTags`: the ENTIRE active live-window tag set (all types, including
 *   non-droppable tool tags). Only their token sum matters — it makes
 *   `fixedFloor` the true irreducible prefix. Passing a narrower set (e.g.
 *   tool-only) folds real conversation/reasoning tail into the "floor",
 *   raising the target and systematically under-evicting at ≥85%.
 * - `tags`: the evictable candidates — active tool tags whose drop target
 *   would actually reclaim bytes (caller pre-filters on `canDrop()` so no
 *   phantom tag is counted as reclaimed).
 */
export function planEmergencyDrop(input: {
    /** Evictable candidates: active tool tags with a working drop target. */
    tags: readonly EmergencyDropTag[];
    /**
     * FULL active live-window tag set (all types) — floor accounting only.
     * See the fixedFloor contract above.
     */
    floorTags: readonly EmergencyDropTag[];
    maxTag: number;
    protectedTags: number;
    currentTotalInputTokens: number;
    /** ceiling = contextLimit × executeThreshold%. */
    ceilingTokens: number;
    /**
     * last_emergency_input_sample — the `currentTotalInputTokens` reading at the
     * previous emergency drop (0 if never dropped). The SOLE idempotence latch:
     * see the same-sample no-op below. (There is deliberately no tag-number
     * watermark — a scalar "dropped-through" cursor wrongly excludes still-active
     * lower-numbered tags after a non-contiguous tier-ordered drop. Dropped tags
     * leave the `status='active'` set, so they're never re-selected; the sample
     * latch is what prevents over-dropping the rest of the tail on a stale pass.)
     */
    priorInputSample: number;
    /** True once any emergency drop has happened (drives the latch + log). */
    hasPriorDrop: boolean;
}): EmergencyDropPlan {
    const {
        tags,
        floorTags,
        maxTag,
        protectedTags,
        currentTotalInputTokens,
        ceilingTokens,
        priorInputSample,
        hasPriorDrop,
    } = input;

    const noop = (reason: string): EmergencyDropPlan => ({
        shouldDrop: false,
        tagNumbers: [],
        reclaimTokens: 0,
        reason,
    });

    // Guard: unknown / not-yet-resolved context limit → skip (the 95% block is
    // the backstop). Never guess a limit.
    if (!Number.isFinite(ceilingTokens) || ceilingTokens <= 0) {
        return noop("unknown-ceiling");
    }
    if (!Number.isFinite(currentTotalInputTokens) || currentTotalInputTokens <= 0) {
        return noop("unknown-usage");
    }

    // Idempotence latch. After a drop the wire is reduced, but the provider
    // hasn't re-measured it — `currentTotalInputTokens` stays at the pre-drop
    // value until the next assistant response. A second ≥85% pass on that SAME
    // stale reading would recompute the floor from the now-smaller active tail
    // and over-drop the rest of the tail (busting the cache again). So once we
    // have dropped at a given usage sample, no-op until a FRESH sample arrives
    // (the reading changes). New measured pressure ⇒ different sample ⇒ release.
    if (hasPriorDrop && currentTotalInputTokens === priorInputSample) {
        return noop("same-input-sample (awaiting fresh usage after prior drop)");
    }

    // fixedFloor from the FULL active live-window content (floorTags — see the
    // contract above). The evictable `tags` set stays tool-only+canDrop so every
    // selected tag below actually reclaims its bytes; the floor sum deliberately
    // includes everything else (message text, files, reasoning, non-droppable
    // tools) because those bytes are on the wire and NOT irreducible prefix.
    let tailTokens = 0;
    for (const tag of floorTags) {
        if (tag.status !== "active") continue;
        tailTokens += estimateEmergencyDropReclaimTokens(tag);
    }
    const fixedFloor = Math.max(currentTotalInputTokens - tailTokens, 0);
    const workingSpan = Math.max(ceilingTokens - fixedFloor, 0);
    const target = fixedFloor + TARGET_FRACTION * workingSpan;
    const reclaimTokens = Math.round(currentTotalInputTokens - target);

    // Already at/under target, or reclaim too small to justify a cache bust.
    if (reclaimTokens <= EMERGENCY_REARM_MIN_TOKENS) {
        return noop(`reclaim<=min (${reclaimTokens} <= ${EMERGENCY_REARM_MIN_TOKENS})`);
    }

    const protectedCutoff = maxTag - protectedTags;

    // Per-tier recency reserve (T1, T2 only): the newest ceil(20%) active tool
    // tags of each tier are continuation context and never evictable.
    const tierActive: Record<1 | 2, number[]> = { 1: [], 2: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;
        const tier = resolveToolTier(tag.toolName);
        if (tier === 1 || tier === 2) tierActive[tier].push(tag.tagNumber);
    }
    const reserved = new Set<number>();
    for (const tier of [1, 2] as const) {
        const nums = tierActive[tier];
        if (nums.length === 0) continue;
        nums.sort((a, b) => b - a); // newest first
        const reserveCount = Math.ceil(TIER_RECENCY_RESERVE * nums.length);
        for (let i = 0; i < reserveCount && i < nums.length; i++) {
            reserved.add(nums[i]);
        }
    }

    // Build evictable candidates per tier. Only active tags are eligible, so a
    // tag dropped on a prior pass (now status!=='active') is never re-selected —
    // that, plus the input-sample latch above, is the full idempotence story.
    const byTier: Record<Tier, EmergencyDropTag[]> = { 1: [], 2: [], 3: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;
        if (tag.tagNumber > protectedCutoff) continue; // global protected tail
        const tier = resolveToolTier(tag.toolName);
        if ((tier === 1 || tier === 2) && reserved.has(tag.tagNumber)) continue;
        byTier[tier].push(tag);
    }

    // Walk T3 → T2 → T1, oldest-first within tier, until reclaim met.
    const selected: number[] = [];
    let reclaimed = 0;
    outer: for (const tier of [3, 2, 1] as const) {
        const group = byTier[tier];
        group.sort((a, b) => a.tagNumber - b.tagNumber); // oldest first
        for (const tag of group) {
            selected.push(tag.tagNumber);
            // Match the floor's tagReclaimBytes exactly: drop() removes output +
            // invocation args + preceding reasoning, so all three reclaim.
            reclaimed += estimateEmergencyDropReclaimTokens(tag);
            if (reclaimed >= reclaimTokens) break outer;
        }
    }

    if (selected.length === 0) {
        // Nothing left to drop (all active candidates reserved/protected). No
        // cache bust — wait for the 95% block to fire.
        return noop("no-candidates");
    }

    return {
        shouldDrop: true,
        tagNumbers: selected,
        reclaimTokens,
        reason: `tiered drop: ${selected.length} tags, reclaim≈${reclaimed}/${reclaimTokens} tokens (floor≈${fixedFloor}, ceiling=${Math.round(ceilingTokens)})`,
    };
}
