/**
 * Strict semver validator for the auto-update path.
 *
 * The plugin version string flows from the npm registry / dist-tags into
 * package.json's dependency spec before `npm install`. A malformed or crafted
 * value (`npm:@evil/pkg@1.0.0`, `file:/tmp/x`, `git+ssh://...`) must never be
 * written there — this is the arbitrary-package-install / SSRF guard.
 *
 * Lives in its own leaf module (no imports beyond this) so both `cache.ts` and
 * `checker.ts` can use it without creating a circular import between them
 * (`cache.ts` imports `checker.ts` for the runtime package.json path; if
 * `checker.ts` also imported this from `cache.ts`, the cycle breaks static
 * export resolution on a cold module graph — CI / fresh installs — even though
 * a warm bun cache tolerates it).
 */
export function isValidSemver(version: string): boolean {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * Compare two semver core versions (major.minor.patch). Returns >0 if `a` is
 * newer than `b`, <0 if older, 0 if equal. Pre-release / build metadata is
 * IGNORED (only the numeric core is compared) — sufficient for the announcement
 * "show only on a forward version change" gate, which never needs to order two
 * pre-releases of the same core. Returns null if either string isn't valid
 * semver, so callers can treat anomalous input conservatively.
 */
export function compareSemverCore(a: string, b: string): number | null {
    if (!isValidSemver(a) || !isValidSemver(b)) return null;
    const core = (v: string) =>
        v
            .split(/[-+]/, 1)[0]
            .split(".")
            .map((n) => Number.parseInt(n, 10));
    const [a0, a1, a2] = core(a);
    const [b0, b1, b2] = core(b);
    return a0 - b0 || a1 - b1 || a2 - b2;
}
