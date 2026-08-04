import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";
import { registerMagicContextTools } from "./index";

describe("registerMagicContextTools", () => {
	it("can omit ctx_memory for retrieval-only sidekick subagents", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => {
					registered.push(tool.name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as never;

			registerMagicContextTools(pi, {
				db,
				memoryToolEnabled: false,
				sessionScopedToolsDisabled: true,
				todowriteCommandEnabled: false,
			});

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("ctx_memory");
			expect(registered).not.toContain("ctx_note");
			expect(registered).not.toContain("ctx_expand");
			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("advertises only real ctx_* fields and allows additional properties", () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}) => registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, { db });

			const expectedFields: Record<string, string[]> = {
				ctx_search: ["query", "limit", "sources"],
				ctx_memory: ["action", "content", "category", "ids", "limit", "reason"],
				ctx_note: [
					"action",
					"content",
					"surface_condition",
					"note_id",
					"filter",
					"limit",
					"offset",
				],
				ctx_expand: ["start", "end", "verbose", "message"],
				ctx_reduce: ["drop"],
			};
			for (const [name, fields] of Object.entries(expectedFields)) {
				const definition = registered.get(name);
				expect(definition).toBeDefined();
				expect(
					Object.keys(definition?.parameters.properties ?? {}).sort(),
				).toEqual([...fields].sort());
				expect(definition?.parameters.properties).not.toHaveProperty("reduced");
				expect(definition?.parameters.properties).not.toHaveProperty("summary");
				expect(definition?.parameters.additionalProperties).toBe(true);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("registered tools resolve smart-note gating from the invocation cwd", async () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{ execute: (...args: never[]) => unknown }
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					execute: (...args: never[]) => unknown;
				}) => {
					registered.set(tool.name, tool);
				},
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, {
				db,
				dreamerEnabled: false,
				resolveDreamerEnabled: (ctx) => ctx.cwd === "/tmp/project-b",
			});

			const noteTool = registered.get("ctx_note");
			expect(noteTool).toBeDefined();
			const result = await noteTool?.execute(
				"call-1" as never,
				{
					action: "write",
					content: "Project B smart note",
					surface_condition: "When project B condition is true",
				} as never,
				new AbortController().signal as never,
				undefined as never,
				{
					cwd: "/tmp/project-b",
					sessionManager: { getSessionId: () => "ses-tool-cd" },
				} as never,
			);

			expect(
				(result as { isError?: boolean } | undefined)?.isError,
			).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("registers todowrite and /todos by default", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db });

			expect(registered).toContain("todowrite");
			expect(commands).toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("omits todowrite and /todos when todowrite is disabled", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteEnabled: false });

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("can keep /todos off for lean subagent entries", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteCommandEnabled: false });

			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});
});
