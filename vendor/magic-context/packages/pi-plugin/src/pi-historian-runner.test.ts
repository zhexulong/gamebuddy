import { describe, expect, it, mock } from "bun:test";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
	getSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { excludeMemorySource } from "@magic-context/core/features/magic-context/memory/source-exclusion";
import {
	getHistorianFailureState,
	getOverflowState,
	getPendingPiCompactionMarkerState,
	getPersistedNoteNudge,
	loadProtectedTailMeta,
	recordOverflowDetected,
	reserveProtectedTailDrainTokens,
} from "@magic-context/core/features/magic-context/storage";
import { getUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type {
	SubagentRunner,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import {
	buildPiCompactionSummary,
	clearPiHistorianAlertState,
	runPiHistorian,
	runPiHistorianForTest,
} from "./pi-historian-runner";
import { createTestDb } from "./test-utils.test";

describe("buildPiCompactionSummary", () => {
	const mk = (title: string) => ({ title, startMessage: 1, endMessage: 2 });

	it("joins all titles when at or below the cap", () => {
		const summary = buildPiCompactionSummary(["a", "b", "c", "d", "e"].map(mk));
		expect(summary).toBe("Magic Context compacted: a; b; c; d; e");
		expect(summary).not.toContain("more");
	});

	it("caps the title list and stays bounded for large compartment counts", () => {
		const many = Array.from({ length: 545 }, (_, i) => mk(`segment-${i}`));
		const summary = buildPiCompactionSummary(many);
		// Bounded: only the first 5 titles appear, plus a remainder count.
		expect(summary).toContain("Magic Context compacted 545 segments:");
		expect(summary).toContain(
			"segment-0; segment-1; segment-2; segment-3; segment-4",
		);
		expect(summary).toContain("…and 540 more");
		expect(summary).not.toContain("segment-5;");
		// Length must not scale with compartment count.
		expect(summary.length).toBeLessThan(200);
	});

	it("falls back to message range when titles are empty", () => {
		const summary = buildPiCompactionSummary([
			{ title: "  ", startMessage: 3, endMessage: 9 },
		]);
		expect(summary).toBe("Magic Context compacted messages 3-9.");
	});
});

function rawMessages(count = 12) {
	return Array.from({ length: count }, (_, index) => {
		const ordinal = index + 1;
		const isUser = ordinal % 2 === 1;
		return {
			ordinal,
			id: `m${ordinal}`,
			role: isUser ? "user" : "assistant",
			parts: [
				{
					type: "text",
					text: isUser
						? `User request ${ordinal}`
						: `Assistant response ${ordinal}`,
				},
			],
		};
	});
}

function successXml(fact = "Pi historian facts can promote to memory.") {
	return `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>\n<PROJECT_RULES>\n* ${fact}\n</PROJECT_RULES>`;
}

function successXmlWithUserObservation(observation: string) {
	return `${successXml()}\n<user_observations>\n* ${observation}\n</user_observations>`;
}

function ongoingInteractionSuccessXml(fact?: string) {
	return `<output>
<compartments>
<compartment start="1" end="2" title="Interaction arc" episode_type="interaction" importance="40"><p1>The player completed a one-off activity and explicitly discussed future decision support.</p1></compartment>
</compartments>${fact === undefined ? "" : `\n<facts><SEMANTIC_MEMORY>\n* ${fact}\n</SEMANTIC_MEMORY></facts>`}
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;
}

function ongoingInteractionDualPromotionXml() {
	return `<output>
<compartments>
<compartment start="1" end="2" title="Unresolved interaction arc" episode_type="interaction" importance="70"><p1>The player and agent explicitly agreed to resume the named unresolved topic later.</p1></compartment>
</compartments>
<facts>
<SEMANTIC_MEMORY>* The player explicitly prefers being offered options before consequential decisions.</SEMANTIC_MEMORY>
<INTERACTION_EPISODE>* The player and agent agreed to resume the named unresolved topic later.</INTERACTION_EPISODE>
</facts>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;
}

function ongoingInteractionToolOnlyXml() {
	return `<output>
<compartments>
<compartment start="1" end="2" title="Tool failure and recovery" episode_type="interaction" importance="30"><p1>A tool call failed and the assistant recovered by retrying the ordinary task.</p1></compartment>
</compartments>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;
}

function ongoingInteractionToolReceiptFactXml() {
	return `<output>
<compartments>
<compartment start="1" end="2" title="Harvest receipt" episode_type="interaction" importance="30"><p1>The tool receipt completed harvest.</p1></compartment>
</compartments>
<facts><INTERACTION_EPISODE>* The tool receipt completed harvest; we explicitly agreed to continue later.</INTERACTION_EPISODE></facts>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;
}

function twoCompartmentSuccessXml() {
	return `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>
<compartment start="3" end="4" title="Provisional Pi slice"><p1>Summarized the provisional Pi turn.</p1></compartment>
<PROJECT_RULES>
* Pi mid-loop wrapup facts must promote.
</PROJECT_RULES>`;
}

function makeBoundarySnapshot(
	overrides: Partial<ProtectedTailBoundarySnapshot> = {},
): ProtectedTailBoundarySnapshot {
	return {
		sessionId: "ses-historian",
		mode: "pi-trigger",
		offset: 1,
		offsetMessageId: "m1",
		protectedTailStart: 6,
		protectedTailStartMessageId: "m6",
		eligibleEndOrdinal: 6,
		eligibleEndMessageId: "m5",
		rawMessageCountAtTrigger: 12,
		rawLastMessageIdAtTrigger: "m12",
		N: 1000,
		usagePercentage: 80,
		usageInputTokens: 8000,
		usageSource: "live",
		contextLimit: 10_000,
		executeThresholdPercentage: 65,
		triggerBudget: 1000,
		priorBoundaryOrdinal: 6,
		migrationFloorActive: false,
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "test:pi-historian",
		createdAt: 1,
		rawRangeFingerprint: "",
		trueRawEligibleTokens: 1000,
		oversizeAtomicUnit: false,
		boundaryReason: "test",
		...overrides,
	};
}

function runnerReturning(outputs: string[]): SubagentRunner {
	return runnerWithSteps(outputs);
}

function okRun(text: string): SubagentRunResult {
	return { ok: true, assistantText: text, durationMs: 1 };
}

function runnerWithSteps(
	steps: Array<string | SubagentRunResult | Error>,
): SubagentRunner {
	const run = mock(async () => {
		const step = steps.shift() ?? "";
		if (step instanceof Error) throw step;
		if (typeof step === "string") return okRun(step);
		return step;
	});
	return { harness: "pi", run } as unknown as SubagentRunner;
}

function attemptedModels(runner: SubagentRunner): Array<string | undefined> {
	return (
		runner.run as unknown as {
			mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
		}
	).mock.calls.map(([options]) => options.model);
}

async function runHistorianWith(args: {
	outputs?: string[];
	runner?: SubagentRunner;
	historianModel?: string;
	fallbackModels?: readonly string[];
	fallbackModelId?: string;
	memoryEnabled?: boolean;
	autoPromote?: boolean;
	memoryDomain?: "coding-project" | "ongoing-interaction";
	userMemoriesEnabled?: boolean;
	twoPass?: boolean;
	signal?: AbortSignal;
	retryBackoffMs?: (retryIndex: number) => number;
	notifyIssue?: Parameters<typeof runPiHistorian>[0]["notifyIssue"];
	onPublished?: () => void;
	appendCompaction?: Parameters<typeof runPiHistorian>[0]["appendCompaction"];
	readBranchEntries?: () => unknown[];
	boundarySnapshot?: ProtectedTailBoundarySnapshot;
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	providerMessages?: ReturnType<typeof rawMessages>;
	forceKeepLastCompartment?: boolean;
	historianChunkTokens?: number;
	beforeRun?: (db: ReturnType<typeof createTestDb>) => void;
	ensureProjectRegistered?: Parameters<
		typeof runPiHistorian
	>[0]["ensureProjectRegistered"];
}) {
	const db = createTestDb();
	const runner = args.runner ?? runnerReturning([...(args.outputs ?? [])]);
	const holderId = "test-holder";
	expect(acquireCompartmentLease(db, "ses-historian", holderId)).not.toBeNull();
	args.beforeRun?.(db);
	await runPiHistorian({
		db,
		sessionId: "ses-historian",
		directory: process.cwd(),
		provider: { readMessages: () => args.providerMessages ?? rawMessages() },
		runner,
		historianModel: args.historianModel ?? "test/model",
		fallbackModels: args.fallbackModels,
		fallbackModelId: args.fallbackModelId,
		historianChunkTokens: args.historianChunkTokens ?? 20_000,
		signal: args.signal,
		retryBackoffMs: args.retryBackoffMs,
		twoPass: args.twoPass,
		memoryEnabled: args.memoryEnabled,
		autoPromote: args.autoPromote,
		memoryDomain: args.memoryDomain,
		userMemoriesEnabled: args.userMemoriesEnabled,
		onPublished: args.onPublished,
		appendCompaction: args.appendCompaction,
		readBranchEntries: args.readBranchEntries,
		notifyIssue: args.notifyIssue,
		boundarySnapshot: args.boundarySnapshot,
		refreshBoundarySnapshot: args.refreshBoundarySnapshot,
		compartmentLeaseHolderId: holderId,
		ensureProjectRegistered: args.ensureProjectRegistered,
		forceKeepLastCompartment: args.forceKeepLastCompartment,
	});
	return { db, runner };
}

describe("runPiHistorian", () => {
	it("keeps the direct test invocation unreachable from production config", async () => {
		const db = createTestDb();
		const holderId = "test-direct-invocation";
		expect(acquireCompartmentLease(db, "ses-historian", holderId)).not.toBeNull();
		const runner = runnerReturning([
			ongoingInteractionSuccessXml("The player explicitly confirmed a durable preference."),
		]);
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			await runPiHistorianForTest({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
				boundarySnapshot: makeBoundarySnapshot(),
				compartmentLeaseHolderId: holderId,
				memoryEnabled: true,
				autoPromote: false,
				memoryDomain: "ongoing-interaction",
			});
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			expect(getMemoriesByProject(db, resolveProjectIdentity(process.cwd()))).toHaveLength(0);
		} finally {
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
			closeQuietly(db);
		}
	});

	it("clears emergency recovery on protected-tail-only no-op", async () => {
		const db = createTestDb();
		const runner = runnerReturning([successXml()]);
		recordOverflowDetected(db, "ses-historian", 100_000);
		appendCompartments(db, "ses-historian", [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 12,
				startMessageId: "m1",
				endMessageId: "m12",
				title: "prior",
				content: "already compacted",
			},
		]);
		try {
			await runPiHistorian({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
			});

			expect(runner.run).not.toHaveBeenCalled();
			expect(getOverflowState(db, "ses-historian").needsEmergencyRecovery).toBe(
				false,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("records failure when existing stored compartments fail validation", async () => {
		const db = createTestDb();
		const runner = runnerReturning([successXml()]);
		appendCompartments(db, "ses-historian", [
			{
				sequence: 0,
				startMessage: 2,
				endMessage: 3,
				startMessageId: "m2",
				endMessageId: "m3",
				title: "gap",
				content: "invalid because message 1 is missing",
			},
		]);
		try {
			await runPiHistorian({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
			});

			expect(runner.run).not.toHaveBeenCalled();
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("skips when the protected-tail drain quota is exhausted", async () => {
		const boundary = makeBoundarySnapshot();
		const usable = Math.round(
			(boundary.contextLimit * boundary.executeThresholdPercentage) / 100,
		);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: boundary,
			beforeRun: (db) => {
				for (let i = 0; i < 3; i++) {
					const reservation = reserveProtectedTailDrainTokens({
						db,
						sessionId: "ses-historian",
						runId: `pre-${i}`,
						trueRawTokens: 3000,
						usagePercentage: boundary.usagePercentage,
						usable,
						perRunCap: 3000,
						executeThresholdPercentage: boundary.executeThresholdPercentage,
					});
					expect(reservation.ok).toBe(true);
				}
			},
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(
				loadProtectedTailMeta(db, "ses-historian").protectedTailDrainTokens,
			).toBe(9000);
		} finally {
			closeQuietly(db);
		}
	});

	it("rolls back reserved drain tokens when the Pi chunk is empty", async () => {
		const emptyMessages = rawMessages(4).map((message) => ({
			...message,
			parts: [],
		}));
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			providerMessages: emptyMessages,
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 5,
				protectedTailStartMessageId: null,
				eligibleEndOrdinal: 5,
				eligibleEndMessageId: "m4",
				rawMessageCountAtTrigger: 4,
				rawLastMessageIdAtTrigger: "m4",
			}),
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(
				loadProtectedTailMeta(db, "ses-historian").protectedTailDrainTokens,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("refreshes a stale protected-tail snapshot and proceeds when the current boundary is runnable", async () => {
		const staleBoundary = makeBoundarySnapshot({
			rawLastMessageIdAtTrigger: "old-m12",
			rawRangeFingerprint: "stale-fingerprint",
		});
		const refreshedBoundary = makeBoundarySnapshot({
			protectedTailStart: 3,
			protectedTailStartMessageId: "m3",
			eligibleEndOrdinal: 3,
			eligibleEndMessageId: "m2",
		});
		const refreshBoundarySnapshot = mock(() => refreshedBoundary);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: staleBoundary,
			refreshBoundarySnapshot,
		});
		try {
			expect(refreshBoundarySnapshot).toHaveBeenCalledTimes(1);
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toEqual([
				expect.objectContaining({
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					title: "Initial Pi slice",
				}),
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the stale-snapshot no-op fallback when the refreshed boundary is not runnable", async () => {
		const staleBoundary = makeBoundarySnapshot({
			rawLastMessageIdAtTrigger: "old-m12",
			rawRangeFingerprint: "stale-fingerprint",
		});
		const refreshBoundarySnapshot = mock(() =>
			makeBoundarySnapshot({
				protectedTailStart: 1,
				protectedTailStartMessageId: "m1",
				eligibleEndOrdinal: 1,
				eligibleEndMessageId: null,
				trueRawEligibleTokens: 0,
			}),
		);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: staleBoundary,
			refreshBoundarySnapshot,
		});
		try {
			expect(refreshBoundarySnapshot).toHaveBeenCalledTimes(1);
			expect(runner.run).not.toHaveBeenCalled();
			expect(getCompartments(db, "ses-historian")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("stores userObservations as candidates (post-commit) when user memories are enabled", async () => {
		const { db } = await runHistorianWith({
			outputs: [successXmlWithUserObservation("User prefers concise answers.")],
			userMemoriesEnabled: true,
		});
		try {
			expect(getUserMemoryCandidates(db)).toEqual([
				expect.objectContaining({
					content: "User prefers concise answers.",
					sessionId: "ses-historian",
					sourceCompartmentStart: 1,
					sourceCompartmentEnd: 2,
				}),
			]);
		} finally {
			closeQuietly(db);
		}
	});
	it("does NOT store userObservations when user memories are disabled (privacy gate)", async () => {
		const { db } = await runHistorianWith({
			outputs: [successXmlWithUserObservation("User prefers concise answers.")],
			userMemoriesEnabled: false,
		});
		try {
			expect(getUserMemoryCandidates(db)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});
	it("runs the Pi subagent, parses output, and publishes compartments and facts", async () => {
		const { db, runner } = await runHistorianWith({ outputs: [successXml()] });
		try {
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toEqual([
				expect.objectContaining({
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					title: "Initial Pi slice",
				}),
			]);
			// v2 faithful fact lifecycle: facts are NOT written to session_facts
			// (no REPLACE). They flow to project memory via promotion.
			expect(getSessionFacts(db, "ses-historian")).toEqual([]);
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(
				getMemoriesByProject(db, projectPath).map((m) => m.content),
			).toContain("Pi historian facts can promote to memory.");
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the ongoing-interaction taxonomy and leaves a one-off interaction episodic when no semantic fact is emitted", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [ongoingInteractionSuccessXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			expect(runner.run).toHaveBeenCalledTimes(1);
			const prompt = (runner.run as unknown as { mock: { calls: Array<[{ systemPrompt: string }]> } }).mock.calls[0][0].systemPrompt;
			expect(prompt).toContain("Ongoing Interaction Memory Domain");
			expect(prompt).toContain("We finished organizing tools during this game.");
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(getMemoriesByProject(db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("promotes both durable ongoing-interaction categories from one output", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [ongoingInteractionDualPromotionXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			expect(runner.run).toHaveBeenCalledTimes(1);
			const projectPath = resolveProjectIdentity(process.cwd());
				expect(getMemoriesByProject(db, projectPath).map((memory) => memory.category)).toEqual([
				"INTERACTION_EPISODE",
				"SEMANTIC_MEMORY",
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not promote an XML interaction episode containing a completed tool receipt", async () => {
		const { db } = await runHistorianWith({
			outputs: [ongoingInteractionToolReceiptFactXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(getMemoriesByProject(db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not promote tool-only failure/recovery or planner experience", async () => {
		const { db } = await runHistorianWith({
			outputs: [ongoingInteractionToolOnlyXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(getMemoriesByProject(db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not promote when the exact published Pi range was already excluded", async () => {
		const { db } = await runHistorianWith({
			outputs: [ongoingInteractionDualPromotionXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
			beforeRun: (database) => {
				excludeMemorySource(database, {
					projectPath: resolveProjectIdentity(process.cwd()),
					sourceRef: "pi-range:ses-historian:1:2",
				});
			},
		});
		try {
			expect(getMemoriesByProject(db, resolveProjectIdentity(process.cwd()))).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("omits ongoing-interaction autoPromote by default and therefore does not promote", async () => {
		const { db } = await runHistorianWith({
			outputs: [ongoingInteractionDualPromotionXml()],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
		});
		try {
			expect(getMemoriesByProject(db, resolveProjectIdentity(process.cwd()))).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("promotes only an explicit ongoing-interaction semantic fact through the existing lifecycle", async () => {
		const fact = "The player explicitly prefers being offered options before a consequential decision.";
		const { db } = await runHistorianWith({
			outputs: [ongoingInteractionSuccessXml(fact)],
			memoryDomain: "ongoing-interaction",
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			const projectPath = resolveProjectIdentity(process.cwd());
			const memories = getMemoriesByProject(db, projectPath);
			expect(memories).toEqual([
				expect.objectContaining({ category: "SEMANTIC_MEMORY", content: fact, sourceType: "historian" }),
			]);
			expect(JSON.parse(memories[0]?.metadataJson ?? "null")).toEqual({
				source_refs: ["pi-range:ses-historian:1:2"],
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("records historian failure when first pass and repair output are invalid", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["not xml", "still not xml"],
		});
		try {
			expect(runner.run).toHaveBeenCalledTimes(2);
			expect(getCompartments(db, "ses-historian")).toEqual([]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("tries configured fallbacks before the live session model last resort", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["", "", successXml("Session model recovered Pi history.")],
			fallbackModels: ["fallback/model"],
			fallbackModelId: "session/model",
		});
		try {
			expect(attemptedModels(runner)).toEqual([
				"test/model",
				"fallback/model",
				"session/model",
			]);
			expect(getCompartments(db, "ses-historian")).toEqual([
				expect.objectContaining({ title: "Initial Pi slice" }),
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not duplicate the session model when it is already the historian model", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [""],
			fallbackModelId: "test/model",
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model"]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not duplicate the session model when it is already a configured fallback", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["", ""],
			fallbackModels: ["session/model"],
			fallbackModelId: "session/model",
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "session/model"]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries transient historian prompt failures on the same model before succeeding", async () => {
		const runner = runnerWithSteps([
			new Error("429 rate limit from provider"),
			successXml("Transient retry recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "test/model"]);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("advances to fallback immediately for non-transient historian prompt failures", async () => {
		const runner = runnerWithSteps([
			new Error("401 unauthorized"),
			successXml("Fallback model recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "fallback/model"]);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not retry or advance fallbacks after an abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const runner = runnerWithSteps([successXml()]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			signal: controller.signal,
			retryBackoffMs: () => 0,
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(getCompartments(db, "ses-historian")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("notifies failed historian runs once with the transient failure framing", async () => {
		clearPiHistorianAlertState("ses-historian");
		const notices: string[] = [];
		const notifyIssue = mock((text: string) => {
			notices.push(text);
		});
		const first = await runHistorianWith({ outputs: [""], notifyIssue });
		try {
			expect(notifyIssue).toHaveBeenCalledTimes(1);
			expect(notices[0]).toContain("Hit a transient issue comparting history");
			expect(notices[0]).toContain("only be alerted again");
		} finally {
			closeQuietly(first.db);
		}

		const second = await runHistorianWith({ outputs: [""], notifyIssue });
		try {
			expect(notifyIssue).toHaveBeenCalledTimes(1);
		} finally {
			closeQuietly(second.db);
			clearPiHistorianAlertState("ses-historian");
		}
	});

	it("writes Pi harness attribution on published compartments", async () => {
		const { db } = await runHistorianWith({ outputs: [successXml()] });
		try {
			const compartmentHarness = db
				.prepare("SELECT harness FROM compartments WHERE session_id = ?")
				.get("ses-historian") as { harness: string };

			expect(compartmentHarness.harness).toBe("pi");
			// v2 faithful facts: no session_facts rows are written anymore;
			// facts are promoted to project memory instead.
			const factRow = db
				.prepare("SELECT harness FROM session_facts WHERE session_id = ?")
				.get("ses-historian");
			expect(factRow).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("fires note-nudge trigger and onPublished after successful publication", async () => {
		const onPublished = mock(() => undefined);
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			onPublished,
		});
		try {
			expect(onPublished).toHaveBeenCalledTimes(1);
			expect(getPersistedNoteNudge(db, "ses-historian").triggerPending).toBe(
				true,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps publish succeeded and signaled when post-commit project registration throws", async () => {
		const onPublished = mock(() => undefined);
		const ensureProjectRegistered = mock(async () => {
			throw new Error("embedding provider unavailable");
		});
		const { db } = await runHistorianWith({
			outputs: [successXml("Pi durable fact survives registration outage.")],
			onPublished,
			ensureProjectRegistered,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onPublished).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			expect(
				loadProtectedTailMeta(db, "ses-historian").priorBoundaryOrdinal,
			).toBe(3);
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(
				getMemoriesByProject(db, projectPath).map((memory) => memory.content),
			).toContain("Pi durable fact survives registration outage.");
			expect(
				db
					.prepare(
						"SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
					)
					.get("ses-historian"),
			).toEqual({ status: "success" });
		} finally {
			closeQuietly(db);
		}
	});

	it("queues a Pi-native compaction marker after publication", async () => {
		const appendCompaction = mock(() => "compact-1");
		const entries = Array.from({ length: 6 }, (_, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			message: { role: index % 2 === 0 ? "user" : "assistant" },
		}));
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			appendCompaction,
			readBranchEntries: () => entries,
		});
		try {
			expect(appendCompaction).not.toHaveBeenCalled();
			expect(getPendingPiCompactionMarkerState(db, "ses-historian")).toEqual(
				expect.objectContaining({
					firstKeptEntryId: "entry-3",
					endMessageId: "m2",
					ordinal: 2,
					tokensBefore: expect.any(Number),
					summary: expect.stringContaining("Initial Pi slice"),
				}),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("downgrades forced final keep on token-capped chunks so discard-last healing still applies", async () => {
		const projectPath = resolveProjectIdentity(process.cwd());
		const longMessages = rawMessages(10).map((message) => ({
			...message,
			parts: [
				{
					type: "text",
					text: `${message.parts[0]?.text ?? "message"} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu alpha beta gamma delta`,
				},
			],
		}));
		const midLoop = await runHistorianWith({
			outputs: [twoCompartmentSuccessXml()],
			providerMessages: longMessages,
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 7,
				protectedTailStartMessageId: "m7",
				eligibleEndOrdinal: 7,
				eligibleEndMessageId: "m6",
			}),
			historianChunkTokens: 100,
			forceKeepLastCompartment: true,
		});
		try {
			// The downgrade proof is the HEALING: an un-downgraded forced keep
			// would persist both compartments. The token-capped chunk instead
			// drops the provisional tail, and discard-last runs skip unanchored
			// promotion by long-standing design (the discarded range re-reads
			// next iteration; reworded facts would double-store).
			expect(getCompartments(midLoop.db, "ses-historian")).toHaveLength(1);
			expect(getCompartments(midLoop.db, "ses-historian")[0]?.endMessage).toBe(
				2,
			);
			expect(getMemoriesByProject(midLoop.db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(midLoop.db);
		}

		const finalChunk = await runHistorianWith({
			outputs: [successXml("Pi final wrapup facts stay deferred.")],
			forceKeepLastCompartment: true,
		});
		try {
			expect(getCompartments(finalChunk.db, "ses-historian")).toHaveLength(1);
			expect(getMemoriesByProject(finalChunk.db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(finalChunk.db);
		}
	});

	it("promotes memories only when memoryEnabled and autoPromote allow it", async () => {
		const projectPath = resolveProjectIdentity(process.cwd());
		const allowed = await runHistorianWith({
			outputs: [successXml("Promote this Pi fact.")],
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			expect(
				getMemoriesByProject(allowed.db, projectPath).map(
					(memory) => memory.content,
				),
			).toContain("Promote this Pi fact.");
		} finally {
			closeQuietly(allowed.db);
		}

		const blocked = await runHistorianWith({
			outputs: [successXml("Do not promote this fact.")],
			memoryEnabled: false,
			autoPromote: true,
		});
		try {
			expect(getMemoriesByProject(blocked.db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(blocked.db);
		}
	});

	describe("historian.two_pass", () => {
		it("does NOT run an editor pass when twoPass is false (default)", async () => {
			const { db, runner } = await runHistorianWith({
				outputs: [successXml()],
				// twoPass omitted → defaults to undefined/false
			});
			try {
				// One subagent run = first pass only.
				expect(runner.run).toHaveBeenCalledTimes(1);
			} finally {
				closeQuietly(db);
			}
		});

		it("runs the editor pass when twoPass=true and uses editor output", async () => {
			const draftXml = successXml("Draft fact only.");
			const editedXml = successXml("Edited fact replaced the draft.");
			const { db, runner } = await runHistorianWith({
				outputs: [draftXml, editedXml],
				twoPass: true,
			});
			try {
				// Two subagent runs = first pass + editor pass.
				expect(runner.run).toHaveBeenCalledTimes(2);
				expect(runner.run).toHaveBeenNthCalledWith(
					2,
					expect.not.objectContaining({ fallbackModels: expect.anything() }),
				);
				// Editor output won — the promoted fact is from the editor.
				const projectPath = resolveProjectIdentity(process.cwd());
				expect(
					getMemoriesByProject(db, projectPath).map((m) => m.content),
				).toContain("Edited fact replaced the draft.");
			} finally {
				closeQuietly(db);
			}
		});

		it("falls back to draft when editor output fails validation", async () => {
			const draftXml = successXml("Original draft fact.");
			// Editor returns garbage — validation fails, draft is preserved.
			const { db, runner } = await runHistorianWith({
				outputs: [draftXml, "not valid xml at all"],
				twoPass: true,
			});
			try {
				expect(runner.run).toHaveBeenCalledTimes(2);
				// Draft fact is promoted despite editor failure (no data loss).
				const projectPath = resolveProjectIdentity(process.cwd());
				expect(
					getMemoriesByProject(db, projectPath).map((m) => m.content),
				).toContain("Original draft fact.");
				// Compartments still persisted.
				expect(getCompartments(db, "ses-historian")).toEqual([
					expect.objectContaining({ title: "Initial Pi slice" }),
				]);
			} finally {
				closeQuietly(db);
			}
		});

		it("does NOT run editor pass when first-pass + repair both fail", async () => {
			// First-pass and repair both invalid → editor pass should be
			// skipped because there's no draft to refine.
			const { db, runner } = await runHistorianWith({
				outputs: ["not xml", "still not xml"],
				twoPass: true,
			});
			try {
				// Exactly 2 calls: first-pass + repair. NOT 3 (no editor).
				expect(runner.run).toHaveBeenCalledTimes(2);
				expect(getCompartments(db, "ses-historian")).toEqual([]);
			} finally {
				closeQuietly(db);
			}
		});
	});
});
