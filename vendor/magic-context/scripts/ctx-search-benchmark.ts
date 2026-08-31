#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadPluginConfig } from "../packages/plugin/src/config";
import {
	buildCanonicalChunkTextFromFts,
	loadCompartmentChunkEmbeddingsForSearch,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { getLastCompartmentEndMessage } from "../packages/plugin/src/features/magic-context/compartment-storage";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/cosine-similarity";
import { sanitizeFtsQuery } from "../packages/plugin/src/features/magic-context/memory/storage-memory-fts";
import {
	embedBatchForProject,
	embedTextForProject,
	type getProjectEmbeddingSnapshot,
	registerProjectEmbedding,
} from "../packages/plugin/src/features/magic-context/project-embedding-registry";
import {
	type CapturedQueryEmbedding,
	type UnifiedSearchOptions,
	type UnifiedSearchResult,
	unifiedSearch,
} from "../packages/plugin/src/features/magic-context/search";
import {
	closeDatabase,
	openDatabase,
} from "../packages/plugin/src/features/magic-context/storage-db";
import { getVisibleMemoryIds } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import {
	getDataDir,
	getMagicContextStorageDir,
} from "../packages/plugin/src/shared/data-path";
import {
	Database,
	type Database as DatabaseType,
} from "../packages/plugin/src/shared/sqlite";

type QueryClass = "conversation" | "identifier" | "fact_rule" | "mixed_hard";
type GoldSource =
	| "compartment"
	| "message"
	| "memory"
	| "git_commit"
	| "primer"
	| "note";

interface ProjectFixture {
	label: string;
	projectPath: string;
	sessionId: string;
}

interface GoldTarget {
	source: GoldSource;
	id: number | string;
	label: string;
	sequence?: number;
	startOrdinal?: number;
	endOrdinal?: number;
	ordinal?: number;
	compartmentId?: number;
	category?: string;
	date?: string;
}

interface QueryFixture {
	id: string;
	class: QueryClass;
	style: string;
	project: string;
	query: string;
	controlQuery?: string;
	expectedFilter?: string;
	gold: GoldTarget[];
}

interface Fixture {
	version: number;
	asOf: string;
	description: string;
	projects: Record<string, ProjectFixture>;
	queries: QueryFixture[];
}

interface CliArgs {
	fixturePath: string;
	outputPath: string;
	p1CachePath: string;
	contextDbPath: string;
	openCodeDbPath: string;
	skipP1: boolean;
}

interface SafeHit {
	source: string;
	id: number | string;
	score: number;
	label: string;
	ordinal?: number;
	startOrdinal?: number;
	endOrdinal?: number;
	rawCosine?: number;
}

interface LaneSummary {
	rank: number | null;
	top: SafeHit[];
}

interface RawChunkHit extends SafeHit {
	source: "compartment";
	id: number;
	startOrdinal: number;
	endOrdinal: number;
	rawCosine: number;
}

interface QueryMeasurement {
	id: string;
	class: QueryClass;
	style: string;
	project: string;
	query: string;
	expectedFilter?: string;
	gold: GoldTarget[];
	extractedTerms: string[];
	lanes: Record<string, LaneSummary>;
}

interface CoverageBucket {
	total: number;
	embedded: number;
	missing: number;
}

interface ProjectCoverage {
	projectPath: string;
	chunkModelId: string | null;
	embeddingModelId: string | null;
	compartments: {
		total: number;
		embedded: number;
		missing: number;
		coveragePct: number;
	};
	compartmentBuckets: Record<string, CoverageBucket>;
	missingCompartmentCreatedRange: { oldest: string; newest: string } | null;
	memories: {
		total: number;
		embedded: number;
		missing: number;
		coveragePct: number;
	};
	commits: {
		total: number;
		embedded: number;
		missing: number;
		coveragePct: number;
	};
}

interface P1Row {
	compartmentId: number;
	sessionId: string;
	title: string;
	startOrdinal: number;
	endOrdinal: number;
	text: string;
	hash: string;
	vector?: Float32Array;
}

const SOURCE_BOOSTS: Record<string, number> = {
	memory: 1.3,
	message: 1.15,
	compartment: 1.15,
	git_commit: 1.2,
	primer: 1.25,
	note: 1,
};

const STOPWORDS = new Set([
	"a",
	"about",
	"after",
	"again",
	"all",
	"also",
	"an",
	"and",
	"around",
	"as",
	"at",
	"be",
	"because",
	"before",
	"both",
	"but",
	"by",
	"conversation",
	"did",
	"do",
	"does",
	"during",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"of",
	"on",
	"one",
	"or",
	"our",
	"that",
	"the",
	"their",
	"then",
	"this",
	"through",
	"to",
	"until",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"while",
	"why",
	"with",
]);

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const value = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index >= 0 ? args[index + 1] : undefined;
	};
	if (args.includes("--help")) {
		console.log(`Usage: bun scripts/ctx-search-benchmark.ts [options]

Options:
  --fixture PATH     Known-answer JSON fixture
  --out PATH         Result snapshot JSON
  --p1-cache PATH    Scratch SQLite cache for P1 vectors
  --context-db PATH  Live context.db path (opened via file: URI mode=ro)
  --opencode-db PATH Live opencode.db path (opened via file: URI mode=ro)
  --skip-p1          Skip the on-the-fly P1-summary probe
  --help             Show this help`);
		process.exit(0);
	}

	return {
		fixturePath: resolve(
			value("--fixture") ?? "scripts/fixtures/ctx-search-known-answers.json",
		),
		outputPath: resolve(
			value("--out") ?? "local-ignore/ctx-search-study/results.json",
		),
		p1CachePath: resolve(
			value("--p1-cache") ?? "local-ignore/ctx-search-study/p1-cache.sqlite",
		),
		contextDbPath: resolve(
			value("--context-db") ?? join(getMagicContextStorageDir(), "context.db"),
		),
		openCodeDbPath: resolve(
			value("--opencode-db") ?? join(getDataDir(), "opencode", "opencode.db"),
		),
		skipP1: args.includes("--skip-p1"),
	};
}

