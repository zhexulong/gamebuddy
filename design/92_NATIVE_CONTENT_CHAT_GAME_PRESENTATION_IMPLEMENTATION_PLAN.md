# Native Content Chat/Game Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `companion_text` / `companion_speak` pseudo-tool output mechanism with one Host-governed projection of Pi native assistant `content` for both Chat and Game, while retaining the existing durable cancellation and Game authority boundaries.

**Architecture:** Pi native assistant text is the sole source of player-visible companion dialogue. `message_update` provides ephemeral text deltas to surface-local observers; the final assistant `message_end` supplies the authoritative assembled content for one Host-controlled durable commit. Chat commits through the existing exact P5 transition authority after the durable running barrier and synchronous cancel/commit reservation; Game submits the same finalized text through its existing source-event, epoch, revision and idempotency-checked native presentation port. Tool calls remain typed Game actions only and are never display text.

**Tech Stack:** TypeScript, Node.js, embedded Pi `AgentSession` v0.84.1, SQLite ChatThreadStore, Host SSE browser contract, Stardew/SMAPI bridge.

**Spec:** User approval in this conversation (2026-04-13); `design/review/CHAT_PIPELINE_ARCHITECTURE_AND_IMMERSION_REVIEW.md`; `design/review/CHAT_PIPELINE_AND_COGNITIVE_COMPANION_IMPLEMENTATION_PLAN.md`; preserve the still-valid safety invariants from `design/71_CHAT_PIPELINE_BATCH_08_P5_PRESENTATION_COMMIT_AND_TERMINALIZATION.md`, `design/34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md`, and project memory.

## Global Constraints

- Remove legacy output paths; do not retain `companion_text`, `companion_speak`, a compatibility mode, a fallback, or a dual writer.
- Native assistant `content` is visible dialogue only after Host surface-specific admission; `thinking`, raw provider payloads, tool results, errors, and tool-call arguments never become player-visible text.
- Chat has no presentation tools. Its native text is ephemeral until an exact, once-only final durable P5 commit wins the existing cancellation race.
- Game native content is not proof of action execution. Typed game tool calls remain subject to existing policy, game-thread validation, terminal receipt, and postcondition rules.
- Preserve Chat's durable `armed → running → presentation_committed → completion_claimed → completed` path, exact one Host `session.prompt()` invocation, and `claim_cancel` race semantics.
- Preserve Game's actual Pi-consumed `sourceEventId`, interruption epoch, native bridge revision, `expressionId` idempotency, game-thread revalidation, and Stop handling.
- `message_update` is an ephemeral preview source only; only a final assistant `message_end` can be committed. An aborted/error/non-assistant/no-text final message produces no new visible committed message.
- The Host never publishes raw Pi session IDs, prompt envelopes, cookies, credentials, hidden reasoning, tool arguments, provider protocol details, or action authority through browser/Game presentation.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `host/src/native-companion-content.ts` | New deep module: exact session event subscription, assistant-message identity binding, bounded native text accumulation, ephemeral delta callbacks, final-content handoff, and disposal. |
| `host/src/native-companion-content.test.ts` | Unit proof for identity matching, delta filtering/accumulation, final authority, abort/error rejection, and detach behavior. |
| `host/src/presentation.ts` | Replace pseudo-tool-specific expression types with Host-owned native content projection facts. |
| `host/src/runtime.ts` | Remove `createChatPresentationTool`; construct native content observers only from Host-owned surface bindings and expose no speaking tool. |
| `host/src/continuity-semantic-chat-runtime-construction/*` | Give the Chat construction a private native-content sink bound to its P5 commit authority, rather than a tool gate. |
| `host/src/continuity-semantic-production-coordinator/*` | Bind/unbind the exact native content observer during one P4 invocation; preserve P5 reservation and terminalization. |
| `host/src/tavern/p4-provider-start-execution.ts` | Subscribe before `session.prompt`, open preview only after durable `running`, commit exactly once from final native text, and then complete/fail safely. |
| `host/src/tavern/chat-presentation-gate.internal.ts` | Delete after its P5 ownership is moved to the native content sink; no shim. |
| `host/src/tavern/chat-event-stream.ts`, `host/src/tavern/browser-contract/index.ts`, `dialogue-web/*` | Add safe ephemeral companion delta event and UI rendering/reconciliation without treating previews as transcript authority. |
| `host/src/companion-loop.ts`, `host/src/host-service.ts`, `host/src/farmhand-companion-presentation.ts` | Attach Game native content observers only after exact Pi consumption; route final text through current game presentation admission. |
| Relevant existing `*.test.ts`, browser tests, and live runners | Replace pseudo-tool expectations with native content behavior and prove non-leakage/cancellation. |

