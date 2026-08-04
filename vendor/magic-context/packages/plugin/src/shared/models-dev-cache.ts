/**
 * Resolve per-model context limits from OpenCode's SDK — the single source of
 * truth — for OpenCode sessions.
 *
 * `client.config.providers()` returns OpenCode's fully-resolved config: the
 * live models.dev cache + compiled-in snapshot + opencode.json custom-provider
 * overrides + auth-plugin caps (e.g. the Codex-OAuth gpt-5.5 400k cap). We
 * consume ONLY that. We no longer read OpenCode's `models.json` file ourselves:
 * a torn read mid-write produced impossible limits (a 6748 "limit" for a session
 * that had run for hours), and a stale on-disk copy out-voted the live
 * auth-resolved cap (922k vs the real 400k). OpenCode reads that file safely in
 * its own process and hands us the merged answer.
 *
 * Layers:
 *   1. `apiCache` (authoritative): warmed once at startup from the SDK; seeded
 *      from a persisted last-known-good file on cold start so a restart uses the
 *      real limit immediately (no 128k-default budget-collapse window).
 *
 * All cached values are bounded to a sane [20k, 3M] range on insert, so torn /
 * unconfigured-default garbage can never be returned or persisted. The startup
 * warm retries a couple times when OpenCode's provider service isn't ready yet.
 *
 * Pi does NOT use this — it resolves from its own `ctx.getModel().contextWindow`
 * (instant at extension load), so `getSdkContextLimit()` returns `undefined`
 * for Pi and Pi's own path is used.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "./data-path";
import { getHarness } from "./harness";
import { sessionLog } from "./logger";

interface OpencodeClientLike {
    config: {
        providers: () => Promise<{ data?: { providers?: unknown } }>;
    };
}

// Plausible bounds for a real model's prompt limit. A value outside this range
// is physically impossible for an agentic session and signals a transient/garbage
// read — e.g. a torn read of OpenCode's `models.json` mid-write once produced
// `contextLimit=6748` (smaller than a single system prompt) for a session that
// had been running for hours past 200k+ (issue #117). Such values must be
// REJECTED, not trusted as a "smaller real cap". A genuinely smaller real limit
// still comes through the overflow-detection path (detectedContextLimit).
export const MIN_SANE_LIMIT = 20_000;
export const MAX_SANE_LIMIT = 3_000_000;

/** True when `limit` is a plausible real prompt window — used to reject torn /
 *  unconfigured-default garbage in BOTH harnesses (OpenCode's SDK values and
 *  Pi's reported `contextWindow`). Exported so Pi applies the identical bound. */
export function isSaneLimit(limit: number | undefined): limit is number {
    return typeof limit === "number" && limit >= MIN_SANE_LIMIT && limit <= MAX_SANE_LIMIT;
}

interface CachedModelMetadata {
    limit?: number;
    /** Provider-enforced prompt cap. Undefined when only a combined context window is known. */
    inputLimit?: number;
    /** Provider metadata says the model accepts image input. Unknown is false. */
    vision?: boolean;
}

/**
 * Authoritative source (OpenCode only): populated async from the SDK
 * `config.providers()`, which is OpenCode's fully-resolved config — models.dev +
 * compiled-in snapshot + opencode.json overrides + auth-plugin caps (e.g. the
 * Codex-OAuth gpt-5.5 400k cap). When present, this WINS unconditionally; the
 * disk file is never consulted (no torn-read exposure, no stale value
 * out-voting the live limit). Pi never warms this — it has its own
 * `contextWindow` source — so for Pi this stays null and resolution falls
 * through to the file fallback exactly as before.
 */
let apiCache: Map<string, CachedModelMetadata> | null = null;
let apiLoadedAt = 0;

// Persisted last-known-good apiCache (OpenCode). Survives restart so a cold
// start uses the real limit instantly instead of falling to the disk file or the
// 128k default for the warm-up window (which over-shrinks the history budget).
// Harness-scoped: only OpenCode warms/persists apiCache, so Pi's file (which is
// never written) stays absent and Pi seeds nothing — keeping Pi byte-identical.
let persistSeedLoaded = false;

function persistFilePath(): string {
    return join(getMagicContextStorageDir(), `model-context-limits-${getHarness()}.json`);
}