function openReadOnly(path: string): DatabaseType {
	if (!existsSync(path)) throw new Error(`Database does not exist: ${path}`);
	return new Database(`file:${path}?mode=ro`, { readonly: true });
}

function loadFixture(path: string): Fixture {
	const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	if (fixture.version !== 1)
		throw new Error(`Unsupported fixture version: ${fixture.version}`);
	if (fixture.queries.length < 40 || fixture.queries.length > 60) {
		throw new Error(`Expected 40-60 queries, found ${fixture.queries.length}`);
	}
	const ids = new Set<string>();
	for (const query of fixture.queries) {
		if (ids.has(query.id)) throw new Error(`Duplicate query id: ${query.id}`);
		ids.add(query.id);
		if (!fixture.projects[query.project]) {
			throw new Error(`Unknown project '${query.project}' on ${query.id}`);
		}
		if (query.gold.length === 0)
			throw new Error(`Query ${query.id} has no gold targets`);
	}
	return fixture;
}

function numberValue(row: unknown, key: string): number {
	const value = (row as Record<string, unknown> | undefined)?.[key];
	return typeof value === "number" ? value : Number(value ?? 0);
}

function isoDate(milliseconds: number): string {
	return new Date(milliseconds).toISOString().slice(0, 10);
}

function pct(embedded: number, total: number): number {
	return total === 0 ? 100 : Number(((embedded / total) * 100).toFixed(1));
}

