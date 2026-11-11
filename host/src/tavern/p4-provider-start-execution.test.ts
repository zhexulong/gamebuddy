import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";
import type { ProviderInvocationScope } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AttemptObservationV1,
  AttemptStartingTurn,
  CancelledTurn,
  ChatTurnLedger,
  ProviderStartTransition,
  PresentationTransition,
  FailedTurn,
  RunningTurn,
} from "./chat-thread-store.js";
import {
  authoredContextCatalogFixture,
  readAuthoredContextRegistry,
} from "../test-support/authored-context-catalog.test-support.js";
import { createChatEventStream } from "./chat-event-stream.js";
import {
  runMountedProviderStart,
  type NativeChatPreviewPublisher,
  type NativeChatSpeechSink,
} from "./p4-provider-start-execution.js";
import {
  createProviderTurnHeaderScope,
  type ProviderTurnHeaderScope,
  type ProviderTurnNaming,
} from "../provider-turn-header.internal.js";
import { LocalVoiceGatewayClient } from "../voice-gateway-client.js";

function nativeText(text: string) {
  return Object.freeze({ type: "text" as const, text });
}

function nativeAssistant(
  content: readonly ReturnType<typeof nativeText>[],
  responseId = "assistant_01",
  stopReason: "stop" | "length" | "aborted" | "error" = "stop",
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
  variant: null,
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
type AuthoredStableSourceRef = Readonly<Record<string, string>>;
type AuthoredVolatileSourceRef = Readonly<Record<string, string>>;

type ScopeOverrides = Readonly<{
  facts?: ProviderInvocationScope["facts"];
  assertAdmission?: () => void;
  beginActivePrompt?: () => () => void;
  readAcceptedMessageText?: () => Promise<string>;
  readAcceptedAuthoredContextPlan?: () => Promise<
    Readonly<{
      turnId: string;
      stableSources: readonly AuthoredStableSourceRef[];
      volatileSources: readonly AuthoredVolatileSourceRef[];
    }>
  >;
  authoredContextCapability?: Readonly<{
    assertInstall(
      durableTurnId: string,
      refs: readonly AuthoredStableSourceRef[],
      volatileRefs?: readonly AuthoredVolatileSourceRef[],
    ): void;
    clearVolatileForTurn(durableTurnId: string): void;
  }>;
  readCurrentTurnLedger?: () => Promise<ChatTurnLedger>;
  runtimeSession?: object;
  presentationCommitted?: () => boolean;
  reserveNativeContentCommit?: () => { cancelEpoch: number; release(): void } | undefined;
  /** Simulates an ordinary SQLite Stop winning just before completion. */
  stopWinsCompletionClaim?: boolean;
  terminalLedger?: () => ChatTurnLedger | undefined;
  /**
   * The durable winner a mounted Stop published for this invocation, read
   * exactly as the coordinator's own `record.cancellation` promise exposes it.
   * Absent reproduces a scope whose owner never published one - the reading this
   * runner's cancellation settlement exists to replace.
   */
  finalizeCancellation?: () => Promise<Awaited<ReturnType<ProviderInvocationScope["finalizeCancellation"]>>>;
  /**
   * The Pi-side half of a variant turn. The double's default refuses, so a variant
   * turn that does not say what its branch did cannot reach a commit by accident.
   */
  branchVariantAnchor?: ProviderInvocationScope["branchVariantAnchor"];
  /** Makes the variant commit raise this exact store code, before it writes. */
  refuseVariantCommitWith?: string;
}>;

function createScope(overrides: ScopeOverrides = {}) {
  const suppliedRuntime = overrides.runtimeSession as
    | { session?: Record<string, unknown>; [key: string]: unknown }
    | undefined;
  const suppliedSession = suppliedRuntime?.session;
  /**
   * These cases drive the runner, which reads the runtime session's own entry list and appends none of
   * its entries, so the double models a manager whose list is readable and empty: the binding the
   * runner records for what a prompt appended is then empty, and no ingress is asked to store anything.
   */
  const sessionManager = (suppliedRuntime?.sessionManager ??
    Object.freeze({
      getEntries: () => [],
      getBranch: () => [],
    })) as SessionManager;
  /**
   * The double deliberately supplies only the parts of a live runtime session these cases reach: an
   * empty object when a case supplies none (the runner then finds no prompt port and records
   * `not_started` before it ever reads an entry list).
   */
  const emptyRuntimeSession = Object.freeze({}) as unknown as ProviderInvocationScope["runtimeSession"];
  /**
   * Every mounted runtime session carries the holder its inline extension reads. The double creates one when
   * a case supplies none, so the runner always reaches a real holder and a case that wants to watch what the
   * runner sets and clears can supply its own.
   */
  const providerTurnHeader =
    (suppliedRuntime?.providerTurnHeader as ProviderTurnHeaderScope | undefined) ?? createProviderTurnHeaderScope();
  const runtimeSession =
    suppliedRuntime === undefined || suppliedSession === undefined
      ? suppliedRuntime
      : Object.freeze({
          ...suppliedRuntime,
          sessionManager,
          providerTurnHeader,
          // A deliberate partial double of the session surface this runner reaches: the listener port
          // and the prompt port a case supplies.
          session: Object.freeze({
            ...suppliedSession,
            subscribe:
              typeof suppliedSession.subscribe === "function"
                ? suppliedSession.subscribe
                : (_listener: (event: unknown) => void) => () => undefined,
          }),
        });
  const transitions: ProviderStartTransition[] = [];
  const presentationTransitions: PresentationTransition[] = [];
  let durableRunning: RunningTurn | undefined;
  let durablePresentation: ChatTurnLedger | undefined;
  const transitionStore = async (
    command: ProviderStartTransition,
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
  const transitionPresentation = async (command: PresentationTransition): Promise<ChatTurnLedger> => {
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
    if (command.operation === "commit_variant") {
      if (overrides.refuseVariantCommitWith !== undefined) throw new Error(overrides.refuseVariantCommitWith);
      if (durablePresentation.status !== "running") throw new Error("p5_presentation_commit_source_required");
      durablePresentation = Object.freeze({
        ...durableRunning,
        status: "presentation_committed" as const,
        presentation: Object.freeze({
          expressionId: command.variant.targetMessageId,
          messageId: command.variant.targetMessageId,
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
      // Mirrors the store's own CAS as it stood while this defect was live: a failure
      // was refused from an attempt that never armed and from an already-terminal
      // ledger, but NOT over a claimed cancel - which is how the pre-fix reading could
      // replace a claimed interruption with a failure. The store refuses that now
      // (`chat-thread-store.cancel-authority.test.ts`), and this double keeps the
      // permissive shape on purpose: the planted test below drives that reading to its
      // real outcome instead of letting a fixed store hide it.
      if (
        durablePresentation.status === "cancelled" ||
        durablePresentation.status === "completed" ||
        durablePresentation.status === "failed"
      )
        throw new Error("p5_presentation_terminal_immutable");
      durablePresentation = Object.freeze({
        ...durableRunning,
        status: "failed" as const,
        presentation: "presentation" in durablePresentation ? durablePresentation.presentation : null,
        reasonCode: command.reasonCode,
        ...(command.providerFailure === undefined ? {} : { providerFailure: command.providerFailure }),
        failedAtMs: command.failedAtMs,
      });
      return durablePresentation;
    }
    throw new Error("unexpected_p5_transition");
  };
  const scope = Object.freeze({
    facts: overrides.facts ?? facts,
    deadlineAtMs: Date.now() + 120_000,
    runtimeSession: runtimeSession ?? emptyRuntimeSession,
    transitionStore,
    transitionPresentation,
    readAcceptedMessageText: overrides.readAcceptedMessageText ?? (async () => "Hello"),
    readAcceptedAuthoredContextPlan:
      overrides.readAcceptedAuthoredContextPlan ??
      (async () =>
        Object.freeze({ turnId: facts.turnId, stableSources: Object.freeze([]), volatileSources: Object.freeze([]) })),
    authoredContextCapability:
      overrides.authoredContextCapability ??
      Object.freeze({
        assertInstall: (
          _durableTurnId: string,
          _refs: readonly AuthoredStableSourceRef[],
          _volatileRefs?: readonly AuthoredVolatileSourceRef[],
        ) => undefined,
        clearVolatileForTurn: (_durableTurnId: string) => undefined,
      }),
    assertAdmission: overrides.assertAdmission ?? (() => undefined),
    beginActivePrompt: overrides.beginActivePrompt ?? (() => () => undefined),
    readCurrentTurnLedger:
      overrides.readCurrentTurnLedger ??
      (async () => {
        const terminal = overrides.terminalLedger?.();
        if (terminal !== undefined) return terminal;
        if (durablePresentation === undefined)
          return attemptStarting(Object.freeze({ phase: "armed", observedAtMs: 1 }));
        return durablePresentation;
      }),
    canPreviewNativeContent: () => true,
    reserveNativeContentCommit:
      overrides.reserveNativeContentCommit ?? (() => Object.freeze({ cancelEpoch: 1, release: () => undefined })),
    finalizeCancellation: overrides.finalizeCancellation ?? (async () => undefined),
    branchVariantAnchor:
      overrides.branchVariantAnchor ??
      (async () => Object.freeze({ status: "refused" as const, reason: "variant_position_has_no_variant" as const })),
    // The runner records the durable message -> entry binding through this ingress once its prompt has
    // settled. These cases append no session entry, so the runner proves nothing and calls it with
    // nothing; the double answers that, and a case that ever appends entries would have to say so.
    recordTranscriptEntryBinding: async () => undefined,
    // Deliberate partial double: it supplies only the scope members these cases reach, and its runtime
    // session carries only the ports and the readable entry list the runner reads. The cast states that
    // plainly rather than relying on an assertion TS happens to accept.
  }) as unknown as ProviderInvocationScope;
  return { scope, transitions, presentationTransitions };
}

test("P4c installs the durable authored-context plan before its plain-text prompt", async () => {
  const events: string[] = [];
  let promptText: string | undefined;
  const { scope } = createScope({
    readAcceptedAuthoredContextPlan: async () => {
      events.push("read-plan");
      return Object.freeze({
        turnId: facts.turnId,
        stableSources: Object.freeze([
          Object.freeze({
            sourceId: "persona_01",
            kind: "persona",
            revision: "1",
            canonicalHash: "a".repeat(64),
            totalOrderKey: "01",
          }),
        ]),
        volatileSources: Object.freeze([]),
      });
    },
    authoredContextCapability: Object.freeze({
      assertInstall(turnId, refs, volatileRefs) {
        assert.equal(turnId, facts.turnId);
        assert.equal(refs.length, 1);
        assert.deepEqual(volatileRefs, []);
        events.push("assert-install");
      },
      clearVolatileForTurn: (_durableTurnId: string) => undefined,
    }),
    readAcceptedMessageText: async () => {
      events.push("read-text");
      return "plain player text";
    },
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => undefined;
      },
      session: Object.freeze({
        prompt(text: string) {
          promptText = text;
          events.push("prompt");
          return Promise.resolve();
        },
      }),
    }),
  });

  await runMountedProviderStart(scope);

  assert.equal(promptText, "plain player text");
  assert.deepEqual(events, ["read-plan", "assert-install", "read-text", "prompt"]);
});

test("P4c hands the plan's selected volatile world-book refs to the vendor binding the extension entry reads", async () => {
  // The keyword-gated world-book entries live ONLY in `plan.volatileSources`: the catalog's per-turn
  // selection (chat-thread-store.ts `selectAuthoredContextVolatileSourceRefs`) put them there, and
  // this call is the only place that selection is handed to Magic Context. The assertion below is
  // read out of the vendor's OWN process-wide registry rather than a spy, so a hardcoded `[]` fails
  // here - and so does a Magic Context build whose two bundle entries keep separate registries,
  // which is the defect that left every selected entry (the always-on constant as much as the
  // keyword-gated one) invisible to the model.
  const catalogSource = Object.freeze({
    sourceId: "book_01_entry_2",
    revision: "1",
    content: "Keyword-gated backdrop.",
    budgetTokens: 8,
    totalOrderKey: "0002",
    provenance: "tavern-world-book-entry/book_01_entry_2/revision/1/canonical/c",
    selectionKeys: Object.freeze(["绿茶"]),
  });
  const authoredScope = Object.freeze({
    continuityId: facts.continuityId,
    sessionId: "pi_session_volatile_delivery",
    surface: "tavern" as const,
    threadId: facts.chatThreadId,
    profile: Object.freeze({ profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }),
  });
  const fixture = authoredContextCatalogFixture(authoredScope, { volatileSources: [catalogSource] });
  const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
  const authoredContextCapability = publishGameBuddyAuthoredStableCatalog(authoredScope, fixture.catalog);
  const volatileRef = fixture.volatileRefs[0];
  assert.ok(volatileRef, "the volatile catalog fixture must produce the ref the plan installs");

  // The turn's volatile binding lives for exactly the prompt window and is released at settlement:
  // p4-provider-start-execution.ts's `finally` calls `clearVolatileForTurn`. Reading the registry
  // after `runMountedProviderStart` returns therefore asks about the wrong moment - the handover has
  // already happened and been released. Snapshot it while the prompt is the live one instead.
  let boundDuringPrompt: unknown;
  const { scope } = createScope({
    readAcceptedAuthoredContextPlan: async () =>
      Object.freeze({
        turnId: facts.turnId,
        stableSources: Object.freeze([]),
        volatileSources: Object.freeze([volatileRef]),
      }),
    authoredContextCapability,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          boundDuringPrompt = readAuthoredContextRegistry()?.volatileTurns.get(authoredScope.sessionId);
          return Promise.resolve();
        },
      }),
    }),
  });

  await runMountedProviderStart(scope);

  assert.deepEqual(boundDuringPrompt, {
    turnId: facts.turnId,
    sourceRefs: [volatileRef],
  });
  // The leak-prevention half: the binding must not outlive its prompt, or a later turn's install
  // would meet a stale binding. A red here is not to be "fixed" by keeping the binding alive.
  assert.equal(readAuthoredContextRegistry()?.volatileTurns.get(authoredScope.sessionId), undefined);
  await authoredContextCapability.clear();
});

