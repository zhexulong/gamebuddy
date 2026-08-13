import { randomUUID } from "node:crypto";

import { CompanionLoop } from "./companion-loop.js";
import { type WorldFact } from "./event-pump.js";
import { type IntegrationEventSource, type IntegrationLifecycleEvent } from "./integration-launcher.js";
import { deliverFinalVoiceInput, type FinalVoiceInput } from "./voice.js";

export type FinalVoiceSource = Readonly<{ onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void }>;

function isEventPumpOverflow(error: unknown): boolean {
  return error instanceof Error &&
    (error.message === "event_pump_terminal_overflow" || error.message === "event_pump_event_overflow");
}

/**
 * Host glue with deliberately limited authority: validated adapter facts become
 * ordinary Agent turns; it neither plans actions nor predicts execution outcomes.
 */
export class CompanionHostService {
  readonly #unsubscribe: () => void;
  readonly #unsubscribeConnection: () => void;
  #unsubscribeVoice: (() => Promise<void>) | undefined;
  #flushScheduled = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = 50;
  #closed = false;
  #integrationAdmissionOpen = true;

  public constructor(
    private readonly loop: CompanionLoop,
    events: IntegrationEventSource,
    private readonly onIntegrationDisconnected?: (reasonCode: string) => void,
  ) {
    this.#unsubscribe = events.onFact((fact) => this.acceptIntegrationFact(fact));
    this.#unsubscribeConnection = events.onLifecycle((event) => this.acceptLifecycleEvent(event));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#unsubscribeConnection();
    const detachVoice = this.#unsubscribeVoice;
    // Detach synchronously so a closed Host never retains an admitting Voice
    // Gateway callback. Gateways whose unsubscribe is asynchronous may finish
    // their own cleanup afterwards, but admission stops at this boundary now.
    this.#unsubscribeVoice = undefined;
    if (detachVoice !== undefined) void detachVoice();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
  }