function auditCoverage(db: DatabaseType, asOf: string): ProjectCoverage[] {
	const asOfMs = Date.parse(`${asOf}T23:59:59.999Z`);
	const day = 24 * 60 * 60 * 1000;
	const buckets = [
		{ name: "last_4d", low: asOfMs - 4 * day, high: asOfMs + 1 },
		{ name: "days_5_7", low: asOfMs - 7 * day, high: asOfMs - 4 * day },
		{ name: "days_8_30", low: asOfMs - 30 * day, high: asOfMs - 7 * day },
		{ name: "days_31_90", low: asOfMs - 90 * day, high: asOfMs - 30 * day },
		{ name: "older_than_90d", low: 0, high: asOfMs - 90 * day },
	];
	const projectRows = db
		.prepare(
			`SELECT sp.project_path AS projectPath, COUNT(*) AS total
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id AND sp.harness = c.harness
             GROUP BY sp.project_path
             ORDER BY total DESC`,
		)
		.all() as Array<{ projectPath: string; total: number }>;

	const identities = new Set(projectRows.map((row) => row.projectPath));
	for (const row of db
		.prepare("SELECT DISTINCT project_path AS projectPath FROM memories")
		.all() as Array<{ projectPath: string }>) {
		identities.add(row.projectPath);
	}
	for (const row of db
		.prepare("SELECT DISTINCT project_path AS projectPath FROM git_commits")
		.all() as Array<{ projectPath: string }>) {
		identities.add(row.projectPath);
	}

	const coverage: ProjectCoverage[] = [];
	for (const projectPath of identities) {
		const registration = db
			.prepare(
				`SELECT model_id AS modelId, chunk_model_id AS chunkModelId
                 FROM embedding_registrations WHERE project_path = ?`,
			)
			.get(projectPath) as
			| { modelId: string; chunkModelId: string }
			| undefined;
		const chunkModelId = registration?.chunkModelId ?? null;
		const embeddingModelId = registration?.modelId ?? null;
		const compartmentTotal = numberValue(
			db
				.prepare(
					`SELECT COUNT(*) AS count
                     FROM compartments c
                     JOIN session_projects sp
                       ON sp.session_id = c.session_id AND sp.harness = c.harness
                     WHERE sp.project_path = ?`,
				)
				.get(projectPath),
			"count",
		);
		const compartmentEmbedded = chunkModelId
			? numberValue(
					db
						.prepare(
							`SELECT COUNT(*) AS count
                           FROM compartments c
                           JOIN session_projects sp
                             ON sp.session_id = c.session_id AND sp.harness = c.harness
                           WHERE sp.project_path = ?
                             AND EXISTS (
                               SELECT 1 FROM compartment_chunk_embeddings e
                               WHERE e.compartment_id = c.id AND e.model_id = ?
                             )`,
						)
						.get(projectPath, chunkModelId),
					"count",
				)
			: 0;
		const compartmentBuckets: Record<string, CoverageBucket> = {};
		for (const bucket of buckets) {
			const row = db
				.prepare(
					`SELECT COUNT(*) AS total,
                            SUM(CASE WHEN EXISTS (
                              SELECT 1 FROM compartment_chunk_embeddings e
                              WHERE e.compartment_id = c.id AND e.model_id = ?
                            ) THEN 1 ELSE 0 END) AS embedded
                     FROM compartments c
                     JOIN session_projects sp
                       ON sp.session_id = c.session_id AND sp.harness = c.harness
                     WHERE sp.project_path = ? AND c.created_at >= ? AND c.created_at < ?`,
				)
				.get(chunkModelId ?? "", projectPath, bucket.low, bucket.high);
			const total = numberValue(row, "total");
			const embedded = numberValue(row, "embedded");
			compartmentBuckets[bucket.name] = {
				total,
				embedded,
				missing: total - embedded,
			};
		}
		const missingRange = chunkModelId
			? (db
					.prepare(
						`SELECT MIN(c.created_at) AS oldest, MAX(c.created_at) AS newest
                       FROM compartments c
                       JOIN session_projects sp
                         ON sp.session_id = c.session_id AND sp.harness = c.harness
                       WHERE sp.project_path = ?
                         AND NOT EXISTS (
                           SELECT 1 FROM compartment_chunk_embeddings e
                           WHERE e.compartment_id = c.id AND e.model_id = ?
                         )`,
					)
					.get(projectPath, chunkModelId) as
					| { oldest: number | null; newest: number | null }
					| undefined)
			: undefined;
		const memoryTotal = numberValue(
			db
				.prepare(
					`SELECT COUNT(*) AS count FROM memories
                     WHERE project_path = ? AND status IN ('active', 'permanent')
                       AND (expires_at IS NULL OR expires_at > ?)`,
				)
				.get(projectPath, asOfMs),
			"count",
		);
		const memoryEmbedded = embeddingModelId
			? numberValue(
					db
						.prepare(
							`SELECT COUNT(*) AS count FROM memories m
                           WHERE m.project_path = ? AND m.status IN ('active', 'permanent')
                             AND (m.expires_at IS NULL OR m.expires_at > ?)
                             AND EXISTS (
                               SELECT 1 FROM memory_embeddings e
                               WHERE e.memory_id = m.id AND e.model_id = ?
                             )`,
						)
						.get(projectPath, asOfMs, embeddingModelId),
					"count",
				)
			: 0;
		const commitTotal = numberValue(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM git_commits WHERE project_path = ?",
				)
				.get(projectPath),
			"count",
		);
		const commitEmbedded = embeddingModelId
			? numberValue(
					db
						.prepare(
							`SELECT COUNT(*) AS count FROM git_commits c
                           WHERE c.project_path = ? AND EXISTS (
                             SELECT 1 FROM git_commit_embeddings e
                             WHERE e.sha = c.sha AND e.model_id = ?
                           )`,
						)
						.get(projectPath, embeddingModelId),
					"count",
				)
			: 0;

		coverage.push({
			projectPath,
			chunkModelId,
			embeddingModelId,
			compartments: {
				total: compartmentTotal,
				embedded: compartmentEmbedded,
				missing: compartmentTotal - compartmentEmbedded,
				coveragePct: pct(compartmentEmbedded, compartmentTotal),
			},
			compartmentBuckets,
			missingCompartmentCreatedRange:
				missingRange?.oldest != null && missingRange.newest != null
					? {
							oldest: isoDate(missingRange.oldest),
							newest: isoDate(missingRange.newest),
						}
					: null,
			memories: {
				total: memoryTotal,
				embedded: memoryEmbedded,
				missing: memoryTotal - memoryEmbedded,
				coveragePct: pct(memoryEmbedded, memoryTotal),
			},
			commits: {
				total: commitTotal,
				embedded: commitEmbedded,
				missing: commitTotal - commitEmbedded,
				coveragePct: pct(commitEmbedded, commitTotal),
			},
		});
	}
	return coverage.sort(
		(left, right) => right.compartments.total - left.compartments.total,
	);
}

