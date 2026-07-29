import { randomUUID } from "node:crypto";

import { CompanionLoop } from "./companion-loop.js";
import { type WorldFact } from "./event-pump.js";
import { type LocalStardewBridgeClient, type LocalStardewBridgeFact } from "./local-stardew-bridge.js";
import { type VoiceExpression, deliverFinalVoiceInput, expressTextFirst, type FinalVoiceInput, type VisibleTextSink, type VoiceSpeechPort } from "./voice.js";

/**
 * Host glue with deliberately limited authority: bridge facts become ordinary
 * Agent turns; it neither plans actions nor predicts execution outcomes.
 */
export class CompanionHostService {
  readonly #unsubscribe: () => void;
  #flushScheduled = false;
  #closed = false;

  public constructor(
    private readonly loop: CompanionLoop,
    bridge: Pick<LocalStardewBridgeClient, "onFact">,
  ) {
    this.#unsubscribe = bridge.onFact((fact) => this.acceptBridgeFact(fact));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
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

  private acceptBridgeFact(message: LocalStardewBridgeFact): void {
    if (this.#closed) return;
    const fact = toWorldFact(message);
    if (fact === null) return;
    this.loop.pump.enqueueFact(fact);
    void this.flushSoon();
  }

  private async flushSoon(): Promise<void> {
    if (this.#closed || this.#flushScheduled) return;
    this.#flushScheduled = true;
    try {
      // A microtask coalesces bursts of Mod receipts/snapshots without adding
      // an intent layer or holding game-thread/pipe work open.
      await Promise.resolve();
      if (!this.#closed) await this.loop.flush();
    } finally {
      this.#flushScheduled = false;
      if (!this.#closed && this.loop.pump.pendingCount > 0) void this.flushSoon();
    }
  }
}

function toWorldFact(message: LocalStardewBridgeFact): WorldFact | null {
  switch (message.type) {
    case "snapshot":
      return { source: "stardew_mod", kind: "snapshot", correlationId: message.correlationId, revision: message.payload.revision, payload: message.payload };
    case "execution_receipt":
      return { source: "stardew_mod", kind: "execution_receipt", correlationId: message.payload.executionId, revision: message.payload.revision, payload: message.payload };
    case "semantic_event":
      return { source: "stardew_mod", kind: "lifecycle", correlationId: message.correlationId, revision: message.payload.revision, payload: message.payload };
    case "lifecycle":
      return { source: "stardew_mod", kind: "lifecycle", correlationId: message.correlationId, revision: 0, payload: message.payload };
  }
}
