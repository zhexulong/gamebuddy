import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TAVERN_NARRATIVE_GATE_MARKER_SCHEMA = "gamebuddy-tavern-narrative-gate-marker/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

type MarkerBinding = Readonly<{ sessionId: string; nonceSha256: string }>;
const bindings = new Map<string, MarkerBinding>();

export function validateTavernNarrativeGateMarkerConfig(value: unknown): MarkerBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_tavern_marker_config");
	const candidate = value as Record<string, unknown>;
	if (Object.keys(candidate).length !== 2 || !Object.keys(candidate).every((key) => key === "sessionId" || key === "nonceSha256"))
		throw new Error("invalid_tavern_marker_config");
	if (typeof candidate.sessionId !== "string" || !SESSION_ID.test(candidate.sessionId))
		throw new Error("invalid_tavern_marker_config");
	if (typeof candidate.nonceSha256 !== "string" || !SHA256.test(candidate.nonceSha256))
		throw new Error("invalid_tavern_marker_config");
	return Object.freeze({ sessionId: candidate.sessionId, nonceSha256: candidate.nonceSha256 });
}

/** Host-only in-process binding. The digest is the only marker secret accepted. */
export function registerTavernNarrativeGateMarker(value: Readonly<{ sessionId: string; nonceSha256: string }>): () => void {
	const binding = validateTavernNarrativeGateMarkerConfig(value);
	bindings.set(binding.sessionId, binding);
	return () => {
		if (bindings.get(binding.sessionId) === binding) bindings.delete(binding.sessionId);
	};
}

export function clearTavernNarrativeGateMarker(sessionId: string): void {
	if (SESSION_ID.test(sessionId)) bindings.delete(sessionId);
}

/** Test helper; it never exposes a binding or payload. */
export function resetTavernNarrativeGateMarkersForTest(): void {
	bindings.clear();
}

function reportMarker(sessionId: string): void {
	const binding = bindings.get(sessionId);
	if (binding === undefined) return;
	// One-shot: consume before attempting IPC so retries cannot replay a marker.
	bindings.delete(sessionId);
	if (typeof process.send !== "function" || process.connected !== true) return;
	try {
		process.send(
			{
				schema: TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
				sessionId: binding.sessionId,
				nonceSha256: binding.nonceSha256,
			},
			() => undefined,
		);
	} catch {
		// IPC loss never changes the provider request path; the one-shot is spent.
	}
}

/**
 * Register the locked Pi 0.84.1 provider boundary. The event payload is
 * intentionally not read, changed, or logged: this marker only says that Pi
 * serialized a request immediately before handing it to the provider.
 */
export function registerTavernNarrativeGateMarkerHook(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (typeof sessionId === "string") reportMarker(sessionId);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (typeof sessionId === "string") clearTavernNarrativeGateMarker(sessionId);
	});
}