function validateGolds(
	db: DatabaseType,
	openCodeDb: DatabaseType,
	fixture: Fixture,
): { transcriptChecked: number; rawMessagesChecked: number } {
	let transcriptChecked = 0;
	let rawMessagesChecked = 0;
	for (const query of fixture.queries) {
		const project = fixture.projects[query.project];
		for (const gold of query.gold) {
			if (gold.source === "compartment") {
				const row = db
					.prepare(
						`SELECT c.id, c.session_id AS sessionId, c.start_message AS startOrdinal,
                                c.end_message AS endOrdinal
                         FROM compartments c WHERE c.id = ?`,
					)
					.get(gold.id) as
					| {
							id: number;
							sessionId: string;
							startOrdinal: number;
							endOrdinal: number;
					  }
					| undefined;
				if (!row || row.sessionId !== project.sessionId) {
					throw new Error(
						`Missing or wrong-session compartment gold ${gold.id} (${query.id})`,
					);
				}
				if (
					gold.startOrdinal !== undefined &&
					(gold.startOrdinal !== row.startOrdinal ||
						gold.endOrdinal !== row.endOrdinal)
				) {
					throw new Error(
						`Stale ordinal range for compartment ${gold.id} (${query.id})`,
					);
				}
				const transcript = buildCanonicalChunkTextFromFts(
					db,
					row.sessionId,
					row.startOrdinal,
					row.endOrdinal,
				);
				if (transcript.trim().length === 0) {
					throw new Error(
						`Empty canonical transcript for compartment ${gold.id} (${query.id})`,
					);
				}
				transcriptChecked += 1;
			} else if (gold.source === "message") {
				const row = db
					.prepare(
						`SELECT message_id AS messageId, CAST(message_ordinal AS INTEGER) AS ordinal
                         FROM message_history_fts WHERE session_id = ? AND message_id = ? LIMIT 1`,
					)
					.get(project.sessionId, gold.id) as
					| { messageId: string; ordinal: number }
					| undefined;
				if (
					!row ||
					(gold.ordinal !== undefined && row.ordinal !== gold.ordinal)
				) {
					throw new Error(
						`Missing or stale message gold ${gold.id} (${query.id})`,
					);
				}
				const raw = openCodeDb
					.prepare("SELECT id FROM message WHERE id = ?")
					.get(gold.id);
				if (!raw)
					throw new Error(`Message gold absent from opencode.db: ${gold.id}`);
				rawMessagesChecked += 1;
			} else if (gold.source === "memory") {
				const row = db
					.prepare(
						"SELECT project_path AS projectPath FROM memories WHERE id = ?",
					)
					.get(gold.id) as { projectPath: string } | undefined;
				if (!row || row.projectPath !== project.projectPath) {
					throw new Error(
						`Missing or wrong-project memory gold ${gold.id} (${query.id})`,
					);
				}
			} else if (gold.source === "git_commit") {
				const row = db
					.prepare(
						"SELECT project_path AS projectPath FROM git_commits WHERE sha = ?",
					)
					.get(gold.id) as { projectPath: string } | undefined;
				if (!row || row.projectPath !== project.projectPath) {
					throw new Error(
						`Missing or wrong-project commit gold ${gold.id} (${query.id})`,
					);
				}
			} else if (gold.source === "note") {
				if (!db.prepare("SELECT id FROM notes WHERE id = ?").get(gold.id)) {
					throw new Error(`Missing note gold ${gold.id} (${query.id})`);
				}
			} else if (gold.source === "primer") {
				if (!db.prepare("SELECT id FROM primers WHERE id = ?").get(gold.id)) {
					throw new Error(`Missing primer gold ${gold.id} (${query.id})`);
				}
			}
		}
	}
	return { transcriptChecked, rawMessagesChecked };
}

function safeResult(result: UnifiedSearchResult): SafeHit {
	switch (result.source) {
		case "compartment":
			return {
				source: result.source,
				id: result.compartmentId,
				score: Number(result.score.toFixed(6)),
				label: result.title,
				startOrdinal: result.startOrdinal,
				endOrdinal: result.endOrdinal,
			};
		case "message":
			return {
				source: result.source,
				id: result.messageId,
				score: Number(result.score.toFixed(6)),
				label: `message @${result.messageOrdinal} (${result.role})`,
				ordinal: result.messageOrdinal,
			};
		case "memory":
			return {
				source: result.source,
				id: result.memoryId,
				score: Number(result.score.toFixed(6)),
				label: `memory #${result.memoryId} [${result.category}]`,
			};
		case "git_commit":
			return {
				source: result.source,
				id: result.sha,
				score: Number(result.score.toFixed(6)),
				label: `${result.shortSha} ${result.content.split("\n")[0]}`,
			};
		case "primer":
			return {
				source: result.source,
				id: result.primerId,
				score: Number(result.score.toFixed(6)),
				label: `primer #${result.primerId}`,
			};
		case "note":
			return {
				source: result.source,
				id: result.noteId,
				score: Number(result.score.toFixed(6)),
				label: `note #${result.noteId} [${result.status}]`,
			};
	}
}

