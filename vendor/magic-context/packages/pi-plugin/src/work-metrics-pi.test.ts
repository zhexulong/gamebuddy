import { describe, expect, test } from "bun:test";
import { computePiWorkMetrics } from "@magic-context/core/features/magic-context/work-metrics";

describe("Pi work metrics", () => {
	test("computes delta new work and phase peak total input", () => {
		expect(
			computePiWorkMetrics([
				{
					role: "assistant",
					usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
				},
				{
					role: "assistant",
					usage: { input: 250, output: 2, cacheRead: 0, cacheWrite: 0 },
				},
				{
					role: "assistant",
					usage: { input: 90, output: 3, cacheRead: 0, cacheWrite: 0 },
				},
				{
					role: "assistant",
					usage: { input: 120, output: 4, cacheRead: 10, cacheWrite: 0 },
				},
			]),
		).toEqual({ newWorkTokens: 294, totalInputTokens: 380 });
	});
});
