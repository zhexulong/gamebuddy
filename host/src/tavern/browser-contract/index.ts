import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Format } from "typebox/format";

export const TAVERN_BROWSER_API_V1 = "tavern_browser_api/v1" as const;
export const TAVERN_BROWSER_API_VERSION = 1 as const;

const MAX_TEXT_UTF8_BYTES = 16_384;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OPAQUE_HANDLE_PATTERN = "^[A-Za-z0-9_-]{22,128}$";
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{22}$";

/** Pure validators registered once for schemas compiled by this module. */
const hasUnpairedUtf16Surrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const isNfcUtf8Text = (value: string): boolean =>
  !hasUnpairedUtf16Surrogate(value) &&
  value === value.normalize("NFC") &&
  new TextEncoder().encode(value).byteLength <= MAX_TEXT_UTF8_BYTES;
const isMemoryText = (value: string): boolean =>
  !hasUnpairedUtf16Surrogate(value) && value === value.normalize("NFC") && new TextEncoder().encode(value).byteLength <= 4096;
const isCanonicalUnpaddedBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const finalValue = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  return value.length % 4 === 0 || (value.length % 4 === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0);
};
Format.Set("tavern-browser-nfc-utf8-text-v1", isNfcUtf8Text);
Format.Set("tavern-browser-memory-text-v1", isMemoryText);
Format.Set("tavern-browser-canonical-base64url-v1", isCanonicalUnpaddedBase64Url);

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const ApiVersion = Type.Literal(TAVERN_BROWSER_API_VERSION);
const OpaqueHandle = Type.String({
  minLength: 22,
  maxLength: 128,
  pattern: OPAQUE_HANDLE_PATTERN,
  format: "tavern-browser-canonical-base64url-v1",
});
const IdempotencyKey = Type.String({
  minLength: 22,
  maxLength: 22,
  pattern: IDEMPOTENCY_KEY_PATTERN,
  format: "tavern-browser-canonical-base64url-v1",
});
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const PositiveGeneration = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const BoundedText = Type.String({ minLength: 1, format: "tavern-browser-nfc-utf8-text-v1" });
const MemoryText = Type.String({ minLength: 1, format: "tavern-browser-memory-text-v1" });
/** Player display title: NFC bounded text, 1..120 chars (exact store ceiling). */
const TitleText = Type.String({ minLength: 1, maxLength: 120, format: "tavern-browser-nfc-utf8-text-v1" });
const ProblemCode = Type.Union([
  Type.Literal("unauthorized"),
  Type.Literal("csrf_failed"),
  Type.Literal("invalid_request"),
  Type.Literal("unsupported_api_version"),
  Type.Literal("profile_operation_unavailable"),
  Type.Literal("selection_conflict"),
  Type.Literal("draft_conflict"),
  Type.Literal("idempotency_conflict"),
  Type.Literal("idempotency_in_progress"),
  Type.Literal("idempotency_expired"),
  Type.Literal("turn_busy"),
  Type.Literal("stream_resync_required"),
  Type.Literal("selection_busy"),
  Type.Literal("turn_not_active"),
  Type.Literal("turn_already_terminal"),
  Type.Literal("runtime_unavailable"),
  Type.Literal("presentation_unavailable"),
  Type.Literal("storage_unavailable"),
  Type.Literal("state_reconciliation_required"),
]);

export const BrowserSwipeInfoV1Schema = strictObject({
  currentIndex: Revision,
  totalSwipes: PositiveGeneration,
  label: Type.String({ minLength: 1, maxLength: 32 }),
  hasPrevious: Type.Boolean(),
  hasNext: Type.Boolean(),
});