function resultMatchesGold(result: SafeHit, golds: GoldTarget[]): boolean {
	return golds.some((gold) => {
		if (result.source === gold.source && String(result.id) === String(gold.id))
			return true;
		if (result.source === "compartment" || result.source === "compartment-p1") {
			if (gold.source === "compartment" && result.id === gold.id) return true;
			if (gold.compartmentId !== undefined && result.id === gold.compartmentId)
				return true;
			if (
				gold.ordinal !== undefined &&
				result.startOrdinal !== undefined &&
				result.endOrdinal !== undefined &&
				gold.ordinal >= result.startOrdinal &&
				gold.ordinal <= result.endOrdinal
			) {
				return true;
			}
		}
		if (
			result.source === "message" &&
			result.ordinal !== undefined &&
			gold.startOrdinal !== undefined &&
			gold.endOrdinal !== undefined
		) {
			return (
				result.ordinal >= gold.startOrdinal && result.ordinal <= gold.endOrdinal
			);
		}
		return false;
	});
}

function summarize(
	hits: SafeHit[],
	golds: GoldTarget[],
	top = 10,
): LaneSummary {
	const rank = hits.findIndex((hit) => resultMatchesGold(hit, golds));
	return { rank: rank < 0 ? null : rank + 1, top: hits.slice(0, top) };
}

function normalizeCosine(score: number): number {
	return Math.max(0, Math.min(1, (score + 1) / 2));
}