## Frozen Slice Card

```text
User-visible result:
  A companion's ordinary native assistant text is streamed as provisional text and becomes one durable/reloadable Chat reply or one admitted Game utterance. The model sees no companion_text/companion_speak tool.

In scope:
  Chat native content preview + final commit; Game native content final projection; removal of speaking pseudo-tools and their dead code/tests/prompts; focused browser and live verification.

Explicit non-goals:
  Changing Game action authorization/receipt/postcondition; exposing reasoning/tool results; persisting partial deltas; cross-surface transcript sharing; new TTS product behavior; changes to Memory authority.

Required topology and authority boundary:
  Pi AgentSession events -> Host native-content observer -> surface-specific Host admission -> Chat P5 durable transaction/SSE or existing Game bridge port. Browser and model never receive the authority objects.

Acceptance scenario:
  Given an exact mounted Chat and a real/fixture Pi assistant message with text content,
  when its message_update text delta arrives after durable running,
  then a safe provisional SSE delta appears; when its matching message_end succeeds,
  exactly one durable companion message is committed and survives /state reload.
  And if Stop wins before final commit, no late delta is accepted and no uncommitted message appears after reload.
  Given an exact Pi-consumed Game player batch with sourceEventId, when its matching native assistant message ends with text,
  then the existing Game presentation port receives one expression bound to that sourceEventId and current epoch; native text never proves a game action.

Cheapest checks:
  new observer unit tests; P4/P5 focused tests; CompanionLoop/Game port tests; browser contract/API/UI tests; host/dialogue-web typechecks.

Mutation lanes:
  A) Chat observer/P4/P5/browser contract (single connected writer).
  B) Game observer + presentation port (single writer, disjoint from A except shared new observer interface).
  C) Retired pseudo-tool removal after both paths prove the replacement.

Independent read-only lanes:
  Pi event type/semantics confirmation; final post-write authority review.

Launch budget:
  One writer per disjoint lane, one final reviewer, no live mutation. One real provider live run only after all static, contract, fixture, and browser preflight checks pass.

Stop/escalation:
  Stop if an exact assistant-message identity cannot be bound to an active Chat attempt/Game consumed batch without weakening existing authority. Do not add a fallback or shared global subscriber.
```

### Task 1: Native Assistant Content Observer

**Files:**
- Create: `host/src/native-companion-content.ts`
- Create: `host/src/native-companion-content.test.ts`

**Interfaces:**
- Consumes: `AgentSession.subscribe(listener)` and Pi events `{type:"message_start"|"message_update"|"message_end"}`.
- Produces:

```ts
export type NativeCompanionContentObserver = Readonly<{
  open(): void;
  revoke(): void;
  close(): Promise<void>;
}>;

export function attachNativeCompanionContent(
  session: Pick<AgentSession, "subscribe">,
  callbacks: Readonly<{
    onPreviewDelta(delta: string): void | Promise<void>;
    onFinalText(text: string): Promise<void>;
    onRejected(reason: "aborted" | "error" | "empty" | "identity_mismatch"): Promise<void>;
  }>,
): NativeCompanionContentObserver;
```

- [ ] **Step 1: Write failing observer tests**

```ts
test("streams only text_delta from one assistant message and commits its final content once", async () => {
  const { session, emit } = fakeSession();
  const previews: string[] = [];
  const finals: string[] = [];
  const observer = attachNativeCompanionContent(session, {
    onPreviewDelta: async (delta) => previews.push(delta),
    onFinalText: async (text) => finals.push(text),
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  emit(assistantStart("message-a"));
  emit(assistantTextDelta("message-a", "Hello"));
  emit(assistantTextDelta("message-b", " leak"));
  emit(assistantEnd("message-a", "Hello"));
  await flush();
  assert.deepEqual(previews, ["Hello"]);
  assert.deepEqual(finals, ["Hello"]);
});

test("never commits aborted, error, empty, tool-result, or foreign assistant output", async () => {
  // Cover final assistant stopReason / errorMessage and identity mismatch.
});
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `pnpm --dir host run build:test && node --test host/dist-test/native-companion-content.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded observer**

