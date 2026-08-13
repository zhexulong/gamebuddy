import { createHash } from "node:crypto";

/** Pre-cutover, read-only input boundary for one current-v3 continuity partition. */
export const CONTINUITY_PRODUCTION_MIGRATION_SNAPSHOT_VERSION = 1 as const;
export const CURRENT_CONTINUITY_LEDGER_SCHEMA_VERSION = 3 as const;

export type LegacySurface = "chat" | "game";
export type LegacySessionState = "active" | "suspended" | "returning" | "recovery_required" | "ended";
export type LegacyEventType =
  | "session_created"
  | "surface_suspended"
  | "surface_resumed"
  | "surface_return_started"
  | "surface_recovery_required"
  | "surface_ended";
export type ChatThreadLifecycle = "active" | "archived" | "trashed";
export type GameOwnerState = "owned" | "return_pending" | "recovery_required";

export type GameOrigin = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
}>;
export type GameWorld = Readonly<{ integrationId: string; saveId: string; worldId: string }>;
export type LegacySession = Readonly<{
  sessionId: string;
  surface: LegacySurface;
  state: LegacySessionState;
  createdAtMs: number;
  updatedAtMs: number;
  origin: GameOrigin | null;
  world: GameWorld | null;
  returnChatSessionId: string | null;
}>;
export type LegacyEvent = Readonly<{
  eventId: string;
  type: LegacyEventType;
  sessionId: string;
  surface: LegacySurface;
  occurredAtMs: number;
}>;
export type CurrentV3Ledger = Readonly<{
  schemaVersion: typeof CURRENT_CONTINUITY_LEDGER_SCHEMA_VERSION;
  continuityId: string;
  companionId: string;
  playerId: string;
  sessions: readonly LegacySession[];
  events: readonly LegacyEvent[];
}>;
export type ExactChatThreadMetadata = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  playerId: string;
  continuityId: string;
  lifecycle: ChatThreadLifecycle;
  managementRevision: number /** The exact pre-trash lifecycle, present only while trashed. */;
  trashRestoreLifecycle: Exclude<ChatThreadLifecycle, "trashed"> | null;
}>;
export type ActiveChatSelection = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  selectionRevision: number;
}>;
export type ExistingGameOwner = Readonly<{
  gameSessionId: string;
  bindingDigest: string;
  ownerToken: string;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
  origin: GameOrigin;
  world: GameWorld;
  state: GameOwnerState;
}>;

/** All reads are injected; this module never discovers, writes, or repairs legacy paths. */
export type LegacyPartitionReader = Readonly<{
  readCurrentV3Ledger(continuityId: string): Promise<CurrentV3Ledger>;
  readExactChatThreadMetadata(continuityId: string): Promise<readonly ExactChatThreadMetadata[]>;
  readActiveSelections(continuityId: string): Promise<readonly ActiveChatSelection[]>;
  readExistingGameOwner(continuityId: string): Promise<ExistingGameOwner | null>;
}>;

/** Typed, immutable migration DTO for a future semantic-store adoption command. */
export type LegacyContinuitySnapshot = Readonly<{
  snapshotVersion: typeof CONTINUITY_PRODUCTION_MIGRATION_SNAPSHOT_VERSION;
  continuityId: string;
  companionId: string;
  playerId: string;
  legacyLedger: CurrentV3Ledger;
  chatThreads: readonly ExactChatThreadMetadata[];
  activeSelection: ActiveChatSelection | null;
  gameOwner: ExistingGameOwner | null;
  snapshotHash: string;
}>;

/** Read-only collection followed by fail-closed admission validation. */
export async function collectQuiescentLegacyContinuitySnapshot(
  continuityId: string,
  reader: LegacyPartitionReader,
): Promise<LegacyContinuitySnapshot> {
  assertOpaque(continuityId, "continuity_id");
  const [legacyLedger, chatThreads, activeSelections, gameOwner] = await Promise.all([
    reader.readCurrentV3Ledger(continuityId),
    reader.readExactChatThreadMetadata(continuityId),
    reader.readActiveSelections(continuityId),
    reader.readExistingGameOwner(continuityId),
  ]);
  return createQuiescentLegacyContinuitySnapshot({
    continuityId,
    legacyLedger,
    chatThreads,
    activeSelections,
    gameOwner,
  });
}

