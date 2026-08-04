import { createHash } from "node:crypto";

import type { MessageLike } from "./transform-operations";

export interface LkgSlot {
    jsonPrefix: string;
    inputIdSeq: string[];
    inputContentDigests: string[];
    lastInputMessageId: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
}

export interface LkgEntryNote {
    pristineTail: MessageLike[];
    entryInputIds: string[];
    entryContentDigests: string[];
    anchorIndex: number;
}

const LKG_TOTAL_BYTES = 64 * 1024 * 1024;
const LKG_SINGLE_SLOT_BYTES = 24 * 1024 * 1024;
const LKG_METADATA_BYTES = 256;

const slots = new Map<string, { slot: LkgSlot; bytes: number }>();
let totalBytes = 0;

function slotBytes(slot: LkgSlot): number {
    const digestBytes = slot.inputContentDigests.reduce(
        (total, digest) => total + 2 * digest.length,
        0,
    );
    return 2 * slot.jsonPrefix.length + digestBytes + LKG_METADATA_BYTES;
}

/** Hash provider-relevant message fields only when capturing or validating a replay. */
export function lkgContentDigest(message: MessageLike): string | null {
    const hash = createHash("sha256");
    const seen = new WeakSet<object>();
    const visit = (value: unknown): void => {
        if (value === null) {
            hash.update("N;");
        } else if (typeof value === "string") {
            hash.update(`S${value.length}:`).update(value);
        } else if (typeof value === "number") {
            hash.update(`D${String(value)};`);
        } else if (typeof value === "boolean") {
            hash.update(value ? "B1;" : "B0;");
        } else if (value === undefined) {
            hash.update("U;");
        } else if (Array.isArray(value)) {
            if (seen.has(value)) throw new Error("cyclic message");
            seen.add(value);
            hash.update(`A${value.length}[`);
            for (const child of value) visit(child);
            hash.update("]");
            seen.delete(value);
        } else if (typeof value === "object") {
            if (seen.has(value)) throw new Error("cyclic message");
            seen.add(value);
            const entries = Object.entries(value);
            hash.update(`O${entries.length}{`);
            for (const [key, child] of entries) {
                hash.update(`K${key.length}:`).update(key);
                visit(child);
            }
            hash.update("}");
            seen.delete(value);
        } else {
            hash.update(`X${typeof value};`);
        }
    };
    try {
        visit(message);
        return hash.digest("base64url");
    } catch {
        return null;
    }
}

function touch(sessionId: string, entry: { slot: LkgSlot; bytes: number }): void {
    slots.delete(sessionId);
    slots.set(sessionId, entry);
}

export function captureSlot(sessionId: string, slot: LkgSlot): boolean {
    if (
        slot.inputContentDigests.length !== slot.inputIdSeq.length ||
        slot.inputContentDigests.some((digest) => digest.length === 0)
    ) {
        return false;
    }
    const bytes = slotBytes(slot);
    if (bytes > LKG_SINGLE_SLOT_BYTES) return false;
    const prior = slots.get(sessionId);
    if (prior) totalBytes -= prior.bytes;
    slots.delete(sessionId);
    while (totalBytes + bytes > LKG_TOTAL_BYTES) {
        const oldest = slots.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const evicted = slots.get(oldest);
        slots.delete(oldest);
        if (evicted) totalBytes -= evicted.bytes;
    }
    if (totalBytes + bytes > LKG_TOTAL_BYTES) {
        if (prior) {
            slots.set(sessionId, prior);
            totalBytes += prior.bytes;
        }
        return false;
    }
    const entry = {
        slot: {
            ...slot,
            inputIdSeq: [...slot.inputIdSeq],
            inputContentDigests: [...slot.inputContentDigests],
        },
        bytes,
    };
    slots.set(sessionId, entry);
    totalBytes += bytes;
    return true;
}

export function getSlot(sessionId: string): LkgSlot | undefined {
    const entry = slots.get(sessionId);
    if (!entry) return undefined;
    touch(sessionId, entry);
    return {
        ...entry.slot,
        inputIdSeq: [...entry.slot.inputIdSeq],
        inputContentDigests: [...entry.slot.inputContentDigests],
    };
}

export function dropSlot(sessionId: string, _reason?: string): void {
    const entry = slots.get(sessionId);
    if (!entry) return;
    slots.delete(sessionId);
    totalBytes -= entry.bytes;
}

export function noteEntry(sessionId: string, messages: MessageLike[]): LkgEntryNote | null {
    const slot = getSlot(sessionId);
    if (!slot) return null;
    const entryInputIds = messages.map((message) => {
        const id = (message.info as { id?: unknown } | undefined)?.id;
        return typeof id === "string" ? id : "";
    });
    const anchorIndex = entryInputIds.indexOf(slot.lastInputMessageId);
    if (anchorIndex < 0) return null;
    const entryContentDigests = messages
        .slice(0, anchorIndex + 1)
        .map((message) => lkgContentDigest(message));
    if (entryContentDigests.some((digest) => digest === null)) return null;
    const pristineTail = structuredClone(messages.slice(anchorIndex + 1)) as MessageLike[];
    return {
        pristineTail,
        entryInputIds,
        entryContentDigests: entryContentDigests as string[],
        anchorIndex,
    };
}

export function resetLkgSlotsForTest(): void {
    slots.clear();
    totalBytes = 0;
}

export function getLkgSlotStatsForTest(): { totalBytes: number; count: number } {
    return { totalBytes, count: slots.size };
}

export const __resetLkgSlotStoreForTest = resetLkgSlotsForTest;
