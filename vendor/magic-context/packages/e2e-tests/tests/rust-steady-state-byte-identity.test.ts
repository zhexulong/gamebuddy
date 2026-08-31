/// <reference types="bun-types" />

/**
 * Invariant #5: steady-state byte identity.
 *
 * With no new content, N consecutive defer passes must serve byte-identical
 * provider request bodies. This is the core cache-stability guarantee of the
 * Rust transform: a defer reuses the frozen m0 prefix verbatim, so the provider
 * sees the exact same bytes and its prompt cache stays warm. A regression here
 * (m0 recomposed, ordinals renumbered, a marker re-rendered) silently evicts the
 * cache on every turn — the class of bug this lane exists to catch.
 *
 * Assertion style: byte-identity BETWEEN passes (not against a stored golden),
 * comparing full provider-request bodies captured from the fake provider, with
 * provider `cache_control` bookkeeping stripped (it is not part of the logical
 * wire and legitimately varies).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust invariant: steady-state byte identity", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("serves byte-identical wire bodies across defer passes with no new content", async () => {
        const sessionId = await h.createSession();
        await driveToSteadyState(h, sessionId, 3);

        // Fixed pressure, fixed-shape turns. Each turn adds a new user message
        // (opencode requires one to advance), but the FROZEN prefix — the
        // synthetic m0 head plus every earlier message — must reproduce
        // byte-for-byte on each defer. Capture each pass's per-message
        // serialization so the retained prefix can be compared element-wise
        // (a whole-array string compare would trip on the differing trailing
        // JSON bracket as the array grows).
        const perPassMessages: string[][] = [];
        for (let i = 1; i <= 4; i += 1) {
            h.mock.setDefault({
                text: "identical steady reply",
                usage: {
                    input_tokens: 9_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `defer probe ${i}: ${h.ballast(150)}`);
            const messages = h.lastMainMessages();
            perPassMessages.push(messages.map((m) => stableSerialize(m)));
        }

        // Every pass must be a defer, not a bust — a bust would rematerialize m0.
        const passes = await h.waitForRustPasses(1);
        expect(passes.every((p) => p.decision !== "error" && p.decision !== "parked")).toBe(true);

        // m0 (the synthetic history head) is byte-identical across every defer.
        const m0s = perPassMessages.map((msgs) => msgs[0]!);
        for (let i = 1; i < m0s.length; i += 1) {
            expect(m0s[i]).toBe(m0s[0]);
        }

        // The retained prefix is byte-identical across every defer: for each pair
        // of consecutive passes, every message the earlier pass held except its
        // newest one must reproduce byte-for-byte at the same index in the later
        // pass. This is the true cache-stability invariant — the frozen head plus
        // all prior turns replay verbatim while only a fresh tail is appended.
        for (let pass = 1; pass < perPassMessages.length; pass += 1) {
            const earlier = perPassMessages[pass - 1]!;
            const later = perPassMessages[pass]!;
            // Compare every message the earlier pass carried except its own newest
            // (which was that turn's live user message).
            const retained = earlier.length - 1;
            expect(retained).toBeGreaterThan(0);
            for (let index = 0; index < retained; index += 1) {
                expect(later[index]).toBe(earlier[index]);
            }
        }
    }, 300_000);
});
