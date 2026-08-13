import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const DIALOGUE_INPUT_KIND = "gamebuddy_dialogue_input_v1" as const;
export const MAX_DIALOGUE_TEXT_BYTES = 4_000;
export const MAX_DIALOGUE_QUEUE = 32;

export type DialogueInput = Readonly<{
  clientMessageId: string;
  text: string;
  locale: string;
  /** Explicit per-turn player grant; absent means no memory-write delegation. */
  memoryDelegation?: true;
}>;

export type DialogueControllerEvent =
  | Readonly<{ type: "turn_queued"; clientMessageId: string }>
  | Readonly<{ type: "turn_started"; clientMessageId: string }>
  | Readonly<{ type: "turn_completed"; clientMessageId: string }>
  | Readonly<{ type: "turn_cancelled"; clientMessageId: string | null }>
  | Readonly<{ type: "turn_failed"; clientMessageId: string }>;

type PendingInput = Readonly<{
  input: DialogueInput;
  receivedAtMs: number;
}>;

type DialogueSession = Pick<AgentSession, "prompt" | "abort" | "clearQueue" | "isIdle">;

/**
 * The only browser-to-Pi writer. It accepts plain player data, renders it as
 * a canonical envelope, serializes turns, and keeps Pi command/template
 * syntax out of the player-controlled top-level prompt.
 */
export class DialogueController {
  readonly #seenIds = new Set<string>();
  readonly #queue: PendingInput[] = [];
  readonly #listeners = new Set<(event: DialogueControllerEvent) => void>();
  #active: PendingInput | undefined;
  #closed = false;
  #draining = false;

  /**
   * `hasVisiblePresentation` is supplied only by a player-facing surface.
   * Pi may complete an ordinary assistant turn without invoking a presentation
   * tool; that is never a completed Dialogue turn from the player's view.
   */
  public constructor(
    private readonly session: DialogueSession,
    private readonly now: () => number = Date.now,
    private readonly hasVisiblePresentation: () => boolean = () => true,
  ) {}

  public subscribe(listener: (event: DialogueControllerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async submit(
    input: DialogueInput,
    beforeQueue?: (input: DialogueInput) => Promise<void>,
  ): Promise<"accepted" | "duplicate"> {
    this.#assertOpen();
    const normalized = validateDialogueInput(input);
    if (this.#seenIds.has(normalized.clientMessageId)) return "duplicate";
    if (this.#queue.length >= MAX_DIALOGUE_QUEUE) throw new Error("dialogue_queue_full");
    // A player-facing surface may install its durable append boundary here.
    // Refuse to enqueue if it cannot commit the visible player turn first.
    await beforeQueue?.(normalized);
    this.#seenIds.add(normalized.clientMessageId);
    const pending = Object.freeze({ input: normalized, receivedAtMs: this.now() });
    this.#queue.push(pending);
    this.#emit({ type: "turn_queued", clientMessageId: normalized.clientMessageId });
    void this.#drain();
    return "accepted";
  }

  /**
   * Opaque Host-owned identity of the only turn currently permitted to make
   * current-turn-scoped companion mutations. It is never accepted from a
   * browser or model payload.
   */
  public currentTurnId(): string | undefined {
    return this.#active?.input.clientMessageId;
  }

  public async stop(): Promise<void> {
    this.#assertOpen();
    const activeId = this.#active?.input.clientMessageId ?? null;
    this.#queue.length = 0;
    // Revoke current-turn capabilities before abort crosses an async boundary.
    // A late tool callback from the cancelled provider run must fail closed.
    this.#active = undefined;
    await this.session.abort();
    this.session.clearQueue();
    this.#emit({ type: "turn_cancelled", clientMessageId: activeId });
  }

  public close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#listeners.clear();
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      while (!this.#closed && this.#active === undefined && this.#queue.length > 0) {
        const pending = this.#queue.shift()!;
        this.#active = pending;
        this.#emit({ type: "turn_started", clientMessageId: pending.input.clientMessageId });
        try {
          await this.session.prompt(canonicalPrompt(pending), { expandPromptTemplates: false, source: "rpc" });
          if (!this.hasVisiblePresentation()) {
            // Ordinary assistant text is intentionally private. Do not report
            // success for a turn that produced no explicit player expression.
            this.#emit({ type: "turn_failed", clientMessageId: pending.input.clientMessageId });
          } else {
            this.#emit({ type: "turn_completed", clientMessageId: pending.input.clientMessageId });
          }
        } catch (error) {
          // Pi/provider detail is deliberately not an outbound player surface.
          if (!this.#closed) this.#emit({ type: "turn_failed", clientMessageId: pending.input.clientMessageId });
          void error;
        } finally {
          this.#active = undefined;
        }
      }
    } finally {
      this.#draining = false;
      if (!this.#closed && this.#active === undefined && this.#queue.length > 0) void this.#drain();
    }
  }

  #emit(event: DialogueControllerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("dialogue_controller_closed");
  }
}

export function validateDialogueInput(value: unknown): DialogueInput {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(
      (key) => key === "clientMessageId" || key === "text" || key === "locale" || key === "memoryDelegation",
    ) ||
    !isOpaqueId(value.clientMessageId) ||
    typeof value.text !== "string" ||
    typeof value.locale !== "string" ||
    (value.memoryDelegation !== undefined && value.memoryDelegation !== true) ||
    Buffer.byteLength(value.text, "utf8") < 1 ||
    Buffer.byteLength(value.text, "utf8") > MAX_DIALOGUE_TEXT_BYTES ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value.locale)
  ) {
    throw new Error("invalid_dialogue_input");
  }
  return Object.freeze({
    clientMessageId: value.clientMessageId,
    text: value.text,
    locale: value.locale,
    ...(value.memoryDelegation === true ? { memoryDelegation: true as const } : {}),
  });
}

function canonicalPrompt(pending: PendingInput): string {
  return JSON.stringify({
    kind: DIALOGUE_INPUT_KIND,
    clientMessageId: pending.input.clientMessageId,
    text: pending.input.text,
    locale: pending.input.locale,
    ...(pending.input.memoryDelegation === true ? { memoryDelegation: true } : {}),
    receivedAtMs: pending.receivedAtMs,
  });
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDialogueClientMessageId(): string {
  return randomUUID();
}