- Track one opaque exact `message_start` assistant message object/ID; never infer from stream order alone.
- Accept only `assistantMessageEvent.type === "text_delta"` with a non-empty string delta belonging to that exact message.
- Forward preview deltas only after `open()` and before `revoke()`.
- On matching `message_end`, obtain final ordinary assistant text from the authoritative final message, validate NFC/size using the existing Chat message limits, and invoke `onFinalText` exactly once.
- Reject final messages with `stopReason: "aborted"|"error"`, text that is empty/invalid, or a mismatch; detach with `close()`.
- Await callback work or serialize it so `close()` drains and no late callback can run after revocation.

- [ ] **Step 4: Run observer tests and Host typecheck**

Run:

```bash
pnpm --dir host run build:test
node --test host/dist-test/native-companion-content.test.js
pnpm --dir host run typecheck
```

Expected: all pass.

### Task 2: Replace Chat Tool Admission with Native Content P5 Projection

**Files:**
- Modify: `host/src/runtime.ts`
- Modify: `host/src/presentation.ts`
- Modify: `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- Modify: `host/src/tavern/p4-provider-start-execution.ts`
- Modify: `host/src/tavern/chat-thread-store.ts` only if naming/types need to cease referring to a tool expression
- Delete: `host/src/tavern/chat-presentation-gate.internal.ts`
- Modify/Test: `host/src/tavern/p4-provider-start-execution.test.ts`, coordinator tests, `host/src/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1's observer and existing `transitionPresentation({operation:"commit_presentation"|"claim_completion"|"complete"|"fail"})` exact P5 authority.
- Produces: an exact Chat attempt can subscribe to native content, emit provisional safe deltas, commit one final response, and retain existing terminal state transitions.

- [ ] **Step 1: Write failing P4/P5 tests**

```ts
test("Chat mounts no companion_text tool and final native assistant content commits one response", async () => {
  const run = await mountedRuntimeWithNativeAssistantText("Native reply.");
  assert.deepEqual(run.session.getActiveToolNames(), []);
  assert.equal(run.ledger.status, "completed");
  assert.deepEqual(run.messages.filter((m) => m.role === "companion").map((m) => m.text), ["Native reply."]);
});

test("Stop winning before final native content commit leaves cancelled with no companion message", async () => {
  // Open native content, make cancel win, emit delayed final, then durable reread.
});
```

- [ ] **Step 2: Run P4/P5 tests to verify failure**

Run: `pnpm --dir host run build:test && node --test host/dist-test/tavern/p4-provider-start-execution.test.js`

Expected: failure because output still requires `companion_text`.

- [ ] **Step 3: Implement the direct Chat projection**

- Delete `createChatPresentationTool()` and all tool/prompt wording that asks the model to call it.
- Remove the construction-time `ChatPresentationGate`; do not replace it with a generic public callback facade.
- Before the exact `session.prompt()` call, attach one private Task-1 observer to the exact session/attempt.
- Keep durable `armed` and provider `running` observation unchanged. Open ephemeral delivery only after `running` is durably written/read back.
- Use the existing coordinator-owned interruption epoch and synchronous `reserveCommit()` just before `onFinalText` invokes `commit_presentation`.
- Give the committed message ID a Host-generated opaque exact-attempt value, never Pi message ID/toolCall ID/provider ID.
- If final content is absent/aborted/error after running and no cancellation won, preserve `no_visible_presentation`/`runtime_unavailable` terminal semantics as applicable.
- Complete only after final content work has drained and the durable commit has succeeded; never persist preview deltas.

- [ ] **Step 4: Replace retired P5 gate tests and source assertions**

- Delete tests that require the pseudo-tool or gate.
- Add assertions that Chat active tool names contain neither `companion_text` nor `companion_speak`.
- Add exact one commit, no final commit after Stop, provider rejection, final-message error, empty assistant content, and reopen read-back coverage.

- [ ] **Step 5: Run focused Chat checks**

Run:

```bash
pnpm --dir host run build:test
node --test --test-concurrency=1 \
  host/dist-test/runtime.test.js \
  host/dist-test/tavern/p4-provider-start-execution.test.js \
  host/dist-test/tavern/chat-pipeline-service.test.js
pnpm --dir host run typecheck
```

