import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	createMemoryStateToken,
	excludeMemorySource,
	type Memory,
	MemoryCommandFacade,
	type MemoryCommandMutationInput,
	type MemoryCommandResult,
	validateMemorySourceRef,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * The only GameBuddy-to-Magic-Context stable-context boundary.
 *
 * This module intentionally accepts immutable values only. It does not expose a
 * database, message, compartment, m[0], m[1], marker, cursor, or fold API.
 * It does not write Host messages or Magic Context storage. Its materialization
 * output is an immutable m[0]-compatible stable block consumed only by the Pi
 * context handler. Publication is explicit, per Pi session, and process-local:
 * neither Host nor this boundary writes Magic Context storage or messages.
 */
export const GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION =
	"gamebuddy-stable-context-source/v1" as const;

export type GameBuddyStableContextSurface = "tavern";
export type GameBuddyStableContextSourceKind =
	| "persona"
	| "scenario"
	| "dialogue_examples"
	| "worldbook";

export interface GameBuddyStableContextBinding {
	continuityId: string;
	sessionId: string;
	surface: GameBuddyStableContextSurface;
}

export interface GameBuddyStableContextSourceRecord {
	sourceId: string;
	kind: GameBuddyStableContextSourceKind;
	revision: string;
	canonicalHash: string;
	content: string;
	budgetTokens: number;
	totalOrderKey: string;
	provenance: string;
}

export interface GameBuddyStableContextSnapshot
	extends GameBuddyStableContextBinding {
	version: typeof GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION;
	canonicalHash: string;
	sources: readonly GameBuddyStableContextSourceRecord[];
}

export type GameBuddyStableContextSourceFailureCode =
	| "adapter_unavailable"
	| "invalid_snapshot"
	| "binding_mismatch"
	| "hash_mismatch"
	| "unknown_source_kind"
	| "duplicate_effective_source";

/**
 * Immutable, renderer-ready m[0] input. This deliberately contains text only:
 * it cannot create a message, mutate m[0]/m[1], or access SQLite.
 */
export type GameBuddyMemoryCategory = "semantic" | "interaction";
export type GameBuddyMemoryStatus = "active" | "permanent" | "archived";

/**
 * Host-facing, bound Memory view. IDs are deliberately opaque state tokens;
 * this boundary never exposes Magic Context database IDs or paths to browser callers.
 */
export interface GameBuddyMemoryView {
	stateToken: string;
	content: string;
	category: GameBuddyMemoryCategory;
	status: GameBuddyMemoryStatus;
	sourceRefs?: readonly string[];
}

export interface GameBuddyDelegatedInferredMemoryCreate {
	continuityId: string;
	/** Host/Pi-issued per-tool-call operation identity; never model supplied. */
	operationId: string;
	content: string;
	sourceRefs?: readonly string[];
}

export interface GameBuddyMemoryFacade {
	/**
	 * Create a Host-authorized, inferred semantic Memory. This entry point is
	 * intentionally separate from player-direct creation: the Host must prove
	 * current-turn delegation before it reaches this bound facade.
	 */
	createDelegatedInferredSemanticMemory(
		input: Readonly<GameBuddyDelegatedInferredMemoryCreate>,
	): Promise<GameBuddyMemoryView>;
	listMemories(
		input: Readonly<{ continuityId: string }>,
	): Promise<readonly GameBuddyMemoryView[]>;
	getMemory(
		input: Readonly<{ continuityId: string; stateToken: string }>,
	): Promise<GameBuddyMemoryView>;
	createMemory(
		input: Readonly<{
			continuityId: string;
			content: string;
			category: GameBuddyMemoryCategory;
			sourceRefs?: readonly string[];
		}>,
	): Promise<GameBuddyMemoryView>;
	updateMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
			content: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	archiveMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
			reason?: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	restoreMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	pinMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	unpinMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	mergeMemory(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
			targetStateToken: string;
		}>,
	): Promise<GameBuddyMemoryView>;
	deleteEntry(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
		}>,
	): Promise<void>;
	excludeSource(
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
			sourceRef?: string;
		}>,
	): Promise<void>;
}

export interface GameBuddyStableContextMaterialization {
	binding: Readonly<GameBuddyStableContextBinding>;
	snapshotCanonicalHash: string;
	budgetTokens: number;
	/** Validated renderer input retained only by the Magic Context fork. */
	sources: readonly Readonly<GameBuddyStableContextSourceRecord>[];
	renderedBlock: string;
}

