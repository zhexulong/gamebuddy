/**
 * Closed, Host-owned lifecycle input for the player-safe Game status adapter.
 * Its deliberately categorical fields must be reduced by Host lifecycle code;
 * it accepts neither browser/bridge payloads nor raw adapter state.
 */
export type HostGameLifecycleSnapshot = Readonly<{
  availability: "available" | "unavailable";
  surface: "active" | "returning" | "recovery_required";
  freshness: "current" | "absent" | "stale" | "mismatch";
  availableCapabilities: Readonly<{
    category: "available" | "none";
    count: number;
  }>;
  activeExecution: "none" | "active";
  latestAuthoritativeReceipt: "none" | "succeeded" | "not_succeeded";
}>;

export type GameStatus = Readonly<{
  availability: "available" | "unavailable";
  category: "unavailable" | "awaiting_state" | "ready" | "busy" | "returning" | "recovery_required";
  label:
    | "Game unavailable"
    | "Awaiting current game state"
    | "Ready"
    | "Game action running"
    | "Returning from game"
    | "Game recovery required";
  surfaceStatus: "unavailable" | "active" | "returning" | "recovery_required";
  freshnessLabel: "Current game state" | "Game state unavailable" | "Game state stale" | "Game state mismatch";
  availableCapabilityCount: number;
  availableCapabilityCategory: "available" | "none";
  activeExecutionCategory: "none" | "active";
  latestAuthoritativeReceiptOutcome: "none" | "succeeded" | "not_succeeded";
}>;

/**
 * Pure player-safe projection. Any absent, stale, mismatched, malformed, or
 * non-active lifecycle state is denied rather than exposing stale authority.
 */
export function projectGameStatus(snapshot: HostGameLifecycleSnapshot | undefined | unknown): GameStatus {
  if (!isSnapshot(snapshot))
    return unavailableStatus("unavailable", "Game unavailable", "unavailable", "Game state unavailable");
  const freshnessLabel = labelForFreshness(snapshot.freshness);
  if (snapshot.availability === "unavailable")
    return unavailableStatus("unavailable", "Game unavailable", snapshot.surface, freshnessLabel);
  if (snapshot.surface === "returning")
    return unavailableStatus("returning", "Returning from game", "returning", freshnessLabel);
  if (snapshot.surface === "recovery_required")
    return unavailableStatus("recovery_required", "Game recovery required", "recovery_required", freshnessLabel);
  if (snapshot.freshness !== "current")
    return unavailableStatus("awaiting_state", "Awaiting current game state", "active", freshnessLabel);

  return Object.freeze({
    availability: "available",
    category: snapshot.activeExecution === "active" ? "busy" : "ready",
    label: snapshot.activeExecution === "active" ? "Game action running" : "Ready",
    surfaceStatus: "active",
    freshnessLabel,
    availableCapabilityCount:
      snapshot.availableCapabilities.category === "available" ? snapshot.availableCapabilities.count : 0,
    availableCapabilityCategory: snapshot.availableCapabilities.category,
    activeExecutionCategory: snapshot.activeExecution,
    latestAuthoritativeReceiptOutcome: snapshot.latestAuthoritativeReceipt,
  });
}

function unavailableStatus(
  category: Extract<GameStatus["category"], "unavailable" | "awaiting_state" | "returning" | "recovery_required">,
  label: Extract<
    GameStatus["label"],
    "Game unavailable" | "Awaiting current game state" | "Returning from game" | "Game recovery required"
  >,
  surfaceStatus: GameStatus["surfaceStatus"],
  freshnessLabel: GameStatus["freshnessLabel"],
): GameStatus {
  return Object.freeze({
    availability: "unavailable",
    category,
    label,
    surfaceStatus,
    freshnessLabel,
    availableCapabilityCount: 0,
    availableCapabilityCategory: "none",
    activeExecutionCategory: "none",
    latestAuthoritativeReceiptOutcome: "none",
  });
}

function labelForFreshness(freshness: HostGameLifecycleSnapshot["freshness"]): GameStatus["freshnessLabel"] {
  return freshness === "current"
    ? "Current game state"
    : freshness === "absent"
      ? "Game state unavailable"
      : freshness === "stale"
        ? "Game state stale"
        : "Game state mismatch";
}

function isSnapshot(value: unknown): value is HostGameLifecycleSnapshot {
  if (!isPlainRecord(value) || Object.keys(value).length !== 6) return false;
  const allowedKeys = new Set([
    "availability",
    "surface",
    "freshness",
    "availableCapabilities",
    "activeExecution",
    "latestAuthoritativeReceipt",
  ]);
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) return false;
  const capabilities = value.availableCapabilities;
  return (
    (value.availability === "available" || value.availability === "unavailable") &&
    (value.surface === "active" || value.surface === "returning" || value.surface === "recovery_required") &&
    (value.freshness === "current" ||
      value.freshness === "absent" ||
      value.freshness === "stale" ||
      value.freshness === "mismatch") &&
    isPlainRecord(capabilities) &&
    Object.keys(capabilities).length === 2 &&
    (capabilities.category === "available" || capabilities.category === "none") &&
    isCapabilityCount(capabilities.count) &&
    (capabilities.category === "available" || capabilities.count === 0) &&
    (value.activeExecution === "none" || value.activeExecution === "active") &&
    (value.latestAuthoritativeReceipt === "none" ||
      value.latestAuthoritativeReceipt === "succeeded" ||
      value.latestAuthoritativeReceipt === "not_succeeded")
  );
}

function isCapabilityCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 512;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
