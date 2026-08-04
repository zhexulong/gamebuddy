import type { Database } from "../../../shared/sqlite";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes — renewed periodically during task execution

/**
 * Dreamer v2 uses one lease PER CONFLICT-DOMAIN (memory:<project>,
 * key-files:<project>, user-memories, …) so disjoint-state tasks don't block
 * each other while the memory-mutating tasks still serialize. A lease is three
 * `dream_state` rows under a key namespace.
 *
 * `DREAMING_LEASE_KEY` is the legacy single-lease key. It keeps the original
 * `acquireLease(db, holderId)` signature working (the lease-key param defaults to
 * it) for the still-suite-based runner until the per-task scheduler replaces it.
 */
export const DREAMING_LEASE_KEY = "dreaming";

interface LeaseRowKeys {
    holder: string;
    heartbeat: string;
    expiry: string;
}

function rowKeys(leaseKey: string): LeaseRowKeys {
    // The legacy lease retains its historical un-namespaced row keys so an
    // in-flight pre-upgrade lease isn't orphaned across the boundary.
    if (leaseKey === DREAMING_LEASE_KEY) {
        return {
            holder: "dreaming_lease_holder",
            heartbeat: "dreaming_lease_heartbeat",
            expiry: "dreaming_lease_expiry",
        };
    }
    return {
        holder: `lease:${leaseKey}:holder`,
        heartbeat: `lease:${leaseKey}:heartbeat`,
        expiry: `lease:${leaseKey}:expiry`,
    };
}

function getLeaseExpiry(db: Database, keys: LeaseRowKeys): number | null {
    const value = getDreamState(db, keys.expiry);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database, leaseKey: string = DREAMING_LEASE_KEY): boolean {
    const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database, leaseKey: string = DREAMING_LEASE_KEY): string | null {
    return getDreamState(db, rowKeys(leaseKey).holder);
}

export function peekLeaseHolderAndExpiry(
    db: Database,
    expectedHolder: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    const holder = getDreamState(db, keys.holder);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, keys.expiry);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

// The lease spans three dream_state rows (holder/heartbeat/expiry), so it can't
// be a single-statement CAS like compartment-lease.ts. Instead each mutation
// runs under BEGIN IMMEDIATE: the write lock is taken at BEGIN time (not at the
// first write, as the deferred BEGIN that db.transaction() emits would), so the
// read-then-write is atomic across the OpenCode+Pi processes that share this
// SQLite file. Without IMMEDIATE, two processes could both read isLeaseActive()
// = false under WAL snapshot isolation and both write — double-acquiring the
// lease and spawning duplicate dreamer workers. busy_timeout (set in
// initializeDatabase) makes the loser wait rather than throw SQLITE_BUSY.
function runImmediate<T>(db: Database, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // already rolled back / no active transaction
            }
        }
    }
}

export function acquireLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (isLeaseActive(db, leaseKey)) {
            const existingHolder = getLeaseHolder(db, leaseKey);
            if (existingHolder && existingHolder !== holderId) {
                return false;
            }
        }

        const now = Date.now();
        setDreamState(db, keys.holder, holderId);
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function renewLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId || !isLeaseActive(db, leaseKey)) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function runLeaseGuardedWrite<T>(
    db: Database,
    holderId: string,
    leaseKey: string,
    fn: () => T,
): T {
    return runImmediate(db, () => {
        // The lease is checked after BEGIN IMMEDIATE has acquired SQLite's write
        // lock. That removes the deferred-transaction gap where another process
        // could steal the lease after a peek but before the durable mutation.
        if (!peekLeaseHolderAndExpiry(db, holderId, leaseKey)) {
            throw new Error("Dream lease lost before guarded write");
        }
        return fn();
    });
}

/** Renewal beat interval. The lease TTL is LEASE_DURATION_MS (2×), so a single
 *  missed or contended beat still leaves a full interval of runway. */
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface LeaseHeartbeat {
    /** Stop the heartbeat timer. Safe to call more than once. */
    stop(): void;
    /** True once the lease was confirmed genuinely lost (and onLost was called). */
    readonly lost: boolean;
}

/**
 * Keep a held lease alive on a background interval, tolerating transient DB
 * contention. The brittle inline pattern this replaces aborted the whole task on
 * the FIRST renewal hiccup — including a transient SQLITE_BUSY throw under a
 * multi-instance lock storm — even though the 2-minute TTL means one missed 60s
 * beat is harmless. That killed multi-minute dreamer runs (map-memories/verify)
 * with "prompt aborted by external signal" when the lease was never actually
 * lost.
 *
 * We declare the lease lost (and call onLost ONCE) only when:
 *   - a DIFFERENT holder actively owns it — renewLease fails and acquireLease
 *     can't reclaim it (acquireLease reclaims an expired-but-free lease, so a
 *     self-inflicted expiry from our own delayed beat recovers instead of
 *     killing the run); or
 *   - a full TTL has elapsed with no confirmed renewal (only reachable via
 *     repeated transient throws), past which exclusive ownership can't be
 *     guaranteed.
 * A transient throw with a recent successful renewal is swallowed and retried on
 * the next beat.
 */
export function startLeaseHeartbeat(
    db: Database,
    holderId: string,
    leaseKey: string,
    onLost: (reason: string) => void,
    intervalMs: number = LEASE_HEARTBEAT_INTERVAL_MS,
): LeaseHeartbeat {
    let lost = false;
    let lastConfirmedAt = Date.now();
    const declareLost = (reason: string): void => {
        if (lost) return;
        lost = true;
        onLost(reason);
    };
    const beat = () => {
        if (lost) return;
        try {
            // Continuous ownership: renewLease keeps it if still ours. This is
            // the always-safe path — we never lost the lease.
            if (renewLease(db, holderId, leaseKey)) {
                lastConfirmedAt = Date.now();
                return;
            }
            // renewLease failed → we are no longer the recorded holder OR the
            // lease lapsed. If the gap since our last confirmed beat exceeds a
            // full TTL, the lease was provably claimable by another process for a
            // meaningful window — a sibling could have acquired AND mutated in the
            // gap (a >2min stall / machine sleep), so blindly reclaiming a now-free
            // lease and continuing on our stale snapshot is split-brain. Declare
            // lost instead. A SHORT delay (≤ TTL, e.g. a slightly-late 60s beat
            // causing self-inflicted expiry) still recovers via reclaim below.
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease lapsed past TTL — another holder may have run");
                return;
            }
            // reclaim an expired-but-free lease after only a short gap (our own
            // delayed beat); returns false only when a different holder is
            // actively in possession.
            if (acquireLease(db, holderId, leaseKey)) {
                lastConfirmedAt = Date.now();
                return;
            }
            declareLost("lease acquired by another holder");
        } catch {
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease renewal unconfirmed past TTL");
            }
        }
    };

    // Confirm ownership before the caller can begin work. Without this first
    // synchronous beat, a long pre-prompt stall could let the TTL expire and a
    // same-domain runner start while this runner still waits for the 60s timer.
    beat();

    const timer = lost ? undefined : setInterval(beat, intervalMs);
    return {
        stop: () => {
            if (timer) clearInterval(timer);
        },
        get lost() {
            return lost;
        },
    };
}

export function releaseLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): void {
    const keys = rowKeys(leaseKey);
    runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId) {
            return;
        }

        deleteDreamState(db, keys.holder);
        deleteDreamState(db, keys.heartbeat);
        deleteDreamState(db, keys.expiry);
    });
}