/** Seed apiCache from the persisted last-known-good file once per process, only
 *  when apiCache hasn't been warmed yet. Values are sane-filtered on load so a
 *  stale garbage entry can never resurrect. */
function loadPersistedApiCacheOnce(): void {
    if (persistSeedLoaded || apiCache !== null) return;
    persistSeedLoaded = true;
    try {
        const raw = readFileSync(persistFilePath(), "utf-8");
        const obj = JSON.parse(raw) as Record<
            string,
            number | { limit?: number; inputLimit?: number; vision?: boolean }
        >;
        const map = new Map<string, CachedModelMetadata>();
        for (const [key, persisted] of Object.entries(obj)) {
            const limit = typeof persisted === "number" ? persisted : persisted.limit;
            const inputLimit = typeof persisted === "number" ? undefined : persisted.inputLimit;
            const vision = typeof persisted === "number" ? false : persisted.vision === true;
            if (isSaneLimit(limit)) {
                map.set(key, {
                    limit,
                    inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
                    vision,
                });
            }
        }
        if (map.size > 0) {
            apiCache = map;
            sessionLog(
                "global",
                `models-dev-cache: seeded ${map.size} entries from persisted cache (cold start)`,
            );
        }
    } catch {
        // No persisted cache yet, or unreadable — fall through to file/SDK.
    }
}

/** Atomically persist the current (sane-filtered) apiCache so the next process
 *  cold-starts with the real limits. Temp-write + rename so a concurrent reader
 *  never sees a torn file (the exact failure mode we're eliminating). */
function persistApiCache(): void {
    if (!apiCache) return;
    const obj: Record<string, CachedModelMetadata> = {};
    for (const [key, value] of apiCache) {
        if (isSaneLimit(value.limit)) {
            obj[key] = {
                limit: value.limit,
                inputLimit: isSaneLimit(value.inputLimit) ? value.inputLimit : undefined,
                vision: value.vision === true,
            };
        }
    }
    try {
        const dir = getMagicContextStorageDir();
        mkdirSync(dir, { recursive: true });
        const target = persistFilePath();
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf-8", mode: 0o600 });
        renameSync(tmp, target);
    } catch {
        // best-effort — a failed persist only loses cold-start warmth, not correctness
    }
}

/**
 * Resolve the effective pressure limit for a model's `limit` object.
 *
 * Prefers `limit.input` (max prompt tokens the provider will accept) over
 * `limit.context` (total window including output). For GitHub Copilot and
 * several proxy providers, `context` is the marketing number (input + output
 * combined), and sending a prompt sized against `context` gets rejected.
 * OpenCode's own `session/overflow.ts` uses `input ?? context` for the same
 * reason — the denominator that drives overflow/pressure must be the number
 * the provider actually enforces on input.
 */
function resolveLimit(limit: { context?: number; input?: number } | undefined): number | undefined {
    if (!limit) return undefined;
    if (typeof limit.input === "number" && limit.input > 0) return limit.input;
    if (typeof limit.context === "number" && limit.context > 0) return limit.context;
    return undefined;
}

function setCachedModelMetadata(
    cache: Map<string, CachedModelMetadata>,
    key: string,
    model:
        | {
              limit?: { context?: number; input?: number };
              experimental?: { modes?: Record<string, unknown> };
              capabilities?: unknown;
              modalities?: unknown;
              input?: unknown;
              attachment?: unknown;
          }
        | undefined,
): void {
    const limit = resolveLimit(model?.limit);
    const inputLimit = model?.limit?.input;

    // Only cache plausible limits. A value outside [20k, 3M] is garbage (torn
    // read / unconfigured default) and must never enter the cache or get
    // persisted — see isSaneLimit.
    if (!isSaneLimit(limit)) {
        return;
    }

    const values = [model?.capabilities, model?.modalities, model?.input, model?.attachment];
    const vision = values.some(
        (value) =>
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("image") ||
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("vision"),
    );
    const value: CachedModelMetadata = {
        limit,
        inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
        vision,
    };
    cache.set(key, value);

    // OpenCode creates derived model IDs from experimental.modes
    // e.g. gpt-5.4 + modes.fast → gpt-5.4-fast. These inherit the same
    // context limit as the parent model.
    const modes = model?.experimental?.modes;
    if (modes && typeof modes === "object") {
        for (const mode of Object.keys(modes)) {
            cache.set(`${key}-${mode}`, value);
        }
    }
}

