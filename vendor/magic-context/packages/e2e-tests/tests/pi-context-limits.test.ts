/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi context-limit resolution from settings/models.json.
 *
 * Pi does not read OpenCode's models.dev path. The Pi e2e harness writes a
 * Pi-native `.pi/agent/models.json` model override, and the plugin must use
 * Pi's reported context window when persisting pressure into session_meta.
 *
 * This test sets the mock model's context window to 50_000 tokens and has the
 * shared MockProvider report 20_000 input tokens. Pi should persist exactly
 * 40% usage (20_000 / 50_000). Falling back to a default 128K/200K window
 * would produce a much lower percentage and fail this parity check.
 */

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 50_000,
        magicContextConfig: {
            execute_threshold_percentage: 80,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi context-limit resolution", () => {
    it("uses Pi model override contextWindow when computing percentage", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 20_000,
                output_tokens: 50,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        });

        const turn = await h.sendPrompt("probe turn for pi context-limit resolution.", {
            timeoutMs: 60_000,
        });
        expect(turn.sessionId).toBeTruthy();

        const pct = await h.waitFor(
            () => {
                const row = h
                    .contextDb()
                    .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
                    .get(turn.sessionId!) as { last_context_percentage: number } | null;
                return row?.last_context_percentage === undefined ? false : row.last_context_percentage;
            },
            { timeoutMs: 5_000, label: "pi last_context_percentage persisted" },
        );

        // Pi's shared-window model reserves min(8,192, 25% of 50,000) =
        // 8,192 output tokens, so 20,000 / 41,808 * 100 is the exact pressure.
        expect(pct).toBe(47.83773440489858);
    }, 60_000);
});
