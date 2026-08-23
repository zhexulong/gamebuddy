import assert from "node:assert/strict";
import test from "node:test";
import type { P4ProviderStartExecutionScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type {
  AttemptObservationV1,
  AttemptStartingTurn,
  CancelledTurn,
  ChatTurnLedger,
  P4ProviderStartTransition,
  P5PresentationTransition,
  FailedTurn,
  RunningTurn,
} from "./chat-thread-store.js";
import { createChatEventStream } from "./chat-event-stream.js";
import {
  P4C_CANONICAL_DIALOGUE_INPUT_KIND,
  renderCanonicalDialogueEnvelope,
  runMountedP4ProviderStart,
  type NativeChatPreviewPublisher,
} from "./p4-provider-start-execution.js";

function nativeText(text: string) {
  return Object.freeze({ type: "text" as const, text });
}

function nativeAssistant(
  content: readonly ReturnType<typeof nativeText>[],
  responseId = "assistant_01",
  stopReason: "stop" | "aborted" | "error" = "stop",
) {
  return Object.freeze({
    role: "assistant" as const,
    content: [...content],
    stopReason,
    responseId,
  });
}

const facts = Object.freeze({
  turnId: "turn_01",
  messageId: "player_01",
  attemptId: "attempt_01",
  generation: 1 as const,
  selectionGeneration: 1,
  idempotencyKey: "abcdefghijklmnopqrstuv",
  acceptedAtMs: 1_000,
  runtimeRoot: "E:/runtime",
  playerId: "player_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
  chatThreadId: "thread_01",
  chatSurfaceSessionId: "surface_01",
  runtimeBindingDigest: "a".repeat(64),
  runtimeOwner: Object.freeze({
    ownerToken: "owner_01",
    runtimeInstanceId: "runtime_01",
    ownerPid: 1234,
    ownerProcessStartIdentity: "process_01",
  }),
});

function attemptStarting(observation?: AttemptObservationV1): AttemptStartingTurn {
  return Object.freeze({
    turnId: facts.turnId,
    status: "attempt_starting" as const,
    idempotencyKey: facts.idempotencyKey,
    messageId: facts.messageId,
    acceptedAtMs: facts.acceptedAtMs,
    attempt: Object.freeze({
      generation: 1 as const,
      attemptId: facts.attemptId,
      claimedAtMs: facts.acceptedAtMs,
      selectionGeneration: facts.selectionGeneration,
      runtimeBindingDigest: facts.runtimeBindingDigest,
      runtimeOwner: facts.runtimeOwner,
    }),
    ...(observation === undefined ? {} : { observation }),
  });
}

function running(observation: Extract<AttemptObservationV1, { phase: "running" }>): RunningTurn {
  return Object.freeze({
    ...attemptStarting(observation),
    status: "running" as const,
    observation,
  });
}

function cancelled(): CancelledTurn {
  return Object.freeze({
    ...running(
      Object.freeze({
        phase: "running",
        source: "after_provider_response",
        statusClass: "success",
        observedAtMs: 1_100,
      }),
    ),
    status: "cancelled" as const,
    presentation: null,
    cancelClaimedAtMs: 1_200,
    cancelledAtMs: 1_300,
  });
}

type Observer = (fact: Readonly<{ statusClass: "success" | "error" }>) => void;
type ScopeOverrides = Readonly<{
  assertAdmission?: () => void;
  beginActivePrompt?: () => () => void;
  readAcceptedMessageText?: () => Promise<string>;
  readCurrentTurnLedger?: () => Promise<ChatTurnLedger>;
  runtimeSession?: object;
  presentationCommitted?: () => boolean;
  reserveNativeContentCommit?: () => { cancelEpoch: number; release(): void } | undefined;
  /** Simulates an ordinary SQLite Stop winning just before completion. */
  stopWinsCompletionClaim?: boolean;
  terminalLedger?: () => ChatTurnLedger | undefined;
}>;

function createScope(overrides: ScopeOverrides = {}) {
  const suppliedRuntime = overrides.runtimeSession as
    | { session?: Record<string, unknown>; [key: string]: unknown }
    | undefined;
  const suppliedSession = suppliedRuntime?.session;
  const runtimeSession =
    suppliedRuntime === undefined || suppliedSession === undefined
      ? suppliedRuntime
      : Object.freeze({
          ...suppliedRuntime,
          session: Object.freeze({
            ...suppliedSession,
            subscribe:
              typeof suppliedSession.subscribe === "function"
                ? suppliedSession.subscribe
                : (_listener: (event: unknown) => void) => () => undefined,
          }),
        });
  const transitions: P4ProviderStartTransition[] = [];
  const presentationTransitions: P5PresentationTransition[] = [];
  let durableRunning: RunningTurn | undefined;
  let durablePresentation: ChatTurnLedger | undefined;
  const transitionStore = async (
    command: P4ProviderStartTransition,
  ): Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn> => {
    transitions.push(command);
    if (command.operation === "running") {
      durableRunning = running(
        Object.freeze({
          phase: "running",
          source: "after_provider_response",
          statusClass: command.statusClass,
          observedAtMs: command.observedAtMs,
        }),
      );
      durablePresentation = durableRunning;
      return durableRunning;
    }
    if (command.operation === "not_started") {
      return attemptStarting(
        Object.freeze({
          phase: "not_started",
          reasonCode: command.reasonCode,
          observedAtMs: command.observedAtMs,
        }),
      );
    }
    if (command.operation === "cancel") {
      return Object.freeze({
        ...attemptStarting(Object.freeze({ phase: "armed" as const, observedAtMs: command.observedAtMs })),
        status: "cancelled" as const,
        observation: Object.freeze({ phase: "armed" as const, observedAtMs: command.observedAtMs }),
        presentation: null,
        cancelClaimedAtMs: command.observedAtMs,
        cancelledAtMs: command.cancelledAtMs,
      });
    }
    if (command.operation === "fail") {
      const failed = Object.freeze({
        ...attemptStarting(Object.freeze({ phase: "armed", observedAtMs: command.observedAtMs })),
        status: "failed" as const,
        observation: Object.freeze({ phase: "armed" as const, observedAtMs: command.observedAtMs }),
        presentation: null,
        reasonCode: command.reasonCode,
        failedAtMs: command.failedAtMs,
      });
      durablePresentation = failed;
      return failed;
    }
    return attemptStarting(Object.freeze({ phase: "armed", observedAtMs: command.observedAtMs }));
  };
  const transitionPresentation = async (command: P5PresentationTransition): Promise<ChatTurnLedger> => {
    presentationTransitions.push(command);
    if (durableRunning === undefined || durablePresentation === undefined)
      throw new Error("p5_presentation_source_running_required");
    if (command.operation === "commit_presentation") {
      if (durablePresentation.status !== "running") throw new Error("p5_presentation_commit_source_required");
      durablePresentation = Object.freeze({
        ...durableRunning,
        status: "presentation_committed" as const,
        presentation: Object.freeze({
          expressionId: command.message.messageId,
          messageId: command.message.messageId,
          cancelEpoch: command.cancelEpoch,
          committedAtMs: command.committedAtMs,
        }),
      });
      return durablePresentation;
    }
    if (command.operation === "claim_completion") {
      if (durablePresentation.status === "running" && overrides.stopWinsCompletionClaim) {
        durablePresentation = Object.freeze({
          ...durableRunning,
          status: "cancel_claimed" as const,
          presentation: null,
          cancelClaimedAtMs: command.claimedAtMs,
        });
        throw new Error("p5_presentation_cancel_source_required");
      }
      if (durablePresentation.status === "running" && overrides.presentationCommitted?.()) {
        durablePresentation = Object.freeze({
          ...durableRunning,
          status: "presentation_committed" as const,
          presentation: Object.freeze({
            expressionId: "expression_01",
            messageId: "expression_01",
            cancelEpoch: 0,
            committedAtMs: command.claimedAtMs,
          }),
        });
      }
      if (durablePresentation.status !== "presentation_committed")
        throw new Error("p5_presentation_completion_source_required");
      durablePresentation = Object.freeze({
        ...durablePresentation,
        status: "completion_claimed" as const,
        completionClaimedAtMs: command.claimedAtMs,
      });
      return durablePresentation;
    }
    if (command.operation === "complete") {
      if (durablePresentation.status !== "completion_claimed")
        throw new Error("p5_presentation_complete_source_required");
      durablePresentation = Object.freeze({
        ...durablePresentation,
        status: "completed" as const,
        completedAtMs: command.completedAtMs,
      });
      return durablePresentation;
    }
    if (command.operation === "claim_cancel") {
      if (durablePresentation.status !== "running" && durablePresentation.status !== "presentation_committed")
        throw new Error("p5_presentation_cancel_source_required");
      durablePresentation = Object.freeze({
        ...durablePresentation,
        status: "cancel_claimed" as const,
        presentation: durablePresentation.status === "presentation_committed" ? durablePresentation.presentation : null,
        cancelClaimedAtMs: command.claimedAtMs,
      });
      return durablePresentation;
    }
    if (command.operation === "cancel") {
      if (durablePresentation.status !== "cancel_claimed") throw new Error("p5_presentation_cancel_source_required");
      durablePresentation = Object.freeze({
        ...durablePresentation,
        status: "cancelled" as const,
        cancelledAtMs: command.cancelledAtMs,
      });
      return durablePresentation;
    }
    if (command.operation === "fail") {
      if (durablePresentation.status !== "running") throw new Error("p5_presentation_terminal_immutable");
      durablePresentation = Object.freeze({
        ...durableRunning,
        status: "failed" as const,
        presentation: null,
        reasonCode: command.reasonCode,
        failedAtMs: command.failedAtMs,
      });
      return durablePresentation;
    }
    throw new Error("unexpected_p5_transition");
  };
  const scope = Object.freeze({
    facts,
    deadlineAtMs: Date.now() + 120_000,
    runtimeSession: runtimeSession ?? Object.freeze({}),
    transitionStore,
    transitionPresentation,
    readAcceptedMessageText: overrides.readAcceptedMessageText ?? (async () => "Hello"),
    assertAdmission: overrides.assertAdmission ?? (() => undefined),
    beginActivePrompt: overrides.beginActivePrompt ?? (() => () => undefined),
    readCurrentTurnLedger:
      overrides.readCurrentTurnLedger ??
      (async () => {
        const terminal = overrides.terminalLedger?.();
        if (terminal !== undefined) return terminal;
        if (durablePresentation === undefined) return attemptStarting(Object.freeze({ phase: "armed", observedAtMs: 1 }));
        return durablePresentation;
      }),
    canPreviewNativeContent: () => true,
    reserveNativeContentCommit:
      overrides.reserveNativeContentCommit ?? (() => Object.freeze({ cancelEpoch: 1, release: () => undefined })),
    finalizeCancellation: async () => undefined,
  }) as P4ProviderStartExecutionScope;
  return { scope, transitions, presentationTransitions };
}

test("P4c serializes the canonical accepted-message envelope without provider facts", () => {
  const envelope = JSON.parse(renderCanonicalDialogueEnvelope(facts, "Hello")) as Record<string, unknown>;
  assert.deepEqual(envelope, {
    kind: P4C_CANONICAL_DIALOGUE_INPUT_KIND,
    turnId: facts.turnId,
    messageId: facts.messageId,
    attemptId: facts.attemptId,
    idempotencyKey: facts.idempotencyKey,
    acceptedAtMs: facts.acceptedAtMs,
    text: "Hello",
    locale: "und",
  });
});

test("P4c terminalizes an observed prompt without a durable presentation as failed", async () => {
  let observer: Observer | undefined;
  let promptCalls = 0;
  let unregisterCalls = 0;
  let receivedEnvelope: unknown;
  const { scope, transitions, presentationTransitions } = createScope({
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => {
          unregisterCalls += 1;
        };
      },
      session: Object.freeze({
        prompt(envelope: string) {
          promptCalls += 1;
          receivedEnvelope = JSON.parse(envelope);
          observer?.(Object.freeze({ statusClass: "success" as const }));
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(unregisterCalls, 1);
  assert.equal(result.outcome, "failed");
  assert.equal(result.ledger.status, "failed");
  assert.equal(result.ledger.status === "failed" && result.ledger.reasonCode, "no_visible_presentation");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm", "running"],
  );
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["claim_completion", "fail"],
  );
  assert.deepEqual(receivedEnvelope, JSON.parse(renderCanonicalDialogueEnvelope(facts, "Hello")));
});

test("P4c runs when native assistant output settles before the provider observer", async () => {
  let observer: Observer | undefined;
  const { scope, transitions, presentationTransitions } = createScope({
    presentationCommitted: () => true,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: (() => {
        const listeners = new Set<(event: unknown) => void>();
        const emit = (event: unknown): void => {
          for (const listener of [...listeners]) listener(event);
        };
        return Object.freeze({
          subscribe(listener: (event: unknown) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            const partial = nativeAssistant([nativeText("")]);
            emit({ type: "message_start", message: partial });
            emit({ type: "message_end", message: nativeAssistant([nativeText("Visible native content.")]) });
            observer?.(Object.freeze({ statusClass: "success" as const }));
          },
        });
      })(),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), ["commit_presentation", "claim_completion", "complete"]);
});

test("P5 commits final native assistant content once after durable running and clears its preview", async () => {
  let observer: Observer | undefined;
  const previews: Array<{ turnId: string; delta: string }> = [];
  let clears = 0;
  const previewPublisher: NativeChatPreviewPublisher = Object.freeze({
    publish: async (preview) => {
      previews.push(preview);
    },
    clear: async () => {
      clears += 1;
    },
  });
  const { scope, transitions, presentationTransitions } = createScope({
    presentationCommitted: () => true,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: (() => {
        const listeners = new Set<(event: unknown) => void>();
        const emit = (event: unknown): void => {
          for (const listener of [...listeners]) listener(event);
        };
        return Object.freeze({
          subscribe(listener: (event: unknown) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            const partial = nativeAssistant([nativeText("")]);
            emit({ type: "message_start", message: partial });
            queueMicrotask(() => observer?.(Object.freeze({ statusClass: "success" as const })));
            await new Promise<void>((resolve) => setImmediate(resolve));
            emit({
              type: "message_update",
              message: partial,
              assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
            });
            emit({
              type: "message_update",
              message: partial,
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Visible ", partial },
            });
            emit({
              type: "message_end",
              message: nativeAssistant([nativeText("Visible native content.")]),
            });
          },
        });
      })(),
    }),
  });

  const result = await runMountedP4ProviderStart(scope, previewPublisher);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), ["commit_presentation", "claim_completion", "complete"]);
  const commit = presentationTransitions[0];
  assert.equal(commit?.operation, "commit_presentation");
  assert.equal(commit?.operation === "commit_presentation" && commit.message.text, "Visible native content.");
  assert.deepEqual(previews, [{ turnId: facts.turnId, delta: "Visible " }]);
  assert.equal(clears, 1);
});
test("P5 normalizes native preview deltas before the browser event contract and completes the final text", async () => {
  let observer: Observer | undefined;
  const eventStream = createChatEventStream();
  const previewPublisher: NativeChatPreviewPublisher = Object.freeze({
    publish: async (preview) => {
      eventStream.publish({
        eventType: "companion.delta",
        selectionGeneration: facts.selectionGeneration,
        payload: Object.freeze({ turnHandle: "A".repeat(22), delta: preview.delta }),
      });
    },
    clear: async () => undefined,
  });
  const { scope, presentationTransitions } = createScope({
    presentationCommitted: () => true,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: (() => {
        const listeners = new Set<(event: unknown) => void>();
        const emit = (event: unknown): void => {
          for (const listener of [...listeners]) listener(event);
        };
        return Object.freeze({
          subscribe(listener: (event: unknown) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            const partial = nativeAssistant([nativeText("")]);
            emit({ type: "message_start", message: partial });
            queueMicrotask(() => observer?.(Object.freeze({ statusClass: "success" as const })));
            await new Promise<void>((resolve) => setImmediate(resolve));
            emit({
              type: "message_update",
              message: partial,
              assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
            });
            emit({
              type: "message_update",
              message: partial,
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "cafe\u0301", partial },
            });
            emit({ type: "message_end", message: nativeAssistant([nativeText("Cafe\u0301")]) });
          },
        });
      })(),
    }),
  });

  const result = await runMountedP4ProviderStart(scope, previewPublisher);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), [
    "commit_presentation",
    "claim_completion",
    "complete",
  ]);
  const events = eventStream.subscribe({ epoch: eventStream.epoch, after: 0, generation: facts.selectionGeneration });
  assert.equal(events.kind, "replay");
  assert.deepEqual(events.kind === "replay" ? events.events.map((event) => event.payload) : [], [
    { turnHandle: "A".repeat(22), delta: "café" },
  ]);
});