test("P4c fails closed on an authored-context mismatch before prompt", async () => {
  let promptCalls = 0;
  const { scope } = createScope({
    authoredContextCapability: Object.freeze({
      assertInstall(
        _durableTurnId: string,
        _refs: readonly AuthoredStableSourceRef[],
        _volatileRefs?: readonly AuthoredVolatileSourceRef[],
      ) {
        throw new Error("authored_context_catalog_mismatch");
      },
      clearVolatileForTurn: (_durableTurnId: string) => undefined,
    }),
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

  await assert.rejects(() => runMountedProviderStart(scope), /authored_context_catalog_mismatch/);
  assert.equal(promptCalls, 0);
});

test("P4c terminalizes an observed prompt without a durable presentation as failed", async () => {
  let observer: Observer | undefined;
  let promptCalls = 0;
  let unregisterCalls = 0;
  let receivedPromptText: string | undefined;
  let receivedPromptOptions: unknown;
  const { scope, transitions, presentationTransitions } = createScope({
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => {
          unregisterCalls += 1;
        };
      },
      session: Object.freeze({
        prompt(text: string, options: unknown) {
          promptCalls += 1;
          receivedPromptText = text;
          receivedPromptOptions = options;
          observer?.(Object.freeze({ statusClass: "success" as const }));
          return Promise.resolve();
        },
      }),
    }),
  });

  const result = await runMountedProviderStart(scope);

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
  assert.equal(receivedPromptText, "Hello");
  assert.deepEqual(receivedPromptOptions, { expandPromptTemplates: false, source: "rpc" });
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

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm", "running"],
  );
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["commit_presentation", "claim_completion", "complete"],
  );
});

