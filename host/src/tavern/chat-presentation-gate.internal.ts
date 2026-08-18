import type { CompanionInterruption, InterruptionSnapshot } from "../companion-interruption.js";
import type {
  ChatCompanionTextExpression,
  CompanionTextExpression,
  CompanionTextPort,
  HostPresentationAdmissionProvider,
  PresentationCommitAdmission,
} from "../presentation.js";

/**
 * The narrow, one-shot activation handed to the P4 runner for exactly one
 * invocation. It is minted by the coordinator against the exact mounted lease
 * and attempt; it carries the running barrier and revocation after active
 * presentation callbacks drain. The exact-attempt P5 commit port remains
 * internal to the gate's consumed text admission path.
 */
export type ChatPresentationStartActivation = Readonly<{
  /** P4 runner resolves this immediately after the durable running transition. */
  runningBarrier: Promise<void>;
  resolveRunning(): void;
  /** Synchronously rejects new captures/uses; it never waits for callback drain. */
  revoke(): void;
  /** Waits for callbacks already admitted before revocation to settle. */
  drain(): Promise<void>;
  /** Convenience close: revoke synchronously, then drain. */
  deactivate(): Promise<void>;
}>;

/** Coordinator-minted binding facts for one gate activation. */
export type ChatPresentationGateActivationInput = Readonly<{
  epoch: CompanionInterruption;
  observationEpoch: InterruptionSnapshot;
  /**
   * Synchronous cancel/commit arbitration. Returning a release function wins
   * the commit linearization point; returning undefined means the epoch was
   * stopped before the durable transition could be reserved.
   */
  reserveCommit(observationEpoch: InterruptionSnapshot): (() => void) | undefined;
  commitPresentation(expression: ChatCompanionTextExpression): Promise<void>;
}>;

/**
 * Chat-only, default-unbound presentation gate (design/71 §3.4 tracer bullet).
 * It implements both the Host admission provider and the Chat text port: the
 * `companion_text` tool is registered at construction, but capture fails
 * closed (`presentation_admission_unbound`) until the coordinator binds the
 * gate to the exact P4 invocation. A bound text delivery waits for the durable
 * running barrier, re-asserts the exact active cancel epoch, commits exactly
 * once through the coordinator's exact P5 store port, and only then forwards
 * to construction sink listeners.
 */
export type ChatPresentationGate = Readonly<{
  admissionProvider: HostPresentationAdmissionProvider;
  textPort: CompanionTextPort;
  attach(listener: (expression: CompanionTextExpression) => void | Promise<void>): () => void;
  /** Coordinator-private activation seam; at most one live binding exists. */
  activate(input: ChatPresentationGateActivationInput): ChatPresentationStartActivation;
}>;

type ActiveGateBinding = Readonly<{
  epoch: CompanionInterruption;
  observationEpoch: InterruptionSnapshot;
  commitPresentation(expression: ChatCompanionTextExpression): Promise<void>;
  reserveCommit(observationEpoch: InterruptionSnapshot): (() => void) | undefined;
  hostBindings: WeakSet<object>;
  consumedBindings: WeakSet<object>;
  admissionTaken: { value: boolean };
  pending: Set<Promise<void>>;
  runningBarrier: Promise<void>;
  resolveRunning(): void;
  rejectBarrier(reason: unknown): void;
  /** True only while new callbacks may capture/use this invocation admission. */
  accepting: { value: boolean };
  /** Remains true through drain so already-reserved work can complete. */
  active: { value: boolean };
}>;

