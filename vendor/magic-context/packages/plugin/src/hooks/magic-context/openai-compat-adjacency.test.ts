import { describe, expect, test } from "bun:test";
import { ISSUE_135_ORPHAN_WIRE } from "./issue-135-wire-fixtures";
import {
    assertOpenAiCompatAdjacency,
    type OpenAiCompatWireMessage,
} from "./openai-compat-adjacency";

describe("assertOpenAiCompatAdjacency", () => {
    test("passes valid tool_call immediately followed by tool", () => {
        const messages: OpenAiCompatWireMessage[] = [
            { role: "user", content: "go" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
                ],
            },
            { role: "tool", tool_call_id: "call-1", content: "ok" },
        ];
        expect(assertOpenAiCompatAdjacency(messages).ok).toBe(true);
    });

    test("fails when assistant tool_calls is separated from tool by another assistant", () => {
        const messages: OpenAiCompatWireMessage[] = [
            { role: "user", content: "go" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
                ],
            },
            { role: "assistant", content: "[dropped]" },
            { role: "tool", tool_call_id: "call-1", content: "ok" },
        ];
        const result = assertOpenAiCompatAdjacency(messages);
        expect(result.ok).toBe(false);
        expect(result.violations[0]?.kind).toBe("missing_tool_messages");
    });

    test("fails when user message intervenes between tool_calls and tool", () => {
        const messages: OpenAiCompatWireMessage[] = [
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "c1", type: "function", function: { name: "x", arguments: "{}" } },
                ],
            },
            { role: "user", content: "[dropped]" },
            { role: "tool", tool_call_id: "c1", content: "y" },
        ];
        expect(assertOpenAiCompatAdjacency(messages).ok).toBe(false);
    });

    test("issue #135 pinned orphan fixture stays failing until fixed", () => {
        const result = assertOpenAiCompatAdjacency(ISSUE_135_ORPHAN_WIRE);
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.kind === "missing_tool_messages")).toBe(true);
    });
});
