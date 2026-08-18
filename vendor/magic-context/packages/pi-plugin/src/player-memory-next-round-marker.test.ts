import { beforeEach, describe, expect, it } from "bun:test";
import {
    PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA,
    activatePlayerMemoryNextRoundEvidence,
    clearPlayerMemoryNextRoundMarker,
    recordPlayerMemoryNextRoundMaterialization,
    registerPlayerMemoryNextRoundMaterializationRefresh,
    registerPlayerMemoryNextRoundMarker,
    registerPlayerMemoryNextRoundMarkerHook,
    reservePlayerMemoryNextRoundEvidence,
    resetPlayerMemoryNextRoundMarkersForTest,
} from "./player-memory-next-round-marker";

const binding = Object.freeze({
    sessionId: "chat_session",
    surface: "chat" as const,
    nonceSha256: "a".repeat(64),
});
const correlation = "c".repeat(22);
beforeEach(resetPlayerMemoryNextRoundMarkersForTest);

function hooks() {
    const handlers = new Map<string, (event: unknown, context: { sessionManager: { getSessionId(): string } }) => void>();
    registerPlayerMemoryNextRoundMarkerHook({
        on(event: string, handler: never) { handlers.set(event, handler as never); },
    } as never);
    return handlers;
}
function captureProcessSend(fn: () => void): unknown[] {
    const reports: unknown[] = [];
    const original = process.send;
    const connected = process.connected;
    Object.defineProperty(process, "send", { configurable: true, value: (message: unknown, callback: () => void) => { reports.push(message); callback(); return true; } });
    Object.defineProperty(process, "connected", { configurable: true, value: true });
    try { fn(); } finally {
        Object.defineProperty(process, "send", { configurable: true, value: original });
        Object.defineProperty(process, "connected", { configurable: true, value: connected });
    }
    return reports;
}
function activateSelectedMemory(mutationId = 17, targetMemoryId = 7) {
    reservePlayerMemoryNextRoundEvidence(binding, correlation);
    activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: mutationId }, targetMemoryId);
    recordPlayerMemoryNextRoundMaterialization(binding.sessionId, mutationId, [{ memoryId: targetMemoryId, latestMutationId: mutationId }]);
}

const expectedMarker = Object.freeze({
    schema: PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA,
    sessionId: binding.sessionId,
    nonceSha256: binding.nonceSha256,
    surface: "chat",
    operationCorrelation: correlation,
    committedMemoryMutationId: 17,
    materializedM1MaxMemoryMutationId: 17,
    providerRoundGeneration: 1,
    covered: true,
    oneShot: true,
});

