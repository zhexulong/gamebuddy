import { afterEach, describe, expect, test } from "bun:test";
import { setOutputReserveConfig } from "@magic-context/core/shared/models-dev-cache";
import { resolvePiUsableContextLimit } from "./pi-context-limit";

describe("resolvePiUsableContextLimit", () => {
	afterEach(() => setOutputReserveConfig(undefined));

	test("honors the reporter's default output_reserve instead of the 25% fallback", () => {
		setOutputReserveConfig({ default: 16_384 });
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 272_000,
				model: {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					contextWindow: 272_000,
					maxTokens: 128_000,
				},
				persistedInputTokens: 139_400,
				persistedPercentage: (139_400 / 204_000) * 100,
			}),
		).toBe(272_000 - 16_384);
	});

	test("reserves Pi model maxTokens on shared-window providers", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 122_880,
				model: {
					provider: "openai",
					id: "reporter-model",
					contextWindow: 122_880,
					maxTokens: 16_384,
				},
			}),
		).toBe(106_496);
	});

	test("keeps Google Antigravity's separate output quota unchanged", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 1_048_576,
				model: {
					provider: "google-antigravity",
					id: "gemini-2.5-pro",
					maxTokens: 65_536,
				},
			}),
		).toBe(1_048_576);
	});

	test("applies detected wire truth before output reservation", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 200_000,
				detectedContextLimit: 120_000,
				model: { provider: "anthropic", id: "claude", maxTokens: 20_000 },
			}),
		).toBe(100_000);
	});
});
