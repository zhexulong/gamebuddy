import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionInterruption } from "../companion-interruption.js";
import { createChatPresentationGate, type ChatPresentationStartActivation } from "./chat-presentation-gate.internal.js";
import type { P4ProviderStartExecutionScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type {
  AttemptObservationV1,
  AttemptStartingTurn,
  ChatTurnLedger,
  CancelledTurn,
  P4ProviderStartTransition,
  P5PresentationTransition,
  RunningTurn,
} from "./chat-thread-store.js";
import {
  P4C_CANONICAL_DIALOGUE_INPUT_KIND,
  renderCanonicalDialogueEnvelope,
  runMountedP4ProviderStart,
} from "./p4-provider-start-execution.js";

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
  readAcceptedMessageText?: () => Promise<string>;
  runtimeSession?: object;
  activatePresentation?: () => ChatPresentationStartActivation;
  presentationCommitted?: () => boolean;
  /** Simulates STOP winning the durable CAS immediately before completion claim. */
  stopWinsCompletionClaim?: boolean;
  finalizeCancellation?: () => Promise<
    Extract<ChatTurnLedger, { status: "completion_claimed" | "completed" | "cancel_claimed" | "cancelled" | "failed" }> | undefined
  >;
}>;

function createScope(overrides: ScopeOverrides = {}) {
  const fallbackEpoch = createCompanionInterruption();
  const fallbackGate = createChatPresentationGate();
  const fallbackSnapshot = fallbackEpoch.capture();
  const transitions: P4ProviderStartTransition[] = [];
  const presentationTransitions: P5PresentationTransition[] = [];
  let durableRunning: RunningTurn | undefined;
  let durablePresentation: ChatTurnLedger | undefined;
  const transitionStore = async (
    command: P4ProviderStartTransition,
  ): Promise<AttemptStartingTurn | RunningTurn> => {
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
    return attemptStarting(Object.freeze({ phase: "armed", observedAtMs: command.observedAtMs }));
  };
  const transitionPresentation = async (command: P5PresentationTransition): Promise<ChatTurnLedger> => {
    presentationTransitions.push(command);
    if (durableRunning === undefined || durablePresentation === undefined)
      throw new Error("p5_presentation_source_running_required");
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
      if (durablePresentation.status !== "cancel_claimed")
        throw new Error("p5_presentation_cancel_source_required");
      durablePresentation = Object.freeze({
        ...durablePresentation,
        status: "cancelled" as const,
        cancelledAtMs: command.cancelledAtMs,
      });
      return durablePresentation;
    }
    if (command.operation === "fail") {
      if (durablePresentation.status !== "running")
        throw new Error("p5_presentation_terminal_immutable");
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
    runtimeSession: overrides.runtimeSession ?? Object.freeze({}),
    transitionStore,
    transitionPresentation,
    readAcceptedMessageText: overrides.readAcceptedMessageText ?? (async () => "Hello"),
    assertAdmission: overrides.assertAdmission ?? (() => undefined),
    activatePresentation:
      overrides.activatePresentation ??
      (() =>
        fallbackGate.activate({
          epoch: fallbackEpoch,
          observationEpoch: fallbackSnapshot,
          reserveCommit: (candidate) =>
            fallbackEpoch.isCurrent(candidate) ? () => undefined : undefined,
          commitPresentation: async () => undefined,
        })),
    finalizeCancellation:
      overrides.finalizeCancellation ??
      (async () =>
        durablePresentation !== undefined &&
        (durablePresentation.status === "completion_claimed" ||
          durablePresentation.status === "completed" ||
          durablePresentation.status === "cancel_claimed" ||
          durablePresentation.status === "cancelled" ||
          durablePresentation.status === "failed")
          ? durablePresentation
          : undefined),
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
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), ["claim_completion", "fail"]);
  assert.deepEqual(receivedEnvelope, JSON.parse(renderCanonicalDialogueEnvelope(facts, "Hello")));
});

