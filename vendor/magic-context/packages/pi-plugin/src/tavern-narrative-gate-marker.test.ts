import { beforeEach, describe, expect, it } from "bun:test";
import {
    clearTavernNarrativeGateMarker,
    countTavernProviderStartObserversForTest,
    fireTavernProviderStartObservationForTest,
    GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
    hasTavernProviderStartObserverForTest,
    publishGameOperationalGateMaterialization,
    registerGameOperationalGateMarker,
    registerTavernNarrativeGateMarker,
    registerTavernNarrativeGateMarkerHook,
    registerTavernProviderStartObserver,
    resetTavernNarrativeGateMarkersForTest,
    TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
    TAVERN_PROVIDER_START_OBSERVATION_SCHEMA,
    validateGameOperationalGateMarkerConfig,
    validateTavernNarrativeGateMarkerConfig,
} from "./tavern-narrative-gate-marker";

const digest = "a".repeat(64);

beforeEach(() => resetTavernNarrativeGateMarkersForTest());

describe("Tavern narrative gate marker binding", () => {
    it("validates the exact session and digest schema", () => {
        expect(
            validateTavernNarrativeGateMarkerConfig({
                sessionId: "session_1",
                nonceSha256: digest,
            }),
        ).toEqual({ sessionId: "session_1", nonceSha256: digest });
        expect(() =>
            validateTavernNarrativeGateMarkerConfig({
                sessionId: "session/1",
                nonceSha256: digest,
            }),
        ).toThrow("invalid_tavern_marker_config");
        expect(() =>
            validateTavernNarrativeGateMarkerConfig({ sessionId: "session_1", nonceSha256: "bad" }),
        ).toThrow("invalid_tavern_marker_config");
    });

    it("is one-shot and cleanup is session-bound", () => {
        const clear = registerTavernNarrativeGateMarker({
            sessionId: "session_1",
            nonceSha256: digest,
        });
        clearTavernNarrativeGateMarker("other_session");
        clear();
        expect(() =>
            registerTavernNarrativeGateMarker({ sessionId: "session_1", nonceSha256: digest }),
        ).not.toThrow();
        clearTavernNarrativeGateMarker("session_1");
    });
});