export const BrowserMessageV1Schema = strictObject({
  handle: OpaqueHandle,
  role: Type.Union([Type.Literal("player"), Type.Literal("companion")]),
  text: BoundedText,
  locale: Type.Union([Type.Literal("en"), Type.Literal("zh-CN"), Type.Literal("und")]),
  order: Revision,
  revision: Revision,
  swipeInfo: Type.Optional(BrowserSwipeInfoV1Schema),
});
export const BrowserTurnV1Schema = strictObject({
  handle: OpaqueHandle,
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("response_visible"),
    Type.Literal("stopping"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("failed"),
  ]),
  projectionRevision: Revision,
  canCancel: Type.Boolean(),
  problemCode: Type.Optional(
    Type.Union([
      Type.Literal("interrupted"),
      Type.Literal("no_visible_presentation"),
      Type.Literal("runtime_unavailable"),
      Type.Literal("storage_unavailable"),
    ]),
  ),
});
export const BrowserDraftV1Schema = strictObject({
  apiVersion: ApiVersion,
  revision: Revision,
  text: Type.Union([BoundedText, Type.Null()]),
});
/**
 * One safe bounded Memory row the browser may see. The handle is an opaque
 * projected handle (never the vendor CAS `stateToken`, which exceeds the
 * frozen handle bound); the title is a fixed category label and never derives
 * from stored content. `sourceRefs` and the raw state token never leave the Host.
 */
export const MemoryItemV1Schema = strictObject({
  handle: OpaqueHandle,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  content: MemoryText,
  category: Type.Union([Type.Literal("semantic"), Type.Literal("interaction")]),
  status: Type.Union([Type.Literal("active"), Type.Literal("permanent"), Type.Literal("archived")]),
  pinned: Type.Boolean(),
});
/**
 * Read-only Memory projection for the exact mounted continuity (design/40 P8
 * item 4 / design/78 Task 6). `projectionRevision` is an opaque content
 * fingerprint of the projected rows so a client can detect a changed set;
 * it is not a storage revision and never carries a durable identifier.
 */
export const MemoryReadV1Schema = strictObject({
  apiVersion: ApiVersion,
  projectionRevision: OpaqueHandle,
  memories: Type.Array(MemoryItemV1Schema, { maxItems: 200 }),
});
/**
 * Player-authored ordinary Memory CRUD. The browser provides only opaque
 * projection facts; the Host resolves them to a current vendor row before a
 * vendor-owned state-token CAS. No provider, Pi session, receipt or evidence
 * fact is expressible by this command.
 */
export const MemoryMutationCommandV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("create"),
    expectedProjectionRevision: OpaqueHandle,
    content: MemoryText,
  }),
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("update"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
    content: MemoryText,
  }),
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("archive"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
  }),
]);
/** Every successful mutation returns the same safe fresh read model. */
export const MemoryMutationResultV1Schema = MemoryReadV1Schema;
const OperationId = Type.Union([
  Type.Literal("chat.submit"),
  Type.Literal("chat.cancel"),
  Type.Literal("draft.save"),
  Type.Literal("draft.discard"),
  Type.Literal("chat.rename"),
  Type.Literal("memory.mutate"),
  Type.Literal("world-info.bind"),
]);
const LabelKey = Type.Union([
  Type.Literal("tavern.nav.chat"),
  Type.Literal("tavern.nav.memory"),
  Type.Literal("tavern.operation.submit"),
  Type.Literal("tavern.operation.cancel"),
  Type.Literal("tavern.operation.draft.save"),
  Type.Literal("tavern.operation.draft.discard"),
  Type.Literal("tavern.operation.rename"),
  Type.Literal("tavern.operation.memory.mutate"),
  Type.Literal("tavern.operation.world-info.bind"),
]);
export const TavernBrowserOperationV1Schema = strictObject({
  operationId: OperationId,
  labelKey: LabelKey,
  availability: Type.Union([Type.Literal("available"), Type.Literal("busy"), Type.Literal("unavailable")]),
  routeId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" }),
});
const NavigationItemId = Type.Union([Type.Literal("chat"), Type.Literal("memory")]);
const NavigationItem = strictObject({
  itemId: NavigationItemId,
  labelKey: LabelKey,
  availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
});
const WorldInfoBindingState = Type.Union([
  Type.Literal("none"),
  Type.Literal("selected"),
  Type.Literal("locked"),
  Type.Literal("unavailable"),
]);
/**
 * Safe World Info binding projection for the exact mounted Chat. `revision`
 * and every item `handle` are opaque values minted by the Host binding
 * service; the browser can never decode them into a durable fact.
 */
