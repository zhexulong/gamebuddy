import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TAVERN_NARRATIVE_GATE_MARKER_SCHEMA =
    "gamebuddy-tavern-narrative-gate-marker/v1" as const;
export const GAME_OPERATIONAL_GATE_MARKER_SCHEMA =
    "gamebuddy-game-operational-gate-marker/v1" as const;
export const TAVERN_PROVIDER_START_OBSERVATION_SCHEMA =
    "gamebuddy-tavern-provider-start-observation/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

type TavernMarkerBinding = Readonly<{ kind: "tavern"; sessionId: string; nonceSha256: string }>;
type GameOperationalGateBinding = Readonly<{
    kind: "game_operational";
    sessionId: string;
    nonceSha256: string;
    surface: "chat" | "game";
}>;
type MarkerBinding = TavernMarkerBinding | GameOperationalGateBinding;
type GameOperationalGateMaterialization = Readonly<{
    m1MaxMemoryMutationId: number;
    materializedCategoryCounts: Readonly<{
        SEMANTIC_MEMORY: number;
        INTERACTION_EPISODE: number;
    }>;
}>;

const bindings = new Map<string, MarkerBinding>();
const materializations = new Map<string, GameOperationalGateMaterialization>();

/** Bounded provider-start observation; it never retains payload, headers, or prompt bytes. */
export type TavernProviderStartObservation = Readonly<{
    schema: typeof TAVERN_PROVIDER_START_OBSERVATION_SCHEMA;
    sessionId: string;
    statusClass: "success" | "error";
    observedAtMs: number;
}>;

type TavernProviderStartObserverBinding = Readonly<{
    sessionId: string;
    onStart: (observation: TavernProviderStartObservation) => void;
}>;
const providerStartObservers = new Map<string, TavernProviderStartObserverBinding>();

export function validateTavernNarrativeGateMarkerConfig(
    value: unknown,
): Readonly<{ sessionId: string; nonceSha256: string }> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("invalid_tavern_marker_config");
    const candidate = value as Record<string, unknown>;
    if (
        Object.keys(candidate).length !== 2 ||
        !Object.keys(candidate).every((key) => key === "sessionId" || key === "nonceSha256")
    )
        throw new Error("invalid_tavern_marker_config");
    if (typeof candidate.sessionId !== "string" || !SESSION_ID.test(candidate.sessionId))
        throw new Error("invalid_tavern_marker_config");
    if (typeof candidate.nonceSha256 !== "string" || !SHA256.test(candidate.nonceSha256))
        throw new Error("invalid_tavern_marker_config");
    return Object.freeze({ sessionId: candidate.sessionId, nonceSha256: candidate.nonceSha256 });
}

/** Strict Host-only binding for the source-owned Chat/Game operational marker. */
export function validateGameOperationalGateMarkerConfig(
    value: unknown,
): Readonly<{ sessionId: string; nonceSha256: string; surface: "chat" | "game" }> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("invalid_game_operational_gate_marker_config");
    const candidate = value as Record<string, unknown>;
    if (
        Object.keys(candidate).length !== 3 ||
        !Object.keys(candidate).every(
            (key) => key === "sessionId" || key === "nonceSha256" || key === "surface",
        )
    )
        throw new Error("invalid_game_operational_gate_marker_config");
    if (typeof candidate.sessionId !== "string" || !SESSION_ID.test(candidate.sessionId))
        throw new Error("invalid_game_operational_gate_marker_config");
    if (typeof candidate.nonceSha256 !== "string" || !SHA256.test(candidate.nonceSha256))
        throw new Error("invalid_game_operational_gate_marker_config");
    if (candidate.surface !== "chat" && candidate.surface !== "game")
        throw new Error("invalid_game_operational_gate_marker_config");
    return Object.freeze({
        sessionId: candidate.sessionId,
        nonceSha256: candidate.nonceSha256,
        surface: candidate.surface,
    });
}

/** Host-only in-process binding. The digest is the only Tavern marker secret accepted. */
export function registerTavernNarrativeGateMarker(
    value: Readonly<{ sessionId: string; nonceSha256: string }>,
): () => void {
    const config = validateTavernNarrativeGateMarkerConfig(value);
    const binding: TavernMarkerBinding = Object.freeze({ kind: "tavern", ...config });
    bindings.set(binding.sessionId, binding);
    return () => {
        if (bindings.get(binding.sessionId) === binding) bindings.delete(binding.sessionId);
    };
}

/** Host-only in-process binding for a payload-blind Game Operational Gate marker. */
export function registerGameOperationalGateMarker(
    value: Readonly<{ sessionId: string; nonceSha256: string; surface: "chat" | "game" }>,
): () => void {
    const config = validateGameOperationalGateMarkerConfig(value);
    const binding: GameOperationalGateBinding = Object.freeze({
        kind: "game_operational",
        ...config,
    });
    bindings.set(binding.sessionId, binding);
    return () => {
        if (bindings.get(binding.sessionId) === binding) {
            bindings.delete(binding.sessionId);
            materializations.delete(binding.sessionId);
        }
    };
}

/**
 * Source-owned injection instrumentation. It accepts only the aggregate emitted
 * by Magic Context's own m[0]/m[1] materializer and retains no prompt content,
 * memory identity, project identity, provider data, or storage location.
 */
