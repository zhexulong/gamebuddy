/**
 * Resolve the fallback model list to attempt for a hidden-agent (historian /
 * dreamer / sidekick) call when its configured primary fails.
 *
 * Policy: ONLY the user's explicitly-configured `fallback_models` for this
 * agent. There is NO builtin provider-agnostic chain — a hardcoded chain
 * inevitably names providers the user doesn't have (e.g. a metapi-only user got
 * a chain of google/github-copilot/opencode entries, every one a
 * `Model not found` retry), which produced confusing errors and wasted
 * attempts. If the user configured nothing, this returns an empty list and the
 * runner's session-model last resort (the model the user is actually using) is
 * the only fallback.
 *
 * The returned list does NOT include the primary model — it's the ordered list
 * of *alternates* to try after the primary fails. Each entry is
 * "provider/modelID" form. Duplicates and empty strings are filtered; entries
 * that don't match the "provider/modelID" shape (a "/" with non-empty parts) are
 * dropped as a defensive guard against malformed user config.
 */
export function resolveFallbackChain(
    userFallbacks: readonly string[] | string | undefined,
): string[] {
    const userList = normalizeUserFallbacks(userFallbacks);
    return dedupe(userList.filter(isValidModelSpec));
}

function normalizeUserFallbacks(userFallbacks: readonly string[] | string | undefined): string[] {
    if (!userFallbacks) return [];
    if (typeof userFallbacks === "string") {
        const trimmed = userFallbacks.trim();
        return trimmed ? [trimmed] : [];
    }
    return userFallbacks.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isValidModelSpec(spec: string): boolean {
    const slash = spec.indexOf("/");
    return slash > 0 && slash < spec.length - 1;
}

function dedupe(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

/**
 * Parse a "provider/modelID" string into the OpenCode `model` object shape.
 * Returns null on invalid input.
 *
 * Note: only splits on the FIRST "/" — modelID can legitimately contain slashes
 * (e.g. `lemonade/GLM-4.7-Flash-GGUF/main`).
 */
export function parseProviderModel(spec: string): { providerID: string; modelID: string } | null {
    const slash = spec.indexOf("/");
    if (slash < 1 || slash >= spec.length - 1) return null;
    return {
        providerID: spec.slice(0, slash).trim(),
        modelID: spec.slice(slash + 1).trim(),
    };
}

/**
 * Build the `{ model: { providerID, modelID } }` fragment for an OpenCode prompt
 * body from a `provider/model` spec string, or `{}` when the spec is absent or
 * unparseable (the session falls back to its default model). Spread into a
 * `client.session.prompt` body.
 */
export function modelBodyField(spec: string | undefined): {
    model?: { providerID: string; modelID: string };
} {
    if (!spec) return {};
    const parsed = parseProviderModel(spec);
    return parsed ? { model: parsed } : {};
}
