import type { Database } from "../../shared/sqlite";
import {
    getPersistedSchemaVersion,
    getSchemaFenceRejection,
    LATEST_SUPPORTED_VERSION,
} from "./storage-db";

export const STALE_CHILD_SPAWN_FAILURE = "stale_schema_fence";
export const STALE_CHILD_SPAWN_LATCH_THRESHOLD = 2;

export interface ChildSpawnFenceFailure {
    failureClass: typeof STALE_CHILD_SPAWN_FAILURE;
    reason: "newer_schema" | "read_error";
    persistedVersion: number;
    supportedVersion: number;
    consecutiveFailures: number;
    totalFailures: number;
    latched: boolean;
}

interface ChildSpawnFenceState {
    consecutiveFailures: number;
    totalFailures: number;
    latched: boolean;
    noticeEmitted: boolean;
    failure: ChildSpawnFenceFailure | null;
}

const state: ChildSpawnFenceState = {
    consecutiveFailures: 0,
    totalFailures: 0,
    latched: false,
    noticeEmitted: false,
    failure: null,
};

export type ChildSpawnFenceProbeResult =
    | { allowSpawn: true }
    | { allowSpawn: false; failure: ChildSpawnFenceFailure; shouldSurface: boolean };

function recordStaleFence(
    persistedVersion: number,
    supportedVersion: number,
    reason: ChildSpawnFenceFailure["reason"] = "newer_schema",
): ChildSpawnFenceProbeResult {
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    const latched = state.consecutiveFailures >= STALE_CHILD_SPAWN_LATCH_THRESHOLD;
    state.latched ||= latched;
    const failure: ChildSpawnFenceFailure = {
        failureClass: STALE_CHILD_SPAWN_FAILURE,
        reason,
        persistedVersion,
        supportedVersion,
        consecutiveFailures: state.consecutiveFailures,
        totalFailures: state.totalFailures,
        latched: state.latched,
    };
    state.failure = failure;
    const shouldSurface = state.latched && !state.noticeEmitted;
    if (shouldSurface) state.noticeEmitted = true;
    return { allowSpawn: false, failure, shouldSurface };
}

/**
 * Probe the schema fence immediately before a child is created. The hot path uses
 * the process's existing SQLite handle; an already fail-closed main handle has no
 * handle to query, so its recorded rejection is the authoritative verdict.
 */
export function probeChildSpawnFence(db: Database | null): ChildSpawnFenceProbeResult {
    if (!db) {
        const knownRejection = getSchemaFenceRejection();
        if (knownRejection) {
            return recordStaleFence(
                knownRejection.persistedVersion,
                knownRejection.supportedVersion,
            );
        }
        return { allowSpawn: true };
    }

    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            return recordStaleFence(persistedVersion, LATEST_SUPPORTED_VERSION);
        }
    } catch {
        // A failed read cannot prove that this process still matches the shared
        // schema. Refuse the child rather than allowing one stale spawn across a
        // migration fence; the surfaced doctor command provides the recovery path.
        return recordStaleFence(LATEST_SUPPORTED_VERSION, LATEST_SUPPORTED_VERSION, "read_error");
    }

    // A successful live read re-arms the N-consecutive latch. This is normally
    // unreachable for a monotonic schema version, but keeps a recovered handle
    // from suppressing a later, independent stale-build incident.
    state.consecutiveFailures = 0;
    state.latched = false;
    state.noticeEmitted = false;
    return { allowSpawn: true };
}

export function getChildSpawnFenceFailure(): ChildSpawnFenceFailure | null {
    return state.failure;
}

/** Test seam: child-spawn fence state is process-local by design. */
export function __resetChildSpawnFenceProbeForTests(): void {
    state.consecutiveFailures = 0;
    state.totalFailures = 0;
    state.latched = false;
    state.noticeEmitted = false;
    state.failure = null;
}