export const WorldInfoStateV1Schema = strictObject({
  state: WorldInfoBindingState,
  revision: OpaqueHandle,
  items: Type.Array(
    strictObject({
      handle: OpaqueHandle,
      title: Type.String({ minLength: 1, maxLength: 256 }),
      summary: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
      selected: Type.Boolean(),
    }),
    { maxItems: 100 },
  ),
});
/**
 * Exact bind/unbind command. `expectedRevision` and `sourceHandle` are the
 * opaque handles from the last validated state projection; a raw title,
 * timestamp, storage handle or canonical hash is never expressible here.
 */
export const SetWorldInfoBindingCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  sourceHandle: Type.Union([OpaqueHandle, Type.Null()]),
});

export const TavernStateEventStreamV1Schema = strictObject({ epoch: OpaqueHandle, cursor: OpaqueHandle });

const MemoryStateSnapshotV1Schema = Type.Union([
  strictObject({
    readAvailable: Type.Literal(true),
    mutationAvailable: Type.Boolean(),
    projectionRevision: OpaqueHandle,
  }),
  strictObject({
    readAvailable: Type.Literal(false),
    mutationAvailable: Type.Literal(false),
    projectionRevision: Type.Null(),
  }),
]);

export const TavernStateSnapshotV1Schema = strictObject({
  apiVersion: ApiVersion,
  build: strictObject({
    browserContract: Type.Literal(TAVERN_BROWSER_API_V1),
    profileId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  csrfToken: OpaqueHandle,
  browserSession: strictObject({ expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }),
  operations: Type.Array(TavernBrowserOperationV1Schema, { maxItems: 100 }),
  navigation: Type.Array(NavigationItem, { maxItems: 100 }),
  selection: Type.Union([
    Type.Null(),
    strictObject({ chatHandle: OpaqueHandle, generation: PositiveGeneration, stateRevision: OpaqueHandle }),
  ]),
  chat: Type.Union([
    Type.Null(),
    strictObject({
      companion: strictObject({ name: Type.String({ minLength: 1, maxLength: 256 }) }),
      title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
      transcript: Type.Array(BrowserMessageV1Schema),
      draft: strictObject({ revision: Revision, present: Type.Boolean() }),
      turn: Type.Union([BrowserTurnV1Schema, Type.Null()]),
      worldInfo: Type.Union([Type.Null(), WorldInfoStateV1Schema]),
    }),
  ]),
  memory: MemoryStateSnapshotV1Schema,
  eventStream: Type.Union([Type.Null(), TavernStateEventStreamV1Schema]),
});
export const SubmitMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  text: BoundedText,
  locale: Type.Union([Type.Literal("en"), Type.Literal("zh-CN")]),
  expectedDraftRevision: Type.Optional(Revision),
});
export const SaveDraftCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: Revision,
  text: BoundedText,
});
export const DiscardDraftCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: Revision,
});
export const ChatListQueryV1Schema = strictObject({
  apiVersion: ApiVersion,
  state: Type.Optional(Type.Literal("active")),
});
/** Metadata-only Chat list entry: no durable identifier ever appears. */
export const ChatListEntryV1Schema = strictObject({
  handle: OpaqueHandle,
  title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  status: Type.Literal("active"),
  managementRevision: Revision,
  isSelected: Type.Boolean(),
});
export const ChatListV1Schema = strictObject({
  apiVersion: ApiVersion,
  chats: Type.Array(ChatListEntryV1Schema, { maxItems: 100 }),
});
export const RenameChatTitleCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  chatHandle: OpaqueHandle,
  expectedManagementRevision: Revision,
  title: TitleText,
});
export const ChatTitleV1Schema = strictObject({
  apiVersion: ApiVersion,
  title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  managementRevision: Revision,
});
export const MessageSubmissionStatusQueryV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  selectionGeneration: PositiveGeneration,
});
export const CancelTurnCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
});
export const SwipeSelectCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  direction: Type.Optional(Type.Union([Type.Literal("prev"), Type.Literal("next")])),
  targetIndex: Type.Optional(Revision),
});
export const SwipeSelectResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  message: BrowserMessageV1Schema,
});
export const RegenerateMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
});
export const SubmitResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  message: BrowserMessageV1Schema,
  turn: BrowserTurnV1Schema,
});
export const MessageSubmissionStatusV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([
    Type.Literal("unknown"),
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("terminal"),
    Type.Literal("expired"),
  ]),
  committedResult: Type.Optional(SubmitResultV1Schema),
});
export const CancelTurnResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([
    Type.Literal("cancelled"),
    Type.Literal("completion_won"),
    Type.Literal("already_terminal"),
  ]),
  turn: BrowserTurnV1Schema,
});
export const TavernProblemV1Schema = strictObject({
  type: Type.String({ minLength: 1, maxLength: 256 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  code: ProblemCode,
  requestId: OpaqueHandle,
  retryable: Type.Boolean(),
});

const EventBase = {
  apiVersion: ApiVersion,
  epoch: OpaqueHandle,
  sequence: PositiveGeneration,
  selectionGeneration: PositiveGeneration,
};
const CompanionDeltaV1Schema = strictObject({
  /** Opaque Host projection of the exact mounted turn; never a Pi message ID. */
  turnHandle: OpaqueHandle,
  delta: BoundedText,
});
export const BrowserEventV1Schema = Type.Union([
  strictObject({ ...EventBase, eventType: Type.Literal("companion.delta"), payload: CompanionDeltaV1Schema }),
  strictObject({ ...EventBase, eventType: Type.Literal("message.committed"), payload: BrowserMessageV1Schema }),
  strictObject({
    ...EventBase,
    eventType: Type.Literal("draft.changed"),
    payload: strictObject({ revision: Revision, present: Type.Boolean() }),
  }),
  strictObject({ ...EventBase, eventType: Type.Literal("turn.state_changed"), payload: BrowserTurnV1Schema }),
  strictObject({
    ...EventBase,
    eventType: Type.Literal("stream.resync_required"),
    payload: strictObject({
      reason: Type.Union([
        Type.Literal("gap"),
        Type.Literal("epoch_changed"),
        Type.Literal("restart"),
        Type.Literal("ambiguous_cursor"),
      ]),
    }),
  }),
]);

export const TAVERN_BROWSER_PROBLEM_CODES_V1 = Object.freeze([
  "unauthorized",
  "csrf_failed",
  "invalid_request",
  "unsupported_api_version",
  "profile_operation_unavailable",
  "selection_conflict",
  "draft_conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "turn_busy",
  "stream_resync_required",
  "selection_busy",
  "turn_not_active",
  "turn_already_terminal",
  "runtime_unavailable",
  "presentation_unavailable",
  "storage_unavailable",
  "state_reconciliation_required",
] as const);

const EmptyHeaders = strictObject({});
const CsrfHeaders = strictObject({ "x-csrf-token": OpaqueHandle });
const IdempotentCsrfHeaders = strictObject({ "x-csrf-token": OpaqueHandle, "idempotency-key": IdempotencyKey });
const BootstrapRequest = strictObject({ apiVersion: ApiVersion, bootstrapToken: OpaqueHandle });
const TurnPath = strictObject({ turnHandle: OpaqueHandle });
const EventsQuery = strictObject({ apiVersion: ApiVersion, cursor: Type.Optional(OpaqueHandle) });
const noQuery = strictObject({});
const noPath = strictObject({});
type RouteDescriptor = Readonly<{
  routeId: string;
  method: string;
  path: string;
  operationId?: TavernBrowserOperationIdV1;
  auth: string;
  origin: string;
  csrf: string;
  idempotency: string;
  headers: TSchema;
  pathParams: TSchema;
  query: TSchema;
  request?: TSchema;
  success: Readonly<{ status: number; contentType: string; schema: TSchema }>;
}>;
const route = <T extends RouteDescriptor>(descriptor: T) => Object.freeze(descriptor);
const RouteDescriptors = Object.freeze([
  route({
    routeId: "bootstrap",
    method: "POST",
    path: "/api/tavern/v1/bootstrap",
    auth: "bootstrap_token",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    request: BootstrapRequest,
    success: { status: 200, contentType: "application/json", schema: TavernStateSnapshotV1Schema },
  }),
  route({
    routeId: "state.read",
    method: "GET",
    path: "/api/tavern/v1/state",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernStateSnapshotV1Schema },
  }),
  route({
    routeId: "draft.read",
    method: "GET",
    path: "/api/tavern/v1/draft",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "draft.save",
    method: "PUT",
    path: "/api/tavern/v1/draft",
    operationId: "draft.save",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SaveDraftCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "draft.discard",
    method: "DELETE",
    path: "/api/tavern/v1/draft",
    operationId: "draft.discard",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: DiscardDraftCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "chat.submit",
    method: "POST",
    path: "/api/tavern/v1/messages",
    operationId: "chat.submit",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "required",
    headers: IdempotentCsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SubmitMessageCommandV1Schema,
    success: { status: 202, contentType: "application/json", schema: SubmitResultV1Schema },
  }),
  route({
    routeId: "chat.submission_status",
    method: "POST",
    path: "/api/tavern/v1/message-submission-status",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "query_key",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    request: MessageSubmissionStatusQueryV1Schema,
    success: { status: 200, contentType: "application/json", schema: MessageSubmissionStatusV1Schema },
  }),
  route({
    routeId: "chat.list",
    method: "GET",
    path: "/api/tavern/v1/chats",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: ChatListQueryV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatListV1Schema },
  }),
  route({
    routeId: "chat.rename",
    method: "PUT",
    path: "/api/tavern/v1/chat/title",
    operationId: "chat.rename",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: RenameChatTitleCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatTitleV1Schema },
  }),
  route({
    routeId: "chat.cancel",
    method: "POST",
    path: "/api/tavern/v1/turns/:turnHandle/cancel",
    operationId: "chat.cancel",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: TurnPath,
    query: noQuery,
    request: CancelTurnCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CancelTurnResultV1Schema },
  }),
  route({
    routeId: "memory.read",
    method: "GET",
    path: "/api/tavern/v1/memory",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: MemoryReadV1Schema },
  }),
  route({
    routeId: "memory.mutate",
    method: "PUT",
    path: "/api/tavern/v1/memory",
    operationId: "memory.mutate",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: MemoryMutationCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: MemoryMutationResultV1Schema },
  }),
  route({
    routeId: "world-info.read",
    method: "GET",
    path: "/api/tavern/v1/world-info",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "world-info.bind",
    method: "PUT",
    path: "/api/tavern/v1/world-info",
    operationId: "world-info.bind",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SetWorldInfoBindingCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "events",
    method: "GET",
    path: "/api/tavern/v1/events",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: EventsQuery,
    success: { status: 200, contentType: "text/event-stream", schema: BrowserEventV1Schema },
  }),
]);

