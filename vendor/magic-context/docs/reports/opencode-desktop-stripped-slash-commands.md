# OpenCode Desktop stripped-command interception report

Date: 2026-08-29

## Outcome

The OpenCode plugin now recognizes the exact single-text-part shape produced when Desktop removes the slash from a registered Magic Context command. A recognized prompt is routed through the existing `command.execute.before` handler, including its existing argument parsers, TUI dialogs, Desktop ignored-chat fallback, and 204 suppression sentinel. The stripped prompt itself is never saved and never starts an LLM completion.

Detection is case-sensitive and single-line. It requires the entire trimmed text to be one registered Magic Context command plus only arguments that command accepts. Attachments, multiple parts, ignored or synthetic parts, prose, partial names, multiline text, slash-prefixed commands, and invalid trailing arguments pass through unchanged.

## Registry and argument source of truth

`getMagicContextBuiltinCommands()` retains literal command keys while satisfying OpenCode's command config type, and exports the resulting key union. Detection checks membership against a fresh result from that same registry; there is no copied detection list.

Command-specific argument validators are exhaustively typed against that registry key union. They reuse the handler's existing parsers for recomp ranges and wrapup counts, the canonical dream-task predicate, and the handler's existing embed/augmentation semantics. The accepted stripped forms are:

- `ctx-status`, `ctx-flush`, `ctx-session-upgrade` with no arguments;
- `ctx-recomp` with no argument, `--upgrade`, or a valid inclusive range;
- `ctx-wrapup` with no argument or one positive safe integer;
- `ctx-aug` with a non-empty free-text prompt;
- `ctx-dream` with no argument or one canonical task name;
- `ctx-embed` with no argument, `start`, or `pause` using the handler's case-insensitive subcommand parsing.

After detection, the argument substring is passed to `createMagicContextCommandHandler` unchanged apart from outer whitespace trimming. Execution therefore uses the same parsing and behavior as native slash dispatch.

## Seam choice and suppression adjudication

The interception seam is OpenCode's `chat.message` hook. In OpenCode 1.17.11, `SessionPrompt.createUserMessage` resolves parts, awaits `plugin.trigger("chat.message", ...)`, and only then calls `sessions.updateMessage` and `sessions.updatePart`. The plugin now forwards the hook's output parts into Magic Context, where the conservative detector runs before ordinary chat-message bookkeeping.

A match invokes the same command-handler object used by `command.execute.before`. Every handled path ends by throwing the existing Effect-compatible empty HTTP response with status 204. At this earlier hook seam, that response aborts `createUserMessage` before persistence and aborts the surrounding prompt request before `runLoop`. Consequently:

- the slashless command input creates no user row;
- no LLM completion can answer the bare text;
- no `session_meta` sticky state or transcript replacement is needed;
- no message-ID ordering heuristic is involved;
- no schema, persistence, or authority fence moved.

Persisting the command as an ignored/noReply replacement was rejected. `ignored: true` hides text from the provider but still creates a user chronology row, while `noReply: true` only prevents that new call from starting a loop. That design would re-enter the known lexicographic-latest hazard and would require active-run chronology management. Likewise, issuing a second `promptAsync` solely to suppress the first prompt was rejected because it would introduce the known stale-chronology/lease hazard.

Command output still follows the established path. A connected TUI receives the existing dialog action. Desktop/headless receives the existing `sendIgnoredMessage` fallback: a `noReply: true`, `ignored: true` text part, guarded by the existing DB-backed mid-turn checks and queue. This output row is the intentional user-visible result, not a replacement for the command input. Provider serialization excludes it, Magic Context's nudge/token walks skip ignored parts, and the three-pass quiet invariant confirms its transformed representation is byte-stable.

## Pi scope verification

Pi is unaffected. Its commands are registered natively with `pi.registerCommand(...)`, including `ctx-flush` in `packages/pi-plugin/src/commands/ctx-flush.ts`, `ctx-dream` in `packages/pi-plugin/src/commands/ctx-dream.ts`, and `ctx-embed` in `packages/pi-plugin/src/commands/ctx-embed.ts`. Pi receives handler arguments directly and does not use OpenCode's `chat.message` or `command.execute.before` surfaces. No Pi source changed.

## Regression and mutation evidence

Focused coverage proves bare `ctx-status` interception invokes the shared handler, emits the Desktop ignored/noReply fallback, and prevents the simulated LLM continuation. It also covers accepted `ctx-wrapup 2` and canonical dream-task arguments, rejects unsupported status prose and prose containing a command name, rejects multiline/partial/case-changed/attachment forms, preserves native slash dispatch, and holds ignored command output stable over three quiet defer passes.

Executed mutations used the exact `NON-VACUITY BREAK` marker and were restored immediately after each red run:

| Deliberate mutation | Command | Observed red evidence |
| --- | --- | --- |
| Disabled every single-part stripped-command match | `bun test src/hooks/magic-context/stripped-command.test.ts src/hooks/magic-context/hook.test.ts -t "matches a bare registered command\|intercepts a Desktop slashless status command" --timeout 30000` | `hook.test.ts:406` observed one simulated LLM completion instead of zero; `stripped-command.test.ts:10` received `null` instead of `ctx-status`. |
| Bypassed command-specific argument validation | `bun test src/hooks/magic-context/stripped-command.test.ts src/hooks/magic-context/hook-handlers.test.ts -t "does not match unsupported trailing prose\|does not route trailing or surrounding prose" --timeout 30000` | `stripped-command.test.ts:30` accepted `ctx-status extra prose sentence`; `hook-handlers.test.ts:457` observed one handler call instead of zero. |
| Rejected the valid wrapup argument in the exhaustive validator | `bun test src/hooks/magic-context/stripped-command.test.ts src/hooks/magic-context/hook-handlers.test.ts -t "matches accepted arguments and preserves the native handler input\|routes accepted wrapup arguments through the native command handler" --timeout 30000` | `stripped-command.test.ts:17` received `null`; `hook-handlers.test.ts:435` observed zero handler calls instead of one. |
| Changed exact matching to accept any text containing `ctx-status` | `bun test src/hooks/magic-context/stripped-command.test.ts -t "does not match prose containing a command name" --timeout 30000` | `stripped-command.test.ts:38` accepted the mid-sentence command name. |
| Short-circuited the native slash adapter | `bun test src/hooks/magic-context/hook-handlers.test.ts -t "leaves native slash dispatch on the same handler adapter" --timeout 30000` | `hook-handlers.test.ts:481` observed that the shared handler was not called. |
| Added random per-pass bytes to transformed ignored text | `bun test src/hooks/magic-context/transform-cache-busting-signals.test.ts -t "keeps ignored Desktop command output byte-stable across three quiet passes" --timeout 30000` | `transform-cache-busting-signals.test.ts:554` reported different ignored status bytes between quiet passes. |

No `NON-VACUITY BREAK` mutation remains in source or tests.

## Verification

- Frozen workspace dependency install: `bun install --frozen-lockfile` — passed.
- Focused interception, hook, native-command, and quiet-pass suite — 75 passed, 0 failed.
- Plugin TypeScript gate: `bun run typecheck` — passed.
- Full plugin suite: `bun run test` — 4,196 passed, 0 failed across 380 files.
- Changed-file Biome check: nine task TypeScript files passed. `hook.ts` still reports a pre-existing formatter-only indentation difference at lines 913-918; the task's one-line wiring change is outside that region.
