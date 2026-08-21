import { createHash } from "node:crypto";
import type { CompanionTextExpression } from "../presentation.js";
import type {
  ChatThreadMessage,
  ChatThreadState,
  ChatThreadStore,
  TavernStableArtifactBinding,
  TavernStableWorldBookBinding,
} from "./chat-thread-store.js";
import { guardTavernCausalMutation, type TavernResponseMutation } from "./effect-aware-causal-guard.js";

/**
 * Chat-only lifecycle adapter for a Tavern thread. It deliberately owns no
 * runtime tools, Game operations, or Magic Context placement.
 */
export type TavernConversation = Readonly<{
  bootstrapTranscript(): readonly ChatThreadMessage[];
  appendPlayer(message: Readonly<{ messageId: string; text: string; occurredAtMs: number }>): Promise<void>;
  commitResponse(expression: CompanionTextExpression, occurredAtMs: number): Promise<void>;
  /**
   * Validates an explicit, effect-free retry intent against the current durable
   * response. This intentionally does not regenerate, re-send, or invoke any
   * runtime/Game capability: variant selection is not yet durably modeled.
   */
  retryResponse(input: TavernResponseRetryIntent): Promise<TavernResponseRetryReceipt>;
}>;

export type TavernResponseRetryIntent = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  messageId: string;
  expectedThreadRevision: number;
  expectedMessageRevision: number;
  effect: TavernResponseMutation["effect"];
}>;

export type TavernResponseRetryReceipt = Readonly<{
  kind: "safe_no_effect_retry";
  chatThreadId: string;
  chatSurfaceSessionId: string;
  messageId: string;
  threadRevision: number;
  messageRevision: number;
  effect: "none";
}>;

export type TavernConversationBinding = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldBookBinding;
}>;

/** A semantic catalog record contains only the exact content binding, never paths or transcript data. */
export type SemanticChatContentRecord = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
}>;

/**
 * A content-open receipt contains only the durable identity tuple and its
 * canonical digest. It intentionally excludes storage paths and transcript
 * text, so it can be carried by a later saga without becoming content access.
 */
export type TavernExactContentReceipt = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
  canonicalBindingDigest: string;
}>;

/** The conversation is exposed only alongside an already verified receipt. */
export type TavernExactContentOpen = Readonly<{
  receipt: TavernExactContentReceipt;
  conversation: TavernConversation;
}>;

export type TavernExactContentErrorCode =
  | "tavern_exact_content_not_found"
  | "tavern_exact_content_already_exists"
  | "tavern_exact_content_binding_mismatch";

/** Typed fail-closed classifications for the exact content protocol only. */
export class TavernExactContentError extends Error {
  readonly code: TavernExactContentErrorCode;

  constructor(code: TavernExactContentErrorCode) {
    super(code);
    this.name = "TavernExactContentError";
    this.code = code;
  }
}

/** A narrow content-only port; it exposes no active/latest selector or storage paths. */
export type TavernSemanticChatContentPort = Readonly<{
  createExplicit(binding: TavernConversationBinding): Promise<TavernExactContentOpen>;
  resumeExact(record: SemanticChatContentRecord): Promise<TavernExactContentOpen>;
}>;

/** Explicit new-conversation creation is separate from strict exact resume. */
export async function createTavernConversation(
  store: ChatThreadStore,
  binding: TavernConversationBinding,
): Promise<TavernConversation> {
  return createConversation(store, binding, await store.createThread({ ...binding, opening: "blank" }));
}

/**
 * Strictly resumes one existing exact content binding. It never creates
 * replacement content or falls back to a latest/active content selector.
 */
export async function resumeExactTavernConversation(
  store: ChatThreadStore,
  record: SemanticChatContentRecord,
): Promise<TavernConversation> {
  const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
  assertExactContentBinding(state, record);
  return createConversation(store, record, state);
}

export function createTavernSemanticChatContentPort(store: ChatThreadStore): TavernSemanticChatContentPort {
  return Object.freeze({
    createExplicit: (binding) => createExactTavernConversation(store, binding),
    resumeExact: (record) => resumeExactTavernConversationReceipt(store, record),
  });
}

async function createExactTavernConversation(
  store: ChatThreadStore,
  binding: TavernConversationBinding,
): Promise<TavernExactContentOpen> {
  try {
    await store.createThread({ ...binding, opening: "blank" });
  } catch (error) {
    throw classifyExactContentError(error, "chat_thread_already_exists", "tavern_exact_content_already_exists");
  }
  // Creation success alone is insufficient for the port: always verify the
  // exact durable state that will back the returned conversation.
  return resumeExactTavernConversationReceipt(store, binding);
}