export function publishGameOperationalGateMaterialization(
    sessionId: string,
    value: GameOperationalGateMaterialization,
): void {
    const binding = bindings.get(sessionId);
    if (binding?.kind !== "game_operational") return;
    const counts = value.materializedCategoryCounts;
    if (
        !Number.isSafeInteger(value.m1MaxMemoryMutationId) ||
        value.m1MaxMemoryMutationId < 0 ||
        !Number.isSafeInteger(counts.SEMANTIC_MEMORY) ||
        counts.SEMANTIC_MEMORY < 0 ||
        !Number.isSafeInteger(counts.INTERACTION_EPISODE) ||
        counts.INTERACTION_EPISODE < 0
    )
        return;
    materializations.set(
        sessionId,
        Object.freeze({
            m1MaxMemoryMutationId: value.m1MaxMemoryMutationId,
            materializedCategoryCounts: Object.freeze({
                SEMANTIC_MEMORY: counts.SEMANTIC_MEMORY,
                INTERACTION_EPISODE: counts.INTERACTION_EPISODE,
            }),
        }),
    );
}

export function clearTavernNarrativeGateMarker(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) return;
    bindings.delete(sessionId);
    materializations.delete(sessionId);
    providerStartObservers.delete(sessionId);
}

/**
 * Host-only in-process, exact-session one-shot provider-start observer. The
 * returned unregister clears only this exact session binding. The callback
 * receives an opaque bounded `{ sessionId, statusClass }` fact and never a
 * payload, header, prompt, or model body.
 */
export function registerTavernProviderStartObserver(
    sessionId: string,
    onStart: (observation: TavernProviderStartObservation) => void,
): () => void {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))
        throw new Error("invalid_tavern_provider_start_observer_session");
    if (typeof onStart !== "function") throw new Error("invalid_tavern_provider_start_observer_callback");
    if (providerStartObservers.has(sessionId))
        throw new Error("tavern_provider_start_observer_already_registered");
    const binding: TavernProviderStartObserverBinding = Object.freeze({
        sessionId,
        onStart,
    });
    providerStartObservers.set(sessionId, binding);
    return () => {
        if (providerStartObservers.get(sessionId) === binding) providerStartObservers.delete(sessionId);
    };
}

/** Test helper; never exposes a binding, callback, or observation payload. */
export function countTavernProviderStartObserversForTest(): number {
    return providerStartObservers.size;
}

/** Test helper; never exposes a binding, callback, or observation payload. */
export function hasTavernProviderStartObserverForTest(sessionId: string): boolean {
    return providerStartObservers.has(sessionId);
}

function consumeProviderStartObserver(sessionId: string, statusClass: "success" | "error"): void {
    const binding = providerStartObservers.get(sessionId);
    if (binding === undefined) return;
    // One-shot: consume before invoking so later Pi agent-loop rounds/retries
    // cannot fire this logical-turn observer twice.
    providerStartObservers.delete(sessionId);
    try {
        binding.onStart(
            Object.freeze({
                schema: TAVERN_PROVIDER_START_OBSERVATION_SCHEMA,
                sessionId,
                statusClass,
                observedAtMs: Date.now(),
            }),
        );
    } catch {
        // An observer failure never breaks or retries the Pi agent loop.
    }
}


/** Test helper; it drives the exact consumed source-owned path with a bounded class. */
export function fireTavernProviderStartObservationForTest(
    sessionId: string,
    statusClass: "success" | "error",
): void {
    consumeProviderStartObserver(sessionId, statusClass);
}

/** Test helper; never exposes a binding, callback, or observation payload. */
export function resetTavernNarrativeGateMarkersForTest(): void {
    bindings.clear();
    materializations.clear();
    providerStartObservers.clear();
}

function sendMarker(message: object): void {
    if (typeof process.send !== "function" || process.connected !== true) return;
    try {
        process.send(message, () => undefined);
    } catch {
        // IPC loss never changes the provider request path; the one-shot is spent.
    }
}

function reportMarker(sessionId: string): void {
    const binding = bindings.get(sessionId);
    if (binding === undefined) return;
    // One-shot: consume before attempting IPC so retries cannot replay a marker.
    bindings.delete(sessionId);
    if (binding.kind === "tavern") {
        sendMarker({
            schema: TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
            sessionId: binding.sessionId,
            nonceSha256: binding.nonceSha256,
        });
        return;
    }
    const materialization = materializations.get(sessionId);
    materializations.delete(sessionId);
    if (materialization === undefined) return;
    sendMarker({
        schema: GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
        sessionId: binding.sessionId,
        nonceSha256: binding.nonceSha256,
        surface: binding.surface,
        m1MaxMemoryMutationId: materialization.m1MaxMemoryMutationId,
        materializedCategoryCounts: materialization.materializedCategoryCounts,
    });
}

function reportProviderStartObservation(sessionId: string, status: number): void {
    const statusClass = status >= 200 && status < 300 ? ("success" as const) : ("error" as const);
    consumeProviderStartObserver(sessionId, statusClass);
}

/**
 * Register the locked Pi 0.84.4 provider boundary. The existing
 * `before_provider_request` narrative-gate IPC marker stays untouched and
 * remains pre-send serialization only; the P4c provider-start observer is
 * separate and consumes only the opaque HTTP status class.
 */
export function registerTavernNarrativeGateMarkerHook(pi: ExtensionAPI): void {
    pi.on("before_provider_request", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId === "string") reportMarker(sessionId);
    });
    pi.on("after_provider_response", (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId !== "string") return;
        if (typeof event?.status !== "number") return;
        reportProviderStartObservation(sessionId, event.status);
    });
    pi.on("session_before_switch", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        // The current session binding is cleared synchronously before any
        // switch so a superseding/foreign session can never fire it.
        if (typeof sessionId === "string") providerStartObservers.delete(sessionId);
    });
    pi.on("session_shutdown", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId === "string") clearTavernNarrativeGateMarker(sessionId);
    });
}
