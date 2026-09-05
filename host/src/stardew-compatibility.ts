/**
 * Frozen Task 5: pure Host Stardew/SMAPI compatibility classifier.
 *
 * This module is a deterministic, dependency-free projection over detected
 * Stardew/SMAPI/integration facts and named tri-state checks. It is the
 * consumer edge of a named producer→consumer→verifier line:
 *
 *   Producer: game-thread detection layer. The identity facts
 *       (gameVersion / gameBuildNumber / smapiVersion) mirror the fields
 *       already lifecycle-validated by `StardewSessionAdvertisement` in
 *       `stardew-attachment.ts`; the four named checks come from the
 *       integration launcher and Mod observation (SMAPI loader status, bridge
 *       protocol-major negotiation, native multiplayer peer protocol).
 *   Consumer: `classifyStardewCompatibility()` — purifies those facts into a
 *       single browser-safe outcome (no filesystem, crypto, runtime, or
 *       network access; purely frozen data).
 *   Verifier: `validateStardewCompatibilityOutcome()` — the browser
 *       attachment gate re-checks an outcome (exact shape, fixed status and
 *       reason sets, per-status reason coupling, and the `attachmentAllowed`
 *       invariant) before trusting it.
 *
 * The verified tuple is game `1.6.15` build `24356` with SMAPI `4.5.2`. The
 * only advisory minimum is the manifest MinimumApiVersion SMAPI `4.0.0`; a
 * Stardew minimum is deliberately NOT invented.
 */

export const VERIFIED_GAME_VERSION = "1.6.15" as const;
export const VERIFIED_GAME_BUILD_NUMBER = 24356 as const;
export const VERIFIED_SMAPI_VERSION = "4.5.2" as const;
export const ADVISORY_MINIMUM_SMAPI_VERSION = "4.0.0" as const;

export type StardewCompatibilityStatus =
  | "verified"
  | "compatible_unverified"
  | "below_minimum_warning"
  | "hard_incompatible";

export type StardewCompatibilityReasonCode =
  | "runtime_missing"
  | "loader_failure"
  | "bridge_protocol_major_mismatch"
  | "native_multiplayer_protocol_mismatch"
  | "smapi_below_minimum"
  | "tuple_not_verified"
  | "compatibility_evidence_incomplete"
  | "tuple_verified";

/**
 * Named tri-state check values. Literal unions, never booleans: each check
 * distinguishes a confirmed positive, a confirmed negative classification,
 * an explicitness of the negative only where a mismatch is meaningful, and an
 * undetermined value. `not_applicable` is legal only for the native
 * multiplayer peer check (there may be no native multiplayer session).
 */
type CompatibilityCheckValue =
  | "confirmed_ok"
  | "confirmed_failure"
  | "confirmed_mismatch"
  | "unknown";

/** A concrete runtime is either present, confirmed missing, or unknown. */
type RuntimePresenceCheck =
  | "confirmed_ok"
  | "confirmed_failure"
  | "unknown";

/** The SMAPI loader is either healthy, confirmed failed, or unknown. */
type LoaderStatusCheck =
  | "confirmed_ok"
  | "confirmed_failure"
  | "unknown";

/** The bridge protocol major is confirmed matching, confirmed mismatched, or unknown. */
type BridgeProtocolMajorCheck =
  | "confirmed_ok"
  | "confirmed_mismatch"
  | "unknown";

/** The native multiplayer peer protocol supports not_applicable. */
type NativeMultiplayerPeerCheck =
  | "confirmed_ok"
  | "confirmed_failure"
  | "confirmed_mismatch"
  | "unknown"
  | "not_applicable";

/** Detected facts plus named checks produced by the game-thread boundary. */
export type StardewCompatibilityFacts = Readonly<{
  gameVersion: string | null;
  gameBuildNumber: number | null;
  smapiVersion: string | null;
  runtime: RuntimePresenceCheck;
  loader: LoaderStatusCheck;
  bridgeProtocolMajor: BridgeProtocolMajorCheck;
  nativeMultiplayerPeer: NativeMultiplayerPeerCheck;
}>;