/** Canonicalizes and validates already collected legacy facts without any I/O. */
export function createQuiescentLegacyContinuitySnapshot(
  input: Readonly<{
    continuityId: string;
    legacyLedger: CurrentV3Ledger;
    chatThreads: readonly ExactChatThreadMetadata[];
    activeSelections: readonly ActiveChatSelection[];
    gameOwner: ExistingGameOwner | null;
  }>,
): LegacyContinuitySnapshot {
  validateCollectedFacts(input);
  const canonical = Object.freeze({
    snapshotVersion: CONTINUITY_PRODUCTION_MIGRATION_SNAPSHOT_VERSION,
    continuityId: input.continuityId,
    companionId: input.legacyLedger.companionId,
    playerId: input.legacyLedger.playerId,
    legacyLedger: freezeLedger(input.legacyLedger),
    chatThreads: Object.freeze([...input.chatThreads].sort(by("chatSurfaceSessionId")).map(freezeThread)),
    activeSelection: input.activeSelections.length === 0 ? null : freezeSelection(input.activeSelections[0]!),
    gameOwner: input.gameOwner === null ? null : freezeOwner(input.gameOwner),
  });
  const snapshotHash = canonicalSha256(canonical);
  return Object.freeze({ ...canonical, snapshotHash });
}

