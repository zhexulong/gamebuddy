import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { isDreamerRunnable } from "../config/agent-disable";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { CTX_MEMORY_ACTIONS, createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { createCtxSearchTools } from "../tools/ctx-search";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { RustToolBackends } from "./rust-tool-backends";
import type { PluginContext } from "./types";

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    rustToolBackends?: RustToolBackends;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig, rustToolBackends } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    // Storage failure (binary ABI mismatch, unwritable path, etc.) must
    // disable Magic Context cleanly instead of silently degrading. We never
    // expose ctx_* tools when storage isn't healthy — see openDatabase()
    // for the reasoning.
    let db: Database;
    try {
        const opened = openDatabase();
        // openDatabase returns null on the schema-fence path (DB newer than this
        // binary) and throws on a fatal open error — handle both as "storage
        // unavailable, disable tools cleanly".
        if (!opened || !isDatabasePersisted(opened)) {
            const reason = getDatabasePersistenceError(opened);
            console.warn(
                `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
            );
            return {};
        }
        db = opened;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }

    // Fire-and-forget: registration failure (including a database handle that
    // closed during process teardown) must never surface as an unhandled
    // rejection from plugin init. The next boot or embed path re-registers.
    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db).catch((error) => {
        log(`[magic-context] embedding registration skipped: ${getErrorMessage(error)}`);
    });

    // Tools resolve project per-call from `toolContext.directory` because
    // OpenCode's top-level `ctx.directory` reflects the launch dir, not the
    // session's actual working directory (e.g. when launched via
    // `opencode -s <id>` from outside the project).
    const resolveProjectPath = (directory: string) => resolveProjectIdentityForSession(directory);

    // When memory is off the <project-memory> block is never injected, so an
    // agent's memory writes would never resurface. Omit ctx_memory entirely
    // (the matching guidance is gated in buildMagicContextSection). ctx_search
    // stays: it still recalls conversation + git commits, just not memories.
    const memoryEnabled = pluginConfig.memory?.enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        ...createCtxReduceTools({
            db,
            protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
            rustToolBackends,
        }),
        ...createCtxExpandTools({ db }),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: isDreamerRunnable(pluginConfig),
            resolveProjectPath,
            rustToolBackends,
        }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
        ...(memoryEnabled
            ? createCtxMemoryTools({
                  db,
                  resolveProjectPath,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                  // Primary agents get the full mutation surface (write/archive/
                  // update/merge) on memories they can already see (with ids) in
                  // the injected <project-memory> block. Only `list` (bulk
                  // enumeration) stays dreamer-only (runtime-gated via
                  // toolContext.agent in tools.ts).
                  allowedActions: [...CTX_MEMORY_ACTIONS],
                  rustToolBackends,
              })
            : {}),
    };

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(allTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return allTools;
}
