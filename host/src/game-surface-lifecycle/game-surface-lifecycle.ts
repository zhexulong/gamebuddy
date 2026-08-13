import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import type { IntegrationActionPolicy, GameIntegrationModule, IntegrationStateView } from "../integration-module.js";
import type { IntegrationConnection } from "../integration-types.js";

/**
 * Host-owned, read-only reduction of the live integration and Game-surface
 * lifecycle. Raw adapter state is consumed here and never crosses this seam.
 */
export class GameSurfaceLifecycleProducer {
  #connectionAvailable = true;
  #surface: "active" | "returning" | "recovery_required" = "active";

  public constructor(
    private readonly module: GameIntegrationModule,
    private readonly connection: IntegrationConnection,
    private readonly policy?: IntegrationActionPolicy,
  ) {}

  /** Terminal local transport loss is unavailable even if an adapter retains stale state. */
  public markConnectionUnavailable(): void {
    this.#connectionAvailable = false;
  }

  /** A return has begun durably; it remains visible if teardown cannot complete. */
  public markReturning(): void {
    this.#surface = "returning";
  }

  /** Explicit recovery paths can retain this fail-closed category. */
  public markRecoveryRequired(): void {
    this.#surface = "recovery_required";
  }

  /** The only public output: a closed categorical snapshot for game-status. */
  public snapshot(): HostGameLifecycleSnapshot {
    if (!this.#connectionAvailable) return unavailable(this.#surface, "absent");
    let state: IntegrationStateView;
    try {
      state = this.module.readState(this.connection);
    } catch {
      return unavailable(this.#surface, "mismatch");
    }
    if (!isStateView(state)) return unavailable(this.#surface, "mismatch");
    if (!state.connected) return unavailable(this.#surface, "absent");
    if (state.sessionId === null || state.snapshotRevision === null) return unavailable(this.#surface, "absent");
    if (this.#surface !== "active") return unavailable(this.#surface, "current");

    let count: number;
    try {
      count = this.module.actionCatalog.visibleActions(state.capabilities, this.policy).length;
    } catch {
      return unavailable("active", "mismatch");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 512) return unavailable("active", "mismatch");
    return Object.freeze({
      availability: "available",
      surface: "active",
      freshness: "current",
      availableCapabilities: Object.freeze({ category: count === 0 ? "none" : "available", count }),
      activeExecution: state.activeExecution === null ? "none" : "active",
      latestAuthoritativeReceipt:
        state.latestReceipt === null
          ? "none"
          : state.latestReceipt.state === "succeeded"
            ? "succeeded"
            : "not_succeeded",
    });
  }
}

function unavailable(
  surface: HostGameLifecycleSnapshot["surface"],
  freshness: HostGameLifecycleSnapshot["freshness"],
): HostGameLifecycleSnapshot {
  return Object.freeze({
    availability: "unavailable",
    surface,
    freshness,
    availableCapabilities: Object.freeze({ category: "none", count: 0 }),
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
}

function isStateView(value: unknown): value is IntegrationStateView {
  if (
    !isRecord(value) ||
    typeof value.connected !== "boolean" ||
    (value.sessionId !== null && !isOpaque(value.sessionId)) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 512 ||
    value.capabilities.some((item) => !isOpaque(item)) ||
    (value.snapshotRevision !== null &&
      (typeof value.snapshotRevision !== "number" ||
        !Number.isSafeInteger(value.snapshotRevision) ||
        value.snapshotRevision < 0)) ||
    (value.activeExecution !== null && !isRecord(value.activeExecution)) ||
    (value.latestReceipt !== null && !isRecord(value.latestReceipt))
  )
    return false;
  return true;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
