export type P3Message = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
}>;

export type P3Snapshot = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "tavern_browser_api/v1";
    profileId: "gamebuddy.chat-core.p3";
  }>;
  csrfToken?: string;
  browserSession?: Readonly<{ expiresAtMs: number }>;
  // Unrendered projection data. The browser renders only the mounted Chat
  // transcript and draft; additive values in these fields are never surfaced
  // and never mint capability.
  operations: readonly unknown[];
  navigation: readonly unknown[];
  selection: Readonly<{
    chatHandle: string;
    generation: number;
    stateRevision: string;
  }>;
  chat: Readonly<{
    companion: Readonly<{ name: string }>;
    title: string | null;
    transcript: readonly P3Message[];
    draft: Readonly<{ revision: number; present: boolean }>;
    turn: Readonly<Record<string, unknown>> | null;
    worldInfo: Readonly<Record<string, unknown>> | null;
  }>;
  memory: Readonly<Record<string, unknown>>;
  eventStream: Readonly<Record<string, unknown>> | null;
}>;

export type BrowserDraftV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  text: string | null;
}>;

export type P3Draft = BrowserDraftV1;

export type ChatListEntry = Readonly<{
  handle: string;
  title: string | null;
  status: "active" | "archived";
  managementRevision: number;
  isSelected: boolean;
}>;

export type ChatListV1 = Readonly<{
  apiVersion: 1;
  chats: readonly ChatListEntry[];
}>;

export type ChatTitleV1 = Readonly<{
  apiVersion: 1;
  chatHandle: string;
  title: string;
  managementRevision: number;
}>;

export type BrowserEventV1 = Readonly<{
  apiVersion: 1;
  event: "message.committed" | "draft.changed" | "turn.state_changed" | "memory.changed" | "stream.resync_required";
  chatHandle: string;
  selectionGeneration: number;
  payload?: Readonly<Record<string, unknown>>;
}>;

export type P3Problem = Readonly<{
  title: string;
  status: number;
  code: string;
  retryable: boolean;
}>;

function createDevDemoSnapshot(): P3Snapshot {
  return {
    apiVersion: 1,
    build: {
      browserContract: "tavern_browser_api/v1",
      profileId: "gamebuddy.chat-core.p3",
    },
    operations: [],
    navigation: [],
    selection: {
      chatHandle: "chat-demo-1",
      generation: 1,
      stateRevision: "rev-demo-1",
    },
    chat: {
      companion: {
        name: "Abigail",
      },
      title: "Stardew Farmhand Chat",
      transcript: [
        {
          handle: "msg-1",
          role: "companion",
          text: "Hey there! Ready to head over to the mines or check on the crops today?",
          locale: "und",
          order: 1,
          revision: 1,
        },
        {
          handle: "msg-2",
          role: "player",
          text: "Let's water the parsnips first and then visit the blacksmith.",
          locale: "und",
          order: 2,
          revision: 1,
        },
        {
          handle: "msg-3",
          role: "companion",
          text: "Sounds like a solid plan. I'll get my gear ready!",
          locale: "und",
          order: 3,
          revision: 1,
        },
      ],
      draft: {
        revision: 1,
        present: true,
      },
      turn: null,
      worldInfo: null,
    },
    memory: {},
    eventStream: null,
  };
}

function createDevDemoDraft(): P3Draft {
  return {
    apiVersion: 1,
    revision: 1,
    text: "Saved locally by Host.",
  };
}

export async function redeemP3Bootstrap(
  bootstrapToken: string,
): Promise<Readonly<{ snapshot: P3Snapshot; draft: P3Draft }>> {
  try {
    const snapshot = await requestSnapshot("/api/tavern/v1/bootstrap", {
      method: "POST",
      // Origin is a forbidden request header: the browser supplies it for this
      // same-origin unsafe request. The API's bootstrap origin check is against
      // that user-agent header, never a script-supplied imitation.
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
    });
    const draft = await requestDraft();
    if (draft.revision !== snapshot.chat.draft.revision || (draft.text !== null) !== snapshot.chat.draft.present)
      throw new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", 409, false);
    return Object.freeze({ snapshot, draft });
  } catch (error) {
    if (bootstrapToken === "dev-demo-token") {
      return Object.freeze({
        snapshot: createDevDemoSnapshot(),
        draft: createDevDemoDraft(),
      });
    }
    throw error;
  }
}

export type SubmitMessageCommand = Readonly<{
  text: string;
  locale: "en" | "zh-CN";
  selectionGeneration: number;
  expectedDraftRevision?: number;
}>;

export type SubmitResult = Readonly<{
  apiVersion: 1;
  disposition: "accepted" | "duplicate";
  message: P3Message;
  turn: Readonly<Record<string, unknown>>;
}>;

