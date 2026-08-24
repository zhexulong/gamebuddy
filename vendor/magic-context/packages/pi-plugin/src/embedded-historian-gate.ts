import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { setHarness } from "@magic-context/core/shared/harness";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

import { EmbeddedPiHistorianRunner } from "./embedded-pi-historian-runner";
import { runPiHistorianForTest } from "./pi-historian-runner";

export type EmbeddedHistorianGateScenario = "semantic" | "interaction" | "ordinary-process";

export type EmbeddedHistorianAuthoringGateInput = Readonly<{
    db: ContextDatabase;
    registry: ModelRegistry;
    directory: string;
    model: string;
    thinkingLevel?: string;
    timeoutMs: number;
    /** Test-only fixture selection; neither surface config nor commands can set it. */
    scenario?: EmbeddedHistorianGateScenario;
    /**
     * Test-only promotion activation. Production runtime config remains the
     * authority for automatic promotion and the public real-provider probe
     * never supplies this value.
     */
    testAutoPromote?: boolean;
    /** Unit-test seam; the real-provider gate never supplies this. */
    runner?: SubagentRunner;
}>;

export type EmbeddedHistorianAuthoringGateResult = Readonly<{
    compartmentCount: number;
    semanticMemoryCount: number;
    interactionEpisodeCount: number;
    factsEmitted: number;
    semanticFactsEmitted: number;
    interactionEpisodeFactsEmitted: number;
    /** This test-only invocation enables shared-lifecycle promotion. */
    testAutoPromote: boolean;
}>;

export type EmbeddedHistorianAuthoringGateRuntimeInput = Omit<
    EmbeddedHistorianAuthoringGateInput,
    "db"
>;

/**
 * Runs the native Historian publication pipeline with the embedded SDK runner.
 *
 * This test-gate entry point bypasses only normal long-context-pressure
 * scheduling. It is exported solely from the dedicated test-gate bundle; the
 * caller must own the temporary DB and ModelRegistry. Browser/operator
 * configuration and Pi commands have no route to this function.
 */