test("Chat's preview and voice never receive reasoning, and the answer arrives in order", async () => {
  // Both sinks read the one delta lane, and `removeModelScaffolding` cleans only
  // the committed row. A reply that opens with an inline reasoning frame therefore
  // printed the model's scratchpad in the live bubble AND spoke it aloud, then
  // settled as a different, clean message. Withholding the frame in the lane is
  // what keeps the bubble and the voice describing the reply that gets committed.
  let observer: Observer | undefined;
  const previews: string[] = [];
  const spoken: string[] = [];
  const previewPublisher: NativeChatPreviewPublisher = Object.freeze({
    publish: async (preview) => {
      previews.push(preview.delta);
    },
    clear: async () => undefined,
  });
  const speechSink: NativeChatSpeechSink = Object.freeze({
    begin: async () => undefined,
    append: async (delta) => {
      spoken.push(delta);
    },
    finalize: async () => undefined,
    cancel: async () => undefined,
  });
  const deltas = ["<thinking>", "玩家刚醒，先接一句话。", "</thinking>", "早安。", "今天有雨。"];
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
            for (const delta of deltas)
              emit({
                type: "message_update",
                message: partial,
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
              });
            emit({ type: "message_end", message: nativeAssistant([nativeText(deltas.join(""))]) });
          },
        });
      })(),
    }),
  });

  const result = await runMountedProviderStart(scope, previewPublisher, speechSink);

  assert.equal(result.outcome, "completed");
  // The answer is unbroken and in arrival order...
  assert.deepEqual(previews, ["早安。", "今天有雨。"]);
  // ...and the voice is fed exactly what the bubble was, never the reasoning.
  assert.equal(spoken.join(""), previews.join(""));
  for (const piece of [...previews, ...spoken]) {
    assert.equal(piece.includes("玩家"), false, piece);
    assert.equal(piece.includes("<thinking>"), false, piece);
  }
  // The committed row is untouched: the final path still owns the whole message.
  const commit = presentationTransitions[0];
  assert.equal(commit?.operation, "commit_presentation");
  assert.equal(commit?.operation === "commit_presentation" && commit.message.text, "早安。今天有雨。");
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

  const result = await runMountedProviderStart(scope, previewPublisher);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm", "running"],
  );
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["commit_presentation", "claim_completion", "complete"],
  );
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

  const result = await runMountedProviderStart(scope, previewPublisher);

  assert.equal(result.outcome, "completed");
  assert.equal(result.ledger.status, "completed");
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["commit_presentation", "claim_completion", "complete"],
  );
  const events = eventStream.subscribe({ epoch: eventStream.epoch, after: 0, generation: facts.selectionGeneration });
  assert.equal(events.kind, "replay");
  assert.deepEqual(events.kind === "replay" ? events.events.map((event) => event.payload) : [], [
    { turnHandle: "A".repeat(22), delta: "café" },
  ]);
});

