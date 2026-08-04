import { describe, expect, it } from "bun:test";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	resolveDreamerFromConfig,
	resolveHistorianFromConfig,
	resolveSidekickFromConfig,
} from "./index";

describe("Pi config resolvers", () => {
	it("returns undefined for historian, dreamer, and sidekick when disabled", () => {
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true, model: "test/historian" },
			dreamer: { disable: true, model: "test/dreamer" },
			sidekick: { disable: true, model: "test/sidekick" },
		});

		expect(resolveHistorianFromConfig(config)).toBeUndefined();
		expect(resolveDreamerFromConfig(config)).toBeUndefined();
		expect(resolveSidekickFromConfig(config)).toBeUndefined();
	});
});