describe("Tavern provider-start observation", () => {
    type HookCtx = { sessionManager: { getSessionId(): string } };
    type FireHandlers = Map<string, (event: unknown, ctx: HookCtx) => void>;

    const captureHandlers = (): FireHandlers => {
        const handlers = new Map<string, (event: unknown, ctx: HookCtx) => void>();
        registerTavernNarrativeGateMarkerHook({
            on(event: string, handler: never) {
                handlers.set(event, handler as never);
            },
        } as never);
        return handlers;
    };

    it("is exact-session, one-shot, and unregister is opaque and exact-session", () => {
        const received: unknown[] = [];
        const unregister = registerTavernProviderStartObserver("session_1", (observation) => {
            received.push(observation);
        });
        expect(hasTavernProviderStartObserverForTest("session_1")).toBe(true);
        expect(countTavernProviderStartObserversForTest()).toBe(1);
        clearTavernNarrativeGateMarker("other_session");
        expect(hasTavernProviderStartObserverForTest("session_1")).toBe(true);
        fireTavernProviderStartObservationForTest("session_1", "success");
        expect(received.length).toBe(1);
        const observation = received[0] as Record<string, unknown>;
        expect(observation.schema).toBe(TAVERN_PROVIDER_START_OBSERVATION_SCHEMA);
        expect(observation.sessionId).toBe("session_1");
        expect(observation.statusClass).toBe("success");
        expect(Object.keys(observation).sort()).toEqual(["observedAtMs", "schema", "sessionId", "statusClass"]);
        // One-shot: a second fire must not invoke or write again.
        fireTavernProviderStartObservationForTest("session_1", "error");
        expect(received.length).toBe(1);
        expect(countTavernProviderStartObserversForTest()).toBe(0);
        // Re-register then unregister clears only the exact binding.
        let calls = 0;
        const other = registerTavernProviderStartObserver("session_1", () => {
            calls += 1;
        });
        const foreign = registerTavernProviderStartObserver("session_2", () => {
            calls += 1;
        });
        other();
        fireTavernProviderStartObservationForTest("session_2", "error");
        expect(calls).toBe(1);
        foreign();
        expect(countTavernProviderStartObserversForTest()).toBe(0);
    });

    it("rejects a duplicate exact-session registration without replacing the first observer", () => {
        const received: string[] = [];
        const unregister = registerTavernProviderStartObserver("session_1", () => {
            received.push("first");
        });
        expect(() =>
            registerTavernProviderStartObserver("session_1", () => {
                received.push("second");
            }),
        ).toThrow("tavern_provider_start_observer_already_registered");
        fireTavernProviderStartObservationForTest("session_1", "success");
        expect(received).toEqual(["first"]);
        unregister();
    });

    it("validates the exact session schema and rejects malformed callbacks", () => {
        expect(() => registerTavernProviderStartObserver("session/1", () => undefined)).toThrow(
            "invalid_tavern_provider_start_observer_session",
        );
        expect(() => registerTavernProviderStartObserver("", () => undefined)).toThrow(
            "invalid_tavern_provider_start_observer_session",
        );
        expect(() => registerTavernProviderStartObserver("session_1", undefined as never)).toThrow(
            "invalid_tavern_provider_start_observer_callback",
        );
    });

    it("classifies 2xx as success and every other status as error without payload retention", () => {
        const handlers = captureHandlers();
        const received: unknown[] = [];
        registerTavernProviderStartObserver("session_1", (observation) => {
            received.push(observation);
        });
        const afterResponse = handlers.get("after_provider_response");
        if (!afterResponse) throw new Error("missing after_provider_response hook");
        const provider = (status: number) =>
            afterResponse({ type: "after_provider_response", status, headers: { "x-secret": "must-not-leak" } }, {
                sessionManager: { getSessionId: () => "session_1" },
            });
        provider(200);
        provider(201);
        expect((received[0] as Record<string, unknown>).statusClass).toBe("success");
        // Second event cannot replay the consumed binding.
        expect(received.length).toBe(1);
        registerTavernProviderStartObserver("session_1", (observation) => {
            received.push(observation);
        });
        provider(404);
        provider(500);
        expect((received[1] as Record<string, unknown>).statusClass).toBe("error");
        expect(received.length).toBe(2);
        const serialized = JSON.stringify(received);
        expect(serialized).not.toContain("x-secret");
        expect(serialized).not.toContain("must-not-leak");
        expect(serialized).not.toContain("headers");
        expect(serialized).not.toContain("prompt");
        expect(serialized).not.toContain("body");
    });

    it("never fires for a foreign or malformed session and never reads other surfaces", () => {
        const handlers = captureHandlers();
        const received: unknown[] = [];
        registerTavernProviderStartObserver("session_1", (observation) => {
            received.push(observation);
        });
        const afterResponse = handlers.get("after_provider_response");
        const beforeSwitch = handlers.get("session_before_switch");
        const shutdown = handlers.get("session_shutdown");
        if (!afterResponse || !beforeSwitch || !shutdown) throw new Error("missing hooks");
        const foreignCtx = { sessionManager: { getSessionId: () => "session_2" } };
        afterResponse({ type: "after_provider_response", status: 200, headers: {} }, foreignCtx);
        expect(received.length).toBe(0);
        // The current session binding is cleared synchronously before any switch.
        const currentCtx = { sessionManager: { getSessionId: () => "session_1" } };
        beforeSwitch({ type: "session_before_switch", reason: "new" }, currentCtx);
        expect(hasTavernProviderStartObserverForTest("session_1")).toBe(false);
        afterResponse({ type: "after_provider_response", status: 200, headers: {} }, currentCtx);
        expect(received.length).toBe(0);
        // Session shutdown is the process-exit defense in depth.
        registerTavernProviderStartObserver("session_1", (observation) => {
            received.push(observation);
        });
        shutdown({ type: "session_shutdown" }, currentCtx);
        expect(hasTavernProviderStartObserverForTest("session_1")).toBe(false);
    });

    it("keeps the before_provider_request narrative-gate IPC marker untouched", () => {
        expect(TAVERN_NARRATIVE_GATE_MARKER_SCHEMA).toBe("gamebuddy-tavern-narrative-gate-marker/v1");
        const handlers = captureHandlers();
        expect(handlers.has("before_provider_request")).toBe(true);
        registerTavernProviderStartObserver("session_1", () => undefined);
        const marker = registerTavernNarrativeGateMarker({ sessionId: "session_1", nonceSha256: digest });
        const reports: unknown[] = [];
        const originalSend = process.send;
        const originalConnected = process.connected;
        Object.defineProperty(process, "send", {
            configurable: true,
            value: (message: unknown, callback: () => void) => {
                reports.push(message);
                callback();
                return true;
            },
        });
        Object.defineProperty(process, "connected", { configurable: true, value: true });
        try {
            const beforeRequest = handlers.get("before_provider_request");
            if (!beforeRequest) throw new Error("missing provider hook");
            beforeRequest({}, { sessionManager: { getSessionId: () => "session_1" } });
        } finally {
            Object.defineProperty(process, "send", { configurable: true, value: originalSend });
            Object.defineProperty(process, "connected", {
                configurable: true,
                value: originalConnected,
            });
            marker();
        }
        expect(reports).toEqual([
            {
                schema: TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
                sessionId: "session_1",
                nonceSha256: digest,
            },
        ]);
    });
});