export const TavernBrowserContractV1 = Object.freeze({
  id: TAVERN_BROWSER_API_V1,
  routes: RouteDescriptors,
  static: Object.freeze({
    shell: Object.freeze({ method: "GET", path: "/", auth: "none", origin: "same-origin", contentType: "text/html" }),
    assets: Object.freeze({
      method: "GET",
      path: "/assets/:assetPath",
      auth: "none",
      origin: "same-origin",
      contentType: "application/javascript|text/css|image/*|font/*",
    }),
  }),
  schemas: Object.freeze({
    BrowserMessageV1Schema,
    BrowserTurnV1Schema,
    BrowserDraftV1Schema,
    TavernBrowserOperationV1Schema,
    TavernStateEventStreamV1Schema,
    TavernStateSnapshotV1Schema,
    SubmitMessageCommandV1Schema,
    SaveDraftCommandV1Schema,
    DiscardDraftCommandV1Schema,
    MessageSubmissionStatusQueryV1Schema,
    CancelTurnCommandV1Schema,
    ChatListQueryV1Schema,
    ChatListEntryV1Schema,
    ChatListV1Schema,
    RenameChatTitleCommandV1Schema,
    ChatTitleV1Schema,
    MemoryItemV1Schema,
    MemoryReadV1Schema,
    MemoryMutationCommandV1Schema,
    MemoryMutationResultV1Schema,
    WorldInfoStateV1Schema,
    SetWorldInfoBindingCommandV1Schema,
    SubmitResultV1Schema,
    MessageSubmissionStatusV1Schema,
    CancelTurnResultV1Schema,
    SwipeSelectCommandV1Schema,
    SwipeSelectResultV1Schema,
    RegenerateMessageCommandV1Schema,
    TavernProblemV1Schema,
    BrowserEventV1Schema,
  }),
});

