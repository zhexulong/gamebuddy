import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA =
    "gamebuddy-player-memory-next-round-marker/v1" as const;

type Surface = "chat" | "game";

type PlayerMemoryNextRoundMarkerDebugEvent = Readonly<{
    type: "activation" | "materialization" | "report";
    sessionId: string;
    active: boolean;
    covered?: boolean;
}>;
let debugObserver: ((event: PlayerMemoryNextRoundMarkerDebugEvent) => void) | undefined;
/** Test-only source-local observability. Never registered by production code. */
export function setPlayerMemoryNextRoundDebugObserverForTests(
    observer: ((event: PlayerMemoryNextRoundMarkerDebugEvent) => void) | undefined,
): () => void {
    debugObserver = observer;
    return () => { if (debugObserver === observer) debugObserver = undefined; };
}
function debug(event: PlayerMemoryNextRoundMarkerDebugEvent): void {
    try { debugObserver?.(event); } catch { /* debug never changes evidence */ }
}
export interface PlayerMemoryNextRoundProviderBinding {
    sessionId: string;
    surface: Surface;
    nonceSha256: string;
}
export interface PlayerMemoryNextRoundCommitReceipt {
    operationCorrelation: string;
    committedMemoryMutationId: number;
}

/** Content-free evidence constructed only by the provider-bound marker source. */
export interface PlayerMemoryNextRoundMarker {
    schema: typeof PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA;
    sessionId: string;
    nonceSha256: string;
    surface: Surface;
    operationCorrelation: string;
    committedMemoryMutationId: number;
    materializedM1MaxMemoryMutationId: number;
    providerRoundGeneration: number;
    covered: boolean;
    oneShot: true;
}
export type PlayerMemoryNextRoundMarkerCallback = (
    marker: Readonly<PlayerMemoryNextRoundMarker>,
) => void;

/** Source-only provenance for an exact Memory revision represented in frozen m[1]. */
export interface PlayerMemoryRenderedMutationProvenance {
    memoryId: number;
    latestMutationId: number;
}

type Slot =
    | Readonly<{ state: "idle" }>
    | Readonly<{ state: "reserved"; operationCorrelation: string }>
    | Readonly<{
          state: "active";
          receipt: PlayerMemoryNextRoundCommitReceipt & Readonly<{ targetMemoryId: number }>;
          /** Generation present when activation occurred; source requires a later render. */
          activationGeneration: number;
      }>;