export async function runEmbeddedHistorianAuthoringGateForTest(
    input: EmbeddedHistorianAuthoringGateInput,
): Promise<EmbeddedHistorianAuthoringGateResult> {
    const scenario = input.scenario ?? "semantic";
    const sessionId = `gamebuddy-embedded-historian-gate-${scenario}`;
    const holderId = `gamebuddy-embedded-historian-gate-holder-${scenario}`;
    if (!acquireCompartmentLease(input.db, sessionId, holderId)) {
        throw new Error("embedded Historian gate could not acquire its temporary lease");
    }

    const messagesByScenario = {
        semantic: [
            {
                ordinal: 1,
                id: "gate-semantic-user-1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "我明确确认：今后遇到会影响选择的决定时，请先向我提供可选方案，再让我自己决定。",
                    },
                ],
            },
            {
                ordinal: 2,
                id: "gate-semantic-assistant-2",
                role: "assistant",
                parts: [
                    {
                        type: "text",
                        text: "我确认会在未来涉及重要选择时先列出选项，并由你作决定。",
                    },
                ],
            },
        ],
        interaction: [
            {
                ordinal: 1,
                id: "gate-interaction-user-1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "我明确同意：我们下次继续讨论已经命名但尚未解决的选择话题。",
                    },
                ],
            },
            {
                ordinal: 2,
                id: "gate-interaction-assistant-2",
                role: "assistant",
                parts: [
                    {
                        type: "text",
                        text: "我确认这项明确约定，并会在未来互动中继续这个未解决的话题。",
                    },
                ],
            },
        ],
        "ordinary-process": [
            {
                ordinal: 1,
                id: "gate-ordinary-user-1",
                role: "user",
                parts: [{ type: "text", text: "刚才的游戏操作已经完成；这只是当前流程的一部分。" }],
            },
            {
                ordinal: 2,
                id: "gate-ordinary-assistant-2",
                role: "assistant",
                parts: [
                    {
                        type: "text",
                        text: "已收到该工具执行结果和当前游戏状态；不需要保留为未来记忆。",
                    },
                ],
            },
        ],
    };
    // Give the production Historian enough raw history for its normal
    // protected-tail semantics: the final two messages remain a lookahead tail;
    // the first two are the eligible, promotable interaction. This is still a
    // synthetic, in-memory gate and never a player transcript.
    const messages = [
        ...messagesByScenario[scenario],
        {
            ordinal: 3,
            id: `gate-${scenario}-tail-user-3`,
            role: "user",
            parts: [{ type: "text", text: "请继续保留后续对话的上下文。" }],
        },
        {
            ordinal: 4,
            id: `gate-${scenario}-tail-assistant-4`,
            role: "assistant",
            parts: [{ type: "text", text: "我会保留后续对话的上下文。" }],
        },
    ].map((message) => ({
        ...message,
        parts: message.parts.map((part) => ({ ...part })),
    }));
    // This gate executes the shared promotion/admission pipeline for every
    // scenario. The ordinary-process case must prove its own rejection rather
    // than avoiding the write path by disabling promotion. The actual
    // production probe does not set this input and therefore remains false.
    const testAutoPromote = input.testAutoPromote === true;
    const boundary: ProtectedTailBoundarySnapshot = {
        sessionId,
        mode: "pi-trigger",
        offset: 1,
        offsetMessageId: messages[0].id,
        protectedTailStart: 3,
        protectedTailStartMessageId: messages[2].id,
        eligibleEndOrdinal: 3,
        eligibleEndMessageId: messages[1].id,
        rawMessageCountAtTrigger: 4,
        rawLastMessageIdAtTrigger: messages[3].id,
        N: 1_000,
        usagePercentage: 80,
        usageInputTokens: 800,
        usageSource: "live",
        contextLimit: 10_000,
        executeThresholdPercentage: 65,
        triggerBudget: 1_000,
        priorBoundaryOrdinal: 3,
        migrationFloorActive: false,
        providerShapeVersion: "pi-folded-v1",
        cacheNamespace: "gamebuddy-embedded-historian-gate",
        createdAt: Date.now(),
        rawRangeFingerprint: "",
        trueRawEligibleTokens: 1_000,
        oversizeAtomicUnit: false,
        boundaryReason: "test",
    };
    const runner = input.runner ?? new EmbeddedPiHistorianRunner();
    if (runner instanceof EmbeddedPiHistorianRunner) {
        runner.bindModelRegistry(input.registry);
    }
    await runPiHistorianForTest({
        db: input.db,
        sessionId,
        directory: input.directory,
        provider: { readMessages: () => messages },
        runner,
        historianModel: input.model,
        historianChunkTokens: 20_000,
        boundarySnapshot: boundary,
        currentContextLimit: boundary.contextLimit,
        historianTimeoutMs: input.timeoutMs,
        thinkingLevel: input.thinkingLevel,
        memoryEnabled: true,
        autoPromote: testAutoPromote,
        memoryDomain: "ongoing-interaction",
        compartmentLeaseHolderId: holderId,
        ensureProjectRegistered: () => undefined,
        // The native scheduler's drain reservation is deliberately bypassed
        // only for this isolated test gate. Without it, the short synthetic
        // eligible head is rejected by a production per-run quota before it can
        // reach the shared promotion/admission publication transaction.
        forceDrainQuota: true,
    });
    // The native historian resolves its own project identity from directory.
    const memories = getMemoriesByProject(input.db, resolveProjectIdentity(input.directory));
    const semanticMemoryCount = memories.filter(
        (memory) => memory.category === "SEMANTIC_MEMORY",
    ).length;
    const interactionEpisodeCount = memories.filter(
        (memory) => memory.category === "INTERACTION_EPISODE",
    ).length;
    const compartmentCount = getCompartments(input.db, sessionId).length;
    const telemetry = input.db.prepare(
        `SELECT status, facts_emitted, facts_by_category_json
         FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sessionId) as { status?: unknown; facts_emitted?: unknown; facts_by_category_json?: unknown } | undefined;
    const factsByCategory = (() => {
        try {
            const parsed: unknown = JSON.parse(typeof telemetry?.facts_by_category_json === "string" ? telemetry.facts_by_category_json : "{}");
            return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    })();
    const count = (category: string) =>
        typeof factsByCategory[category] === "number" && Number.isSafeInteger(factsByCategory[category])
            ? factsByCategory[category]
            : 0;
    // A successful runner pass must publish its history compartment and create
    // a real embedded-SDK invocation. If either is absent, fail rather than
    // misrepresenting a model/parser failure as safe no-memory output.
    if (compartmentCount < 1 || telemetry?.status !== "success") {
        throw new Error("embedded_historian_gate_publication_missing");
    }
    return {
        compartmentCount,
        semanticMemoryCount,
        interactionEpisodeCount,
        factsEmitted: typeof telemetry.facts_emitted === "number" ? telemetry.facts_emitted : 0,
        semanticFactsEmitted: count("SEMANTIC_MEMORY"),
        interactionEpisodeFactsEmitted: count("INTERACTION_EPISODE"),
        testAutoPromote,
    };
}

/** Creates an in-memory, GameBuddy-test-owned DB for a direct live gate. */
export async function runEmbeddedHistorianAuthoringGateInMemoryForTest(
    input: EmbeddedHistorianAuthoringGateRuntimeInput,
): Promise<EmbeddedHistorianAuthoringGateResult> {
    setHarness("pi");
    const db = new Database(":memory:") as ContextDatabase;
    try {
        initializeDatabase(db);
        runMigrations(db);
        return await runEmbeddedHistorianAuthoringGateForTest({ ...input, db });
    } finally {
        closeQuietly(db);
    }
}
