# Chat Pipeline — P5 Source Lineage and Verification Boundary

**Status:** `deferred — not a Chat Core reference-pipeline prerequisite`

**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §5.1 and §12 P5; `design/71_CHAT_PIPELINE_BATCH_08_P5_PRESENTATION_COMMIT_AND_TERMINALIZATION.md`

**Scope:** record the rejected assistant-message provenance requirement and define the separation between production authority and audit/live evidence. This card owns no durable presentation transition, terminalization, browser route, SSE projection, cancellation route, or provider invocation.

## 1. Decision

The Chat Core reference pipeline does **not** require an assistant-message-level `sourceEventId`.

P5's functional authority is provided by the existing private, invocation-scoped chain:

```text
exact mounted Chat/session
  → exact durable turn and attempt generation
  → one coordinator-owned prompt invocation scope
  → one-shot presentation admission
  → cancel-epoch revalidation
  → ChatThreadStore CAS and prepared-journal read-back
```

A source-event ID would add audit/provenance detail but would not change whether the current invocation is allowed to commit. It is therefore deferred rather than allowed to block the reference pipeline.

This decision is local to Chat P5. Existing Game/native companion paths continue to use their `sourceEventId` contracts because those IDs participate in their control, interruption, bridge, receipt, and live-attestation semantics.

## 2. Rejected Pi premise

The locked embedded Pi runtime is `@earendil-works/pi-coding-agent` `0.84.1`.

Its inspected ordering is:

```text
assistant message starts
  → tool_call hook
  → tool execution
  → message_end handlers
  → SessionManager.appendMessage()
```

`tool_call` exposes `toolName`, `toolCallId`, and input. `AgentMessage` has no stable per-message ID, and the persisted `SessionMessageEntry.id` is unavailable at the earlier tool callback boundary.

The former P5 proposal:

```text
message_start → AgentMessage.id → companion_text tool_call
```

is invalid. We do not repair it by using `toolCallId`, a Host UUID, timestamps, hashes, browser keys, the last SessionManager entry, or inferred ordering. Those are correlation values, not required production authority for this reference pipeline.

If a future product requirement needs assistant-message-level provenance, it must be a separately scoped Pi/runtime enhancement with its own versioned artifact and evidence gate. It must not be smuggled into P5 as a functional prerequisite.

## 3. Production authority versus verification evidence

The project uses two deliberately separate planes:

### Production authority plane

Production code decides behavior using only Host/SDK-owned capabilities and durable facts:

- coordinator private binding and close-drained invocation scope;
- exact mounted identity, turn, attempt generation, runtime binding, and deadline;
- one-shot presentation admission and cancel epoch;
- `ChatThreadStore` transition CAS, prepared journal, capacity checks, and read-back;
- embedded Pi `session.prompt()` as the provider invocation effect.

Test helpers, artifact inventories, live attestation messages, hashes, snapshots, browser keys, and reviewer statements do not mint or widen these capabilities. The production path must never be made more permissive because a test or live observer is absent.

### Verification/evidence plane

Tests, static checkers, emitted-artifact verifiers, process fixtures, live runs, and independent reviews observe or challenge the production authority chain:

- a focused test may inject a narrowly scoped fake capability only through an explicit test seam;
- an emitted-artifact test must run the published generation, not a source-tree fallback;
- a live run must use the embedded GameBuddy Host/SDK runtime and GameBuddy-owned data root;
- live attestation is content-free evidence consumed by the gate, not a runtime authorization fact;
- evidence loss or mismatch fails the gate and cannot cause a retry, fallback, capability mint, or durable mutation;
- a reviewer can reject a change but cannot substitute for a missing command or runtime result.

This is the intended model already used by P3.5 and the Game live-source attestation path: verification can prove or fail a gate, but it does not become product authority.

## 4. Future provenance enhancement (not P5 scope)

If later requirements need assistant-message provenance, a new card must define a Pi-owned identity available before the presentation callback. Acceptance must include source ordering, parallel tool binding, session switch/shutdown, replay, emitted artifact provenance, and target-runtime evidence. Until then:

- Chat P5 does not persist `sourceEventId` in `PresentationCommitV1`;
- Chat P5 does not register a Pi lineage observer;
- Chat P5 does not claim assistant-message-level provenance;
- existing Game/native `sourceEventId` contracts remain unchanged.

## 5. Gate and next decision

This card no longer blocks P5 implementation. P5 may proceed after the already completed P4c implementation gate, using exact invocation/attempt/session/cancel/store authority only.

The deferred provenance enhancement remains an explicit future issue. It must not be reintroduced as an implicit requirement during P5 implementation or live-run acceptance.

This card does not change the accepted P3.5 or P4c boundaries.