Expected: all pass with no pseudo-tool source/import reference outside historical designs.

### Task 3: Chat Preview SSE and Browser Reconciliation

**Files:**
- Modify: `host/src/tavern/browser-contract/index.ts`
- Modify: `host/src/tavern/chat-event-stream.ts`
- Modify: `host/src/tavern/chat-pipeline-service.ts`
- Modify: `host/src/tavern-management-dialogue-web.ts`
- Modify: `dialogue-web/src/management-pipeline-api.ts`
- Modify: `dialogue-web/src/components/ReferenceApp.tsx`
- Test: `host/src/tavern/browser-contract/index.test.ts`, `dialogue-web/tests/reference-pipeline-api.test.mjs`, `dialogue-web/tests/reference-pipeline-browser.spec.ts`

**Interfaces:**
- Consumes: Task 2's preview callback and final durable `message.committed` event.
- Produces: `companion.delta` is a bounded, non-durable stream event associated only with an opaque turn handle; `/state` remains the reconciliation authority.

- [ ] **Step 1: Write failing contract and UI tests**

```ts
test("companion.delta is bounded, uses an opaque turn handle, and cannot be replayed as transcript state", () => {
  assert.equal(TavernBrowserValidatorsV1.BrowserEventV1Schema.Check({
    apiVersion: 1, epoch, sequence: 3, selectionGeneration: 1,
    eventType: "companion.delta",
    payload: { turnHandle, delta: "Hi" },
  }), true);
});

test("Reference UI renders preview then replaces it with committed transcript after state reconciliation", async ({ page }) => {
  // Emit delta, assert provisional bubble, commit final message, reload /state, assert exactly one durable bubble.
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir dialogue-web run test:unit
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts
```

Expected: failure because `companion.delta` is absent.

- [ ] **Step 3: Implement safe preview handling**

- Add only this event shape:

```ts
{ eventType: "companion.delta", payload: { turnHandle: OpaqueHandle, delta: BoundedText } }
```

- The Host publishes it only after Task 2's durable running barrier and only while the exact lease/current epoch remains active.
- The client stores previews separately from transcript and clears them on `message.committed`, terminal state, stream resync, or snapshot replacement.
- Do not add a browser API for final text submission, a durable partial-message route, raw message IDs, or content recovery outside `/state`.

- [ ] **Step 4: Run browser/API/type checks**

Run:

```bash
pnpm --dir host run build:test
node --test host/dist-test/tavern/browser-contract/index.test.js
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run test:unit
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts
```

Expected: all pass.

### Task 4: Route Native Content to Game Without Weakening Game Authority

**Files:**
- Modify: `host/src/companion-loop.ts`
- Modify: `host/src/host-service.ts`
- Modify: `host/src/farmhand-companion-presentation.ts`
- Modify: `host/src/farmhand-companion-preview.ts`
- Modify/Test: their focused tests

**Interfaces:**
- Consumes: Task 1 observer, `CompanionLoop` exact `message_start` player-batch source binding, and existing Game `CompanionTextPort.present`/bridge checks.
- Produces: final ordinary assistant content becomes a Game text expression only when bound to an actual consumed Game player batch; tool calls remain actions, not words.

- [ ] **Step 1: Write failing Game tests**

```ts
test("matching native assistant final content reaches the Game port with the consumed player sourceEventId", async () => {
  const result = await runConsumedGameBatchWithAssistantText("I am here.");
  assert.deepEqual(result.presentation, {
    sourceEventId: "player-event-1",
    text: "I am here.",
  });
});

test("foreign/aborted native assistant text, a world-only batch, or text after Stop never reaches Game presentation", async () => {
  // Assert zero bridge sends and no minted expression acceptance.
});
```

- [ ] **Step 2: Run Game tests to verify failure**

Run: `pnpm --dir host run build:test && node --test host/dist-test/companion-loop.test.js host/dist-test/farmhand-companion-presentation.test.js`

Expected: failure because Game only listens for pseudo-tool delivery.

- [ ] **Step 3: Implement Game final-content projection**

