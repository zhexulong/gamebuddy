import { randomUUID } from "node:crypto";

import { CompanionLoop } from "./companion-loop.js";
import { type WorldFact } from "./event-pump.js";
import { type IntegrationEventSource, type IntegrationLifecycleEvent } from "./integration-launcher.js";
import { deliverFinalVoiceInput, type FinalVoiceInput } from "./voice.js";

export type FinalVoiceSource = Readonly<{ onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void }>;

/**
 * Host glue with deliberately limited authority: validated adapter facts become
 * ordinary Agent turns; it neither plans actions nor predicts execution outcomes.
 */
export class CompanionHostService {
  readonly #unsubscribe: () => void;
  readonly #unsubscribeConnection: () => void;
  #unsubscribeVoice: (() => void) | undefined;
  #flushScheduled = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = 50;
  #closed = false;

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
    this.#unsubscribeVoice?.();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
  }

  /** Keyboard text follows the same labelled player-input path as final voice. */
  public async acceptPlayerText(text: string, locale = "zh-CN", timestampMs = Date.now()): Promise<void> {
    if (text.trim().length === 0) return;
    this.loop.pump.enqueuePlayerInput({ source: "player_text", inputId: randomUUID(), text, locale, timestampMs });
    await this.flushSoon();
  }

  /** Final voice input follows the same labelled player-input path as text. */
  public async acceptFinalVoice(input: FinalVoiceInput): Promise<void> {
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
  public attachFinalVoiceSource(source: FinalVoiceSource): () => void {
    this.#unsubscribeVoice?.();
    const unsubscribe = source.onFinalTranscript((input) => {
      // Gateway callbacks are not a game-thread boundary. A provider failure
      // remains local to voice; the Host event pump preserves pending input.
      void this.acceptFinalVoice(input).catch(() => undefined);
    });
    const wrapped = () => {
      unsubscribe();
      if (this.#unsubscribeVoice === wrapped) this.#unsubscribeVoice = undefined;
    };
    this.#unsubscribeVoice = wrapped;
    return wrapped;
  }

  /** Initial launch facts were already adapter-validated before runtime mount. */
  public acceptInitialFacts(facts: readonly WorldFact[]): void {
    for (const fact of facts) this.acceptIntegrationFact(fact);
  }

  private acceptIntegrationFact(fact: WorldFact): void {
    if (this.#closed) return;
    // This source label is Host-reserved so an adapter cannot manufacture a
    // local transport transition and have it confused with Host lifecycle.
    if (fact.source === "host_local_transport") throw new Error("adapter_transport_source_reserved");
    this.loop.pump.enqueueFact(fact);
    void this.flushSoon().catch(() => undefined);
  }

  private acceptLifecycleEvent(event: IntegrationLifecycleEvent): void {
    if (this.#closed) return;
    // Every lifecycle event accepted by this port is terminal (the only
    // non-terminal state, `ready`, is admitted before bootstrap). Revoke the
    // Host execution fence for both transport loss and orderly adapter stop.
    this.onIntegrationDisconnected?.(event.reasonCode);
    // This truthfully identifies the local adapter transport; it is never
    // presented as a game-world fact emitted by the integration.
    this.loop.pump.enqueueFact({ source: "host_local_transport", kind: "lifecycle", correlationId: `transport_${event.state}`, revision: 0, payload: event });
    void this.flushSoon().catch(() => undefined);
  }

  private async flushSoon(): Promise<void> {
    if (this.#closed || this.#flushScheduled) return;
    this.#flushScheduled = true;
    try {
      // A microtask coalesces bursts of Mod receipts/snapshots without adding
      // an intent layer or holding game-thread/pipe work open.
      await Promise.resolve();
      if (!this.#closed) await this.loop.flush();
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
      if (!this.#closed && this.#retryTimer === undefined && this.loop.pump.pendingCount > 0) {
        // Only a successful flush should immediately drain work accepted while
        // it was running. On failure scheduleRetry owns the next attempt.
        // Otherwise a rejected provider turn would recurse in this finally.
        if (this.#retryDelayMs === 50) void this.flushSoon().catch(() => undefined);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.#closed || this.#retryTimer !== undefined || this.loop.pump.pendingCount === 0) return;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, 5_000);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushSoon().catch(() => undefined);
    }, delay);
  }
}