test("P5 activates the construction gate before prompt and terminalizes one durable presentation", async () => {
  const interruption = createCompanionInterruption();
  const gate = createChatPresentationGate();
  const observationEpoch = interruption.capture();
  let activation: ChatPresentationStartActivation | undefined;
  let observer: Observer | undefined;
  let commitCount = 0;
  let sinkCount = 0;
  gate.attach(() => {
    sinkCount += 1;
  });
  const { scope, transitions, presentationTransitions } = createScope({
    presentationCommitted: () => commitCount === 1,
    activatePresentation: () => {
      activation = gate.activate({
        epoch: interruption,
        observationEpoch,
        reserveCommit: (candidate) =>
          interruption.isCurrent(candidate) ? () => undefined : undefined,
        commitPresentation: async () => {
          commitCount += 1;
        },
      });
      return activation;
    },
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        async prompt() {
          const captured = gate.admissionProvider.capture();
          const expression = Object.freeze({
            surface: "chat" as const,
            expressionId: "expression_01",
            sessionId: "surface_01",
            text: "Visible.",
            locale: "zh-CN",
          });
          const delivery = gate.textPort.present(expression, captured.admission);
          queueMicrotask(() => observer?.(Object.freeze({ statusClass: "success" as const })));
          await delivery;
          await assert.rejects(
            async () => {
              await gate.textPort.present(expression, captured.admission);
            },
            /presentation_admission_replayed|presentation_admission_unbound/,
          );
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions.map(({ operation }) => operation), ["claim_completion", "complete"]);
  assert.equal(commitCount, 1);
  assert.equal(sinkCount, 1);
  assert.equal(activation !== undefined, true);
});

test("P4c terminalizes a STOP winner that races its completion claim", async () => {
  let observer: Observer | undefined;
  const { scope, presentationTransitions } = createScope({
    stopWinsCompletionClaim: true,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          observer?.(Object.freeze({ statusClass: "success" as const }));
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["claim_completion", "cancel"],
  );
});

test("P4c terminalizes a durable cancel winner after prompt and presentation drain", async () => {
  let observer: Observer | undefined;
  let promptCalls = 0;
  let finalizeCalls = 0;
  const { scope, transitions, presentationTransitions } = createScope({
    finalizeCancellation: async () => {
      finalizeCalls += 1;
      return cancelled();
    },
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          promptCalls += 1;
          observer?.(Object.freeze({ statusClass: "success" as const }));
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "running"]);
  assert.deepEqual(presentationTransitions, []);
});

test("P5 Chat gate rejects a Game expression before durable commit", async () => {
  const interruption = createCompanionInterruption();
  const gate = createChatPresentationGate();
  const observationEpoch = interruption.capture();
  let commitCount = 0;
  const activation = gate.activate({
    epoch: interruption,
    observationEpoch,
    reserveCommit: (candidate) =>
      interruption.isCurrent(candidate) ? () => undefined : undefined,
    commitPresentation: async () => {
      commitCount += 1;
    },
  });
  const captured = gate.admissionProvider.capture();
  await assert.rejects(
    async () =>
      await Promise.resolve(
        gate.textPort.present(
          Object.freeze({
            surface: "game" as const,
            expressionId: "expression_game",
            sessionId: "surface_01",
            sourceEventId: "source_game",
            text: "Must not cross the Chat boundary.",
            locale: "zh-CN",
          }),
          captured.admission,
        ),
      ),
    /presentation_surface_mismatch/,
  );
  assert.equal(commitCount, 0);
  await activation.deactivate();
});

test("P5 stop before commit reservation rejects with zero durable presentation work", async () => {
  const interruption = createCompanionInterruption();
  const gate = createChatPresentationGate();
  const observationEpoch = interruption.capture();
  let commitCount = 0;
  const activation = gate.activate({
    epoch: interruption,
    observationEpoch,
    reserveCommit: (candidate) =>
      interruption.isCurrent(candidate) ? () => undefined : undefined,
    commitPresentation: async () => {
      commitCount += 1;
    },
  });
  const captured = gate.admissionProvider.capture();
  const delivery = gate.textPort.present(
    Object.freeze({ surface: "chat" as const, expressionId: "expression_stopped", sessionId: "surface_01", text: "Late.", locale: "zh-CN" }),
    captured.admission,
  );
  interruption.stop("stop_first", "source_first", "player_stop_all");
  activation.resolveRunning();
  await assert.rejects(async () => await delivery, /presentation_admission_revoked/);
  assert.equal(commitCount, 0);
  await activation.deactivate();
});

test("P5 commit reservation orders a racing stop after the reserved durable commit", async () => {
  const interruption = createCompanionInterruption();
  const gate = createChatPresentationGate();
  const observationEpoch = interruption.capture();
  let releaseCommit!: () => void;
  let commitStarted = false;
  let commitFinished = false;
  const activation = gate.activate({
    epoch: interruption,
    observationEpoch,
    reserveCommit: (candidate) =>
      interruption.isCurrent(candidate) ? () => undefined : undefined,
    commitPresentation: async () => {
      commitStarted = true;
      await new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      commitFinished = true;
    },
  });
  const captured = gate.admissionProvider.capture();
  const delivery = gate.textPort.present(
    Object.freeze({ surface: "chat" as const, expressionId: "expression_race", sessionId: "surface_01", text: "Visible.", locale: "zh-CN" }),
    captured.admission,
  );
  activation.resolveRunning();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(commitStarted, true);
  const stop = interruption.stop("stop_race", "source_race", "player_stop_all");
  assert.equal(stop.accepted, true);
  // The stop invalidates the old epoch, but cannot overtake a commit that
  // already won the synchronous reservation linearization point.
  assert.equal(commitFinished, false);
  releaseCommit();
  await delivery;
  assert.equal(commitFinished, true);
  await activation.deactivate();
});

test("P5 activation exposes no direct commit and deactivation drains a reserved callback before rebinding", async () => {
  const interruption = createCompanionInterruption();
  const gate = createChatPresentationGate();
  const observationEpoch = interruption.capture();
  let releaseListener!: () => void;
  let listenerStarted = false;
  gate.attach(async () => {
    listenerStarted = true;
    await new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
  });
  const activation = gate.activate({
    epoch: interruption,
    observationEpoch,
    reserveCommit: (candidate) =>
      interruption.isCurrent(candidate) ? () => undefined : undefined,
    commitPresentation: async () => undefined,
  });
  assert.equal("commitPresentation" in activation, false);
  const captured = gate.admissionProvider.capture();
  const delivery = gate.textPort.present(
    Object.freeze({ surface: "chat" as const, expressionId: "expression_drain", sessionId: "surface_01", text: "Visible.", locale: "zh-CN" }),
    captured.admission,
  );
  activation.resolveRunning();
  while (!listenerStarted) await new Promise<void>((resolve) => queueMicrotask(resolve));

  const deactivation = activation.deactivate();
  await assert.rejects(
    async () => {
      gate.admissionProvider.capture();
    },
    /presentation_admission_revoked/,
  );
  assert.throws(
    () =>
      gate.activate({
        epoch: interruption,
        observationEpoch,
        reserveCommit: () => undefined,
        commitPresentation: async () => undefined,
      }),
    /chat_presentation_gate_already_bound/,
  );
  let settled = false;
  void deactivation.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(settled, false);
  releaseListener();
  await delivery;
  await deactivation;
  assert.equal(settled, true);
});

test("P4c leaves the durable attempt armed when prompt settles without a provider observation", async () => {
  let promptCalls = 0;
  let unregisterCalls = 0;
  const { scope, transitions } = createScope({
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => {
          unregisterCalls += 1;
        };
      },
      session: Object.freeze({
        prompt() {
          promptCalls += 1;
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(unregisterCalls, 1);
  assert.equal(result.outcome, "armed");
  assert.equal(result.ledger.status, "attempt_starting");
  assert.equal(result.ledger.observation?.phase, "armed");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm"]);
});

test("P4c revalidates after asynchronous message read and records local pre-invocation revocation without prompting", async () => {
  let invalid = false;
  let promptCalls = 0;
  const { scope, transitions } = createScope({
    assertAdmission() {
      if (invalid) throw new Error("semantic_chat_runtime_p4_attempt_invocation_rejected");
    },
    readAcceptedMessageText: async () => {
      invalid = true;
      return "Hello";
    },
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          promptCalls += 1;
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(promptCalls, 0);
  assert.equal(result.outcome, "not_started");
  assert.equal(result.ledger.observation?.phase, "not_started");
  assert.equal(result.ledger.observation?.phase === "not_started" && result.ledger.observation.reasonCode, "admission_revoked");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "not_started"]);
});

test("P4c ignores a late provider observation once running admission is no longer active", async () => {
  let observer: Observer | undefined;
  let assertions = 0;
  const { scope, transitions } = createScope({
    assertAdmission() {
      assertions += 1;
      // initial, activation-before-arm, arm-after-activation, pre-read
      // invocation, and post-read prompt linearizations pass; only the
      // observer-side running linearization is no longer active.
      if (assertions >= 6) throw new Error("semantic_chat_runtime_p4_attempt_invocation_rejected");
    },
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          observer?.(Object.freeze({ statusClass: "error" as const }));
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "armed");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm"]);
});

test("P4c records session_unavailable only before a Host prompt invocation", async () => {
  const { scope, transitions } = createScope();

  const result = await runMountedP4ProviderStart(scope);

  assert.equal(result.outcome, "not_started");
  assert.equal(result.ledger.observation?.phase, "not_started");
  assert.equal(result.ledger.observation?.phase === "not_started" && result.ledger.observation.reasonCode, "session_unavailable");
  assert.deepEqual(transitions.map(({ operation }) => operation), ["arm", "not_started"]);
});
