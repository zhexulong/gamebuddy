import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { setSessionWorkMetrics } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { showStatusDialog } from "./status-dialog";

describe("Pi status dialog", () => {
	it("renders stored work metrics", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-work";
			setSessionWorkMetrics(db, sessionId, 1200, 9800);
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
				getSystemPrompt: () => "system prompt",
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Work tokens 1.2K new · 9.8K total input");
		} finally {
			closeQuietly(db);
		}
	});
});