export class GameBuddyStableContextSourceError extends Error {
	constructor(
		readonly code: GameBuddyStableContextSourceFailureCode,
		message: string,
	) {
		super(message);
		this.name = "GameBuddyStableContextSourceError";
	}
}

const SOURCE_KINDS = new Set<GameBuddyStableContextSourceKind>([
	"persona",
	"scenario",
	"dialogue_examples",
	"worldbook",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(
	code: GameBuddyStableContextSourceFailureCode,
	message: string,
): never {
	throw new GameBuddyStableContextSourceError(code, message);
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		fail("invalid_snapshot", `${field} must be a non-empty string`);
	}
	return value;
}

function requireHash(value: unknown, field: string): string {
	const hash = requireText(value, field);
	if (!SHA256.test(hash))
		fail("invalid_snapshot", `${field} must be lowercase SHA-256`);
	return hash;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>))
			freeze(child);
	}
	return value;
}

function parseSource(value: unknown): GameBuddyStableContextSourceRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return fail("invalid_snapshot", "source must be an object");
	}
	const input = value as Record<string, unknown>;
	const kind = requireText(input.kind, "source.kind");
	if (!SOURCE_KINDS.has(kind as GameBuddyStableContextSourceKind)) {
		return fail("unknown_source_kind", `unsupported source kind: ${kind}`);
	}
	const budgetTokens = input.budgetTokens;
	if (
		typeof budgetTokens !== "number" ||
		!Number.isSafeInteger(budgetTokens) ||
		budgetTokens <= 0
	) {
		return fail(
			"invalid_snapshot",
			"source.budgetTokens must be a positive safe integer",
		);
	}
	const content = requireText(input.content, "source.content");
	const canonicalHash = requireHash(
		input.canonicalHash,
		"source.canonicalHash",
	);
	if (canonicalHash !== sha256(content)) {
		return fail(
			"hash_mismatch",
			"source.canonicalHash does not match source.content",
		);
	}
	return {
		sourceId: requireText(input.sourceId, "source.sourceId"),
		kind: kind as GameBuddyStableContextSourceKind,
		revision: requireText(input.revision, "source.revision"),
		canonicalHash,
		content,
		budgetTokens,
		totalOrderKey: requireText(input.totalOrderKey, "source.totalOrderKey"),
		provenance: requireText(input.provenance, "source.provenance"),
	};
}

/** Validates and deep-freezes a Host-owned canonical artifact snapshot. */
export function validateGameBuddyStableContextSnapshot(
	value: unknown,
	expectedBinding: GameBuddyStableContextBinding,
): Readonly<GameBuddyStableContextSnapshot> {
	const continuityId = requireText(
		expectedBinding.continuityId,
		"binding.continuityId",
	);
	const sessionId = requireText(expectedBinding.sessionId, "binding.sessionId");
	if (expectedBinding.surface !== "tavern") {
		return fail("binding_mismatch", "active binding surface is unsupported");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return fail("invalid_snapshot", "snapshot must be an object");
	}
	const input = value as Record<string, unknown>;
	if (input.version !== GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION) {
		return fail("invalid_snapshot", "unsupported snapshot version");
	}
	for (const field of ["continuityId", "sessionId", "surface"] as const) {
		if (input[field] !== expectedBinding[field]) {
			return fail(
				"binding_mismatch",
				`snapshot ${field} does not match active binding`,
			);
		}
	}
	if (!Array.isArray(input.sources)) {
		return fail("invalid_snapshot", "snapshot.sources must be an array");
	}
	const sources = input.sources.map(parseSource);
	const identities = new Set<string>();
	for (const source of sources) {
		const identity = `${source.kind}\u0000${source.sourceId}`;
		if (identities.has(identity)) {
			return fail(
				"duplicate_effective_source",
				"duplicate source kind/sourceId",
			);
		}
		identities.add(identity);
	}
	const canonicalHash = requireHash(
		input.canonicalHash,
		"snapshot.canonicalHash",
	);
	const hashInput = {
		version: GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION,
		continuityId,
		sessionId,
		surface: expectedBinding.surface,
		sources,
	};
	if (canonicalHash !== sha256(canonicalJson(hashInput))) {
		return fail(
			"hash_mismatch",
			"snapshot.canonicalHash does not match canonical snapshot content",
		);
	}
	return freeze({ ...hashInput, canonicalHash, sources });
}

