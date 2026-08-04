#!/usr/bin/env bun
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { printGrowthTable, printLargestPhaseTable } from "./reporting";
import type { PerfRunReport } from "./run";

interface Options {
	fixture?: string;
	fixturesDir: string;
	all: boolean;
	synthetic: boolean;
	messages: number;
	step: number;
	points?: string;
	repeatFinal: number;
	lane: string;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const fixtures = selectFixtures(options);
	for (const fixture of fixtures) {
		const report = await runHarness(options, fixture);
		printGrowthTable(`transform:${report.lane}`, report);
		printLargestPhaseTable(`transform:${report.lane}`, report);
	}
}

function selectFixtures(options: Options): Array<string | undefined> {
	if (options.synthetic) return [undefined];
	if (options.fixture) return [resolve(options.fixture)];
	const candidates = listJsonl(options.fixturesDir).sort(
		(left, right) => statSync(right).size - statSync(left).size,
	);
	if (candidates.length === 0) {
		console.warn(
			`No JSONL fixtures under ${options.fixturesDir}; using the synthetic corpus.`,
		);
		return [undefined];
	}
	return options.all ? candidates : [candidates[0]];
}

async function runHarness(
	options: Options,
	fixture: string | undefined,
): Promise<PerfRunReport> {
	const outputDir = mkdtempSync(join(tmpdir(), "mc-pi-perf-report-"));
	const output = join(outputDir, "report.json");
	const args = [
		process.execPath,
		join(import.meta.dir, "run.ts"),
		"--messages",
		String(options.messages),
		"--step",
		String(options.step),
		"--output",
		output,
		"--lane",
		options.lane,
	];
	if (fixture) args.push("--fixture", fixture);
	if (options.points) args.push("--points", options.points);
	if (options.repeatFinal > 0) {
		args.push("--repeat-final", String(options.repeatFinal));
	}
	try {
		const child = Bun.spawn(args, {
			cwd: resolve(import.meta.dir, "../../.."),
			stdout: "inherit",
			stderr: "inherit",
			env: { ...process.env, NODE_ENV: "test" },
		});
		const exitCode = await child.exited;
		if (exitCode !== 0)
			throw new Error(`perf runner exited with status ${exitCode}`);
		return await Bun.file(output).json();
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
}

function listJsonl(directory: string): string[] {
	const output: string[] = [];
	const pending = [resolve(directory)];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl"))
				output.push(path);
		}
	}
	return output;
}

function parseOptions(args: readonly string[]): Options {
	const options: Options = {
		fixturesDir:
			process.env.MC_PI_PERF_FIXTURES ??
			join(homedir(), ".pi", "agent", "sessions"),
		all: false,
		synthetic: false,
		messages: 1_000,
		step: 500,
		repeatFinal: 0,
		lane: "default",
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--fixture" && value) {
			options.fixture = value;
			index += 1;
		} else if (arg === "--fixtures-dir" && value) {
			options.fixturesDir = value;
			index += 1;
		} else if (arg === "--messages" && value) {
			options.messages = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--step" && value) {
			options.step = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--points" && value) {
			options.points = value;
			index += 1;
		} else if (arg === "--repeat-final" && value) {
			options.repeatFinal = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--lane" && value) {
			options.lane = value;
			index += 1;
		} else if (arg === "--all") {
			options.all = true;
		} else if (arg === "--synthetic") {
			options.synthetic = true;
		} else {
			throw new Error(`Unknown or incomplete argument: ${arg ?? "<missing>"}`);
		}
	}
	return options;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive integer, got ${value}`);
	}
	return parsed;
}

await main();