/** Browser-safe structured classifier result. */
export type StardewCompatibilityOutcome = Readonly<{
  status: StardewCompatibilityStatus;
  reasonCode: StardewCompatibilityReasonCode;
  attachmentAllowed: boolean;
}>;

export const STARDEW_COMPATIBILITY_STATUSES: readonly StardewCompatibilityStatus[] =
  Object.freeze([
    "verified",
    "compatible_unverified",
    "below_minimum_warning",
    "hard_incompatible",
  ]);

export const STARDEW_COMPATIBILITY_REASONS: readonly StardewCompatibilityReasonCode[] =
  Object.freeze([
    "runtime_missing",
    "loader_failure",
    "bridge_protocol_major_mismatch",
    "native_multiplayer_protocol_mismatch",
    "smapi_below_minimum",
    "tuple_not_verified",
    "compatibility_evidence_incomplete",
    "tuple_verified",
  ]);

/** Status→reason coupling the verifier enforces (per-status closure). */
export const STARDEW_COMPATIBILITY_REASONS_BY_STATUS: Readonly<
  Record<StardewCompatibilityStatus, readonly StardewCompatibilityReasonCode[]>
> = Object.freeze({
  verified: Object.freeze<readonly StardewCompatibilityReasonCode[]>([
    "tuple_verified",
  ]),
  compatible_unverified: Object.freeze<readonly StardewCompatibilityReasonCode[]>(
    ["tuple_not_verified", "compatibility_evidence_incomplete"],
  ),
  below_minimum_warning: Object.freeze<readonly StardewCompatibilityReasonCode[]>(
    ["smapi_below_minimum"],
  ),
  hard_incompatible: Object.freeze<readonly StardewCompatibilityReasonCode[]>([
    "runtime_missing",
    "loader_failure",
    "bridge_protocol_major_mismatch",
    "native_multiplayer_protocol_mismatch",
  ]),
});

const SMAPI_VERSION_PATTERN =
  /^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})(?:\.[0-9]{1,9})?(?:[-+][A-Za-z0-9][A-Za-z0-9.\-+]*)?$/;

const ADVISORY_MINIMUM_PARSED: ParsedSmapiVersion = parseSmapiVersion(
  ADVISORY_MINIMUM_SMAPI_VERSION,
)!;

/**
 * Deterministic decision cascade. Hard classes are evaluated first in the
 * fixed order of their reason codes; each of the guard clauses returns at
 * most one outcome, so the reason is always unique.
 *
 *   1. Hard: a confirmed runtime miss, load failure, bridge protocol-major
 *      mismatch, or applicable native peer protocol mismatch ⇒
 *      `hard_incompatible` with the matching reason in the fixed order
 *      `runtime_missing` → `loader_failure` → `bridge_protocol_major_mismatch`
 *      → `native_multiplayer_protocol_mismatch`.
 *   2. Otherwise a valid parseable SMAPI below the advisory minimum `4.0.0` ⇒
 *      `below_minimum_warning` / `smapi_below_minimum`. Malformed, missing, or
 *      unknown SMAPI never reaches this branch (it yields `compatible_unverified`).
 *   3. Otherwise `verified` requires the exact tuple AND runtime/loader/bridge
 *      all `confirmed_ok` AND the peer check either `confirmed_ok` or
 *      `not_applicable`.
 *   4. Otherwise `compatible_unverified`. When several non-hard uncertainties
 *      coexist the reason precedence is transparent and stable:
 *        a. the exact tuple holds but a required check is not confirmed ⇒
 *           `compatibility_evidence_incomplete`;
 *        b. otherwise all three identity facts are present but the tuple is
 *           not exactly the verified tuple ⇒ `tuple_not_verified`;
 *        c. otherwise (an identity fact is absent) ⇒
 *           `compatibility_evidence_incomplete`.
 */