/** Revalidates a supplied canonical DTO, including its digest, before future adoption. */
export function validateQuiescentLegacyContinuitySnapshot(snapshot: LegacyContinuitySnapshot): void {
  if (
    !isRecord(snapshot) ||
    snapshot.snapshotVersion !== CONTINUITY_PRODUCTION_MIGRATION_SNAPSHOT_VERSION ||
    !isHash(snapshot.snapshotHash)
  )
    throw new Error("invalid_legacy_snapshot");
  const rebuilt = createQuiescentLegacyContinuitySnapshot({
    continuityId: snapshot.continuityId,
    legacyLedger: snapshot.legacyLedger,
    chatThreads: snapshot.chatThreads,
    activeSelections: snapshot.activeSelection === null ? [] : [snapshot.activeSelection],
    gameOwner: snapshot.gameOwner,
  });
  if (rebuilt.snapshotHash !== snapshot.snapshotHash) throw new Error("legacy_snapshot_hash_mismatch");
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Deterministic JSON canonicalization for JSON-compatible migration facts only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("noncanonical_snapshot_field");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("noncanonical_snapshot_field");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function validateCollectedFacts(
  input: Readonly<{
    continuityId: string;
    legacyLedger: CurrentV3Ledger;
    chatThreads: readonly ExactChatThreadMetadata[];
    activeSelections: readonly ActiveChatSelection[];
    gameOwner: ExistingGameOwner | null;
  }>,
): void {
  assertOpaque(input.continuityId, "continuity_id");
  const ledger = input.legacyLedger;
  if (
    !isRecord(ledger) ||
    ledger.schemaVersion !== CURRENT_CONTINUITY_LEDGER_SCHEMA_VERSION ||
    ledger.continuityId !== input.continuityId ||
    !isOpaque(ledger.companionId) ||
    !isOpaque(ledger.playerId) ||
    !Array.isArray(ledger.sessions) ||
    !Array.isArray(ledger.events)
  )
    throw new Error("invalid_current_v3_ledger");
  if (!Array.isArray(input.chatThreads) || !Array.isArray(input.activeSelections))
    throw new Error("invalid_legacy_snapshot");
  const sessions = new Map<string, LegacySession>();
  for (const session of ledger.sessions) {
    validateSession(session, input.continuityId);
    if (sessions.has(session.sessionId)) throw new Error("duplicate_legacy_session");
    sessions.set(session.sessionId, session);
  }
  const threads = new Map<string, ExactChatThreadMetadata>();
  for (const thread of input.chatThreads) {
    if (
      !isThread(thread, input.continuityId, ledger.companionId, ledger.playerId) ||
      threads.has(thread.chatSurfaceSessionId)
    )
      throw new Error("invalid_chat_thread_metadata");
    const session = sessions.get(thread.chatSurfaceSessionId);
    if (!session || session.surface !== "chat") throw new Error("chat_thread_session_mismatch");
    threads.set(thread.chatSurfaceSessionId, thread);
  }
  if (threads.size !== [...sessions.values()].filter((session) => session.surface === "chat").length)
    throw new Error("chat_thread_session_mismatch");
  validateEvents(ledger.events, sessions);
  const unresolvedGames = [...sessions.values()].filter(
    (session) => session.surface === "game" && session.state !== "ended",
  );
  if (unresolvedGames.length > 1) throw new Error("multiple_unresolved_game_sessions");
  if (input.gameOwner !== null) validateOwner(input.gameOwner, unresolvedGames[0], input.continuityId);
  if ((unresolvedGames.length === 1) !== (input.gameOwner !== null)) throw new Error("game_owner_presence_mismatch");
  for (const game of unresolvedGames) {
    const originThread = threads.get(game.origin!.chatSurfaceSessionId);
    if (
      !originThread ||
      originThread.chatThreadId !== game.origin!.chatThreadId ||
      originThread.companionId !== game.origin!.companionId ||
      originThread.playerId !== game.origin!.playerId
    )
      throw new Error("game_origin_chat_binding_mismatch");
  }
  if (input.activeSelections.length > 1) throw new Error("multiple_active_chat_selections");
  const activeChats = [...sessions.values()].filter(
    (session) => session.surface === "chat" && session.state === "active",
  );
  if (activeChats.length > 1) throw new Error("multiple_active_chat_sessions");
  const selection = input.activeSelections[0];
  if ((activeChats.length === 1) !== (selection !== undefined)) throw new Error("active_chat_selection_mismatch");
  if (selection !== undefined) {
    if (!isSelection(selection) || selection.chatSurfaceSessionId !== activeChats[0]!.sessionId)
      throw new Error("active_chat_selection_mismatch");
    const thread = threads.get(selection.chatSurfaceSessionId);
    if (!thread || thread.chatThreadId !== selection.chatThreadId || thread.lifecycle !== "active")
      throw new Error("active_chat_selection_mismatch");
  }
  // Collection is read-only. Quiescence/exclusion is a future coordinator concern;
  // an internally consistent unresolved Game is a valid canonical legacy fact.
}

function validateSession(value: unknown, continuityId: string): asserts value is LegacySession {
  if (
    !isRecord(value) ||
    !isOpaque(value.sessionId) ||
    !isSurface(value.surface) ||
    !isState(value.state) ||
    !timestamp(value.createdAtMs) ||
    !timestamp(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  )
    throw new Error("invalid_legacy_session");
  if (value.surface === "chat") {
    if (value.origin !== null || value.world !== null || value.returnChatSessionId !== null)
      throw new Error("invalid_chat_session_scope");
    return;
  }
  if (
    !isOrigin(value.origin, continuityId) ||
    !isWorld(value.world) ||
    value.returnChatSessionId !== value.origin.chatSurfaceSessionId
  )
    throw new Error("invalid_game_session_scope");
}
function validateEvents(events: readonly LegacyEvent[], sessions: ReadonlyMap<string, LegacySession>): void {
  const eventIds = new Set<string>();
  const history = new Map<string, LegacySessionState>();
  const created = new Set<string>();
  for (const event of [...events].sort(
    (a, b) => a.occurredAtMs - b.occurredAtMs || a.eventId.localeCompare(b.eventId),
  )) {
    if (
      !isRecord(event) ||
      !isHash(event.eventId) ||
      !isEventType(event.type) ||
      !isOpaque(event.sessionId) ||
      !isSurface(event.surface) ||
      !timestamp(event.occurredAtMs) ||
      eventIds.has(event.eventId)
    )
      throw new Error("invalid_legacy_event");
    const session = sessions.get(event.sessionId);
    if (
      !session ||
      session.surface !== event.surface ||
      event.occurredAtMs < session.createdAtMs ||
      event.occurredAtMs > session.updatedAtMs
    )
      throw new Error("legacy_event_session_mismatch");
    const before = history.get(event.sessionId);
    const after = transition(before, event.type);
    if (after === null) throw new Error("invalid_legacy_event_transition");
    history.set(event.sessionId, after);
    if (event.type === "session_created") created.add(event.sessionId);
    eventIds.add(event.eventId);
  }
  for (const session of sessions.values())
    if (!created.has(session.sessionId) || history.get(session.sessionId) !== session.state)
      throw new Error("legacy_session_event_integrity_mismatch");
}
function transition(state: LegacySessionState | undefined, event: LegacyEventType): LegacySessionState | null {
  if (event === "session_created") return state === undefined ? "active" : null;
  if (event === "surface_suspended") return state === "active" ? "suspended" : null;
  if (event === "surface_resumed") return state === "suspended" ? "active" : null;
  if (event === "surface_return_started") return state === "active" ? "returning" : null;
  if (event === "surface_recovery_required")
    return state === "active" || state === "returning" ? "recovery_required" : null;
  if (event === "surface_ended")
    return state === "returning" || state === "active" || state === "suspended" || state === "recovery_required"
      ? "ended"
      : null;
  return null;
}
function validateOwner(owner: ExistingGameOwner, game: LegacySession | undefined, continuityId: string): void {
  if (
    !game ||
    game.surface !== "game" ||
    !isRecord(owner) ||
    !isOpaque(owner.gameSessionId) ||
    owner.gameSessionId !== game.sessionId ||
    !isHash(owner.bindingDigest) ||
    !isOpaque(owner.ownerToken) ||
    !isOpaque(owner.runtimeInstanceId) ||
    !Number.isSafeInteger(owner.ownerPid) ||
    owner.ownerPid <= 0 ||
    !isOpaque(owner.ownerProcessStartIdentity) ||
    !isOwnerState(owner.state) ||
    !same(owner.origin, game.origin) ||
    !same(owner.world, game.world) ||
    owner.origin.continuityId !== continuityId
  )
    throw new Error("invalid_game_owner_scope");
  if (
    (game.state === "active" && owner.state !== "owned") ||
    (game.state === "returning" && owner.state !== "return_pending") ||
    (game.state === "recovery_required" && owner.state !== "recovery_required")
  )
    throw new Error("game_owner_state_mismatch");
}
function freezeLedger(ledger: CurrentV3Ledger): CurrentV3Ledger {
  return Object.freeze({
    schemaVersion: 3,
    continuityId: ledger.continuityId,
    companionId: ledger.companionId,
    playerId: ledger.playerId,
    sessions: Object.freeze([...ledger.sessions].sort(by("sessionId")).map(freezeSession)),
    events: Object.freeze(
      [...ledger.events]
        .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventId.localeCompare(b.eventId))
        .map(freezeEvent),
    ),
  });
}
function freezeSession(s: LegacySession): LegacySession {
  return Object.freeze({
    ...s,
    origin: s.origin === null ? null : Object.freeze({ ...s.origin }),
    world: s.world === null ? null : Object.freeze({ ...s.world }),
  });
}
function freezeEvent(e: LegacyEvent): LegacyEvent {
  return Object.freeze({ ...e });
}
function freezeThread(t: ExactChatThreadMetadata): ExactChatThreadMetadata {
  return Object.freeze({ ...t });
}
function freezeSelection(s: ActiveChatSelection): ActiveChatSelection {
  return Object.freeze({ ...s });
}
function freezeOwner(o: ExistingGameOwner): ExistingGameOwner {
  return Object.freeze({ ...o, origin: Object.freeze({ ...o.origin }), world: Object.freeze({ ...o.world }) });
}
function by<K extends string>(key: K) {
  return <T extends Record<K, string>>(a: T, b: T): number => a[key].localeCompare(b[key]);
}
function isThread(
  v: unknown,
  continuityId: string,
  companionId: string,
  playerId: string,
): v is ExactChatThreadMetadata {
  return (
    isRecord(v) &&
    isOpaque(v.chatThreadId) &&
    isOpaque(v.chatSurfaceSessionId) &&
    v.companionId === companionId &&
    v.playerId === playerId &&
    v.continuityId === continuityId &&
    isLifecycle(v.lifecycle) &&
    revision(v.managementRevision) &&
    ((v.lifecycle === "trashed" && (v.trashRestoreLifecycle === "active" || v.trashRestoreLifecycle === "archived")) ||
      (v.lifecycle !== "trashed" && v.trashRestoreLifecycle === null))
  );
}
function isSelection(v: unknown): v is ActiveChatSelection {
  return isRecord(v) && isOpaque(v.chatThreadId) && isOpaque(v.chatSurfaceSessionId) && revision(v.selectionRevision);
}
function isOrigin(v: unknown, continuityId: string): v is GameOrigin {
  return (
    isRecord(v) &&
    isOpaque(v.chatThreadId) &&
    isOpaque(v.chatSurfaceSessionId) &&
    isOpaque(v.playerId) &&
    isOpaque(v.companionId) &&
    v.continuityId === continuityId
  );
}
function isWorld(v: unknown): v is GameWorld {
  return isRecord(v) && isOpaque(v.integrationId) && isOpaque(v.saveId) && isOpaque(v.worldId);
}
function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function isOpaque(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}
function assertOpaque(v: unknown, label: string): asserts v is string {
  if (!isOpaque(v)) throw new Error(`invalid_${label}`);
}
function isHash(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}
function timestamp(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function revision(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function isSurface(v: unknown): v is LegacySurface {
  return v === "chat" || v === "game";
}
function isState(v: unknown): v is LegacySessionState {
  return v === "active" || v === "suspended" || v === "returning" || v === "recovery_required" || v === "ended";
}
function isEventType(v: unknown): v is LegacyEventType {
  return (
    v === "session_created" ||
    v === "surface_suspended" ||
    v === "surface_resumed" ||
    v === "surface_return_started" ||
    v === "surface_recovery_required" ||
    v === "surface_ended"
  );
}
function isLifecycle(v: unknown): v is ChatThreadLifecycle {
  return v === "active" || v === "archived" || v === "trashed";
}
function isOwnerState(v: unknown): v is GameOwnerState {
  return v === "owned" || v === "return_pending" || v === "recovery_required";
}
function same(a: object | null, b: object | null): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