export type BrowserSwipeInfoV1 = Static<typeof BrowserSwipeInfoV1Schema>;
export type BrowserMessageV1 = Static<typeof BrowserMessageV1Schema>;
export type BrowserTurnV1 = Static<typeof BrowserTurnV1Schema>;
export type BrowserDraftV1 = Static<typeof BrowserDraftV1Schema>;
export type SaveDraftCommandV1 = Static<typeof SaveDraftCommandV1Schema>;
export type DiscardDraftCommandV1 = Static<typeof DiscardDraftCommandV1Schema>;
export type TavernStateSnapshotV1 = Static<typeof TavernStateSnapshotV1Schema>;
export type TavernBrowserOperationV1 = Static<typeof TavernBrowserOperationV1Schema>;
export type TavernStateEventStreamV1 = Static<typeof TavernStateEventStreamV1Schema>;
export type TavernBrowserNavigationItemIdV1 = Static<typeof NavigationItemId>;
export type SubmitMessageCommandV1 = Static<typeof SubmitMessageCommandV1Schema>;
export type SwipeSelectCommandV1 = Static<typeof SwipeSelectCommandV1Schema>;
export type SwipeSelectResultV1 = Static<typeof SwipeSelectResultV1Schema>;
export type RegenerateMessageCommandV1 = Static<typeof RegenerateMessageCommandV1Schema>;
export type MessageSubmissionStatusQueryV1 = Static<typeof MessageSubmissionStatusQueryV1Schema>;
export type MessageSubmissionStatusV1 = Static<typeof MessageSubmissionStatusV1Schema>;
export type CancelTurnCommandV1 = Static<typeof CancelTurnCommandV1Schema>;
export type CancelTurnResultV1 = Static<typeof CancelTurnResultV1Schema>;
export type ChatListQueryV1 = Static<typeof ChatListQueryV1Schema>;
export type ChatListEntryV1 = Static<typeof ChatListEntryV1Schema>;
export type ChatListV1 = Static<typeof ChatListV1Schema>;
export type RenameChatTitleCommandV1 = Static<typeof RenameChatTitleCommandV1Schema>;
export type ChatTitleV1 = Static<typeof ChatTitleV1Schema>;
export type MemoryItemV1 = Static<typeof MemoryItemV1Schema>;
export type MemoryMutationCommandV1 = Static<typeof MemoryMutationCommandV1Schema>;
export type MemoryMutationResultV1 = Static<typeof MemoryMutationResultV1Schema>;
export type WorldInfoStateV1 = Static<typeof WorldInfoStateV1Schema>;
export type SetWorldInfoBindingCommandV1 = Static<typeof SetWorldInfoBindingCommandV1Schema>;
export type MemoryReadV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  projectionRevision: string;
  memories: readonly MemoryItemV1[];
}>;
export type TavernProblemV1 = Static<typeof TavernProblemV1Schema>;
export type BrowserEventV1 = Static<typeof BrowserEventV1Schema>;
export type TavernBrowserOperationIdV1 = Static<typeof OperationId>;
export type TavernBrowserRouteIdV1 = (typeof RouteDescriptors)[number]["routeId"];
export type TavernReleaseTierV1 = "chat_core" | "tavern_management";

