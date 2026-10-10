/**
 * The .NET SDK lock `global.json` declares, and what satisfies it.
 *
 * Four Windows builders each used to require `dotnet --version` to EQUAL `global.json`'s pinned version,
 * and each failed with its own `<builder>_dotnet_sdk_drift` message. That is stricter than the SDK
 * itself: `global.json` here says `rollForward: "latestPatch"`, so a machine patched from 8.0.424 to
 * 8.0.425 satisfies the lock and can build - but the builders refused, which turned a routine Windows
 * Update into "this repository can no longer produce a generation on this machine".
 *
 * The lock stays a lock: this accepts exactly what `global.json` asks the SDK to accept, and fails
 * closed on any policy it does not implement rather than guessing.
 */

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

export const UNSUPPORTED_ROLL_FORWARD = "sdk_lock_rollforward_unsupported";

/** Parse a semantic version into its parts. Prerelease text is kept so `allowPrerelease` can be honored. */
export function parseSdkVersion(value) {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? undefined,
  });
}

/**
 * Read `global.json`'s SDK lock.
 *
 * `rollForward` defaults to `latestPatch`, which is the SDK's own default for `sdk.version`.
 * `allowPrerelease` defaults to false, also matching the SDK.
 */
export function parseSdkLock(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("sdk_lock_invalid");
  }
  const version = parsed?.sdk?.version;
  const locked = typeof version === "string" ? parseSdkVersion(version) : undefined;
  if (locked === undefined) throw new Error("sdk_lock_invalid");
  const rollForward = typeof parsed?.sdk?.rollForward === "string" ? parsed.sdk.rollForward : "latestPatch";
  const allowPrerelease = parsed?.sdk?.allowPrerelease === true;
  return Object.freeze({ version, locked, rollForward, allowPrerelease });
}

/**
 * Does `actual` satisfy `lock`?
 *
 * Implemented: `latestPatch` (same major.minor, patch >= locked) and `disable` (exact equality). Every
 * other policy throws, so a `global.json` that asks for wider rolling is a loud failure with a named
 * reason instead of a silently weakened gate.
 */
export function sdkVersionSatisfiesLock({ actual, lock }) {
  if (lock.rollForward !== "latestPatch" && lock.rollForward !== "disable")
    throw new Error(`${UNSUPPORTED_ROLL_FORWARD}:${lock.rollForward}`);
  const parsedActual = parseSdkVersion(String(actual));
  if (parsedActual === undefined) return false;
  if (parsedActual.prerelease !== undefined && !lock.allowPrerelease) return false;
  if (lock.rollForward === "disable") return parsedActual.major === lock.locked.major && parsedActual.minor === lock.locked.minor && parsedActual.patch === lock.locked.patch;
  return (
    parsedActual.major === lock.locked.major &&
    parsedActual.minor === lock.locked.minor &&
    parsedActual.patch >= lock.locked.patch
  );
}
