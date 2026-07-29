import { randomUUID } from "node:crypto";

import { CompanionLoop } from "./companion-loop.js";
import { type WorldFact } from "./event-pump.js";
import { type LocalStardewBridgeClient, type LocalStardewBridgeFact, type LocalStardewConnectionFact } from "./local-stardew-bridge.js";
import { type VoiceExpression, deliverFinalVoiceInput, expressTextFirst, type FinalVoiceInput, type VisibleTextSink, type VoiceSpeechPort } from "./voice.js";

/**
 * Host glue with deliberately limited authority: bridge facts become ordinary
 * Agent turns; it neither plans actions nor predicts execution outcomes.
 */
export class CompanionHostService {
  readonly #unsubscribe: () => void;
  readonly #unsubscribeConnection: () => void;
  #flushScheduled = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = 50;
  #closed = false;

  public constructor(
    private readonly loop: CompanionLoop,
    bridge: Pick<LocalStardewBridgeClient, "onFact" | "onConnectionFact">,
  ) {
    this.#unsubscribe = bridge.onFact((fact) => this.acceptBridgeFact(fact));
    this.#unsubscribeConnection = bridge.onConnectionFact((fact) => this.acceptConnectionFact(fact));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#unsubscribeConnection();
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

  /** Visible text is committed first; speech is a non-authoritative side path. */
  public async express(
    visible: VisibleTextSink,
    speech: VoiceSpeechPort | undefined,
    input: Omit<VoiceExpression, "expressionId">,
  ): Promise<VoiceExpression> {
    return expressTextFirst(visible, speech, input);
  }

  /** Initial observation is forwarded exactly as an authoritative Mod fact. */
  public acceptInitialSnapshot(snapshot: LocalStardewBridgeFact): void {
    this.acceptBridgeFact(snapshot);
  }

  private acceptBridgeFact(message: LocalStardewBridgeFact): void {
    if (this.#closed) return;
    const fact = toWorldFact(message);
    if (fact === null) return;
    this.loop.pump.enqueueFact(fact);
    void this.flushSoon().catch(() => undefined);
  }

  private acceptConnectionFact(fact: LocalStardewConnectionFact): void {
    if (this.#closed) return;
    // This truthfully identifies the local transport source; it is never
    // presented as a Stardew world/lifecycle fact emitted by the Mod.
    this.loop.pump.enqueueFact({ source: "host_local_transport", kind: "lifecycle", correlationId: `transport_${fact.state}`, revision: 0, payload: fact });
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
        void this.flushSoon().catch(() => undefined);
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

function toWorldFact(message: LocalStardewBridgeFact): WorldFact | null {
  switch (message.type) {
    case "snapshot":
      return { source: "stardew_mod", kind: "snapshot", correlationId: message.correlationId, revision: message.payload.revision, payload: message.payload };
    case "execution_receipt":
      return { source: "stardew_mod", kind: "execution_receipt", correlationId: message.payload.executionId, revision: message.payload.revision, payload: message.payload };
    case "semantic_event":
      // The event pump deliberately has no intent taxonomy. Preserve this
      // Mod-originated low-frequency fact as a lifecycle/event record instead
      // of inventing a Host semantic interpretation.
      return { source: "stardew_mod", kind: "lifecycle", correlationId: message.correlationId, revision: message.payload.revision, payload: message.payload };
    case "lifecycle":
      return { source: "stardew_mod", kind: "lifecycle", correlationId: message.correlationId, revision: 0, payload: message.payload };
  }
}
