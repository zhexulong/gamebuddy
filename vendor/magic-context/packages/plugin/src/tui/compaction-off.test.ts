import { expect, test } from "bun:test";
import type { SidebarSnapshot } from "../shared/rpc-types";
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "./compaction-off";

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
    return {
        sessionId: "ses-native-ui",
        usagePercentage: 63.1,
        inputTokens: 41_000,
        contextLimit: 100_000,
        native_context_usage_percentage: 41,
        compaction_enabled: false,
        systemPromptTokens: 0,
        compartmentCount: 12,
        archivedCompartmentCount: 3,
        memoryCount: 5,
        memoryBlockCount: 2,
        pendingOpsCount: 4,
        historianRunning: true,
        compartmentInProgress: true,
        sessionNoteCount: 2,
        readySmartNoteCount: 1,
        cacheTtl: "5m",
        lastDreamerRunAt: null,
        projectIdentity: null,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        ...overrides,
    };
}

test("renders raw input-versus-model usage rather than threshold-relative fill", () => {
    const value = nativeCompactionContextLabel(snapshot());

    expect(value).toBe("Context: 41.0% · native compaction");
    expect(value).not.toBe("Context: 63.1% · native compaction");
});

test("keeps historical compartments as a static archived row", () => {
    const initialRows = compactionOffSidebarRows(snapshot());
    const activeCountChangedRows = compactionOffSidebarRows(snapshot({ compartmentCount: 99 }));

    expect(initialRows).toEqual([
        { label: "Memories", value: "5" },
        { label: "Notes", value: "2" },
        { label: "Archived compartments", value: "3" },
    ]);
    expect(activeCountChangedRows).toEqual(initialRows);
});
