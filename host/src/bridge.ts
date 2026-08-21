import { EventEmitter } from "node:events";

import {
  type BridgeMessage,
  EVENT_WINDOW_MS,
  MAX_EVENTS_PER_WINDOW,
  type Scope,
  serializeBounded,
  validateBridgeMessage,
} from "./protocol.js";

export type BridgeFault = "disconnected" | "invalid_message" | "message_too_large" | "rate_limited";

/**
 * Deterministic in-memory Phase 2 transport. It models delivery, ordering,
 * bounded payloads, rate limits, and disconnection without selecting the
 * production Windows IPC mechanism.
 */
export class DeterministicBridgeEndpoint {
  readonly #events = new EventEmitter();
  #peer: DeterministicBridgeEndpoint | undefined;
  #connected = true;
  #eventWindowStartedAt = 0;
  #eventsInWindow = 0;

  public constructor(readonly scope: Scope) {}

  public connect(peer: DeterministicBridgeEndpoint): void {
    if (peer === this) throw new Error("bridge_self_connect_forbidden");
    this.#peer = peer;
    this.#connected = true;
  }

  public get connected(): boolean {
    return this.#connected && this.#peer !== undefined && this.#peer.#connected;
  }

  public onMessage(listener: (message: BridgeMessage) => void): () => void {
    this.#events.on("message", listener);
    return () => this.#events.off("message", listener);
  }

  public onDisconnect(listener: (reasonCode: string) => void): () => void {
    this.#events.on("disconnect", listener);
    return () => this.#events.off("disconnect", listener);
  }

  public send(message: BridgeMessage, nowMs = Date.now()): BridgeFault | null {
    if (!this.connected || this.#peer === undefined) return "disconnected";
    try {
      serializeBounded(message);
    } catch (error) {
      return error instanceof Error && error.message === "message_too_large" ? "message_too_large" : "invalid_message";
    }
    if (
      validateBridgeMessage(message, this.scope, nowMs) !== null ||
      validateBridgeMessage(message, this.#peer.scope, nowMs) !== null
    )
      return "invalid_message";
    if (message.type === "execution_request") {
      // Execution requests require snapshot-specific validation at the Mod;
      // transport only verifies their bounded, scoped envelope.
    }
    if (message.type === "semantic_event" && this.rateLimited(nowMs)) return "rate_limited";
    this.#peer.#events.emit("message", structuredClone(message));
    return null;
  }

  public disconnect(reasonCode = "local_disconnect"): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#events.emit("disconnect", reasonCode);
    if (this.#peer !== undefined) this.#peer.#peerDisconnected(reasonCode);
  }

  #peerDisconnected(reasonCode: string): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#events.emit("disconnect", reasonCode);
  }

  private rateLimited(nowMs: number): boolean {
    if (nowMs - this.#eventWindowStartedAt >= EVENT_WINDOW_MS) {
      this.#eventWindowStartedAt = nowMs;
      this.#eventsInWindow = 0;
    }
    this.#eventsInWindow++;
    return this.#eventsInWindow > MAX_EVENTS_PER_WINDOW;
  }
}

export function createDeterministicBridgePair(
  scope: Scope,
): readonly [DeterministicBridgeEndpoint, DeterministicBridgeEndpoint] {
  const host = new DeterministicBridgeEndpoint(scope);
  const integration = new DeterministicBridgeEndpoint(scope);
  host.connect(integration);
  integration.connect(host);
  return [host, integration];
}
