import { afterEach, describe, expect, it, spyOn } from "bun:test";

import * as loggerModule from "@magic-context/core/shared/logger";

import { __test } from "./index";

afterEach(() => {
	__test.resetLoggedPiConfigDirs();
});

describe("embedded runtime authoring surface", () => {
	it("disables every CLI-backed authoring command path", () => {
		const prior = process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
		process.env.GAMEBUDDY_EMBEDDED_RUNTIME = "1";
		try {
			expect(__test.embeddedRuntimeDisablesCliAuthoringCommands()).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
			else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = prior;
		}
	});

	it("keeps CLI command registration available outside GameBuddy embedded mode", () => {
		const prior = process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
		delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
		try {
			expect(__test.embeddedRuntimeDisablesCliAuthoringCommands()).toBe(false);
		} finally {
			if (prior === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
			else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = prior;
		}
	});
});

describe("Pi config load logging", () => {
	it("dedupes /cd config warnings per directory", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-b",
				loadedFromPaths: [],
				warnings: ["Ignoring execute_threshold_percentage from project config"],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.filter((message) => message.includes("config loaded from:")),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"config: no magic-context.jsonc found, using schema defaults",
					),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes("Ignoring historian.model from project config"),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"Ignoring execute_threshold_percentage from project config",
					),
				),
			).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});
});
