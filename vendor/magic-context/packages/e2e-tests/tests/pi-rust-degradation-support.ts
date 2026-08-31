import { readFileSync } from "node:fs";
import { join } from "node:path";

export const E2E_ROOT = join(import.meta.dir, "..");
export const REPO_ROOT = join(E2E_ROOT, "..", "..");

export interface DrillMutationRecord {
	id: string;
	mutation: string;
	must_fail: string;
	failure_signal: string;
	applied_diff_summary: string;
	observed_failure: { exit_status: number; assertion_output: string };
	reverted_rerun: string;
}

export interface DrillArtifact {
	schema: number;
	drill_id: string;
	lineage_key: string;
	both_halves: Array<{ test_id: string; half: string; assertion: string }>;
	mutation_records: DrillMutationRecord[];
}

export function readArtifact(path: string): DrillArtifact {
	return JSON.parse(
		readFileSync(join(E2E_ROOT, path), "utf8"),
	) as DrillArtifact;
}

export function readRepositorySource(path: string): string {
	return readFileSync(join(REPO_ROOT, path), "utf8");
}

export function messagesOnly(body: { messages?: unknown }): unknown[] {
	if (!Array.isArray(body.messages)) {
		throw new Error("provider assertion requires a messages[] array");
	}
	return body.messages;
}

export function textInMessages(messages: readonly unknown[]): string {
	return JSON.stringify(messages);
}

export function assertExternalProviderIsNotSupervised(
	lineageKey: string,
): void {
	const configured = (process.env.MC_PI_SUPERVISED_MODULES ?? "")
		.split(",")
		.map((moduleId) => moduleId.trim())
		.filter(Boolean);
	if (configured.includes("magic-context")) {
		throw new Error(
			`${lineageKey}: magic-context is supervised; the outage drill requires an external provider with no supervisor restart`,
		);
	}
}

export function assertMutationDiscipline(
	artifact: DrillArtifact,
	expectedTestIds: readonly string[],
): void {
	if (artifact.schema !== 1)
		throw new Error(`${artifact.drill_id}: mutation schema is not 1`);
	if (artifact.lineage_key !== "session_id") {
		throw new Error(
			`${artifact.drill_id}: assertions must be keyed by session_id`,
		);
	}
	const actualTestIds = artifact.both_halves.map((half) => half.test_id).sort();
	if (
		JSON.stringify(actualTestIds) !==
		JSON.stringify([...expectedTestIds].sort())
	) {
		throw new Error(`${artifact.drill_id}: both-halves test IDs drifted`);
	}
	if (artifact.both_halves.some((half) => half.assertion.trim().length === 0)) {
		throw new Error(`${artifact.drill_id}: every half needs an assertion`);
	}
	if (artifact.mutation_records.length !== 2) {
		throw new Error(
			`${artifact.drill_id}: expected rung-swap and rung-deletion records`,
		);
	}
	const mutationIds = artifact.mutation_records
		.map((record) => record.id)
		.sort();
	if (!mutationIds.some((id) => id.includes("MUTATE-RUNG-SWAP"))) {
		throw new Error(
			`${artifact.drill_id}: rung-swap mutation record is missing`,
		);
	}
	if (!mutationIds.some((id) => id.includes("MUTATE-RUNG-DELETION"))) {
		throw new Error(
			`${artifact.drill_id}: rung-deletion mutation record is missing`,
		);
	}
	for (const record of artifact.mutation_records) {
		if (!expectedTestIds.includes(record.must_fail)) {
			throw new Error(
				`${artifact.drill_id}: mutation ${record.id} has no selected test`,
			);
		}
		if (
			record.applied_diff_summary.trim().length === 0 ||
			record.observed_failure.exit_status !== 1 ||
			record.observed_failure.assertion_output.trim().length === 0 ||
			record.reverted_rerun !== "pass"
		) {
			throw new Error(
				`${artifact.drill_id}: mutation ${record.id} lacks applied, red, or reverted evidence`,
			);
		}
	}
}

export function assertTraceBranch(
	trace: { branches: Array<Record<string, unknown>> },
	id: string,
	sourcePath: string,
	sourceNeedle: string,
): void {
	const branch = trace.branches.find((candidate) => candidate.id === id);
	if (!branch) throw new Error(`trace branch ${id} is missing`);
	if (branch.source_location && typeof branch.source_location === "object") {
		const source = branch.source_location as { path?: unknown };
		if (source.path !== sourcePath) {
			throw new Error(`${id}: source path drifted from ${sourcePath}`);
		}
	}
	const source = readRepositorySource(sourcePath);
	if (!source.includes(sourceNeedle)) {
		throw new Error(`${id}: source no longer contains ${sourceNeedle}`);
	}
}

export function createFakePi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	return {
		pi: {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
		},
		async emit(event: string, ...args: unknown[]): Promise<unknown> {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(...args);
			}
			return result;
		},
	};
}