const contractDeclaredRouteIds = new Set<TavernBrowserRouteIdV1>(RouteDescriptors.map((entry) => entry.routeId));
const routeIdByOperationId = new Map<TavernBrowserOperationIdV1, TavernBrowserRouteIdV1>(
  RouteDescriptors.flatMap((entry) => {
    const operationId = (entry as { readonly operationId?: TavernBrowserOperationIdV1 }).operationId;
    return operationId === undefined ? [] : [[operationId, entry.routeId]];
  }),
);
const routeBoundOperationIds = new Set(routeIdByOperationId.keys());
const contractDeclaredNavigationItemIds = new Set<TavernBrowserNavigationItemIdV1>(["chat", "memory"]);
export type ComposedTavernProfile = Readonly<{
  readonly profileId: string;
  readonly releaseTier: TavernReleaseTierV1;
  readonly routeIds: readonly TavernBrowserRouteIdV1[];
  readonly operationIds: readonly TavernBrowserOperationIdV1[];
  readonly navigationItemIds: readonly TavernBrowserNavigationItemIdV1[];
}>;
/**
 * Module-private identity registry: only the frozen capability slice minted and
 * returned by `composeTavernProfile` is branded here. A structural clone of a
 * composed profile (including an `Object.freeze` spread copy) is not a composed
 * capability slice and must fail before any durable I/O.
 */