test("Chat commits the model's exact text, keeping its asterisk action beat", async () => {
  // `attachNativeCompanionContent` sits between Pi's `message_end` and the
  // durable `commit_presentation`, so a `strip` presentation on this lane would
  // write every Chat row without the beat the renderer draws — irreversible for
  // messages already generated. The failure this catches: the Chat lane passing
  // `stageDirection: "strip"` (or a default that strips), which commits
  // "早安!今天天气真好。" instead of the model's own line.
  let observer: Observer | undefined;
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
            emit({ type: "message_end", message: nativeAssistant([nativeText("*转过身微笑* 早安!今天天气真好。")]) });
          },
        });
      })(),
    }),
  });

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "completed");
  const commit = presentationTransitions[0];
  assert.equal(commit?.operation, "commit_presentation");
  assert.equal(
    commit?.operation === "commit_presentation" && commit.message.text,
    "*转过身微笑* 早安!今天天气真好。",
    "the Chat durable row must keep the model's asterisk action beat",
  );
});

test("a generation that stopped at the model's length ceiling records that fact on its own commit", async () => {
  // The player's real pain: a reply cut off by the model's output ceiling is
  // indistinguishable from a finished one, so nothing tells them whether to ask
  // again. The fact comes from Pi's own stop reason and nothing else, and it is
  // written together with the reply it describes - on this turn's presentation
  // record, which is the record of the one generation that produced that reply.
  for (const [stopReason, expected] of [
    ["length", true],
    ["stop", false],
  ] as const) {
    let observer: Observer | undefined;
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
              emit({
                type: "message_end",
                message: nativeAssistant([nativeText("Half a reply.")], "assistant_01", stopReason),
              });
              observer?.(Object.freeze({ statusClass: "success" as const }));
            },
          });
        })(),
      }),
    });

    const result = await runMountedProviderStart(scope);

    assert.equal(result.outcome, "completed");
    const commit = presentationTransitions[0];
    assert.equal(commit?.operation, "commit_presentation");
    // The fact is present or absent, never a second spelling of "finished".
    assert.equal(commit !== undefined && "truncated" in commit, expected, stopReason);
    assert.equal(commit?.operation === "commit_presentation" && commit.message.text, "Half a reply.", stopReason);
  }
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

  const result = await runMountedProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "failed");
  assert.equal(result.ledger.status, "failed");
  assert.equal(result.ledger.reasonCode, "runtime_unavailable");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm", "running"],
  );
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["fail"],
  );
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

  const result = await runMountedProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm"],
  );
  assert.deepEqual(presentationTransitions, []);
});

