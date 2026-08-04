import type { PerfRunReport } from "./run";

export function printGrowthTable(label: string, report: PerfRunReport): void {
	console.log(
		`\n${label}: ${report.fixture} (${formatBytes(report.fixtureBytes)})`,
	);
	console.table(
		report.passes.map((pass) => ({
			pass: pass.pass,
			requested: pass.requestedMessages,
			input: pass.inputMessages,
			output: pass.outputMessages,
			total_ms: round(pass.phases.total),
			tag_ms: round(
				pass.phases.tagIdentity + pass.phases.tagPrefix + pass.phases.targets,
			),
			token_ms: round(pass.phases.tokenCountingBackfill),
			db_ms: round(pass.phases.dbIo),
			serialize_ms: round(pass.serializationMs ?? 0),
			deferred_db_ops: pass.deferredDb?.operations ?? 0,
			tags: pass.tagRows,
		})),
	);
}

export function printLargestPhaseTable(
	label: string,
	report: PerfRunReport,
): void {
	const largest = report.passes.at(-1);
	if (!largest) return;
	console.log(
		`\n${label} phase breakdown at ${largest.inputMessages} input messages:`,
	);
	console.table(
		Object.entries(largest.phases).map(([phase, elapsedMs]) => ({
			phase,
			ms: round(elapsedMs),
		})),
	);
	const coverage =
		largest.phases.total > 0
			? (largest.phases.accounted / largest.phases.total) * 100
			: 100;
	console.log(
		`Top-level stages account for ${round(coverage)}% of transform wall time. ` +
			`DB I/O is cross-cutting: ${largest.db.operations} operations ` +
			`(${largest.db.reads} reads, ${largest.db.writes} writes). ` +
			`Serialization took ${round(largest.serializationMs ?? 0)}ms; the 150ms drain observed ` +
			`${largest.deferredDb?.operations ?? 0} deferred DB operations.`,
	);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function round(value: number): number {
	return Number(value.toFixed(2));
}
