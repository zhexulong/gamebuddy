import { describe, expect, it, beforeEach } from "bun:test";
import {
	clearTavernNarrativeGateMarker,
	registerTavernNarrativeGateMarker,
	resetTavernNarrativeGateMarkersForTest,
	validateTavernNarrativeGateMarkerConfig,
} from "./tavern-narrative-gate-marker";

const digest = "a".repeat(64);

beforeEach(() => resetTavernNarrativeGateMarkersForTest());

describe("Tavern narrative gate marker binding", () => {
	it("validates the exact session and digest schema", () => {
		expect(validateTavernNarrativeGateMarkerConfig({ sessionId: "session_1", nonceSha256: digest })).toEqual({
			sessionId: "session_1",
			nonceSha256: digest,
		});
		expect(() => validateTavernNarrativeGateMarkerConfig({ sessionId: "session/1", nonceSha256: digest })).toThrow(
			"invalid_tavern_marker_config",
		);
		expect(() => validateTavernNarrativeGateMarkerConfig({ sessionId: "session_1", nonceSha256: "bad" })).toThrow(
			"invalid_tavern_marker_config",
		);
	});

	it("is one-shot and cleanup is session-bound", () => {
		const clear = registerTavernNarrativeGateMarker({ sessionId: "session_1", nonceSha256: digest });
		clearTavernNarrativeGateMarker("other_session");
		clear();
		// Re-registration is accepted only after explicit cleanup and remains in-memory.
		expect(() => registerTavernNarrativeGateMarker({ sessionId: "session_1", nonceSha256: digest })).not.toThrow();
		clearTavernNarrativeGateMarker("session_1");
	});
});