const composedTavernProfiles = new WeakSet<object>();
export function composeTavernProfile(input: unknown): ComposedTavernProfile {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new TypeError("Tavern profile must be a plain object");
  const value = input as Record<string, unknown>;
  const expectedKeys = ["profileId", "releaseTier", "routeIds", "operationIds", "navigationItemIds"] as const;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => {
      const descriptor = descriptors[key];
      return (
        keys.includes(key) &&
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        descriptor.configurable === true &&
        descriptor.writable === true &&
        "value" in descriptor
      );
    })
  )
    throw new TypeError("Tavern profile input is not a capability slice");
  if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value.profileId))
    throw new TypeError("Tavern profile id is invalid");
  if (value.releaseTier !== "chat_core" && value.releaseTier !== "tavern_management")
    throw new TypeError("Tavern release tier is invalid");
  if (!Array.isArray(value.routeIds) || value.routeIds.length > 100) throw new TypeError("Tavern routes are invalid");
  if (!Array.isArray(value.operationIds) || value.operationIds.length > 100)
    throw new TypeError("Tavern operations are invalid");
  if (!Array.isArray(value.navigationItemIds) || value.navigationItemIds.length > 100)
    throw new TypeError("Tavern navigation items are invalid");
  const seenRouteIds = new Set<string>();
  for (const routeId of value.routeIds) {
    if (typeof routeId !== "string" || !contractDeclaredRouteIds.has(routeId as TavernBrowserRouteIdV1))
      throw new TypeError("Tavern route is not declared by the contract");
    if (seenRouteIds.has(routeId)) throw new TypeError("Tavern route is duplicated");
    seenRouteIds.add(routeId);
  }
  const seenOperationIds = new Set<string>();
  for (const operationId of value.operationIds) {
    if (typeof operationId !== "string" || !routeBoundOperationIds.has(operationId as TavernBrowserOperationIdV1))
      throw new TypeError("Tavern operation is not bound to a route");
    if (seenOperationIds.has(operationId)) throw new TypeError("Tavern operation is duplicated");
    seenOperationIds.add(operationId);
  }
  for (const operationId of seenOperationIds) {
    const routeId = routeIdByOperationId.get(operationId as TavernBrowserOperationIdV1)!;
    if (!seenRouteIds.has(routeId)) throw new TypeError("Tavern operation route is unavailable in the profile");
  }
  for (const routeId of seenRouteIds) {
    const operationId = (
      RouteDescriptors.find((entry) => entry.routeId === routeId) as
        | { readonly operationId?: TavernBrowserOperationIdV1 }
        | undefined
    )?.operationId;
    if (operationId !== undefined && !seenOperationIds.has(operationId))
      throw new TypeError("Tavern route operation is unavailable in the profile");
  }
  const seenNavigationItemIds = new Set<string>();
  for (const navigationItemId of value.navigationItemIds) {
    if (
      typeof navigationItemId !== "string" ||
      !contractDeclaredNavigationItemIds.has(navigationItemId as TavernBrowserNavigationItemIdV1)
    )
      throw new TypeError("Tavern navigation item is not declared by the contract");
    if (seenNavigationItemIds.has(navigationItemId)) throw new TypeError("Tavern navigation item is duplicated");
    seenNavigationItemIds.add(navigationItemId);
  }
  const profile = Object.freeze({
    profileId: value.profileId,
    releaseTier: value.releaseTier,
    routeIds: Object.freeze([...value.routeIds] as TavernBrowserRouteIdV1[]),
    operationIds: Object.freeze([...value.operationIds] as TavernBrowserOperationIdV1[]),
    navigationItemIds: Object.freeze([...value.navigationItemIds] as TavernBrowserNavigationItemIdV1[]),
  });
  composedTavernProfiles.add(profile);
  return profile;
}