function sourceRefsFor(memory: Memory): readonly string[] | undefined {
	try {
		const metadata: unknown =
			memory.metadataJson === null
				? undefined
				: JSON.parse(memory.metadataJson);
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
			return undefined;
		const sourceRefs = (metadata as { source_refs?: unknown }).source_refs;
		return Array.isArray(sourceRefs) &&
			sourceRefs.every((value) => typeof value === "string")
			? sourceRefs
			: undefined;
	} catch {
		return undefined;
	}
}

function toMemoryView(memory: Memory): GameBuddyMemoryView {
	const category =
		memory.category === "INTERACTION_EPISODE" ? "interaction" : "semantic";
	return {
		stateToken: createMemoryStateToken(memory),
		content: memory.content,
		category,
		status: memory.status,
		...(sourceRefsFor(memory) === undefined
			? {}
			: { sourceRefs: sourceRefsFor(memory) }),
	};
}

function validatedSourceRefs(
	sourceRefs: readonly string[] | undefined,
): readonly string[] | undefined {
	if (sourceRefs === undefined) return undefined;
	for (const sourceRef of sourceRefs) validateMemorySourceRef(sourceRef);
	return [...sourceRefs];
}

function memoryMetadata(
	sourceRefs: readonly string[] | undefined,
	operationId?: string,
): string | undefined {
	const validated = validatedSourceRefs(sourceRefs);
	return validated === undefined && operationId === undefined
		? undefined
		: JSON.stringify({
			...(validated === undefined ? {} : { source_refs: validated }),
			...(operationId === undefined
				? {}
				: { gamebuddy_delegation: { operation_hash: delegationHash(operationId) } }),
		});
}

function delegationHash(operationId: string): string {
	if (!/^[A-Za-z0-9_-]{1,256}$/u.test(operationId))
		throw new Error("gamebuddy_memory_delegation_operation_invalid");
	return createHash("sha256").update(operationId, "utf8").digest("hex");
}

function delegatedMemoryForOperation(
	facade: MemoryCommandFacade,
	projectPath: string,
	operationId: string,
): Memory | undefined {
	const hash = delegationHash(operationId);
	return facade.list(projectPath).map((entry) => entry.memory).find((memory) => {
		const metadata = metadataObject(memory.metadataJson);
		const delegation = metadata.gamebuddy_delegation;
		return delegation && typeof delegation === "object" && !Array.isArray(delegation)
			&& (delegation as Record<string, unknown>).operation_hash === hash;
	});
}

function metadataObject(metadataJson: string | null): Record<string, unknown> {
	if (!metadataJson) return {};
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch { return {}; }
}

/**
 * Construct the only production bridge from a bound GameBuddy Continuity to
 * Magic Context memory. The caller supplies the opaque runtime cwd, while this
 * bridge derives the canonical storage identity itself and validates every
 * request against the bound continuity. It exposes no DB, project path or raw
 * Memory ID to Host/browser code.
 */
