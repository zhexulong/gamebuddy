import type { Database } from "../../shared/sqlite";

export const COMPARTMENT_LEASE_TTL_MS = 5 * 60 * 1000;
export const COMPARTMENT_LEASE_RENEWAL_MS = 60 * 1000;

export interface LeaseAcquired {
    sessionId: string;
    holderId: string;
    acquiredAt: number;
    expiresAt: number;
}

export function acquireCompartmentLease(
    db: Database,
    sessionId: string,
    holderId: string,
): LeaseAcquired | null {
    const acquiredAt = Date.now();
    const expiresAt = acquiredAt + COMPARTMENT_LEASE_TTL_MS;
    const result = db
        .prepare(
            `INSERT INTO compartment_state_lease (session_id, holder_id, acquired_at, expires_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                holder_id = excluded.holder_id,
                acquired_at = excluded.acquired_at,
                expires_at = excluded.expires_at
             WHERE compartment_state_lease.holder_id = excluded.holder_id
                OR compartment_state_lease.expires_at <= ?`,
        )
        .run(sessionId, holderId, acquiredAt, expiresAt, acquiredAt);

    if (result.changes !== 1) {
        return null;
    }

    return { sessionId, holderId, acquiredAt, expiresAt };
}

export function renewCompartmentLease(db: Database, sessionId: string, holderId: string): boolean {
    const now = Date.now();
    const expiresAt = now + COMPARTMENT_LEASE_TTL_MS;
    const result = db
        .prepare(
            `UPDATE compartment_state_lease
             SET expires_at = ?, acquired_at = ?
             WHERE session_id = ? AND holder_id = ? AND expires_at > ?`,
        )
        .run(expiresAt, now, sessionId, holderId, now);
    return result.changes === 1;
}

export function releaseCompartmentLease(db: Database, sessionId: string, holderId: string): void {
    db.prepare("DELETE FROM compartment_state_lease WHERE session_id = ? AND holder_id = ?").run(
        sessionId,
        holderId,
    );
}

export function isCompartmentLeaseHeld(db: Database, sessionId: string, holderId: string): boolean {
    const row = db
        .prepare(
            "SELECT 1 FROM compartment_state_lease WHERE session_id = ? AND holder_id = ? AND expires_at > ?",
        )
        .get(sessionId, holderId, Date.now());
    return row != null;
}