/**
 * Identity-brand type guard: true only for the exact frozen object returned by
 * `composeTavernProfile` (plus actual route/operation membership checks that the
 * binding service performs separately). Structural clones are never branded.
 */
export function isComposedTavernProfile(value: unknown): value is ComposedTavernProfile {
  return typeof value === "object" && value !== null && composedTavernProfiles.has(value);
}

export const TavernBrowserValidatorsV1: Readonly<Record<keyof typeof TavernBrowserContractV1.schemas, Validator>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(TavernBrowserContractV1.schemas).map(([name, schema]) => [name, Compile(schema)]),
    ) as Record<keyof typeof TavernBrowserContractV1.schemas, Validator>,
  );
const fixtureHandle = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
export const TavernBrowserFixtureV1 = Object.freeze({
  message: (): BrowserMessageV1 =>
    Object.freeze({
      handle: fixtureHandle,
      role: "player",
      text: "Hello from a synthetic fixture.",
      locale: "en",
      order: 1,
      revision: 1,
    }),
  turn: (): BrowserTurnV1 =>
    Object.freeze({ handle: fixtureHandle, state: "queued", projectionRevision: 1, canCancel: true }),
  snapshot: (): TavernStateSnapshotV1 => ({
    apiVersion: 1,
    build: { browserContract: TAVERN_BROWSER_API_V1, profileId: "synthetic.chat-core" },
    csrfToken: fixtureHandle,
    browserSession: { expiresAtMs: 1 },
    operations: [],
    navigation: [],
    selection: null,
    chat: null,
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  }),
});