export function createChatPresentationGate(): ChatPresentationGate {
  const listeners = new Set<(expression: CompanionTextExpression) => void | Promise<void>>();
  let binding: ActiveGateBinding | undefined;

  const assertActive = (): ActiveGateBinding => {
    if (binding === undefined || !binding.active.value) throw new Error("presentation_admission_unbound");
    if (!binding.accepting.value) throw new Error("presentation_admission_revoked");
    return binding;
  };
  const assertAdmissionCurrent = (activeBinding: ActiveGateBinding): void => {
    if (
      !activeBinding.active.value ||
      !activeBinding.accepting.value ||
      !activeBinding.epoch.isCurrent(activeBinding.observationEpoch)
    )
      throw new Error("presentation_admission_revoked");
  };

  const capture = (): Readonly<{
    surface: "chat";
    sourceEventId?: never;
    admission: PresentationCommitAdmission;
  }> => {
    const activeBinding = assertActive();
    if (activeBinding.admissionTaken.value) throw new Error("presentation_admission_replayed");
    // This is the one callback admission for the exact P4 invocation. Consume
    // it at capture time so a second tool call cannot race a pending first one.
    activeBinding.admissionTaken.value = true;
    const hostBinding = Object.freeze({});
    activeBinding.hostBindings.add(hostBinding);
    return Object.freeze({
      surface: "chat" as const,
      admission: Object.freeze({
        hostBinding,
        assertHostCurrent(candidate: object) {
          if (!activeBinding.hostBindings.has(candidate)) throw new Error("presentation_admission_unbound");
          assertAdmissionCurrent(activeBinding);
        },
      }),
    });
  };

  const present = async (
    expression: CompanionTextExpression,
    admission: PresentationCommitAdmission,
  ): Promise<void> => {
    if (expression.surface !== "chat") throw new Error("presentation_surface_mismatch");
    const activeBinding = assertActive();
    if (!activeBinding.hostBindings.has(admission.hostBinding)) throw new Error("presentation_admission_unbound");
    if (activeBinding.consumedBindings.has(admission.hostBinding))
      throw new Error("presentation_admission_replayed");
    // Consume before awaiting the running barrier. A callback that later loses
    // the barrier cannot replay the same captured authority after the lease
    // changes or after another callback commits.
    activeBinding.consumedBindings.add(admission.hostBinding);
    const work = (async () => {
      // The running barrier is the first linearization: no store mutation may
      // occur before the durable running transition. After it opens, re-assert
      // the exact active cancel epoch, then commit exactly once and only then
      // deliver to construction listeners.
      await activeBinding.runningBarrier;
      assertAdmissionCurrent(activeBinding);
      // The synchronous reservation is the cancel/commit linearization point.
      // A STOP that wins before this call makes the reservation unavailable;
      // a STOP after it is ordered after the presentation commit, even if the
      // filesystem transaction itself is asynchronous.
      const releaseCommit = activeBinding.reserveCommit(activeBinding.observationEpoch);
      if (releaseCommit === undefined) throw new Error("presentation_admission_revoked");
      try {
        await activeBinding.commitPresentation(expression);
      } finally {
        releaseCommit();
      }
      await Promise.all([...listeners].map(async (listener) => await listener(expression)));
    })();
    activeBinding.pending.add(work);
    try {
      await work;
    } finally {
      activeBinding.pending.delete(work);
    }
  };

  const activate = (input: ChatPresentationGateActivationInput): ChatPresentationStartActivation => {
    if (binding !== undefined) throw new Error("chat_presentation_gate_already_bound");
    let resolveRunning!: () => void;
    let rejectBarrier!: (reason: unknown) => void;
    const runningBarrier = new Promise<void>((resolve, reject) => {
      resolveRunning = resolve;
      rejectBarrier = reject;
    });
    const activeBinding: ActiveGateBinding = Object.freeze({
      epoch: input.epoch,
      observationEpoch: input.observationEpoch,
      commitPresentation: input.commitPresentation,
      reserveCommit: input.reserveCommit,
      hostBindings: new WeakSet<object>(),
      consumedBindings: new WeakSet<object>(),
      admissionTaken: { value: false },
      pending: new Set<Promise<void>>(),
      runningBarrier,
      resolveRunning,
      rejectBarrier,
      accepting: { value: true },
      active: { value: true },
    });
    binding = activeBinding;
    // A rejected barrier is observed by every callback that captured it, but
    // must not become an unhandled rejection when this invocation emits no
    // presentation callback at all.
    void runningBarrier.catch(() => undefined);
    const revoke = (): void => {
      // Synchronously cut off capture and callbacks that have not won the
      // reservation. Work that already reserved remains active solely to
      // complete its ordered durable commit and listener drain.
      activeBinding.accepting.value = false;
      activeBinding.rejectBarrier(new Error("presentation_admission_revoked"));
    };
    const drain = async (): Promise<void> => {
      await Promise.allSettled([...activeBinding.pending]);
      activeBinding.active.value = false;
      if (binding === activeBinding) binding = undefined;
    };
    return Object.freeze({
      runningBarrier,
      resolveRunning: () => activeBinding.resolveRunning(),
      revoke,
      drain,
      deactivate: async () => {
        revoke();
        await drain();
      },
    });
  };

  return Object.freeze({
    admissionProvider: Object.freeze({ capture }),
    textPort: Object.freeze({ present }),
    attach(listener: (expression: CompanionTextExpression) => void | Promise<void>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate,
  });
}