  /** Keyboard text follows the same labelled player-input path as final voice. */
  public async acceptPlayerText(text: string, locale = "zh-CN", timestampMs = Date.now()): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen || text.trim().length === 0) return;
    this.loop.pump.enqueuePlayerInput({ source: "player_text", inputId: randomUUID(), text, locale, timestampMs });
    await this.flushSoon();
  }

  /** Final voice input follows the same labelled player-input path as text. */
  public async acceptFinalVoice(input: FinalVoiceInput): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    await deliverFinalVoiceInput({
      receive: async (final) => {
        this.loop.pump.enqueuePlayerInput({
          source: "voice_final", inputId: final.inputId, text: final.text,
          locale: final.locale, timestampMs: final.timestampMs,
        });
        await this.flushSoon();
      },
    }, input);
  }

  /** Attach only a Gateway that already validates/authenticates final ASR events. */
  public attachFinalVoiceSource(source: FinalVoiceSource, _sessionId?: string): () => Promise<void> {
    if (this.#unsubscribeVoice !== undefined) void this.#unsubscribeVoice();
    const unsubscribe = source.onFinalTranscript((input) => {
      // Gateway callbacks are not a game-thread boundary. A provider failure
      // remains local to voice; the Host event pump preserves pending input.
      void this.acceptFinalVoice(input).catch(() => undefined);
    });
    let detached = false;
    const wrapped = (): Promise<void> => {
      if (!detached) {
        detached = true;
        // Unsubscribe before returning so close/replacement immediately seals
        // listener admission; the Promise preserves the public cleanup shape.
        unsubscribe();
        if (this.#unsubscribeVoice === wrapped) this.#unsubscribeVoice = undefined;
      }
      return Promise.resolve();
    };
    this.#unsubscribeVoice = wrapped;
    return wrapped;
  }

  /** Initial launch facts were already adapter-validated before runtime mount. */
  public acceptInitialFacts(facts: readonly WorldFact[]): void {
    for (const fact of facts) this.acceptIntegrationFact(fact);
  }

  private acceptIntegrationFact(fact: WorldFact): void {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    // This source label is Host-reserved so an adapter cannot manufacture a
    // local transport transition and have it confused with Host lifecycle.
    if (fact.source === "host_local_transport") throw new Error("adapter_transport_source_reserved");
    try {
      this.loop.pump.enqueueFact(fact);
    } catch (error) {
      if (!isEventPumpOverflow(error)) throw error;
      this.#containIntegrationOverflow();
      return;
    }
    void this.flushSoon().catch(() => undefined);
  }

  private acceptLifecycleEvent(event: IntegrationLifecycleEvent): void {
    if (this.#closed || !this.#integrationAdmissionOpen) return;
    // This truthfully identifies the local adapter transport; it is never
    // presented as a game-world fact emitted by the integration. Its admission
    // must happen before invoking external code: a synchronous reentrant
    // callback must observe either the queued terminal event or a sealed pump.
    try {
      this.loop.pump.enqueueFact({ source: "host_local_transport", kind: "lifecycle", correlationId: `transport_${event.state}`, revision: 0, payload: event });
    } catch (error) {
      if (!isEventPumpOverflow(error)) throw error;
      this.#containIntegrationOverflow();
      return;
    }
    // Every lifecycle event accepted by this port is terminal (the only
    // non-terminal state, `ready`, is admitted before bootstrap). Revoke the
    // Host execution fence for both transport loss and orderly adapter stop.
    this.onIntegrationDisconnected?.(event.reasonCode);
    void this.flushSoon().catch(() => undefined);
  }

  /**
   * Overflow has no Host-owned resynchronization authority. Revoke this
   * integration and discard every pending frame rather than deliver a partial
   * or stale view of the world. The callback may throw, but clear remains an
   * unconditional cancellation boundary and its error never replaces it.
   */
  #containIntegrationOverflow(revocationAlreadyRequested = false): void {
    if (!this.#integrationAdmissionOpen) return;
    this.#integrationAdmissionOpen = false;
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    let callbackError: unknown;
    try {
      if (!revocationAlreadyRequested) this.onIntegrationDisconnected?.("event_overflow");
    } catch (error) {
      callbackError = error;
    } finally {
      try {
        this.loop.pump.clear();
      } catch (clearError) {
        if (callbackError === undefined) throw clearError;
      }
    }
    if (callbackError !== undefined) throw callbackError;
  }

  private async flushSoon(): Promise<void> {
    if (this.#closed || !this.#integrationAdmissionOpen || this.#flushScheduled) return;
    this.#flushScheduled = true;
    try {
      // A microtask coalesces bursts of Mod receipts/snapshots without adding
      // an intent layer or holding game-thread/pipe work open.
      await Promise.resolve();
      // An overflow can occur after this work was scheduled. Admission is the
      // Host-owned cancellation fence for scheduled and retry flushes.
      if (!this.#closed && this.#integrationAdmissionOpen) await this.loop.flush();
      this.#retryDelayMs = 50;
    } catch (error) {
      // EventPump restored the exact batch. Do not spin or create an unhandled
      // rejection when a provider/session is unavailable; retry with bounded
      // exponential backoff and retain backpressure in the pump.
      this.scheduleRetry();
      // Callers that await explicit player input receive the failure, while
      // bridge callbacks catch it at their boundary.
      throw error;
    } finally {
      this.#flushScheduled = false;
      // Facts may arrive after this invocation has captured its batch but
      // before its provider turn completes. Their attempted flush correctly
      // returned while scheduled; wake one follow-up turn without requiring an
      // unrelated third event.
      if (!this.#closed && this.#integrationAdmissionOpen && this.#retryTimer === undefined && this.loop.pump.pendingCount > 0) {
        // Only a successful flush should immediately drain work accepted while
        // it was running. On failure scheduleRetry owns the next attempt.
        // Otherwise a rejected provider turn would recurse in this finally.
        if (this.#retryDelayMs === 50) void this.flushSoon().catch(() => undefined);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.#closed || !this.#integrationAdmissionOpen || this.#retryTimer !== undefined || this.loop.pump.pendingCount === 0) return;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, 5_000);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushSoon().catch(() => undefined);
    }, delay);
  }
}
