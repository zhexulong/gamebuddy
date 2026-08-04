import { getCompartmentsByEndMessageId } from "@magic-context/core/features/magic-context/compartment-storage";
import type { PendingPiCompactionMarker } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

export type PiMarkerUpdateOutcome =
	| { kind: "applied"; firstKeptEntryId: string }
	| { kind: "already-current" }
	| {
			kind: "stale-skip";
			reason: "compartment-removed" | "target-superseded" | "entry-removed";
	  }
	| { kind: "retryable-failure"; error: Error };

export interface ApplyDeferredPiCompactionMarkerDeps {
	db: Database;
	readBranchEntries: () => unknown[];
	appendCompaction: (
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	) => string | undefined;
}

export function applyDeferredPiCompactionMarker(
	deps: ApplyDeferredPiCompactionMarkerDeps,
	sessionId: string,
	pending: PendingPiCompactionMarker,
): PiMarkerUpdateOutcome {
	try {
		const matches = getCompartmentsByEndMessageId(
			deps.db,
			sessionId,
			pending.endMessageId,
		);
		if (matches.length === 0 || matches.length > 1) {
			if (matches.length > 1) {
				sessionLog(
					sessionId,
					`Pi compaction-marker drain: ${matches.length} compartments share endMessageId=${pending.endMessageId}; treating as stale`,
				);
			}
			return { kind: "stale-skip", reason: "compartment-removed" };
		}
		if (matches[0]?.endMessage !== pending.ordinal) {
			return { kind: "stale-skip", reason: "target-superseded" };
		}

		const branchEntries = deps.readBranchEntries();
		const pendingFirstKeptIndex = findEntryIndex(
			branchEntries,
			pending.firstKeptEntryId,
		);
		if (pendingFirstKeptIndex < 0) {
			return { kind: "stale-skip", reason: "entry-removed" };
		}

		const latestFirstKept = findLatestCompactionFirstKept(branchEntries);
		if (latestFirstKept !== null) {
			const latestFirstKeptIndex = findEntryIndex(
				branchEntries,
				latestFirstKept,
			);
			if (latestFirstKeptIndex >= pendingFirstKeptIndex) {
				return { kind: "already-current" };
			}
		}

		const compactionId = deps.appendCompaction(
			pending.summary,
			pending.firstKeptEntryId,
			pending.tokensBefore,
			{
				source: "magic-context",
				lastCompactedOrdinal: pending.ordinal,
			},
			true,
		);
		if (typeof compactionId !== "string" || compactionId.length === 0) {
			return {
				kind: "retryable-failure",
				error: new Error("Pi appendCompaction returned no compaction id"),
			};
		}
		sessionLog(
			sessionId,
			`Pi compaction-marker drain: applied compactionId=${compactionId} firstKept=${pending.firstKeptEntryId} endMessageId=${pending.endMessageId} ordinal=${pending.ordinal} tokensBefore=${pending.tokensBefore}`,
		);
		return { kind: "applied", firstKeptEntryId: pending.firstKeptEntryId };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		sessionLog(
			sessionId,
			`Pi compaction-marker drain: retryable failure for ordinal ${pending.ordinal}:`,
			error,
		);
		return { kind: "retryable-failure", error };
	}
}

export function findLatestCompactionFirstKept(
	branchEntries: unknown[],
): string | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; firstKeptEntryId?: unknown };
		if (
			record.type === "compaction" &&
			typeof record.firstKeptEntryId === "string"
		) {
			return record.firstKeptEntryId;
		}
	}
	return null;
}

function getEntryId(entry: unknown): string | null {
	if (entry === null || typeof entry !== "object") return null;
	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" ? id : null;
}

function findEntryIndex(branchEntries: unknown[], entryId: string): number {
	return branchEntries.findIndex((entry) => getEntryId(entry) === entryId);
}
