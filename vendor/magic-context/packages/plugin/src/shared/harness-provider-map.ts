/**
 * Provider-id translation between the canonical (OpenCode) form stored in the
 * shared magic-context config and Pi's harness-native provider ids.
 *
 * OpenCode and Pi now share ONE config, but a few auth-plugin providers were
 * named differently on each side. The model id AFTER the slash is identical;
 * only the provider prefix differs:
 *
 *   canonical (OpenCode)   Pi's preferred auth-plugin form
 *   --------------------   ------------------------------
 *   openai/<model>         openai-codex/<model>
 *   google/<model>         google-antigravity/<model>
 *   anthropic/<model>      anthropic/<model> (same; every other provider too)
 *
 * The mapping is intentionally not a one-to-one provider identity. Pi also
 * exposes plain `openai` and `google` providers for direct API keys, while the
 * canonical prefix does not record whether a subscription or API-key backend
 * should win. Pi therefore starts with the preferred auth-plugin form at the
 * spawn boundary and subagent-runner may retry once with the untranslated
 * canonical form when that form reports missing credentials. The runner caches
 * the winning form per provider prefix in memory only; setup writes still use
 * the reverse mapping below so configs remain canonical.
 *
 * Canonical = OpenCode: the config always stores the OpenCode form. Pi
 * translates at its edges:
 *   - read:  canonical -> Pi when spawning a configured model (subagent-runner),
 *            with the runtime credential fallback described above.
 *   - write: Pi -> canonical in the Pi setup wizard, so a config written from
 *            the Pi side stays readable by OpenCode.
 *
 * OpenCode needs no translation (canonical IS the OpenCode form).
 */

const CANONICAL_TO_PI_PROVIDER: Record<string, string> = {
    openai: "openai-codex",
    google: "google-antigravity",
};

const PI_TO_CANONICAL_PROVIDER: Record<string, string> = {
    "openai-codex": "openai",
    "google-antigravity": "google",
};

/** Remap only the provider prefix (text before the first "/"), preserving the
 *  model id verbatim. No "/", empty provider, or unmapped provider -> unchanged. */
function remapProviderPrefix(ref: string, map: Record<string, string>): string {
    if (typeof ref !== "string") return ref;
    const slash = ref.indexOf("/");
    if (slash <= 0) return ref;
    const provider = ref.slice(0, slash);
    const mapped = map[provider];
    return mapped ? `${mapped}${ref.slice(slash)}` : ref;
}

/** Pi-native `provider/model` -> canonical (OpenCode). Identity when unmapped.
 *  Used by the Pi setup wizard so configs it writes stay OpenCode-readable. */
export function piModelRefToCanonical(ref: string): string {
    return remapProviderPrefix(ref, PI_TO_CANONICAL_PROVIDER);
}

/** Canonical (OpenCode) `provider/model` -> Pi-native, for spawning a model on
 *  Pi. Idempotent: normalizes any Pi-form prefix back to canonical first, so it
 *  is safe on a config that already holds Pi-form ids (hand-edited or pre-fix). */
export function resolveModelRefForPi(ref: string): string {
    return remapProviderPrefix(piModelRefToCanonical(ref), CANONICAL_TO_PI_PROVIDER);
}