async function resumeExactTavernConversationReceipt(
  store: ChatThreadStore,
  record: SemanticChatContentRecord,
): Promise<TavernExactContentOpen> {
  let state: ChatThreadState;
  try {
    state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
  } catch (error) {
    if (isErrorCode(error, "chat_thread_not_found"))
      throw new TavernExactContentError("tavern_exact_content_not_found");
    if (isErrorCode(error, "chat_thread_surface_mismatch"))
      throw new TavernExactContentError("tavern_exact_content_binding_mismatch");
    throw error;
  }
  try {
    assertExactContentBinding(state, record);
  } catch (error) {
    if (isErrorCode(error, "tavern_exact_content_binding_mismatch"))
      throw new TavernExactContentError("tavern_exact_content_binding_mismatch");
    throw error;
  }
  const receipt = createExactContentReceipt(record);
  return Object.freeze({ receipt, conversation: createConversation(store, record, state) });
}

function createExactContentReceipt(record: SemanticChatContentRecord): TavernExactContentReceipt {
  const canonicalBinding = JSON.stringify({
    chatThreadId: record.chatThreadId,
    companionId: record.companionId,
    continuityId: record.continuityId,
    chatSurfaceSessionId: record.chatSurfaceSessionId,
  });
  return Object.freeze({
    chatThreadId: record.chatThreadId,
    companionId: record.companionId,
    continuityId: record.continuityId,
    chatSurfaceSessionId: record.chatSurfaceSessionId,
    canonicalBindingDigest: createHash("sha256").update(canonicalBinding, "utf8").digest("hex"),
  });
}

function classifyExactContentError(error: unknown, sourceCode: string, exactCode: TavernExactContentErrorCode): never {
  if (isErrorCode(error, sourceCode)) throw new TavernExactContentError(exactCode);
  throw error;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && error.message === code;
}

function createConversation(
  store: ChatThreadStore,
  binding: TavernConversationBinding,
  initialState: ChatThreadState,
): TavernConversation {
  let state = initialState;
  return Object.freeze({
    bootstrapTranscript(): readonly ChatThreadMessage[] {
      return state.messages;
    },
    async appendPlayer(message): Promise<void> {
      state = await store.appendPlayer(binding.chatThreadId, message);
    },
    async commitResponse(expression, occurredAtMs): Promise<void> {
      state = await store.commitResponse(binding.chatThreadId, {
        messageId: expression.expressionId,
        text: expression.text,
        occurredAtMs,
      });
    },
    async retryResponse(input): Promise<TavernResponseRetryReceipt> {
      if (input.chatThreadId !== binding.chatThreadId || input.chatSurfaceSessionId !== binding.chatSurfaceSessionId)
        throw new Error("tavern_retry_binding_mismatch");
      // Re-open before deciding, rather than trusting this adapter's cached
      // state, so a retry always has a durable-thread readback.
      const readback = await store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
      const threadRevision = readback.messages.length + 1;
      const target = readback.messages.find((message) => message.messageId === input.messageId);
      const decision = guardTavernCausalMutation(
        {
          kind: "response_mutation",
          threadId: binding.chatThreadId,
          messageId: input.messageId,
          expectedThreadRevision: input.expectedThreadRevision,
          expectedMessageRevision: input.expectedMessageRevision,
          effect: input.effect,
        },
        {
          artifactRevisions: {},
          responses:
            target === undefined
              ? {}
              : {
                  [target.messageId]: {
                    threadId: binding.chatThreadId,
                    threadRevision,
                    // ChatThread messages are immutable append records; no durable
                    // alternate response variant exists yet, so its revision is one.
                    messageRevision: 1,
                    eligible: target.role === "companion" && target.kind === "response",
                  },
                },
        },
      );
      if (!decision.allowed) throw new Error(`tavern_retry_${decision.reason}`);
      // Confirm the exact response still exists in the authoritative readback.
      if (target === undefined || target.role !== "companion" || target.kind !== "response")
        throw new Error("tavern_retry_response_ineligible");
      state = readback;
      return Object.freeze({
        kind: "safe_no_effect_retry",
        chatThreadId: binding.chatThreadId,
        chatSurfaceSessionId: binding.chatSurfaceSessionId,
        messageId: target.messageId,
        threadRevision,
        messageRevision: 1,
        effect: "none",
      });
    },
  });
}

function assertExactContentBinding(state: ChatThreadState, record: SemanticChatContentRecord): void {
  const thread = state.thread;
  if (
    thread.chatThreadId !== record.chatThreadId ||
    thread.chatSurfaceSessionId !== record.chatSurfaceSessionId ||
    thread.companionId !== record.companionId ||
    thread.continuityId !== record.continuityId
  )
    throw new Error("tavern_exact_content_binding_mismatch");
}