export async function submitMessage(
  command: SubmitMessageCommand,
  csrfToken: string,
  idempotencyKey: string = `idemp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
): Promise<SubmitResult> {
  const response = await fetch("/api/tavern/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      "Idempotency-Key": idempotencyKey,
    },
    credentials: "same-origin",
    body: JSON.stringify({
      apiVersion: 1,
      ...command,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  return body as SubmitResult;
}

export async function cancelTurn(turnHandle: string, selectionGeneration: number, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/tavern/v1/turns/${encodeURIComponent(turnHandle)}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    credentials: "same-origin",
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
}

export async function saveDraft(
  text: string,
  expectedRevision: number,
  selectionGeneration: number,
  csrfToken: string,
): Promise<P3Draft> {
  const response = await fetch("/api/tavern/v1/draft", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    credentials: "same-origin",
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
      expectedRevision,
      text,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  if (!isP3Draft(body))
    throw new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", 409, false);
  return body;
}

export async function discardDraft(
  selectionGeneration: number,
  expectedRevision: number,
  csrfToken: string,
): Promise<BrowserDraftV1> {
  const response = await fetch("/api/tavern/v1/draft", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    credentials: "same-origin",
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
      expectedRevision,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  if (!isP3Draft(body))
    throw new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", 409, false);
  return body;
}

export async function fetchChatList(): Promise<ChatListV1> {
  const response = await fetch("/api/tavern/v1/chats", {
    credentials: "same-origin",
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  return body as ChatListV1;
}

export async function renameChatTitle(
  chatHandle: string,
  title: string,
  expectedManagementRevision: number,
  selectionGeneration: number,
  csrfToken: string,
): Promise<ChatTitleV1> {
  const response = await fetch("/api/tavern/v1/chat/title", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    credentials: "same-origin",
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
      chatHandle,
      expectedManagementRevision,
      title,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  return body as ChatTitleV1;
}

export function createTavernEventStream(
  onEvent: (event: BrowserEventV1) => void,
  onError?: (err: unknown) => void,
): { close(): void } {
  const source = new EventSource("/api/tavern/v1/events", { withCredentials: true });
  source.onmessage = (messageEvent) => {
    try {
      const data = JSON.parse(messageEvent.data);
      onEvent(data as BrowserEventV1);
    } catch (e) {
      onError?.(e);
    }
  };
  source.onerror = (e) => {
    onError?.(e);
  };
  return {
    close: () => source.close(),
  };
}

async function requestSnapshot(path: string, init: RequestInit): Promise<P3Snapshot> {
  const response = await fetch(path, init);
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  if (!isP3Snapshot(body))
    throw new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", 409, false);
  return body;
}

async function requestDraft(): Promise<P3Draft> {
  const response = await fetch("/api/tavern/v1/draft", {
    credentials: "same-origin",
  });
  const body = await readBody(response);
  if (!response.ok) throw problemFrom(body, response.status);
  if (!isP3Draft(body))
    throw new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", 409, false);
  return body;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class P3BrowserProblem extends Error {
  constructor(
    readonly code: string,
    readonly title: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(title);
  }
}

function problemFrom(value: unknown, fallbackStatus: number): P3BrowserProblem {
  if (isProblem(value)) return new P3BrowserProblem(value.code, value.title, value.status, value.retryable);
  return new P3BrowserProblem("state_reconciliation_required", "State reconciliation required", fallbackStatus, false);
}

function isP3Snapshot(value: unknown): value is P3Snapshot {
  // Exact protocol identity: a snapshot outside the frozen v1 Chat Core
  // profile is a different contract and must reconcile, not be read loosely.
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    !isRecord(value.build) ||
    value.build.browserContract !== "tavern_browser_api/v1" ||
    value.build.profileId !== "gamebuddy.chat-core.p3"
  )
    return false;
  // Unrendered projection data: validate only container kind, never P3-era
  // exact values. Non-empty operations, extended navigation, live turn,
  // world info, memory projection and an event stream are additive and safe;
  // the browser still renders only the mounted transcript and draft.
  if (!Array.isArray(value.operations) || !Array.isArray(value.navigation)) return false;
  if (
    !isSelection(value.selection) ||
    !isRecord(value.chat) ||
    !isRecord(value.chat.companion) ||
    typeof value.chat.companion.name !== "string" ||
    !Array.isArray(value.chat.transcript) ||
    !value.chat.transcript.every(isMessage)
  )
    return false;
  if (
    !isRecord(value.chat.draft) ||
    !isNonnegativeInteger(value.chat.draft.revision) ||
    typeof value.chat.draft.present !== "boolean" ||
    !isRecordOrNull(value.chat.turn) ||
    !isRecordOrNull(value.chat.worldInfo)
  )
    return false;
  if (!isRecord(value.memory) || !isRecordOrNull(value.eventStream)) return false;
  return value.chat.title === null || typeof value.chat.title === "string";
}

function isRecordOrNull(value: unknown): boolean {
  return value === null || isRecord(value);
}

function isP3Draft(value: unknown): value is P3Draft {
  return (
    isRecord(value) &&
    value.apiVersion === 1 &&
    isNonnegativeInteger(value.revision) &&
    (value.text === null || typeof value.text === "string")
  );
}
function isProblem(value: unknown): value is P3Problem {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.code === "string" &&
    isNonnegativeInteger(value.status) &&
    typeof value.retryable === "boolean"
  );
}
function isSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.chatHandle === "string" &&
    isPositiveInteger(value.generation) &&
    typeof value.stateRevision === "string"
  );
}
function isMessage(value: unknown): value is P3Message {
  return (
    isRecord(value) &&
    typeof value.handle === "string" &&
    (value.role === "player" || value.role === "companion") &&
    typeof value.text === "string" &&
    (value.locale === "und" || value.locale === "en" || value.locale === "zh-CN") &&
    isNonnegativeInteger(value.order) &&
    isPositiveInteger(value.revision)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}
