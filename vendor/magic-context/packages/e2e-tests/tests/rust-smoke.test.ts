/// <reference types="bun-types" />

/**
 * Rust-mode lane smoke test: proves the hermetic stack (opencode → plugin →
 * subc daemon → ck-mc module) actually transforms end to end, and that the lane
 * SKIPs cleanly (with a printed reason) when prerequisites are missing.
 *
 * This is the de-risking harness check the incident-corpus scenarios build on:
 * if this cannot boot Rust mode and observe a transform, none of the regression
 * scenarios can either.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";

const prereqs = RustTestHarness.detectPrereqs();

describe.skipIf(!prereqs.ok)("rust-mode lane smoke", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40 },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("boots Rust mode and transforms a real session through the ck-mc module", async () => {
        const sessionId = await h.createSession();

        // A handful of small turns — enough for the Rust transform to run and
        // emit its per-pass decision log without approaching any threshold.
        for (let i = 1; i <= 3; i += 1) {
            h.mock.setDefault({
                text: `assistant ${i}`,
                usage: { input_tokens: 1_000 * i, output_tokens: 20, cache_creation_input_tokens: 500 },
            });
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(400)}`);
        }

        // Primary signal: the plugin actually issued requests to the provider.
        expect(h.mainRequests().length).toBeGreaterThanOrEqual(3);

        // Secondary signal: the RUST transform ran (not the TS pipeline). The
        // rust-pass diagnostic line is emitted only by createRustModeTransform,
        // so its presence proves the plugin routed through the module.
        const passes = await h.waitFor(
            () => {
                const p = h.readRustPasses();
                return p.length > 0 ? p : null;
            },
            { timeoutMs: 30_000, label: "rust transform pass observed" },
        );
        expect(passes.length).toBeGreaterThan(0);

        // The module served real bytes on at least one pass (transform, not a
        // parked raw pass-through). served_from=transform is the module's own
        // verdict that it produced the wire.
        const served = h.readRustPasses().filter((p) => p.servedFrom === "transform");
        expect(served.length).toBeGreaterThan(0);

        // No permanent park: the lane never reported a parked decision on a
        // healthy module.
        expect(h.readRustPasses().every((p) => p.decision !== "parked")).toBe(true);
    }, 300_000);
});

describe.skipIf(prereqs.ok)("rust-mode lane skip visibility", () => {
    it("prints a skip reason when prerequisites are unmet", () => {
        // This branch only runs on machines lacking cargo / the subconscious
        // sibling / a supported platform. Emit the reason so CI logs show WHY
        // the Rust lane was skipped rather than silently green-washing.
        console.log(`[rust-e2e] SKIPPED: ${prereqs.skipReason ?? "unknown reason"}`);
        expect(prereqs.skipReason && prereqs.skipReason.length > 0).toBe(true);
    });
});