/**
 * Asynchronously refresh the API-layer cache from OpenCode's SDK.
 *
 * Call this at plugin startup and from the issue #77 regression-recovery path.
 * OpenCode's `/config/providers` endpoint returns every provider with full
 * model metadata — including `limit.context` — resolved through the same path
 * OpenCode itself uses (live cache + compiled-in snapshot + opencode.json
 * overrides + derived experimental modes + auth-plugin caps).
 *
 * `retries`/`retryDelayMs`: when OpenCode's provider service isn't ready at our
 * startup, `config.providers()` can return an empty/no-providers payload. Retry
 * a few times so the cache warms instead of leaving the session on the 128k
 * default until the next restart. A successful load (any providers) stops early.
 *
 * Safe to call concurrently; only overwrites the cache on success.
 */
export async function refreshModelLimitsFromApi(
    client: OpencodeClientLike,
    options?: { retries?: number; retryDelayMs?: number },
): Promise<void> {
    const attempts = Math.max(1, (options?.retries ?? 0) + 1);
    const delayMs = options?.retryDelayMs ?? 1000;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const ok = await refreshModelLimitsOnce(client);
        if (ok) return;
        if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

// Once-per-process latch for the after-auth re-warm below.
let authRewarmDone = false;

/**
 * Re-warm the limit cache ONCE per process, after auth is provably live.
 *
 * The startup warm (index.ts) can run before the user's provider auth is
 * loaded. When it does, an auth-conditional limit patch hasn't applied yet, so
 * `config.providers()` returns the RAW catalog limit (e.g. OpenAI gpt-5.5 OAuth
 * is downshifted to a 272k input cap by OpenCode's Codex auth plugin only when
 * `ctx.auth.type === "oauth"`; before auth loads it reports the raw 922k). That
 * too-high value gets cached AND persisted as last-known-good, survives
 * restarts, and the existing recovery only re-resolves a too-LOW limit
 * (overflow / `percentage > 100`), so a too-HIGH one never self-corrects: the
 * sidebar shows huge headroom while the backend rejects at the real cap (#179).
 *
 * The first `message.updated` carrying usage tokens proves a request succeeded,
 * so auth + providers are fully resolved. Re-warming there overwrites any stale
 * pre-auth limit with the live auth-adjusted one. Idempotent and cheap: a single
 * `config.providers()` round-trip, then a no-op for the rest of the process. The
 * latch is set before the await so concurrent `message.updated` events don't
 * stack duplicate warms; a failed warm resets it so a later message retries.
 */
export async function refreshModelLimitsAfterAuthOnce(client: OpencodeClientLike): Promise<void> {
    if (authRewarmDone) return;
    authRewarmDone = true;
    const ok = await refreshModelLimitsOnce(client);
    if (!ok) authRewarmDone = false;
}

/** Test-only: reset the after-auth re-warm latch between cases. */
export function resetAuthRewarmLatchForTest(): void {
    authRewarmDone = false;
}

/** Single SDK fetch + cache rebuild. Returns true when providers were loaded. */
async function refreshModelLimitsOnce(client: OpencodeClientLike): Promise<boolean> {
    try {
        const result = await client.config.providers();
        const data = (result as { data?: { providers?: Array<unknown> } }).data;
        const providers = data?.providers;
        if (!Array.isArray(providers) || providers.length === 0) {
            sessionLog(
                "global",
                "models-dev-cache: API refresh returned no providers payload (will retry if attempts remain)",
            );
            return false;
        }

        const map = new Map<string, CachedModelMetadata>();
        for (const entry of providers) {
            const p = entry as {
                id?: string;
                models?: Record<
                    string,
                    {
                        limit?: { context?: number; input?: number };
                        experimental?: { modes?: Record<string, unknown> };
                    }
                >;
            };
            if (!p?.id || !p.models || typeof p.models !== "object") continue;
            for (const [modelId, model] of Object.entries(p.models)) {
                setCachedModelMetadata(map, `${p.id}/${modelId}`, model);
            }
        }

        const previousSize = apiCache?.size ?? null;
        apiCache = map;
        apiLoadedAt = Date.now();
        // Persist the freshly-resolved (sane-filtered) limits so the next process
        // cold-starts with the real values instead of the 128k default.
        persistApiCache();

        if (previousSize === null) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries`,
            );
        } else if (previousSize !== map.size) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries (was ${previousSize})`,
            );
        }
        return true;
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: API refresh failed:",
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

/**
 * Resolve a model's prompt limit from OpenCode's SDK (`config.providers()`),
 * the single source of truth: it already merges models.dev + compiled-in
 * snapshot + opencode.json overrides + auth-plugin caps (e.g. the Codex-OAuth
 * gpt-5.5 400k cap). We deliberately do NOT read OpenCode's `models.json` file
 * ourselves — a torn read of that file mid-write produced garbage limits, and a
 * stale on-disk copy out-voted the live auth-resolved cap (922k vs the real
 * 400k). OpenCode reads that file safely within its own process and exposes the
 * merged result here.
 *
 * Resolution:
 *   1. Seed `apiCache` from the persisted last-known-good file once (cold start).
 *   2. Return the SDK value (sane by construction — only [20k,3M] is cached).
 *   3. `undefined` when the SDK hasn't reported this model yet → the caller
 *      defaults / retries (the startup warm retries when OpenCode isn't ready).
 *
 * OpenCode-only: Pi never warms `apiCache` (it resolves from its own
 * `ctx.getModel().contextWindow`), so for Pi this returns `undefined` and Pi's
 * own resolution path is used.
 */
export function getSdkContextLimit(providerID: string, modelID: string): number | undefined {
    loadPersistedApiCacheOnce();
    const fromApi = lookupLimitWithTagFallback(apiCache, providerID, modelID);
    return isSaneLimit(fromApi) ? fromApi : undefined;
}

/**
 * Return only a provider-declared input cap. A combined context window is useful
 * for scheduling but is not safe as a fail-closed prompt boundary.
 */
/** Resolve image-input support from the same models.dev metadata cache as limits. */
export function modelSupportsVision(providerID: string, modelID: string): boolean {
    loadPersistedApiCacheOnce();
    if (!apiCache) return false;
    const exact = apiCache.get(`${providerID}/${modelID}`);
    if (exact?.vision === true) return true;
    const colon = modelID.lastIndexOf(":");
    return colon > 0
        ? apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.vision === true
        : false;
}

export function getSdkInputLimit(providerID: string, modelID: string): number | undefined {
    loadPersistedApiCacheOnce();
    if (!apiCache) return undefined;
    const direct = apiCache.get(`${providerID}/${modelID}`)?.inputLimit;
    if (isSaneLimit(direct)) return direct;
    const colon = modelID.indexOf(":");
    if (colon > 0) {
        const tagless = apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.inputLimit;
        if (isSaneLimit(tagless)) return tagless;
    }
    return undefined;
}

/**
 * Look up a model's limit in the cache, with an ollama-style tag-suffix
 * fallback. ollama invokes cloud models with a tag at runtime
 * (`deepseek-v4-pro:cloud`) while the underlying metadata key is tag-less
 * (`deepseek-v4-pro`), so an exact-only match misses.
 *
 * Strategy: exact match first (never collapses a legitimately-tagged model),
 * then retry once with the last `:tag` segment stripped.
 */
function lookupLimitWithTagFallback(
    cache: Map<string, CachedModelMetadata> | null,
    providerID: string,
    modelID: string,
): number | undefined {
    if (!cache) return undefined;
    const exact = cache.get(`${providerID}/${modelID}`)?.limit;
    if (typeof exact === "number") return exact;

    const colonIdx = modelID.lastIndexOf(":");
    if (colonIdx > 0) {
        const baseModel = modelID.slice(0, colonIdx);
        const fallback = cache.get(`${providerID}/${baseModel}`)?.limit;
        if (typeof fallback === "number") return fallback;
    }
    return undefined;
}

/** Clear in-memory caches (for testing and the regression-recovery refetch). */
export function clearModelsDevCache(): void {
    apiCache = null;
    apiLoadedAt = 0;
    persistSeedLoaded = false;
}

/** Inspection helpers (for logging / debugging). */
export function getModelsDevCacheState(): {
    apiLoaded: boolean;
    apiCount: number;
    apiAgeMs: number;
} {
    return {
        apiLoaded: apiCache !== null,
        apiCount: apiCache?.size ?? 0,
        apiAgeMs: apiLoadedAt > 0 ? Date.now() - apiLoadedAt : -1,
    };
}