export function createGameBuddyMemoryFacade(
	args: Readonly<{
		continuityId: string;
		runtimeCwd: string;
	}>,
): GameBuddyMemoryFacade {
	const projectPath = resolveProjectIdentityForSession(args.runtimeCwd);
	if (!projectPath)
		throw new Error("gamebuddy_memory_project_identity_unavailable");
	const assertContinuity = (continuityId: string): void => {
		if (continuityId !== args.continuityId)
			throw new Error("gamebuddy_memory_continuity_mismatch");
	};
	const dbPath = join(
		args.runtimeCwd,
		"data",
		"cortexkit",
		"magic-context",
		"context.db",
	);
	const actor = { principal: "player_direct" as const, delegated: false };
	const openFacade = async (): Promise<
		Readonly<{ db: Database; facade: MemoryCommandFacade }>
	> => {
		const db = await openDatabaseAsync(dbPath);
		if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
		return { db, facade: new MemoryCommandFacade(db) };
	};
	const findByStateToken = async (
		facade: MemoryCommandFacade,
		stateToken: string,
	): Promise<Memory> => {
		const memory = facade
			.list(projectPath)
			.find((candidate) => candidate.stateToken === stateToken)?.memory;
		if (!memory) throw new Error("gamebuddy_memory_not_found");
		return memory;
	};
	const mutation = async (
		input: Readonly<{
			continuityId: string;
			stateToken: string;
			expectedStateToken: string;
		}>,
	): Promise<
		Readonly<{
			facade: MemoryCommandFacade;
			memory: Memory;
			command: MemoryCommandMutationInput;
		}>
	> => {
		assertContinuity(input.continuityId);
		if (input.stateToken !== input.expectedStateToken) {
			throw new Error("gamebuddy_memory_stale_state");
		}
		const { facade } = await openFacade();
		const memory = await findByStateToken(facade, input.stateToken);
		return {
			facade,
			memory,
			command: {
				projectPath,
				id: memory.id,
				stateToken: input.expectedStateToken,
				actor,
			},
		};
	};
	const view = (result: MemoryCommandResult): GameBuddyMemoryView =>
		toMemoryView(result.memory);
	return Object.freeze({
		async createDelegatedInferredSemanticMemory(
			input: Readonly<GameBuddyDelegatedInferredMemoryCreate>,
		): Promise<GameBuddyMemoryView> {
			assertContinuity(input.continuityId);
			const { facade } = await openFacade();
			const existing = delegatedMemoryForOperation(
				facade,
				projectPath,
				input.operationId,
			);
			if (existing !== undefined) return toMemoryView(existing);
			const created = facade.create({
				actor: { principal: "companion_agent", delegated: true },
				projectPath,
				category: "SEMANTIC_MEMORY",
				content: input.content,
				sourceType: "agent",
				metadataJson: memoryMetadata(input.sourceRefs, input.operationId),
			});
			return toMemoryView(created.memory);
		},
		async listMemories(
			input: Readonly<{ continuityId: string }>,
		): Promise<readonly GameBuddyMemoryView[]> {
			assertContinuity(input.continuityId);
			return (await openFacade()).facade
				.list(projectPath)
				.map((entry) => toMemoryView(entry.memory));
		},
		async getMemory(
			input: Readonly<{ continuityId: string; stateToken: string }>,
		): Promise<GameBuddyMemoryView> {
			assertContinuity(input.continuityId);
			const { facade } = await openFacade();
			return toMemoryView(await findByStateToken(facade, input.stateToken));
		},
		async createMemory(
			input: Readonly<{
				continuityId: string;
				content: string;
				category: GameBuddyMemoryCategory;
				sourceRefs?: readonly string[];
			}>,
		): Promise<GameBuddyMemoryView> {
			assertContinuity(input.continuityId);
			if (input.category !== "semantic" && input.category !== "interaction") {
				throw new Error("gamebuddy_memory_category_invalid");
			}
			const { facade } = await openFacade();
			const created = facade.create({
				actor,
				projectPath,
				category:
					input.category === "interaction"
						? "INTERACTION_EPISODE"
						: "SEMANTIC_MEMORY",
				content: input.content,
				sourceType: "user",
				metadataJson: memoryMetadata(input.sourceRefs),
			});
			return toMemoryView(created.memory);
		},
		async updateMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
				content: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.update({ ...command, content: input.content }));
		},
		async archiveMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
				reason?: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.archive(command, input.reason));
		},
		async restoreMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.restore(command));
		},
		async pinMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.pin(command));
		},
		async unpinMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.unpin(command));
		},
		async mergeMemory(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
				targetStateToken: string;
			}>,
		): Promise<GameBuddyMemoryView> {
			const { facade, command } = await mutation(input);
			return view(facade.merge({ ...command, targetStateToken: input.targetStateToken }));
		},
		async deleteEntry(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
			}>,
		): Promise<void> {
			const { facade, command } = await mutation(input);
			facade.deleteEntry(command);
		},
		async excludeSource(
			input: Readonly<{
				continuityId: string;
				stateToken: string;
				expectedStateToken: string;
				sourceRef?: string;
			}>,
		): Promise<void> {
			const { db, facade } = await openFacade();
			assertContinuity(input.continuityId);
			const memory = await findByStateToken(facade, input.stateToken);
			if (createMemoryStateToken(memory) !== input.expectedStateToken) {
				throw new Error("gamebuddy_memory_stale_state");
			}
			const sourceRefs =
				input.sourceRef === undefined
					? validatedSourceRefs(sourceRefsFor(memory))
					: validatedSourceRefs([input.sourceRef]);
			if (!sourceRefs || sourceRefs.length === 0) {
				throw new Error("gamebuddy_memory_source_ref_required");
			}
			for (const sourceRef of sourceRefs)
				excludeMemorySource(db, { projectPath, sourceRef });
		},
	});
}

function escapeXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value)
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * Validate an untrusted Host artifact and render it into a deterministic,
 * immutable stable m[0] block. Source content is XML-escaped, never interpreted
 * as messages, scripts, HTML, or a database command.
 */
export function materializeGameBuddyStableContextSnapshot(
	value: unknown,
	expectedBinding: GameBuddyStableContextBinding,
): Readonly<GameBuddyStableContextMaterialization> {
	const snapshot = validateGameBuddyStableContextSnapshot(
		value,
		expectedBinding,
	);
	const sources = [...snapshot.sources].sort((left, right) => {
		const leftKey = `${left.totalOrderKey}\u0000${left.kind}\u0000${left.sourceId}\u0000${left.revision}\u0000${left.canonicalHash}`;
		const rightKey = `${right.totalOrderKey}\u0000${right.kind}\u0000${right.sourceId}\u0000${right.revision}\u0000${right.canonicalHash}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	const renderedSources = sources.map(
		(source) =>
			`<gamebuddy-stable-source kind="${source.kind}" source-id="${escapeXmlAttribute(source.sourceId)}" revision="${escapeXmlAttribute(source.revision)}" canonical-hash="${source.canonicalHash}" budget-tokens="${source.budgetTokens}" total-order-key="${escapeXmlAttribute(source.totalOrderKey)}" provenance="${escapeXmlAttribute(source.provenance)}">\n${escapeXmlText(source.content)}\n</gamebuddy-stable-source>`,
	);
	const renderedBlock = `<gamebuddy-stable-context version="${GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION}" continuity-id="${escapeXmlAttribute(snapshot.continuityId)}" session-id="${escapeXmlAttribute(snapshot.sessionId)}" surface="${snapshot.surface}" canonical-hash="${snapshot.canonicalHash}">\n${renderedSources.join("\n")}\n</gamebuddy-stable-context>`;
	return freeze({
		binding: { ...expectedBinding },
		snapshotCanonicalHash: snapshot.canonicalHash,
		budgetTokens: sources.reduce(
			(total, source) => total + source.budgetTokens,
			0,
		),
		sources,
		renderedBlock,
	});
}

/** Controlled in-process boundary for replacing and materializing snapshots. */
const publishedSourcesByPiSession = new Map<
	string,
	Readonly<GameBuddyStableContextMaterialization>
>();

/**
 * Publish one verified Tavern snapshot for the exact live Pi session named by
 * its binding. Re-publishing that binding atomically replaces the effective
 * source set; an empty `sources` array is the explicit tombstone state.
 */
export function publishGameBuddyStableContextSnapshot(
	binding: GameBuddyStableContextBinding,
	value: unknown,
): Readonly<GameBuddyStableContextMaterialization> {
	const materialization = materializeGameBuddyStableContextSnapshot(
		value,
		binding,
	);
	publishedSourcesByPiSession.set(binding.sessionId, materialization);
	return materialization;
}

/**
 * Returns a materialization only for its exact live Pi session. Callers must
 * not infer a binding from cwd, project identity, or another session.
 */
export function readPublishedGameBuddyStableContext(
	sessionId: string,
): Readonly<GameBuddyStableContextMaterialization> | undefined {
	return publishedSourcesByPiSession.get(sessionId);
}

/** Remove a session-scoped publication when its Pi session is disposed. */
export function clearPublishedGameBuddyStableContext(sessionId: string): void {
	publishedSourcesByPiSession.delete(sessionId);
}

export class GameBuddyStableContextSource {
	readonly materializationStatus = "available" as const;
	#snapshot: Readonly<GameBuddyStableContextSnapshot> | undefined;

	readonly binding: Readonly<GameBuddyStableContextBinding>;

	constructor(binding: GameBuddyStableContextBinding) {
		this.binding = freeze({ ...binding });
	}

	replaceSnapshot(value: unknown): void {
		this.#snapshot = validateGameBuddyStableContextSnapshot(
			value,
			this.binding,
		);
	}

	readSnapshot(): Readonly<GameBuddyStableContextSnapshot> {
		if (!this.#snapshot) {
			return fail(
				"adapter_unavailable",
				"no verified stable-context snapshot is available",
			);
		}
		return this.#snapshot;
	}

	materialize(): Readonly<GameBuddyStableContextMaterialization> {
		return materializeGameBuddyStableContextSnapshot(
			this.readSnapshot(),
			this.binding,
		);
	}
}
