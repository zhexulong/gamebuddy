---
title: Session modes
description: The effective Magic Context modes — primary sessions, subagents, and compaction-off mode.
---

Magic Context has three effective runtime surfaces: **primary sessions**, **subagents**, and **compaction-off mode**. Primary sessions and subagents use the normal context-management pipeline with different feature sets. Compaction-off mode keeps the knowledge layer but does not manage the context window. The agent-facing reduce surface (`ctx_reduce`, `§N§` prefixes, and reduce nudges) is gated by both the session mode and the session's actual tool availability.

## The modes

### Primary session

The full surface. Your agent gets the historian, compartments, memory/search/note guidance, prompt adjuncts, synthetic-todowrite, auto-search hints, and automatic safety valves. When `ctx_reduce` is available in the agent's tool set, it also sees `§N§` tags and receives nudges to reduce spent tool outputs as pressure builds.

This is the recommended mode for most users. The agent actively managing spent tool outputs usually beats fully automatic cleanup because the agent knows which results it has already used.

To hide the reduce surface for a particular agent, remove or deny `ctx_reduce` in that agent's tool allow-list. The rest of Magic Context keeps running: historian compression, heuristic cleanup, compartments, memory, and search still work.

Caveman text compression (`caveman_text_compression.enabled`) is an orthogonal opt-in for primary sessions. It can run whether or not `ctx_reduce` is available, and it only rewrites old user/assistant prose; dropped tags still win.

### Subagent

Subagent sessions (council members, historian, sidekick, dreamer child sessions) get a lightweight pass:

- Tagging and heuristic cleanup run normally
- No historian, no compartment injection, no prompt-adjunct blocks (`<project-docs>`, `<user-profile>`)
- No deferred-note nudges
- Heuristic drops run on **every** execute pass (not once-per-turn like primary sessions — subagents are effectively one parent turn)
- Overflow is handled via the overflow detection path without emergency-recovery state
- No caveman text compression

Subagents are driven by a parent agent, have bounded lifetimes, and often run in parallel. Turning on the full feature set in each subagent would create redundant work and per-agent cache churn.

### Compaction-off mode

Set `compaction.enabled: false` in the user-level `magic-context.jsonc` and restart the harness. Memory, docs, user-profile, key-file, notes, search, expand, and raw-message indexing stay live through additive injection. The transform remains registered, but Magic Context stops managing context: it creates no new tags or compartments, writes no MC markers, performs no folds, drops, strips, splices, heuristic or emergency reclaim, synthetic context-management injection, temporal markers, nudges, or blocking. `ctx_reduce` is unavailable; `ctx_expand` remains available. The harness's native compaction may run, but this setting does not enable it. `fail_closed_blocking` is inert: a failed transform passes input messages through.

The first turn after disabling may trigger one native compaction cycle on a long session. Only history hidden solely by Magic Context is exposed; a surviving native boundary remains authoritative, and Magic Context does not pre-trim the history. Marker cleanup is lazy per session, so an unresumed session is cleaned when it is next resumed. When switching back to compaction on, run `/ctx-wrapup` if the historian is runnable. OpenCode peer verification against v1.18.4 confirms that native compaction covers child sessions: subagents are managed by native compaction like any session, while Magic Context provides additive memory/docs injection and no reclaim. Keep subagent tasks small or leave compaction on for projects that rely on long subagent runs.

Magic Context's `compaction.enabled` in `magic-context.jsonc` is separate from OpenCode's `compaction.auto` and `compaction.prune` in `opencode.jsonc`; they are different files and different owners. The coexistence contract covers OpenCode and Pi native compaction only. DCP and OMO keep their existing conflict policy. If `transform_mode: "rust"` is also configured, compaction-off mode selects the TypeScript transform and emits one frozen boot warning because Rust has no reduced-mode contract yet. The no-manager combination (native compaction disabled too) is allowed; Magic Context reports it rather than enabling native compaction. The sidebar shows raw usage with either `native compaction` or `no active compaction`, not an MC execute-threshold percentage.

## Feature comparison

| Feature | Primary session | Subagent | Compaction-off |
|---------|:---:|:---:|:---:|
| Tag tracking | ✓ | ✓ | existing rows inert; no new rows |
| `§N§` tags in message text | when `ctx_reduce` is available | when `ctx_reduce` is available | |
| `ctx_reduce` tool | tool allow-list controlled | tool allow-list controlled | |
| `ctx_expand` tool | ✓ | ✓ | ✓ |
| Historian and compartments | ✓ | | |
| `<session-history>` injection | ✓ | | |
| `<project-docs>`, `<user-profile>` | ✓ | | additive m[0]/m[1] injection |
| Channel 1 nudge (tool-output reminder) | when `ctx_reduce` is available | when `ctx_reduce` is available | |
| Channel 2 ceiling nudge | when `ctx_reduce` is available | when `ctx_reduce` is available | |
| Deferred-note nudges | ✓ | | |
| Synthetic-todowrite injection | ✓ | | |
| Auto-search hints | ✓ | | ✓ |
| Heuristic drops at execute threshold | ✓ | ✓ | |
| 85% emergency drop | ✓ | | |
| 95% block and recovery | ✓ | | |
| Caveman text compression | opt-in | | |

## How it connects

Session modes are a lens on the full [context pipeline](/concepts/overview/). Primary sessions get the [context reduction](/concepts/context-reduction/) surface when `ctx_reduce` is available, plus the [historian](/concepts/historian/) and heuristic cleanup. Both modes benefit from cache-safe tagging and the [cache architecture](/concepts/cache-architecture/).