describe("Player Memory exact-next provider evidence", () => {
    it("invalidates frozen m[1] locally when a direct committed mutation activates", () => {
        const refreshed: string[] = [];
        registerPlayerMemoryNextRoundMarker(binding, () => undefined);
        registerPlayerMemoryNextRoundMaterializationRefresh((sessionId) => refreshed.push(sessionId));
        reservePlayerMemoryNextRoundEvidence(binding, correlation);
        activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: 17 }, 7);
        expect(refreshed).toEqual([binding.sessionId]);
    });

    it("delivers the exact activated commit marker only through the private source callback", () => {
        const local: unknown[] = [];
        registerPlayerMemoryNextRoundMarker(binding, (marker) => { local.push(marker); });
        activateSelectedMemory();
        const before = hooks().get("before_provider_request")!;
        const reports = captureProcessSend(() => {
            before({ prompt: "must not read" }, { sessionManager: { getSessionId: () => binding.sessionId } });
            before({}, { sessionManager: { getSessionId: () => binding.sessionId } });
        });
        expect(local).toEqual([expectedMarker]);
        expect(reports).toEqual([]);
        const wire = JSON.stringify(local);
        for (const forbidden of ["prompt", "content", "targetMemoryId", "stateToken", "projectPath", "sourceRef", "response"])
            expect(wire).not.toContain(forbidden);
    });

    it("does not expose the raw marker through IPC when local source delivery fails", () => {
        registerPlayerMemoryNextRoundMarker(binding, () => { throw new Error("host_delivery_failed"); });
        activateSelectedMemory();
        const before = hooks().get("before_provider_request")!;
        expect(captureProcessSend(() => before({}, { sessionManager: { getSessionId: () => binding.sessionId } }))).toEqual([]);
    });

    it("reports uncovered locally on the first exact provider hook and cannot cross a stale round", () => {
        const local: unknown[] = [];
        registerPlayerMemoryNextRoundMarker(binding, (marker) => local.push(marker));
        reservePlayerMemoryNextRoundEvidence(binding, correlation);
        activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: 22 }, 8);
        recordPlayerMemoryNextRoundMaterialization(binding.sessionId, 21, [{ memoryId: 8, latestMutationId: 21 }]);
        const before = hooks().get("before_provider_request")!;
        before({}, { sessionManager: { getSessionId: () => binding.sessionId } });
        expect(local).toHaveLength(1);
        expect((local[0] as { covered: boolean }).covered).toBe(false);
        recordPlayerMemoryNextRoundMaterialization(binding.sessionId, 999, [{ memoryId: 8, latestMutationId: 999 }]);
        before({}, { sessionManager: { getSessionId: () => binding.sessionId } });
        expect(local).toHaveLength(1);
    });

    it("is uncovered when a newer cached cursor belongs to a Memory omitted by trimming", () => {
        const local: unknown[] = [];
        registerPlayerMemoryNextRoundMarker(binding, (marker) => local.push(marker));
        reservePlayerMemoryNextRoundEvidence(binding, correlation);
        activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: 22 }, 8);
        recordPlayerMemoryNextRoundMaterialization(binding.sessionId, 99, [{ memoryId: 9, latestMutationId: 99 }]);
        hooks().get("before_provider_request")!({}, { sessionManager: { getSessionId: () => binding.sessionId } });
        expect(local).toEqual([expect.objectContaining({ materializedM1MaxMemoryMutationId: 99, covered: false })]);
    });

    it("is uncovered when the same Memory changed after the committed revision", () => {
        const local: unknown[] = [];
        registerPlayerMemoryNextRoundMarker(binding, (marker) => local.push(marker));
        reservePlayerMemoryNextRoundEvidence(binding, correlation);
        activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: 22 }, 8);
        recordPlayerMemoryNextRoundMaterialization(binding.sessionId, 23, [{ memoryId: 8, latestMutationId: 23 }]);
        hooks().get("before_provider_request")!({}, { sessionManager: { getSessionId: () => binding.sessionId } });
        expect(local).toEqual([expect.objectContaining({ materializedM1MaxMemoryMutationId: 23, covered: false })]);
    });

    it("rejects replacement, wrong bindings and shutdown replay", () => {
        expect(() => registerPlayerMemoryNextRoundMarker(binding, undefined as never)).toThrow("marker_callback");
        registerPlayerMemoryNextRoundMarker(binding, () => undefined);
        expect(() => registerPlayerMemoryNextRoundMarker(binding, () => undefined)).toThrow("already_registered");
        expect(() => reservePlayerMemoryNextRoundEvidence({ ...binding, surface: "game" }, correlation)).toThrow("binding_unavailable");
        expect(() => reservePlayerMemoryNextRoundEvidence({ ...binding, sessionId: "other" }, correlation)).toThrow("binding_unavailable");
        reservePlayerMemoryNextRoundEvidence(binding, correlation);
        expect(() => reservePlayerMemoryNextRoundEvidence(binding, "d".repeat(22))).toThrow("slot_unavailable");
        clearPlayerMemoryNextRoundMarker(binding.sessionId);
        expect(() => activatePlayerMemoryNextRoundEvidence(binding, { operationCorrelation: correlation, committedMemoryMutationId: 1 }, 1)).toThrow("activation_invalid");
    });
});