interface Registration {
    readonly binding: Readonly<PlayerMemoryNextRoundProviderBinding>;
    /** Retained privately; only `report` below can invoke this Host callback. */
    readonly onSourceMarker: PlayerMemoryNextRoundMarkerCallback;
    slot: Slot;
    providerRoundGeneration: number;
    materialization:
        | Readonly<{
              generation: number;
              m1MaxMemoryMutationId: number;
              exactSelectedCommitCovered: boolean;
          }>
        | undefined;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
const CORRELATION = /^[A-Za-z0-9_-]{22,256}$/;
const registrations = new Map<string, Registration>();
// Installed by the source-owned context materializer. A committed direct Memory
// mutation must invalidate its m[1] replay *and force the next context pass to
// materialize* before the exact next provider hook. Cache-busting alone is
// insufficient: a low-pressure pass could otherwise choose `defer`, retain the
// old frozen m[1], and correctly produce no exact evidence.
let requestMaterializationRefresh: ((sessionId: string) => void) | undefined;

export function registerPlayerMemoryNextRoundMaterializationRefresh(
    callback: (sessionId: string) => void,
): void {
    if (typeof callback !== "function")
        throw new Error("invalid_player_memory_materialization_refresh");
    requestMaterializationRefresh = callback;
}

/** True only while an activated mutation awaits its one source-owned render. */
export function hasActivePlayerMemoryNextRoundEvidence(sessionId: string): boolean {
    return registrations.get(sessionId)?.slot.state === "active";
}

/** Source-only selected memory identity for the pending exact-next render. */
export function pendingPlayerMemoryNextRoundTargetMemoryId(sessionId: string): number | undefined {
    const slot = registrations.get(sessionId)?.slot;
    return slot?.state === "active" ? slot.receipt.targetMemoryId : undefined;
}

function sameBinding(
    left: PlayerMemoryNextRoundProviderBinding,
    right: PlayerMemoryNextRoundProviderBinding,
): boolean {
    return (
        left.sessionId === right.sessionId &&
        left.surface === right.surface &&
        left.nonceSha256 === right.nonceSha256
    );
}

function validateBinding(
    value: PlayerMemoryNextRoundProviderBinding,
): Readonly<PlayerMemoryNextRoundProviderBinding> {
    if (
        !SESSION_ID.test(value.sessionId) ||
        !SHA256.test(value.nonceSha256) ||
        (value.surface !== "chat" && value.surface !== "game")
    )
        throw new Error("invalid_player_memory_next_round_binding");
    return Object.freeze({ ...value });
}

export function registerPlayerMemoryNextRoundMarker(
    bindingValue: PlayerMemoryNextRoundProviderBinding,
    onSourceMarker: PlayerMemoryNextRoundMarkerCallback,
): () => void {
    const binding = validateBinding(bindingValue);
    if (typeof onSourceMarker !== "function")
        throw new Error("invalid_player_memory_next_round_marker_callback");
    if (registrations.has(binding.sessionId))
        throw new Error("player_memory_next_round_marker_already_registered");
    const registration: Registration = {
        binding,
        onSourceMarker,
        slot: Object.freeze({ state: "idle" }),
        providerRoundGeneration: 0,
        materialization: undefined,
    };
    registrations.set(binding.sessionId, registration);
    return () => {
        if (registrations.get(binding.sessionId) === registration)
            registrations.delete(binding.sessionId);
    };
}

export function reservePlayerMemoryNextRoundEvidence(
    binding: PlayerMemoryNextRoundProviderBinding,
    operationCorrelation: string,
): () => void {
    if (!CORRELATION.test(operationCorrelation))
        throw new Error("invalid_player_memory_operation_correlation");
    const registration = registrations.get(binding.sessionId);
    if (!registration || !sameBinding(registration.binding, binding))
        throw new Error("player_memory_next_round_marker_binding_unavailable");
    if (registration.slot.state !== "idle")
        throw new Error("player_memory_next_round_marker_slot_unavailable");
    registration.slot = Object.freeze({ state: "reserved", operationCorrelation });
    return () => {
        if (
            registration.slot.state === "reserved" &&
            registration.slot.operationCorrelation === operationCorrelation
        )
            registration.slot = Object.freeze({ state: "idle" });
    };
}

export function activatePlayerMemoryNextRoundEvidence(
    binding: PlayerMemoryNextRoundProviderBinding,
    receipt: PlayerMemoryNextRoundCommitReceipt,
    targetMemoryId: number,
): void {
    const registration = registrations.get(binding.sessionId);
    if (
        !registration ||
        !sameBinding(registration.binding, binding) ||
        registration.slot.state !== "reserved" ||
        registration.slot.operationCorrelation !== receipt.operationCorrelation ||
        !Number.isSafeInteger(receipt.committedMemoryMutationId) ||
        receipt.committedMemoryMutationId <= 0 ||
        !Number.isSafeInteger(targetMemoryId) ||
        targetMemoryId <= 0
    )
        throw new Error("player_memory_next_round_marker_activation_invalid");
    registration.slot = Object.freeze({
        state: "active",
        receipt: Object.freeze({ ...receipt, targetMemoryId }),
        activationGeneration: registration.providerRoundGeneration,
    });
    // This is local source-to-source coordination, not a Host/IPC signal. It
    // makes the immediately following provider pass rebuild frozen m[1].
    requestMaterializationRefresh?.(binding.sessionId);
    debug(Object.freeze({ type: "activation", sessionId: binding.sessionId, active: true }));
}

/** Called only by Magic Context's m[1] materializer, once for each provider round. */
export function recordPlayerMemoryNextRoundMaterialization(
    sessionId: string,
    m1MaxMemoryMutationId: number,
    rendered: readonly PlayerMemoryRenderedMutationProvenance[],
): void {
    const registration = registrations.get(sessionId);
    if (!registration || !Number.isSafeInteger(m1MaxMemoryMutationId) || m1MaxMemoryMutationId < 0)
        return;
    if (
        !rendered.every(
            (value) =>
                Number.isSafeInteger(value.memoryId) &&
                value.memoryId > 0 &&
                Number.isSafeInteger(value.latestMutationId) &&
                value.latestMutationId > 0,
        )
    )
        return;
    const active = registration.slot.state === "active" ? registration.slot : undefined;
    const receipt = active?.receipt;
    // This function is invoked only after the renderer selected and froze m[1]
    // for the *current* provider-bound pass. A deferred pre-activation render
    // may have advanced the ordinary counter, but the active receipt was
    // installed before this invocation; exact coverage is therefore determined
    // solely from this frozen render provenance.
    const exactSelectedCommitCovered =
        receipt !== undefined &&
        rendered.some(
            (value) =>
                value.memoryId === receipt.targetMemoryId &&
                // The gate attests the durable revision committed by this
                // operation—not merely a later revision of the same Memory.
                // A competing update before dispatch is a different state and
                // must fail closed rather than borrowing this one-shot claim.
                value.latestMutationId === receipt.committedMemoryMutationId,
        );
    registration.providerRoundGeneration += 1;
    registration.materialization = Object.freeze({
        generation: registration.providerRoundGeneration,
        m1MaxMemoryMutationId,
        exactSelectedCommitCovered,
    });
    debug(Object.freeze({
        type: "materialization",
        sessionId,
        active: receipt !== undefined,
        covered: exactSelectedCommitCovered,
    }));
}

function report(sessionId: string): void {
    const registration = registrations.get(sessionId);
    if (!registration || registration.slot.state !== "active") return;
    const receipt = registration.slot.receipt;
    const materialization = registration.materialization;
    registration.slot = Object.freeze({ state: "idle" });
    registration.materialization = undefined;
    if (!materialization || materialization.generation !== registration.providerRoundGeneration)
        return;
    const marker: Readonly<PlayerMemoryNextRoundMarker> = Object.freeze({
        schema: PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA,
        sessionId: registration.binding.sessionId,
        nonceSha256: registration.binding.nonceSha256,
        surface: registration.binding.surface,
        operationCorrelation: receipt.operationCorrelation,
        committedMemoryMutationId: receipt.committedMemoryMutationId,
        materializedM1MaxMemoryMutationId: materialization.m1MaxMemoryMutationId,
        providerRoundGeneration: materialization.generation,
        // A snapshot cursor only proves that a mutation was observed, not that this
        // Memory revision was represented in frozen provider context. The source-only
        // renderer provenance above proves the exact entry (or a later mutation).
        covered: materialization.exactSelectedCommitCovered,
        oneShot: true,
    });
    // Local delivery is source-owned: this callback is retained exclusively in
    // the registration and is never available to browser, runner, or IPC input.
    // The raw marker has private commit correlation and must never cross process
    // boundaries. The Host may publish a separately redacted attestation only
    // after it independently accepts this callback against its private receipt.
    debug(Object.freeze({ type: "report", sessionId, active: false, covered: marker.covered }));
    try {
        registration.onSourceMarker(marker);
    } catch {
        /* evidence is terminally consumed */
    }
}

export function clearPlayerMemoryNextRoundMarker(sessionId: string): void {
    if (SESSION_ID.test(sessionId)) registrations.delete(sessionId);
}
export function resetPlayerMemoryNextRoundMarkersForTest(): void {
    registrations.clear();
}

/** The payload is deliberately ignored: evidence comes only from source-owned state. */
export function registerPlayerMemoryNextRoundMarkerHook(pi: ExtensionAPI): void {
    pi.on("before_provider_request", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId === "string") report(sessionId);
    });
    pi.on("session_shutdown", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId === "string") clearPlayerMemoryNextRoundMarker(sessionId);
    });
}
