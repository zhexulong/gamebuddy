import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";

import { EmbeddedPiHistorianRunner } from "./embedded-pi-historian-runner";
import { runPiHistorianForTest } from "./pi-historian-runner";

export type EmbeddedHistorianGateScenario = "episodic" | "semantic-promotion";

export type EmbeddedHistorianAuthoringGateInput = Readonly<{
	db: ContextDatabase;
	registry: ModelRegistry;
	directory: string;
	model: string;
	thinkingLevel?: string;
	timeoutMs: number;
	/** Test-only fixture selection; neither surface config nor commands can set it. */
	scenario?: EmbeddedHistorianGateScenario;
}>;

export type EmbeddedHistorianAuthoringGateResult = Readonly<{
	compartmentCount: number;
	semanticMemoryCount: number;
	autoPromote: boolean;
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
	const scenario = input.scenario ?? "episodic";
	const sessionId = `gamebuddy-embedded-historian-gate-${scenario}`;
	const holderId = `gamebuddy-embedded-historian-gate-holder-${scenario}`;
	if (!acquireCompartmentLease(input.db, sessionId, holderId)) {
		throw new Error("embedded Historian gate could not acquire its temporary lease");
	}

	const messages = scenario === "semantic-promotion"
		? [
			{
				ordinal: 1,
				id: "gate-semantic-user-1",
				role: "user",
				parts: [{ type: "text", text: "我明确确认：今后遇到会影响选择的决定时，请先向我提供可选方案，再让我自己决定。" }],
			},
			{
				ordinal: 2,
				id: "gate-semantic-assistant-2",
				role: "assistant",
				parts: [{ type: "text", text: "我确认会在未来涉及重要选择时先列出选项，并由你作决定。" }],
			},
		]
		: [
			{
				ordinal: 1,
				id: "gate-episodic-user-1",
				role: "user",
				parts: [{ type: "text", text: "今天只是整理了一次背包工具，这件事不需要保留到未来。" }],
			},
			{
				ordinal: 2,
				id: "gate-episodic-assistant-2",
				role: "assistant",
				parts: [{ type: "text", text: "明白，这是一次性的经历；我会把它留在本次互动里。" }],
			},
		];
	const boundary: ProtectedTailBoundarySnapshot = {
		sessionId,
		mode: "pi-trigger",
		offset: 1,
		offsetMessageId: messages[0].id,
		protectedTailStart: 2,
		protectedTailStartMessageId: messages[1].id,
		eligibleEndOrdinal: 2,
		eligibleEndMessageId: messages[1].id,
		rawMessageCountAtTrigger: 2,
		rawLastMessageIdAtTrigger: messages[1].id,
		N: 1_000,
		usagePercentage: 80,
		usageInputTokens: 800,
		usageSource: "live",
		contextLimit: 10_000,
		executeThresholdPercentage: 65,
		triggerBudget: 1_000,
		priorBoundaryOrdinal: 2,
		migrationFloorActive: false,
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "gamebuddy-embedded-historian-gate",
		createdAt: Date.now(),
		rawRangeFingerprint: "",
		trueRawEligibleTokens: 1_000,
		oversizeAtomicUnit: false,
		boundaryReason: "test",
	};
	const runner = new EmbeddedPiHistorianRunner();
	runner.bindModelRegistry(input.registry);
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
		autoPromote: scenario === "semantic-promotion",
		memoryDomain: "ongoing-interaction",
		compartmentLeaseHolderId: holderId,
		ensureProjectRegistered: () => undefined,
	});
	// The native historian resolves its own project identity from directory.
	const semanticMemories = getMemoriesByProject(input.db, resolveProjectIdentity(input.directory))
		.filter((memory) => memory.category === "SEMANTIC_MEMORY");
	if (scenario === "episodic" && semanticMemories.length !== 0) {
		throw new Error("episodic gate unexpectedly promoted Semantic Memory");
	}
	if (scenario === "semantic-promotion" && semanticMemories.length !== 1) {
		throw new Error("semantic promotion gate did not produce exactly one Semantic Memory");
	}
	return {
		compartmentCount: getCompartments(input.db, sessionId).length,
		semanticMemoryCount: semanticMemories.length,
		autoPromote: scenario === "semantic-promotion",
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
