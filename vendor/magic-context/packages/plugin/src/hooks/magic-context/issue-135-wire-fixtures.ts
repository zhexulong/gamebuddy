/**
 * Captured openai-compat wire fixtures from issue #135 pinning harness.
 * Source: scripts/experiments/issue-135-pinning-harness.ts (case 1c).
 */
import type { OpenAiCompatWireMessage } from "./openai-compat-adjacency";

/** Known FAIL: [dropped] assistant between tool_calls and tool result. */
export const ISSUE_135_ORPHAN_WIRE: OpenAiCompatWireMessage[] = [
    { role: "user", content: "go" },
    {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_orphan",
                type: "function",
                function: { name: "read", arguments: '{"filePath":"x"}' },
            },
        ],
    },
    { role: "assistant", content: "[dropped]" },
    { role: "tool", tool_call_id: "call_orphan", content: "ok" },
];
