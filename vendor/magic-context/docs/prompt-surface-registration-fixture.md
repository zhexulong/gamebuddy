# Prompt-surface registration lifecycle fixture

This fixture records the existing registration boundaries that later prompt-surface slices must preserve. It is intentionally descriptive: this slice does not change guidance text, tool registration, or runtime consumers.

| Harness | Registration boundary | Source citation | Contract captured |
|---|---|---|---|
| OpenCode | `createToolRegistry` builds the `ctx_*` definitions and normalizes parameter schemas before returning them | [`packages/plugin/src/plugin/tool-registry.ts:51-171`](../packages/plugin/src/plugin/tool-registry.ts#L51-L171) | Tool IDs and parameter schemas remain registration-owned; prompt-surface overrides must not mutate schemas |
| Pi | `registerMagicContextTools` registers the Pi tool set from the shared config/runtime | [`packages/pi-plugin/src/tools/index.ts:69-144`](../packages/pi-plugin/src/tools/index.ts#L69-L144) | Pi consumes the same tool-surface contract without changing registration in the preset slice |
| Pi boot | `startPiMagicContextRuntime` resolves config and starts the runtime that owns Pi prompt/system handling | [`packages/pi-plugin/src/index.ts:839-2317`](../packages/pi-plugin/src/index.ts#L839-L2317) | Config routing is available at the harness boundary; no prompt-surface behavior is consumed yet |

The byte-level guidance and tool-description baseline is captured in [`packages/plugin/src/shared/prompt-surface-a1-golden.md`](../packages/plugin/src/shared/prompt-surface-a1-golden.md). It was generated from the current source surface on 2026-08-08 and includes the deterministic system-prompt hash baseline.