test("the provider turn header names this turn while its prompt is in flight and no turn afterwards", async () => {
  // A captured provider body can only be attributed to a turn if the turn names itself ON the request.
  // The value is the Host's own turn identity, held for exactly the window in which this prompt can
  // build a request: a holder written later names nothing, and one left written names the wrong turn.
  const providerTurnHeader = createProviderTurnHeaderScope();
  let observer: Observer | undefined;
  const turnsSeenByPrompt: (ProviderTurnNaming | undefined)[] = [];
  const { scope } = createScope({
    presentationCommitted: () => true,
    runtimeSession: Object.freeze({
      providerTurnHeader,
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
            turnsSeenByPrompt.push(providerTurnHeader.turnInFlight());
            const partial = nativeAssistant([nativeText("")]);
            emit({ type: "message_start", message: partial });
            emit({ type: "message_end", message: nativeAssistant([nativeText("A reply.")]) });
            observer?.(Object.freeze({ statusClass: "success" as const }));
          },
        });
      })(),
    }),
  });

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "completed");
  assert.deepEqual(
    turnsSeenByPrompt,
    [{ turnId: facts.turnId, idempotencyKey: facts.idempotencyKey }],
    "the prompt must run with its own turn and its own submission key named on the holder",
  );
  assert.equal(
    providerTurnHeader.turnInFlight(),
    undefined,
    "a settled prompt must not leave its turn named for a probe or a title generation",
  );
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

  const result = await runMountedProviderStart(scope);

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

  const result = await runMountedProviderStart(scope);

  assert.equal(promptCalls, 1);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.ledger.status, "cancelled");
  assert.deepEqual(
    transitions.map(({ operation }) => operation),
    ["arm", "running"],
  );
  assert.deepEqual(presentationTransitions, []);
});

/**
 * One published durable winner, two readings of it. The mounted cancel seam
 * publishes `record.cancellation` and then aborts the prompt it owns, so the
 * rejection this runner sees is the stop's own act - never evidence of a failed
 * runtime. `consumePublishedClaim: false` is the planted pre-fix reading: the
 * scope holds the claim, the runner never asks for it, and its only evidence is
 * the abort it just caused, which it classifies as the turn's failure.
 */
async function driveClaimedCancel(
  phase: "running" | "presentation_committed",
  consumePublishedClaim: boolean,
): Promise<{
  outcome: string;
  ledgerStatus: string;
  reasonCode: string | null;
  presentation: boolean | null;
  operationsAfterClaim: readonly string[];
}> {
  let observer: Observer | undefined;
  let abortPrompt!: (error: Error) => void;
  const promptOutcome = new Promise<never>((_resolve, reject) => {
    abortPrompt = reject;
  });
  let published: Awaited<ReturnType<ProviderInvocationScope["finalizeCancellation"]>>;
  const { scope, transitions, presentationTransitions } = createScope({
    finalizeCancellation: consumePublishedClaim ? async () => published : async () => undefined,
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver(onStart: Observer) {
        observer = onStart;
        return () => undefined;
      },
      session: Object.freeze({
        prompt() {
          observer?.(Object.freeze({ statusClass: "success" as const }));
          return promptOutcome;
        },
      }),
    }),
  });
  const run = runMountedProviderStart(scope);
  // The runner's own durable running write, then - when the phase has one - the
  // presentation commit whose reservation let it land before the stop.
  await waitForProviderStartOperation(transitions, "running");
  if (phase === "presentation_committed") {
    await scope.transitionPresentation({
      operation: "commit_presentation",
      cancelEpoch: 1,
      message: { messageId: "response_01", text: "Half a thought, kept.", occurredAtMs: Date.now() },
      committedAtMs: Date.now(),
    });
  }
  published = (await scope.transitionPresentation({
    operation: "claim_cancel",
    claimedAtMs: Date.now(),
  })) as typeof published;
  const claimIndex = presentationTransitions.length;
  abortPrompt(new Error("aborted_by_the_stop"));
  const result = await run;
  const ledger = result.ledger;
  return {
    outcome: result.outcome,
    ledgerStatus: ledger.status,
    reasonCode: ledger.status === "failed" ? ledger.reasonCode : null,
    presentation: "presentation" in ledger ? ledger.presentation !== null : null,
    operationsAfterClaim: presentationTransitions.slice(claimIndex).map(({ operation }) => operation),
  };
}