test("P4c terminalizes a rejected prompt after an observation as durable runtime failure", async () => {
  let observer: Observer | undefined;
  let promptCalls = 0;
  const { scope, transitions, presentationTransitions } = createScope({
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        async prompt() {
          promptCalls += 1;
          observer?.(Object.freeze({ statusClass: "success" as const }));
          throw new Error("transport_rejected_after_observation");
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "failed");
  assert.equal(result.ledger.status, "failed");
  assert.equal(result.ledger.reasonCode, "runtime_unavailable");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), ["fail"]);
});

test("P4c returns a normal durable Stop winner when an aborted prompt rejects", async () => {
  let promptCalls = 0;
  let stopped = false;
  const { scope, transitions, presentationTransitions } = createScope({
    terminalLedger: () => (stopped ? cancelled() : undefined),
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => undefined;
      },
      session: Object.freeze({
        async prompt() {
          promptCalls += 1;
          stopped = true;
          throw new Error("aborted_by_stop");
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm"]);
  assert.deepEqual(presentationTransitions, []);
});

test("P4c rereads a normal Stop winner that races completion", async () => {
  let observer: Observer | undefined;
  let stopped = false;
  const { scope, presentationTransitions } = createScope({
    stopWinsCompletionClaim: true,
    terminalLedger: () => (stopped ? cancelled() : undefined),
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          observer?.(Object.freeze({ statusClass: "success" as const }));
          stopped = true;
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(presentationTransitions, []);
});

test("P4c rereads a normal Stop winner after provider settlement", async () => {
  let observer: Observer | undefined;
  let promptCalls = 0;
  let stopped = false;
  const { scope, transitions, presentationTransitions } = createScope({
    terminalLedger: () => (stopped ? cancelled() : undefined),
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          promptCalls += 1;
          observer?.(Object.freeze({ statusClass: "success" as const }));
          stopped = true;
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions, []);
});
