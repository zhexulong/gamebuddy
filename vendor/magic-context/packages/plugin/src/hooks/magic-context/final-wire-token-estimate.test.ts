import { afterEach, describe, expect, it } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import {
    estimateFinalWireInputTokens,
    type FinalWireTokenEstimate,
} from "./final-wire-token-estimate";
import type { MessageLike } from "./tag-messages";

const MODEL = { providerID: "test-provider", modelID: "test-model", agentName: "build" };

afterEach(() => __resetToolDefinitionMeasurements());

function estimate(messages: MessageLike[]): FinalWireTokenEstimate {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read a file", {
        type: "object",
        properties: { path: { type: "string" } },
    });
    return estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 10_000,
        ...MODEL,
    });
}

function toolMessage(output: string): MessageLike {
    return {
        info: { id: "tool-owner", role: "assistant" },
        parts: [
            {
                type: "tool",
                state: { input: { path: "large.log" }, output },
            },
        ],
    } as unknown as MessageLike;
}

describe("final outgoing-wire token estimate", () => {
    it("reflects a flushed pending drop in telemetry", () => {
        const largeOutput = Array.from({ length: 40_000 }, (_, index) => `token_${index}`).join(
            " ",
        );
        const message = toolMessage(largeOutput);
        const beforeDrop = estimate([message]);
        (message.parts[0] as { state: { output: string } }).state.output = "[dropped]";
        const afterDrop = estimate([message]);
        const inputLimit = Math.floor((beforeDrop.tokens + afterDrop.tokens) / 2.1);

        expect(beforeDrop.trusted).toBe(true);
        expect(afterDrop.tokens).toBeLessThan(inputLimit);
        expect(beforeDrop.tokens).toBeGreaterThan(inputLimit * 1.05);
    });

    it("reports telemetry for an unchanged rebuilt fold", () => {
        const unchanged = estimate([
            toolMessage(Array.from({ length: 20_000 }, (_, index) => `fold_${index}`).join(" ")),
        ]);
        const inputLimit = Math.floor(unchanged.tokens / 1.1);

        expect(unchanged.tokens).toBeGreaterThan(inputLimit);
    });

    it("reports a compact completed recomp refresh", () => {
        const trimmed = estimate([
            {
                info: { id: "summary", role: "user" },
                parts: [
                    { type: "text", text: "<session-history>compact summary</session-history>" },
                ],
            } as MessageLike,
        ]);

        expect(trimmed.trusted).toBe(true);
        expect(trimmed.messageTokens.conversation).toBeGreaterThan(0);
    });
});