async function waitForProviderStartOperation(
  transitions: readonly ProviderStartTransition[],
  operation: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transitions.some((entry) => entry.operation === operation)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitForProviderStartOperation_timeout_${operation}`);
}

test("Chat settles a Stop's own abort as the cancel it published, keeping the committed text", async () => {
  const settled = await driveClaimedCancel("presentation_committed", true);
  assert.equal(settled.outcome, "cancelled");
  assert.equal(settled.ledgerStatus, "cancelled");
  assert.equal(settled.reasonCode, null);
  assert.deepEqual(settled.operationsAfterClaim, ["cancel"]);
  // The text the provider had already produced is the cancelled ledger's own
  // presentation: an interruption settles what was produced, it does not drop it.
  assert.equal(settled.presentation, true);
});

test("Chat settles a Stop's own abort as a cancel before any presentation too", async () => {
  const settled = await driveClaimedCancel("running", true);
  assert.equal(settled.outcome, "cancelled");
  assert.equal(settled.ledgerStatus, "cancelled");
  assert.equal(settled.reasonCode, null);
  assert.deepEqual(settled.operationsAfterClaim, ["cancel"]);
  // ADR-0010:62 keeps committed presentation content and discards never-durable
  // preview deltas; a turn interrupted before its commit presents nothing, and that
  // is asserted as intended rather than left to chance.
  assert.equal(settled.presentation, false);
});

/**
 * The planted failure this gate is sensitive to, at both cancellable phases a
 * claim can reach: with nobody consuming the published winner, the stop's own
 * abort becomes `failed` / `runtime_unavailable` - the exact durable shape the real
 * run read back (`cancel_claimed_at_ms` null, the player told to retry a reply that
 * did not fail). Every assertion below is the inverse of the two tests above.
 */
test("the pre-fix reading is what this gate catches: a Stop's own abort becomes a false failure", async () => {
  for (const phase of ["running", "presentation_committed"] as const) {
    const planted = await driveClaimedCancel(phase, false);
    assert.equal(planted.outcome, "failed", `planted ${phase}`);
    assert.equal(planted.ledgerStatus, "failed", `planted ${phase}`);
    assert.equal(planted.reasonCode, "runtime_unavailable", `planted ${phase}`);
    assert.deepEqual(planted.operationsAfterClaim, ["fail"], `planted ${phase}`);
    assert.equal(planted.presentation, phase === "presentation_committed", `planted ${phase}`);
  }
});

/**
 * The one Pi surface a variant turn needs: a session that answers once with `reply`
 * and the provider-start observer that classifies the answer. `events` receives the
 * name of each Host step a variant turn orders, so a test can read that order.
 */
function variantRuntimeSession(reply: string, events: string[] = [], stopReason: "stop" | "length" = "stop"): object {
  let observer: Observer | undefined;
  return Object.freeze({
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
          events.push("prompt");
          const partial = nativeAssistant([nativeText("")]);
          emit({ type: "message_start", message: partial });
          emit({ type: "message_end", message: nativeAssistant([nativeText(reply)], "assistant_01", stopReason) });
          observer?.(Object.freeze({ statusClass: "success" as const }));
        },
      });
    })(),
  });
}

const variantFacts = Object.freeze({
  ...facts,
  variant: Object.freeze({ targetMessageId: "response_01", anchorMessageId: "player_01" }),
  // A variant turn answers an existing reply; it is not a reply-target turn, which is the other way a
  // turn can be told which row it speaks to. The two are mutually exclusive, so this is null here.
  replyToPlayerMessageId: null,
});

function branchedVariant(onRevert: () => void = () => undefined) {
  return Object.freeze({ status: "branched" as const, revert: onRevert });
}

test("a variant turn branches before its prompt and never mints a new message id", async () => {
  const events: string[] = [];
  let branchAnchorText: string | undefined;
  const { scope, presentationTransitions } = createScope({
    facts: variantFacts,
    presentationCommitted: () => true,
    branchVariantAnchor: async (anchorText: string) => {
      events.push("branch");
      branchAnchorText = anchorText;
      return branchedVariant();
    },
    runtimeSession: variantRuntimeSession("Regenerated reply.", events),
  });

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "completed");
  // The ordering: the branch runs before the prompt, so the request that prompt
  // builds reads the anchor line once and unanswered; the only transition that can
  // make the variant visible follows the reply.
  assert.deepEqual(events, ["branch", "prompt"]);
  assert.equal(branchAnchorText, "Hello");
  assert.deepEqual(
    presentationTransitions.map(({ operation }) => operation),
    ["commit_variant", "claim_completion", "complete"],
  );
  const commit = presentationTransitions[0];
  assert.equal(commit?.operation, "commit_variant");
  if (commit?.operation === "commit_variant") {
    assert.equal(commit.variant.targetMessageId, "response_01");
    assert.equal(commit.variant.text, "Regenerated reply.");
  }
});

test("a variant turn's own stop reason is the variant's, and the reply it replaced is not described by it", async () => {
  // Regenerate re-asks one position. The variant is a NEW generation with a
  // record of its own, so a variant the model cut off at its length ceiling is
  // truncated on its own terms - and a variant the model finished writes no
  // fact, whatever the reply it replaced had.
  for (const [stopReason, expected] of [
    ["length", true],
    ["stop", false],
  ] as const) {
    const { scope, presentationTransitions } = createScope({
      facts: variantFacts,
      presentationCommitted: () => true,
      branchVariantAnchor: async () => branchedVariant(),
      runtimeSession: variantRuntimeSession("Regenerated reply.", [], stopReason),
    });

    const result = await runMountedProviderStart(scope);

    assert.equal(result.outcome, "completed", stopReason);
    const commit = presentationTransitions[0];
    assert.equal(commit?.operation, "commit_variant", stopReason);
    assert.equal(commit !== undefined && "truncated" in commit, expected, stopReason);
    assert.equal(commit?.operation === "commit_variant" && commit.variant.targetMessageId, "response_01", stopReason);
  }
});

/**
 * The refusal half of the ordering: a position whose session shape the branch
 * cannot prove is never prompted and never committed, so the player-visible reply
 * is exactly what it was.
 */
test("a variant turn whose branch refuses prompts nothing, commits nothing, and fails", async () => {
  const events: string[] = [];
  const { scope, presentationTransitions } = createScope({
    facts: variantFacts,
    branchVariantAnchor: async () =>
      Object.freeze({ status: "refused" as const, reason: "variant_reply_tail_text_mismatch" as const }),
    runtimeSession: variantRuntimeSession("Regenerated reply.", events),
  });

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "failed");
  assert.deepEqual(events, []);
  assert.deepEqual(presentationTransitions, []);
  assert.equal(result.ledger.status, "failed");
  if (result.ledger.status === "failed") assert.equal(result.ledger.reasonCode, "runtime_unavailable");
});

/**
 * The compensation halves, asserted in both directions. A branch whose variant never
 * became durable must not stay in the model's history - not when the store refused
 * the commit before writing, and not when the prompt never produced one - while an
 * ambiguous failure may have committed it, and reverting there would produce the
 * same divergence mirrored.
 */
test("a variant commit that refused before it wrote reverts the branch, an ambiguous one does not", async () => {
  for (const [code, expectedReverts] of [
    ["p5_presentation_source_running_required", 1],
    ["chat_presentation_readback_mismatch", 0],
  ] as const) {
    let reverts = 0;
    const { scope, presentationTransitions } = createScope({
      facts: variantFacts,
      refuseVariantCommitWith: code,
      branchVariantAnchor: async () =>
        branchedVariant(() => {
          reverts += 1;
        }),
      runtimeSession: variantRuntimeSession("Regenerated reply."),
    });

    const result = await runMountedProviderStart(scope);

    assert.equal(result.outcome, "failed", code);
    // The commit was attempted and refused before it wrote: no presentation exists,
    // which is what makes the branch safe to put back.
    assert.deepEqual(
      presentationTransitions.map(({ operation }) => operation),
      ["commit_variant", "fail"],
      code,
    );
    assert.equal(result.ledger.presentation, null, code);
    assert.equal(reverts, expectedReverts, code);
  }
});

test("a variant turn whose prompt is rejected puts the branch back", async () => {
  let reverts = 0;
  const { scope } = createScope({
    facts: variantFacts,
    branchVariantAnchor: async () =>
      branchedVariant(() => {
        reverts += 1;
      }),
    runtimeSession: Object.freeze({
      installTavernProviderStartObserver() {
        return () => undefined;
      },
      session: Object.freeze({
        subscribe() {
          return () => undefined;
        },
        async prompt() {
          throw new Error("provider rejected");
        },
      }),
    }),
  });

  const result = await runMountedProviderStart(scope);

  assert.equal(result.outcome, "failed");
  assert.equal(reverts, 1);
});

/**
 * A provider refusal that arrives as a terminal assistant message rather than as a rejected
 * `session.prompt()`: Pi folds the endpoint's status and body into the message's own
 * `errorMessage` and resolves the prompt. That string is the one fact in this tree that says
 * WHY the endpoint refused, and it is deliberately never published - so what is asserted
 * below is what the DURABLE turn records, which is the fact a later surface reads.
 */
function refusalRuntimeSession(errorMessage: string): object {
  let observer: Observer | undefined;
  return Object.freeze({
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
          emit({ type: "message_start", message: nativeAssistant([nativeText("")]) });
          emit({
            type: "message_end",
            message: { ...nativeAssistant([nativeText("")], "assistant_01", "error"), errorMessage },
          });
          observer?.(Object.freeze({ statusClass: "error" as const }));
        },
      });
    })(),
  });
}

/** The durable failure command a refusal settled as, read without assuming its members. */
function recordedFailure(presentationTransitions: readonly PresentationTransition[]): Record<string, unknown> {
  const failure = presentationTransitions.find(({ operation }) => operation === "fail");
  assert.ok(failure !== undefined, "a refused turn writes one durable failure");
  return failure as unknown as Record<string, unknown>;
}

/**
 * The assertion this whole change exists for: a refused credential and a throttle are two
 * different facts with two different fixes, and the durable turn must be able to tell them
 * apart. Both arrive with a real provider status line, so this also fails if the classifier
 * ever stops distinguishing them.
 *
 * Before this, a 401 and a 429 both settled as `runtime_unavailable` with nothing beside it -
 * the player's one sentence named five causes and therefore prescribed nothing.
 */
test("a refused credential and a throttle do not settle as the same durable failure", async () => {
  const readings: unknown[] = [];
  for (const [errorMessage, expected] of [
    ['401: {"error":{"message":"Incorrect API key provided: sk-proj-AbC***XyZ"}}', "credential_rejected"],
    ['429: {"error":{"message":"Rate limit reached for requests per min"}}', "rate_limited"],
  ] as const) {
    const { scope, presentationTransitions } = createScope({ runtimeSession: refusalRuntimeSession(errorMessage) });
    const result = await runMountedProviderStart(scope);
    assert.equal(result.outcome, "failed", errorMessage);
    assert.equal(recordedFailure(presentationTransitions).providerFailure, expected, errorMessage);
    readings.push(recordedFailure(presentationTransitions).providerFailure);
  }
  assert.notEqual(
    readings[0],
    readings[1],
    `a 401 and a 429 must not settle identically; both read ${String(readings[0])}`,
  );
});

/**
 * The smallest real Voice Gateway the Chat speech sink can be driven against.
 *
 * The sink, its protocol frames and the job rules under test are production
 * (`voice-gateway-client.ts`); only the peer is a double. It answers the
 * handshake and the health probe the sink gates its streaming lane on, and it
 * records every frame, so a reading can name what actually crossed the wire.
 */
async function startFakeVoiceGateway(): Promise<
  Readonly<{
    connect(): Promise<LocalVoiceGatewayClient>;
    frames(type: string): readonly Record<string, unknown>[];
    close(): Promise<void>;
  }>
> {
  const seen: Record<string, unknown>[] = [];
  let peer: Socket | undefined;
  const server = await new Promise<Server>((resolvePromise, reject) => {
    const listener = createServer((socket) => {
      peer = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown> & { requestId: string };
          buffer = buffer.slice(newline + 1);
          seen.push(frame);
          const write = (value: Record<string, unknown>): void => {
            socket.write(`${JSON.stringify({ requestId: frame.requestId, ...value })}\n`);
          };
          if (frame.type === "hello") write({ type: "hello_ack", protocolVersion: 1 });
          else if (frame.type === "health")
            write({
              type: "health",
              protocolVersion: 1,
              status: "ready",
              capabilities: {
                providerId: "fake-tts",
                modelRevision: "v1",
                perUtteranceDirection: false,
                ready: true,
                epoch: 3,
              },
            });
        }
      });
    });
    listener.listen(0, "127.0.0.1", () => resolvePromise(listener)).once("error", reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return Object.freeze({
    async connect(): Promise<LocalVoiceGatewayClient> {
      const client = await LocalVoiceGatewayClient.connect({ port: address.port, token: "voice_token_1234567890" });
      await client.health();
      return client;
    },
    frames: (type: string) => seen.filter((frame) => frame.type === type),
    async close(): Promise<void> {
      peer?.destroy();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error == null ? resolvePromise() : reject(error))),
      );
    },
  });
}

/**
 * The speech job a turn opens belongs to that turn's own scope, and the Chat
 * surface reuses ONE sink for the life of the page. So a job the runner leaves
 * open is not a local leak: `begin()` refuses the next turn
 * (`voice_speech_job_already_open`) and that turn is silently mute, because the
 * refusal is caught and degraded.
 *
 * The failure this catches: the job was opened before the provider was invoked
 * (before the arm revalidation, the preset read, and the prompt), so every exit
 * between those points - a revoked admission, an expired deadline, a refused
 * preset, a refused variant branch - returned without the `finalize()` the
 * content callback sends or the `cancel()` the rejection callback sends.
 */
test("a turn that ends before its provider starts closes the voice job it opened", async () => {
  const gateway = await startFakeVoiceGateway();
  try {
    const client = await gateway.connect();
    const speechSink = client.createChatVoiceStreamingSink();
    let admissionRevoked = false;
    const { scope } = createScope({
      runtimeSession: Object.freeze({
        installTavernProviderStartObserver: () => () => undefined,
        session: Object.freeze({ prompt: async () => undefined }),
      }),
      assertAdmission: () => {
        if (admissionRevoked) throw new Error("semantic_chat_runtime_p4_provider_start_deadline_expired");
      },
      readAcceptedMessageText: async () => {
        admissionRevoked = true;
        return "Hello";
      },
    });

    const result = await runMountedProviderStart(scope, undefined, speechSink);

    assert.equal(result.outcome, "not_started", "the turn ends before its provider is invoked");
    // The decisive reading: the next turn's job is admitted. The production sink
    // refuses `begin()` while a job is open, and this is the same sink instance
    // the surface keeps for every later turn.
    let refusal: unknown;
    try {
      await speechSink.begin("turn_02");
    } catch (error) {
      refusal = error;
    }
    assert.equal(
      refusal,
      undefined,
      `the next turn's speech job was refused by the turn before it: ${String(refusal)}`,
    );
  } finally {
    await gateway.close();
  }
});

