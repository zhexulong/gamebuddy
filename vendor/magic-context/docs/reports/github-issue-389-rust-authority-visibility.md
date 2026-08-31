# GitHub issue #389 — Rust authority visibility

Date: 2026-08-29

## Finding and scope

`transform_mode: "rust"` changes more than the transform implementation. After authority reaches `MODULE`, the host routes `ctx_memory` and `ctx_note` to the module, and historian orchestration is module-side. Host-only attachments on those paths can therefore stop observing work without an error.

This change implements the report's two cheap visibility arms only:

1. The host declares an authority transition once per project transition.
2. `/ctx-status` identifies the host paths that are module-routed in Rust mode.

It does not add an attachment-registration API or otherwise move an authority fence.

## Transition declaration

`context-authority.ts` now keeps process-local last-observed routing ownership per project. It emits one line when the host observes module ownership, including a first `MODULE` observation after process startup, and does not repeat it on later passes. It emits the matching return line when a completed drain restores TypeScript ownership.

Examples:

```text
[magic-context] project git:example authority → MODULE: host backends → MODULE: ctx_memory, ctx_note; historian: module-side
[magic-context] project git:example authority → TS: host backends → TypeScript: ctx_memory, ctx_note; historian: host-side
```

The Rust authority adapter observes the settled two-domain result after preparation/reconciliation. The TypeScript drain path records an already-active module owner before draining, then records `TS` only after the shared marker has gone away. This covers an ordinary flip, a cold host finding `MODULE`, and a cold TypeScript host draining a prior Rust owner.

## Status surfaces

Rust-mode status now includes this user-facing line:

```text
Host backends → MODULE: ctx_memory, ctx_note; historian: module-side
```

It appears in the legacy `/ctx-status` compatibility formatter, the shared `StatusDetail` chat fallback, and the OpenCode status dialog. The field is derived from resolved `transform_mode`, so TypeScript status omits it.

Pi is intentionally out of scope: Pi accepts the shared `transform_mode` config key, but its runtime has no Rust module client, authority-status route, or Rust transform branch; its status dialog reads the TypeScript-owned store and tools. OpenCode is the only harness that can currently present Rust-mode status.

## Regression and mutation evidence

Focused regression coverage includes:

- exactly one declaration for a `TS → MODULE` transition and exactly one for the later `MODULE → TS` return;
- the Rust authority adapter invokes the transition observer after preparation settles;
- exactly one declaration when a process first sees an already-`MODULE` project;
- the host-path line in Rust status and its omission in TypeScript status for the compatibility formatter, shared chat fallback, RPC payload, and command response.

Executed mutations were restored immediately:

| Deliberate break | Red assertion(s) |
| --- | --- |
| Suppress `MODULE` declaration | `context-authority.test.ts:97` transition declaration; `:120` boot-time declaration |
| Suppress Rust host-path status | `execute-status.test.ts:149` Rust-mode section |
| Force the Rust line in TypeScript mode | `execute-status.test.ts:153` TypeScript omission |

No `NON-VACUITY BREAK` marker remains.

## Verification

- `bun run build:tui` — passed; regenerated the checked-in OpenCode TUI artifact.
- `bun test src/features/magic-context/context-authority.test.ts src/hooks/magic-context/execute-status.test.ts src/shared/status-detail-text.test.ts src/plugin/rpc-handlers.test.ts src/hooks/magic-context/command-handler.test.ts` — passed, 112 tests.
- `bun run typecheck` — passed.
- `bun run test` — passed, 4,217 plugin tests.
- `bun run lint` — reports six pre-existing Biome findings in untouched classifier, storage, hook, raw-token, and Rust-test files; no finding remains in this change.

## Reply draft for #389

Thanks @iceteaSA — your class analysis was right: Rust authority is a behavioral routing switch for host paths, not merely an implementation/performance switch. We added two visibility surfaces without changing the authority fence. On every settled `MODULE` transition the host logs one declaration such as `authority → MODULE: host backends → MODULE: ctx_memory, ctx_note; historian: module-side`; a completed drain logs the matching return to TypeScript. A fresh host that discovers an already-`MODULE` project also declares it once, while ordinary later passes stay quiet. `/ctx-status` now shows `Host backends → MODULE: ctx_memory, ctx_note; historian: module-side` in Rust mode in the OpenCode dialog and chat fallback, and omits it in TypeScript mode.

Your unresolved promoted-fact embedding instance was also real: before August 28, Rust-mode promotions left facts unembedded until a later backfill — option (b). Parity hunt #6 has now landed the mirrored-memory embedding trigger on master: the mirror-back hook embeds promoted facts synchronously with the mirror write and will ride the next release. Your no-HTTP-crate structural bound was the right proof that the old module historian could not have performed remote embedding itself.

We are declining arm 3 for now. `context_authority` is readable from the host, so a fork can already observe these transitions without a new registration API. A registration seam is heavier than this upstream class needs today; we should revisit it if a second consumer appears.

The external-store tee itself remains fork scope, but the durable attachment point is the mirror-back hook. Memories mirror to `context.db` regardless of authority, so a tee attached to that mirror path sees both TypeScript and MODULE writes. That is the migration path we recommend rather than attaching to the replaced tool or historian paths.

No authority fence moved, and this worktree did not push master.
