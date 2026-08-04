/**
 * Pi-side tool registration.
 *
 * Registers `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, and
 * `ctx_reduce` against the live Pi extension API. The shared guidance block
 * in `system-prompt.ts` advertises these to the LLM only when each is
 * available, so a registration gap surfaces as "tool not found" errors when
 * the agent tries to follow the guidance.
 *
 * `ctx_reduce` is part of the primary session-scoped surface. It is omitted
 * only for `--no-session` child processes where session-scoped tools would
 * resolve to the hidden ephemeral child session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { registerTodosCommand } from "./todo-view-pi";
import { createTodowriteTool } from "./todowrite";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	/** When true, ctx_memory exposes dreamer-only actions (update, merge, archive).
	 *  Set by the subagent extension entry when the parent passes
	 *  `--magic-context-dreamer-actions`. The main extension entry
	 *  (./index.ts) leaves this false to match OpenCode's primary-agent surface. */
	allowDreamerActions?: boolean;
	/** Number of recent tags that ctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number;
	/** Resolve protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	/** When true, ctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean;
	/** Resolve smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	/** When false, omit ctx_memory from the registered surface. Sidekick only
	 *  needs read-only ctx_search; dreamer and the main agent keep ctx_memory. */
	memoryToolEnabled?: boolean;
	/** When true, omit session-scoped tools (ctx_note, ctx_expand) from the
	 *  registered surface. Set by `--no-session` children (sidekick, dreamer):
	 *  those tools resolve `ctx.sessionManager.getSessionId()` to the EPHEMERAL
	 *  child session, so ctx_note would write notes orphaned under the hidden
	 *  child id and ctx_expand would expand the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean;
	/** When false, omit Magic Context's Pi todowrite tool entirely. */
	todowriteEnabled?: boolean;
	/** Main Pi entry registers /todos; lean subagent entries keep commands off. */
	todowriteCommandEnabled?: boolean;
}

export function registerMagicContextTools(
	pi: ExtensionAPI,
	opts: RegisterToolsOptions,
): void {
	pi.registerTool(
		createCtxSearchTool({
			db: opts.db,
			ensureProjectRegistered: opts.ensureProjectRegistered,
			memoryEnabled: opts.memoryEnabled,
			embeddingEnabled: opts.embeddingEnabled,
			gitCommitsEnabled: opts.gitCommitsEnabled,
		}),
	);

	if (opts.memoryToolEnabled !== false) {
		pi.registerTool(
			createCtxMemoryTool({
				db: opts.db,
				ensureProjectRegistered: opts.ensureProjectRegistered,
				memoryEnabled: opts.memoryEnabled,
				embeddingEnabled: opts.embeddingEnabled,
				allowDreamerActions: opts.allowDreamerActions ?? false,
			}),
		);
	}

	// ctx_note and ctx_expand are session-scoped: they resolve the CURRENT
	// session id at call time. For `--no-session` children that id is the hidden
	// ephemeral child session, so a note would be orphaned and an expand would
	// target the child's empty transcript. Omit them for those children; ctx_search
	// stays available and ctx_memory is controlled above.
	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(
			createCtxNoteTool({
				db: opts.db,
				dreamerEnabled: opts.dreamerEnabled ?? false,
				resolveDreamerEnabled: opts.resolveDreamerEnabled,
			}),
		);

		pi.registerTool(createCtxExpandTool({ db: opts.db }));
	}

	if (opts.todowriteEnabled !== false) {
		// `todowrite` parity with OpenCode. Pi-coding-agent has no built-in
		// task list tool, so without this the synthetic-todowrite injector
		// would never have anything to surface. The tool just captures the
		// `todos` arg and echoes a pretty-printed JSON ack; `message_end`
		// in index.ts snapshots `params.todos` into `session_meta.last_todo_state`
		// for downstream synthesis. See `tools/todowrite.ts` header for rationale.
		pi.registerTool(createTodowriteTool());
		if (opts.todowriteCommandEnabled !== false) {
			registerTodosCommand(pi);
		}
	}

	// ctx_reduce is session-scoped just like ctx_note/ctx_expand: it resolves the
	// CURRENT session id at call time. Omit it for `--no-session` children where
	// that id points at a hidden ephemeral child session.
	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(
			createCtxReduceTool({
				db: opts.db,
				protectedTags: opts.protectedTags ?? 20,
				resolveProtectedTags: opts.resolveProtectedTags,
			}),
		);
	}
}