/**
 * A Stop during companion speech: Pi aborts the run, so `message_end` carries
 * `stopReason: "aborted"` (`pi-agent-core`'s `handleRunFailure`), the native
 * content observer turns that into `onRejected("aborted")`, and the runner
 * answers it with `speechSink.cancel()`.
 *
 * This pins the reading the surface depends on: after an aborted speech turn the
 * next turn is admitted AND voiced under its own job id - a job left open would
 * have the second turn refused at `begin()` and its deltas written into the first
 * turn's abandoned job instead. It also pins that closing the job on the way out
 * cannot double-cancel: one `cancel_speech` per aborted job.
 */
test("an aborted speech turn closes its job, so the next turn is voiced under its own job", async () => {
  const gateway = await startFakeVoiceGateway();
  try {
    const client = await gateway.connect();
    const speechSink = client.createChatVoiceStreamingSink();
    let observer: Observer | undefined;
    const deltas = ["我先想想。", "今天有雨。"];
    const { scope } = createScope({
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
              await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
              emit({
                type: "message_update",
                message: partial,
                assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
              });
              for (const delta of deltas)
                emit({
                  type: "message_update",
                  message: partial,
                  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
                });
              // The Stop: Pi settles the run by aborting it, and the run promise
              // itself still fulfils - only the message says why it ended.
              emit({
                type: "message_end",
                message: nativeAssistant([nativeText(deltas.join(""))], "assistant_01", "aborted"),
              });
            },
          });
        })(),
      }),
      finalizeCancellation: async () => cancelled(),
    });

    const result = await runMountedProviderStart(scope, undefined, speechSink);

    assert.equal(result.outcome, "cancelled", "a Stop that aborted the speech wins the turn");
    // The sink's writes are socket writes: give the loopback peer the tick it
    // needs before reading what actually crossed the wire.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    const chunks = gateway.frames("stream_speech_chunk");
    assert.equal(chunks.length, deltas.length, "the reply's deltas reached the gateway as chunks");
    const cancels = gateway.frames("cancel_speech");
    assert.equal(cancels.length, 1, "exactly one cancel closes the aborted job");
    assert.equal(cancels[0]?.speechJobId, chunks[0]?.speechJobId, "the cancel names the streamed job");

    // The decisive reading: the next turn is admitted, and its own chunks carry
    // its own job and session - not the abandoned turn's.
    await speechSink.begin("turn_02");
    await speechSink.append("第二轮的答复。");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    const nextChunks = gateway.frames("stream_speech_chunk").slice(chunks.length);
    assert.equal(nextChunks.length, 1, "the next turn streams under its own job");
    assert.ok(
      String(nextChunks[0]?.speechJobId).startsWith("chat_turn_turn_02_"),
      "the job id belongs to the second turn",
    );
    assert.ok(
      String(nextChunks[0]?.sessionId).startsWith("chat_turn_turn_02"),
      "the session belongs to the second turn",
    );
  } finally {
    await gateway.close();
  }
});