- Attach the observer only after `CompanionLoop` sees the exact user `message_start` and calls `beginPlayerBatch(sourceEventId, batchId)`.
- Forward final text through the existing Host-owned Game presentation admission; retain `sourceEventId`, current interruption snapshot, expression idempotency, bridge revision, and game-thread validation.
- Do not deliver preview deltas to the current Game bridge unless the existing native adapter explicitly supports and validates incremental text; initial implementation delivers the final text only.
- Ensure `agent_settled` does not itself create dialogue; only the matched assistant final content can request it.

- [ ] **Step 4: Remove Game pseudo-tool mounting/tests and run focused checks**

Run:

```bash
pnpm --dir host run build:test
node --test --test-concurrency=1 \
  host/dist-test/companion-loop.test.js \
  host/dist-test/host-service.test.js \
  host/dist-test/farmhand-companion-presentation.test.js \
  host/dist-test/farmhand-companion-preview.test.js
pnpm --dir host run typecheck
```

Expected: all pass; no Game-visible ordinary tool output remains.

### Task 5: Delete Retired Pseudo-Tool Surface and Validate the Product

**Files:**
- Delete obsolete pseudo-tool-specific modules/tests/prompts once Tasks 2 and 4 have consumers.
- Modify all live runner source checks that expect a pseudo-tool.
- Modify: design documents only where they are current owning product/design material; do not rewrite historical plans.

**Interfaces:**
- Consumes: passing Task 2–4 behavior.
- Produces: no production code path, prompt, tool registry, or live runner depends on `companion_text`/`companion_speak`.

- [ ] **Step 1: Add a failing retired-surface scan test**

```ts
test("production Host has no speaking pseudo-tool or pseudo-tool prompt", async () => {
  const source = await productionSourceText();
  assert.doesNotMatch(source, /\bcompanion_(text|speak)\b/);
});
```

Scope the scan to production TypeScript/import graph and runner contracts, excluding `design/legacy`, historical test fixtures, and migration audit documentation.

- [ ] **Step 2: Delete the retired implementations and update product prompt text**

- Remove tool definitions, `allowedToolNames` entries, mounting logic, tool-call-specific event assumptions, and dead exports.
- Retain typed Game action tools only.
- Make the Chat system prompt explicitly ask for ordinary concise assistant text and never a speaking tool.

- [ ] **Step 3: Run full preflight**

Run:

```bash
pnpm --dir host run typecheck
pnpm --dir host run build:test
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
node --test --test-concurrency=1 <all Task 1-4 focused Host test artifacts>
pnpm --dir dialogue-web run test:unit
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts tests/management-pipeline-browser.spec.ts
pnpm --dir host run build
pnpm --dir host run check:production-artifact
git diff --check
```

Expected: all pass. Review exact changed imports and verify no compatibility path remains.

- [ ] **Step 4: Execute one real provider Chat live run only after preflight passes**

Run the repository's content-free GameBuddy-owned live runner against a fresh production artifact. Required report facts:

```json
{
  "providerInvocation": true,
  "chatTools": [],
  "nativeContentObserved": true,
  "durableTerminalState": "completed",
  "durableCompanionMessageCommitted": true,
  "rawPromptOrResponsePersisted": false
}
```

The report must contain no prompt, cookie, credential, raw provider response, hidden reasoning, or Memory text. If any preflight item or the live run fails, stop and report the exact blocker; do not repeat live requests as a substitute for diagnosis.

## Self-Review

- **Spec coverage:** Tasks 1–3 implement the review designs’ direct native Chat content/SSE and durable read-back requirements. Task 4 applies the same content source to Game while preserving separate Game action authority. Task 5 removes pseudo-tools without a compatibility layer and verifies both automation and one provider live run.
- **Authority coverage:** Chat P5 reservation/terminalization remains in Task 2; Game sourceEventId/epoch/revision/idempotency/game-thread rules remain in Task 4. Native previews cannot become durable authority.
- **Placeholder scan:** No task delegates unspecified error handling or testing; each names exact files, interfaces, commands, and scenario assertions.
- **Type consistency:** `NativeCompanionContentObserver` is created in Task 1 and consumed by Tasks 2 and 4; browser `companion.delta` is introduced in Task 3 and is explicitly non-durable.

## Execution Handoff

Plan complete and saved to `design/92_NATIVE_CONTENT_CHAT_GAME_PRESENTATION_IMPLEMENTATION_PLAN.md`. Execute it now using the `subagent-driven-development` skill task-by-task, beginning with Task 1.