describe("Game Operational Gate marker binding", () => {
    it("requires the exact session, digest, and surface schema", () => {
        expect(
            validateGameOperationalGateMarkerConfig({
                sessionId: "game_1",
                nonceSha256: digest,
                surface: "game",
            }),
        ).toEqual({ sessionId: "game_1", nonceSha256: digest, surface: "game" });
        for (const invalid of [
            { sessionId: "game_1", nonceSha256: digest },
            { sessionId: "game_1", nonceSha256: digest, surface: "other" },
            { sessionId: "game_1", nonceSha256: digest, surface: "game", extra: true },
            { sessionId: "game/1", nonceSha256: digest, surface: "game" },
        ])
            expect(() => validateGameOperationalGateMarkerConfig(invalid)).toThrow(
                "invalid_game_operational_gate_marker_config",
            );
    });

    it("reports only source-owned aggregate counts once without content leakage", () => {
        const handlers = new Map<
            string,
            (event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => void
        >();
        registerTavernNarrativeGateMarkerHook({
            on(event: string, handler: never) {
                handlers.set(event, handler as never);
            },
        } as never);
        const reports: unknown[] = [];
        const originalSend = process.send;
        const originalConnected = process.connected;
        Object.defineProperty(process, "send", {
            configurable: true,
            value: (message: unknown, callback: () => void) => {
                reports.push(message);
                callback();
                return true;
            },
        });
        Object.defineProperty(process, "connected", { configurable: true, value: true });
        try {
            registerGameOperationalGateMarker({
                sessionId: "game_1",
                nonceSha256: digest,
                surface: "game",
            });
            publishGameOperationalGateMaterialization("game_1", {
                m1MaxMemoryMutationId: 17,
                materializedCategoryCounts: { SEMANTIC_MEMORY: 2, INTERACTION_EPISODE: 3 },
            });
            const beforeRequest = handlers.get("before_provider_request");
            if (!beforeRequest) throw new Error("missing provider hook");
            beforeRequest({}, { sessionManager: { getSessionId: () => "game_1" } });
            beforeRequest({}, { sessionManager: { getSessionId: () => "game_1" } });
        } finally {
            Object.defineProperty(process, "send", { configurable: true, value: originalSend });
            Object.defineProperty(process, "connected", {
                configurable: true,
                value: originalConnected,
            });
        }
        expect(reports).toEqual([
            {
                schema: GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
                sessionId: "game_1",
                nonceSha256: digest,
                surface: "game",
                m1MaxMemoryMutationId: 17,
                materializedCategoryCounts: { SEMANTIC_MEMORY: 2, INTERACTION_EPISODE: 3 },
            },
        ]);
        const serialized = JSON.stringify(reports);
        expect(serialized).not.toContain("prompt");
        expect(serialized).not.toContain("provider");
        expect(serialized).not.toContain("storage");
        expect(serialized).not.toContain("projectPath");
    });

    it("does not alter Tavern registrations", () => {
        const clear = registerGameOperationalGateMarker({
            sessionId: "game_1",
            nonceSha256: digest,
            surface: "chat",
        });
        clear();
        expect(() =>
            registerTavernNarrativeGateMarker({ sessionId: "game_1", nonceSha256: digest }),
        ).not.toThrow();
        expect(GAME_OPERATIONAL_GATE_MARKER_SCHEMA).toBe(
            "gamebuddy-game-operational-gate-marker/v1",
        );
    });
});