export function classifyStardewCompatibility(
  facts: StardewCompatibilityFacts,
): StardewCompatibilityOutcome {
  if (facts.runtime === "confirmed_failure")
    return outcome("hard_incompatible", "runtime_missing");
  if (facts.loader === "confirmed_failure")
    return outcome("hard_incompatible", "loader_failure");
  if (facts.bridgeProtocolMajor === "confirmed_mismatch")
    return outcome("hard_incompatible", "bridge_protocol_major_mismatch");
  if (facts.nativeMultiplayerPeer === "confirmed_mismatch")
    return outcome(
      "hard_incompatible",
      "native_multiplayer_protocol_mismatch",
    );

  const smapi = parseSmapiVersion(facts.smapiVersion);
  if (smapi !== null && belowSmapiMinimum(smapi))
    return outcome("below_minimum_warning", "smapi_below_minimum");

  if (isExactVerifiedTuple(facts)) {
    if (
      facts.runtime === "confirmed_ok" &&
      facts.loader === "confirmed_ok" &&
      facts.bridgeProtocolMajor === "confirmed_ok" &&
      (facts.nativeMultiplayerPeer === "confirmed_ok" ||
        facts.nativeMultiplayerPeer === "not_applicable")
    )
      return outcome("verified", "tuple_verified");
    return outcome("compatible_unverified", "compatibility_evidence_incomplete");
  }

  if (
    facts.gameVersion !== null &&
    facts.gameBuildNumber !== null &&
    facts.smapiVersion !== null
  )
    return outcome("compatible_unverified", "tuple_not_verified");

  return outcome("compatible_unverified", "compatibility_evidence_incomplete");
}

/**
 * Verifier re-checks an outcome from the browser boundary. Enforces the exact
 * visible shape, the fixed status/reason sets, the per-status reason coupling,
 * and the `attachmentAllowed` invariant (`false` only for hard, otherwise
 * true). Returns null and therefore fail-closes on any violation.
 */
export function validateStardewCompatibilityOutcome(
  value: unknown,
): StardewCompatibilityOutcome | null {
  if (!exactKeys(value, ["status", "reasonCode", "attachmentAllowed"])) return null;
  const { status, reasonCode, attachmentAllowed } = value;
  if (!oneOf(status, STARDEW_COMPATIBILITY_STATUSES)) return null;
  if (!oneOf(reasonCode, STARDEW_COMPATIBILITY_REASONS)) return null;
  if (!oneOf(reasonCode, STARDEW_COMPATIBILITY_REASONS_BY_STATUS[status]))
    return null;
  if (typeof attachmentAllowed !== "boolean") return null;
  if (attachmentAllowed !== (status !== "hard_incompatible")) return null;
  return Object.freeze({ status, reasonCode, attachmentAllowed });
}

function isExactVerifiedTuple(facts: StardewCompatibilityFacts): boolean {
  return (
    facts.gameVersion === VERIFIED_GAME_VERSION &&
    facts.gameBuildNumber === VERIFIED_GAME_BUILD_NUMBER &&
    facts.smapiVersion === VERIFIED_SMAPI_VERSION
  );
}

function outcome(
  status: StardewCompatibilityStatus,
  reasonCode: StardewCompatibilityReasonCode,
): StardewCompatibilityOutcome {
  return Object.freeze({
    status,
    reasonCode,
    attachmentAllowed: status !== "hard_incompatible",
  });
}

type ParsedSmapiVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
}>;

/** Returns the numeric version triple for a valid parseable SMAPI version. */
function parseSmapiVersion(value: string | null): ParsedSmapiVersion | null {
  if (typeof value !== "string") return null;
  const match = SMAPI_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

/** Strictly-below comparison against the advisory SMAPI minimum. */
function belowSmapiMinimum(version: ParsedSmapiVersion): boolean {
  const minimum = ADVISORY_MINIMUM_PARSED;
  if (version.major !== minimum.major) return version.major < minimum.major;
  if (version.minor !== minimum.minor) return version.minor < minimum.minor;
  return version.patch < minimum.patch;
}

function oneOf<T>(value: unknown, options: readonly T[]): value is T {
  return (options as readonly unknown[]).some((option) => option === value);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}