function rawChunkSearch(
	db: DatabaseType,
	project: ProjectFixture,
	modelId: string,
	vector: Float32Array,
	maxOrdinal: number,
	limit = 50,
): RawChunkHit[] {
	const rows = loadCompartmentChunkEmbeddingsForSearch(
		db,
		project.sessionId,
		project.projectPath,
		modelId,
	);
	const byCompartment = new Map<number, RawChunkHit>();
	for (const row of rows) {
		if (maxOrdinal >= 0 && row.endOrdinal > maxOrdinal) continue;
		const rawCosine = cosineSimilarity(vector, row.vector);
		const score = normalizeCosine(rawCosine) * 0.8;
		const hit: RawChunkHit = {
			source: "compartment",
			id: row.compartmentId,
			score: Number(score.toFixed(6)),
			rawCosine: Number(rawCosine.toFixed(6)),
			label: row.title,
			startOrdinal: row.startOrdinal,
			endOrdinal: row.endOrdinal,
		};
		const prior = byCompartment.get(row.compartmentId);
		if (!prior || hit.rawCosine > prior.rawCosine)
			byCompartment.set(row.compartmentId, hit);
	}
	return [...byCompartment.values()]
		.filter((hit) => hit.score > 0)
		.sort(
			(left, right) =>
				right.rawCosine - left.rawCosine ||
				left.startOrdinal - right.startOrdinal,
		)
		.slice(0, limit);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function vectorBlob(vector: Float32Array): Uint8Array {
	return new Uint8Array(
		vector.buffer.slice(
			vector.byteOffset,
			vector.byteOffset + vector.byteLength,
		),
	);
}

function decodeVector(value: Uint8Array | ArrayBuffer): Float32Array {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	const copy = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
	return new Float32Array(copy);
}

async function prepareP1Rows(
	liveDb: DatabaseType,
	cachePath: string,
	projectKey: string,
	project: ProjectFixture,
	modelId: string,
): Promise<P1Row[]> {
	mkdirSync(dirname(cachePath), { recursive: true });
	const cache = new Database(cachePath);
	cache.exec(`CREATE TABLE IF NOT EXISTS p1_summary_embeddings (
        project_key TEXT NOT NULL,
        compartment_id INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_key, compartment_id, model_id)
    )`);
	const rows: P1Row[] = (
		liveDb
			.prepare(
				`SELECT id AS compartmentId, session_id AS sessionId, title,
                        start_message AS startOrdinal, end_message AS endOrdinal,
                        COALESCE(NULLIF(p1, ''), content) AS p1
                 FROM compartments WHERE session_id = ? ORDER BY sequence`,
			)
			.all(project.sessionId) as Array<{
			compartmentId: number;
			sessionId: string;
			title: string;
			startOrdinal: number;
			endOrdinal: number;
			p1: string;
		}>
	).map((row) => {
		const text = `${row.title.trim()}\n${row.p1.trim()}`.trim();
		return { ...row, text, hash: hashText(text) } satisfies P1Row;
	});

	const lookup = cache.prepare(
		`SELECT content_hash AS contentHash, vector
         FROM p1_summary_embeddings
         WHERE project_key = ? AND compartment_id = ? AND model_id = ?`,
	);
	const missing: P1Row[] = [];
	for (const row of rows) {
		const cached = lookup.get(projectKey, row.compartmentId, modelId) as
			| { contentHash: string; vector: Uint8Array | ArrayBuffer }
			| undefined;
		if (cached?.contentHash === row.hash)
			row.vector = decodeVector(cached.vector);
		else missing.push(row);
	}

	const save = cache.prepare(
		`INSERT INTO p1_summary_embeddings
           (project_key, compartment_id, model_id, content_hash, dims, vector, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_key, compartment_id, model_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           dims = excluded.dims,
           vector = excluded.vector,
           created_at = excluded.created_at`,
	);
	const batchSize = 16;
	for (let offset = 0; offset < missing.length; offset += batchSize) {
		const batch = missing.slice(offset, offset + batchSize);
		const result = await embedBatchForProject(
			project.projectPath,
			batch.map((row) => row.text),
			undefined,
			"passage",
		);
		if (!result || result.vectors.length !== batch.length) {
			cache.close();
			throw new Error(`P1 embedding batch failed at offset ${offset}`);
		}
		for (let index = 0; index < batch.length; index += 1) {
			let vector = result.vectors[index];
			for (let attempt = 0; !vector && attempt < 3; attempt += 1) {
				const retry = await embedTextForProject(
					project.projectPath,
					batch[index].text,
					undefined,
					"passage",
				);
				vector = retry?.vector ?? null;
			}
			if (!vector) {
				cache.close();
				throw new Error(
					`P1 embedding returned null for compartment ${batch[index].compartmentId}`,
				);
			}
			batch[index].vector = vector;
			save.run(
				projectKey,
				batch[index].compartmentId,
				modelId,
				batch[index].hash,
				vector.length,
				vectorBlob(vector),
				Date.now(),
			);
		}
		console.log(
			`[p1] ${projectKey}: embedded ${Math.min(offset + batch.length, missing.length)}/${missing.length}`,
		);
	}
	cache.close();
	return rows;
}

function p1Search(
	rows: P1Row[],
	vector: Float32Array,
	maxOrdinal: number,
): SafeHit[] {
	return rows
		.filter((row) => row.vector && row.endOrdinal <= maxOrdinal)
		.map((row) => ({
			source: "compartment-p1",
			id: row.compartmentId,
			score: Number(
				cosineSimilarity(vector, row.vector as Float32Array).toFixed(6),
			),
			label: row.title,
			startOrdinal: row.startOrdinal,
			endOrdinal: row.endOrdinal,
		}))
		.sort(
			(left, right) =>
				right.score - left.score ||
				(left.startOrdinal ?? 0) - (right.startOrdinal ?? 0),
		);
}

function extractCandidateTerms(
	db: DatabaseType,
	sessionId: string,
	query: string,
	maxOrdinal: number,
): string[] {
	const tokens = [
		...new Set(
			(query.match(/[A-Za-z0-9_./#-]+/g) ?? [])
				.map((token) => token.replace(/^[#./-]+|[#./-]+$/g, ""))
				.filter(
					(token) => token.length >= 3 && !STOPWORDS.has(token.toLowerCase()),
				),
		),
	];
	const scored = tokens.map((token) => {
		const fts = sanitizeFtsQuery(token);
		let count = 0;
		if (fts) {
			count = numberValue(
				db
					.prepare(
						`SELECT COUNT(*) AS count FROM message_history_fts
                         WHERE session_id = ? AND CAST(message_ordinal AS INTEGER) <= ?
                           AND message_history_fts MATCH ?`,
					)
					.get(sessionId, maxOrdinal, fts),
				"count",
			);
		}
		return { token, count };
	});
	const present = scored.filter((entry) => entry.count > 0);
	const pool = present.length >= 2 ? present : scored;
	return pool
		.sort(
			(left, right) =>
				(left.count || Number.MAX_SAFE_INTEGER) -
					(right.count || Number.MAX_SAFE_INTEGER) ||
				right.token.length - left.token.length,
		)
		.slice(0, 4)
		.map((entry) => entry.token);
}

function rrfFuse(
	resultLists: UnifiedSearchResult[][],
	limit = 10,
): UnifiedSearchResult[] {
	const fused = new Map<
		string,
		{ result: UnifiedSearchResult; score: number }
	>();
	const key = (result: UnifiedSearchResult): string => {
		if (result.source === "message") return `message:${result.messageId}`;
		if (result.source === "compartment")
			return `compartment:${result.compartmentId}`;
		return `${result.source}:${safeResult(result).id}`;
	};
	for (const list of resultLists) {
		list.forEach((result, rank) => {
			const identity = key(result);
			const prior = fused.get(identity);
			if (prior) prior.score += 1 / (60 + rank);
			else fused.set(identity, { result, score: 1 / (60 + rank) });
		});
	}
	const ranked = [...fused.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
	return ranked.map((entry, rank) => ({
		...entry.result,
		score: Math.max(0, 1 - rank / Math.max(1, ranked.length)),
	}));
}

function offlineFusion(
	lanes: UnifiedSearchResult[][],
	multipliers: Record<string, number>,
): UnifiedSearchResult[] {
	return lanes
		.flat()
		.sort((left, right) => {
			const leftScore =
				left.score *
				(SOURCE_BOOSTS[left.source] ?? 1) *
				(multipliers[left.source] ?? 1);
			const rightScore =
				right.score *
				(SOURCE_BOOSTS[right.source] ?? 1) *
				(multipliers[right.source] ?? 1);
			return rightScore - leftScore;
		})
		.slice(0, 10);
}

async function main(): Promise<void> {
	const args = parseArgs();
	const fixture = loadFixture(args.fixturePath);
	const db = openReadOnly(args.contextDbPath);
	const openCodeDb = openReadOnly(args.openCodeDbPath);
	const scratch = openDatabase(":memory:");
	if (!scratch)
		throw new Error("Could not initialize in-memory registration database");

	try {
		const validation = validateGolds(db, openCodeDb, fixture);
		const coverage = auditCoverage(db, fixture.asOf);
		const config = loadPluginConfig(process.cwd());
		const projectSnapshots = new Map<
			string,
			NonNullable<ReturnType<typeof getProjectEmbeddingSnapshot>>
		>();
		for (const [key, project] of Object.entries(fixture.projects)) {
			const snapshot = registerProjectEmbedding(
				scratch,
				project.projectPath,
				config.embedding,
				{
					memoryEnabled: config.memory.enabled,
					gitCommitEnabled: config.memory.git_commit_indexing.enabled,
				},
				process.cwd(),
			);
			const live = db
				.prepare(
					`SELECT model_id AS modelId, chunk_model_id AS chunkModelId
                     FROM embedding_registrations WHERE project_path = ?`,
				)
				.get(project.projectPath) as
				| { modelId: string; chunkModelId: string }
				| undefined;
			if (
				!live ||
				live.modelId !== snapshot.modelId ||
				live.chunkModelId !== snapshot.chunkModelId
			) {
				throw new Error(
					`Configured provider does not match live corpus for ${key}: ` +
						`configured=${snapshot.modelId}/${snapshot.chunkModelId}, ` +
						`live=${live?.modelId ?? "none"}/${live?.chunkModelId ?? "none"}`,
				);
			}
			projectSnapshots.set(key, snapshot);
		}

		const queryEmbeddingCache = new Map<
			string,
			Promise<CapturedQueryEmbedding | null>
		>();
		const embedOnce = (
			projectKey: string,
			text: string,
		): Promise<CapturedQueryEmbedding | null> => {
			const cacheKey = `${projectKey}\u0000${text}`;
			let promise = queryEmbeddingCache.get(cacheKey);
			if (!promise) {
				const project = fixture.projects[projectKey];
				promise = embedTextForProject(
					project.projectPath,
					text,
					undefined,
					"query",
				);
				queryEmbeddingCache.set(cacheKey, promise);
			}
			return promise;
		};

		const p1RowsByProject = new Map<string, P1Row[]>();
		if (!args.skipP1) {
			const conversationProjects = new Set(
				fixture.queries
					.filter((query) => query.class === "conversation")
					.map((query) => query.project),
			);
			for (const projectKey of conversationProjects) {
				const project = fixture.projects[projectKey];
				const snapshot = projectSnapshots.get(projectKey);
				if (!snapshot)
					throw new Error(`Missing project snapshot: ${projectKey}`);
				p1RowsByProject.set(
					projectKey,
					await prepareP1Rows(
						db,
						args.p1CachePath,
						projectKey,
						project,
						snapshot.modelId,
					),
				);
			}
		}

		const measurements: QueryMeasurement[] = [];
		for (const [index, query] of fixture.queries.entries()) {
			const project = fixture.projects[query.project];
			const snapshot = projectSnapshots.get(query.project);
			if (!snapshot)
				throw new Error(`Missing project snapshot: ${query.project}`);
			const maxOrdinal = getLastCompartmentEndMessage(db, project.sessionId);
			const visibleMemoryIds = getVisibleMemoryIds(db, project.sessionId);
			const shared: UnifiedSearchOptions = {
				limit: 10,
				memoryEnabled: true,
				embeddingEnabled: true,
				embedQuery: (text) => embedOnce(query.project, text),
				isEmbeddingRuntimeEnabled: () => true,
				maxMessageOrdinal: maxOrdinal,
				gitCommitsEnabled: true,
				visibleMemoryIds,
				explicitSearch: true,
				countRetrievals: false,
				measurementDisabled: true,
			};
			const run = (text: string, options: UnifiedSearchOptions = {}) =>
				unifiedSearch(db, project.sessionId, project.projectPath, text, {
					...shared,
					...options,
				});

			const full = await run(query.query);
			const conversation = await run(query.query, { sources: ["message"] });
			const messageFts = await run(query.query, {
				sources: ["message"],
				embeddingEnabled: false,
			});
			const messageUnfiltered = await run(query.query, {
				sources: ["message"],
				embeddingEnabled: false,
				maxMessageOrdinal: -1,
			});
			const memory = await run(query.query, { sources: ["memory"] });
			const memoryUnfiltered = await run(query.query, {
				sources: ["memory"],
				visibleMemoryIds: null,
			});
			const commits = await run(query.query, { sources: ["git_commit"] });
			const primers = await run(query.query, { sources: ["primer"] });
			const notes = await run(query.query, { sources: ["note"] });
			const captured = await embedOnce(query.project, query.query);
			if (!captured) throw new Error(`Query embedding failed for ${query.id}`);
			const chunkRaw = rawChunkSearch(
				db,
				project,
				snapshot.chunkModelId,
				captured.vector,
				maxOrdinal,
				50,
			);
			const controlCaptured = query.controlQuery
				? await embedOnce(query.project, query.controlQuery)
				: null;
			const controlChunk = controlCaptured
				? rawChunkSearch(
						db,
						project,
						snapshot.chunkModelId,
						controlCaptured.vector,
						maxOrdinal,
						50,
					)
				: [];
			const p1Rows = p1RowsByProject.get(query.project);
			const p1 = p1Rows ? p1Search(p1Rows, captured.vector, maxOrdinal) : [];

			const extractedTerms = extractCandidateTerms(
				db,
				project.sessionId,
				query.query,
				maxOrdinal,
			);
			const keytermAnd =
				extractedTerms.length > 0
					? await run(extractedTerms.join(" "), {
							sources: ["message"],
							embeddingEnabled: false,
						})
					: [];
			const keytermLists: UnifiedSearchResult[][] = [];
			for (const term of extractedTerms) {
				keytermLists.push(
					await run(term, {
						limit: 30,
						sources: ["message"],
						embeddingEnabled: false,
					}),
				);
			}
			const keytermRrf = rrfFuse(keytermLists, 10);
			const fusionLanes = [memory, primers, conversation, commits, notes];
			const baselineOffline = offlineFusion(fusionLanes, {});
			const conversationBoost125 = offlineFusion(fusionLanes, {
				compartment: 1.25,
				message: 1.25,
			});
			const conversationClassAware = offlineFusion(fusionLanes, {
				compartment: 1.5,
				message: 1.35,
				memory: 0.8,
				primer: 0.85,
				note: 0.9,
			});
			const chunkHeavy = offlineFusion(fusionLanes, {
				compartment: 1.75,
				message: 1.15,
				memory: 0.75,
				primer: 0.8,
				note: 0.85,
			});

			const laneResults: Record<string, SafeHit[]> = {
				full: full.map(safeResult),
				conversation: conversation.map(safeResult),
				message_fts: messageFts.map(safeResult),
				message_fts_unfiltered: messageUnfiltered.map(safeResult),
				memory: memory.map(safeResult),
				memory_unfiltered: memoryUnfiltered.map(safeResult),
				commits: commits.map(safeResult),
				primers: primers.map(safeResult),
				notes: notes.map(safeResult),
				chunk_raw: chunkRaw,
				chunk_control_reword: controlChunk,
				p1_summary: p1,
				keyterm_fts_and: keytermAnd.map(safeResult),
				keyterm_fts_rrf: keytermRrf.map(safeResult),
				fusion_offline_baseline: baselineOffline.map(safeResult),
				fusion_conversation_boost_125: conversationBoost125.map(safeResult),
				fusion_conversation_class_aware: conversationClassAware.map(safeResult),
				fusion_chunk_heavy: chunkHeavy.map(safeResult),
			};
			const lanes = Object.fromEntries(
				Object.entries(laneResults).map(([name, hits]) => [
					name,
					summarize(hits, query.gold, name === "chunk_raw" ? 50 : 10),
				]),
			);
			measurements.push({
				id: query.id,
				class: query.class,
				style: query.style,
				project: query.project,
				query: query.query,
				expectedFilter: query.expectedFilter,
				gold: query.gold,
				extractedTerms,
				lanes,
			});
			console.log(
				`[${index + 1}/${fixture.queries.length}] ${query.id}: full=${lanes.full.rank ?? "miss"} chunk=${lanes.chunk_raw.rank ?? "miss"}`,
			);
		}

		const output = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			fixture: {
				path: args.fixturePath,
				version: fixture.version,
				asOf: fixture.asOf,
				queryCount: fixture.queries.length,
			},
			readOnlyStores: {
				contextDb: args.contextDbPath,
				openCodeDb: args.openCodeDbPath,
				openMode: "file: URI mode=ro + readonly constructor flag",
			},
			embedding: {
				provider: config.embedding.provider,
				model: "model" in config.embedding ? config.embedding.model : "off",
				modelIds: Object.fromEntries(
					[...projectSnapshots.entries()].map(([key, snapshot]) => [
						key,
						{ modelId: snapshot.modelId, chunkModelId: snapshot.chunkModelId },
					]),
				),
				queryEmbeddingsComputed: queryEmbeddingCache.size,
				p1ProbeSkipped: args.skipP1,
				p1CachePath: args.skipP1 ? null : args.p1CachePath,
			},
			validation,
			coverage,
			queries: measurements,
		};
		mkdirSync(dirname(args.outputPath), { recursive: true });
		writeFileSync(args.outputPath, `${JSON.stringify(output, null, 2)}\n`);
		console.log(`Wrote ${args.outputPath}`);
	} finally {
		db.close();
		openCodeDb.close();
		closeDatabase();
	}
}

await main();
