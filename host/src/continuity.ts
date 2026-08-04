import { createHash, randomUUID } from "node:crypto";
import { withPathLock } from "./path-lock.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompanionIdentity, RuntimePaths } from "./runtime.js";

export const CONTINUITY_LEDGER_SCHEMA_VERSION = 1 as const;
/** Retain enough explicit user-visible surface lifecycle for recovery without allowing unbounded ledger growth. */
export const MAX_CONTINUITY_SESSIONS = 512;
export const MAX_CONTINUITY_EVENTS = 4_096;
export type CompanionSurface = "chat" | "game";
export type SurfaceSessionState = "active" | "suspended" | "ended";

export type SurfaceSession = Readonly<{
  sessionId: string;
  surface: CompanionSurface;
  state: SurfaceSessionState;
  createdAtMs: number;
  updatedAtMs: number;
  /** A game session can be factual only for this explicit live-world scope. */
  world: Readonly<{ integrationId: string; saveId: string; worldId: string }> | null;
}>;

export type ContinuityLedger = Readonly<{
  schemaVersion: typeof CONTINUITY_LEDGER_SCHEMA_VERSION;
  continuityId: string;
  sessions: readonly SurfaceSession[];
  events: readonly Readonly<{
    eventId: string;
    type: "session_created" | "surface_suspended" | "surface_resumed" | "surface_ended";
    sessionId: string;
    surface: CompanionSurface;
    occurredAtMs: number;
  }>[];
}>;

export type ContinuitySelection = Readonly<{
  ledger: ContinuityLedger;
  session: SurfaceSession;
}>;

export function continuityLedgerPath(paths: RuntimePaths): string {
  return join(paths.runtimeCwd, "companion-continuity.json");
}

export function surfaceSessionDirectory(paths: RuntimePaths, sessionId: string): string {
  assertOpaque("sessionId", sessionId);
  return join(paths.runtimeCwd, "surface-sessions", sessionId);
}

/**
 * Select a user-visible surface session. No timer, token count, RSS value, or
 * background process invokes this API: callers do so only for explicit product
 * actions such as open chat, enter game, return to chat, or New Chat.
 */
export async function selectContinuitySession(
  paths: RuntimePaths,
  identity: CompanionIdentity,
  request: Readonly<{ surface: CompanionSurface; sessionId?: string; world?: SurfaceSession["world"] }>,
  now: () => number = Date.now,
): Promise<ContinuitySelection> {
  if (identity.continuityId === undefined) throw new Error("continuity_id_required");
  assertOpaque("continuityId", identity.continuityId);
  await mkdir(paths.runtimeCwd, { recursive: true });
  const path = continuityLedgerPath(paths);
  return withPathLock(path, async () => {
    const current = await readLedger(path, identity.continuityId!);
    const timestamp = now();
    const desiredId = request.sessionId;
    if (desiredId !== undefined) assertOpaque("sessionId", desiredId);
    const existing = desiredId === undefined ? findResumable(current.sessions, request.surface, request.world ?? null) : current.sessions.find((item) => item.sessionId === desiredId);
    if (existing !== undefined) {
      if (existing.surface !== request.surface || !sameWorld(existing.world, request.world ?? null)) throw new Error("surface_session_scope_mismatch");
      const ledger = activate(current, existing.sessionId, timestamp, "surface_resumed");
      await writeLedger(path, ledger);
      return Object.freeze({ ledger, session: ledger.sessions.find((item) => item.sessionId === existing.sessionId)! });
    }

    const sessionId = desiredId ?? randomUUID();
    const created: SurfaceSession = Object.freeze({ sessionId, surface: request.surface, state: "active", createdAtMs: timestamp, updatedAtMs: timestamp, world: request.surface === "game" ? requireWorld(request.world ?? null) : null });
    const suspended = current.sessions.map((item) => item.state === "active" ? Object.freeze({ ...item, state: "suspended" as const, updatedAtMs: timestamp }) : item);
    const ledger = boundedLedger(current, [...suspended, created], [...current.events, ...suspended.filter((item, index) => current.sessions[index]!.state === "active").map((item) => event("surface_suspended", item, timestamp)), event("session_created", created, timestamp)]);
    await writeLedger(path, ledger);
    return Object.freeze({ ledger, session: created });
  });
}

export async function endContinuitySession(paths: RuntimePaths, identity: CompanionIdentity, sessionId: string, now: () => number = Date.now): Promise<ContinuityLedger> {
  if (identity.continuityId === undefined) throw new Error("continuity_id_required");
  assertOpaque("sessionId", sessionId);
  const path = continuityLedgerPath(paths);
  return withPathLock(path, async () => {
    const current = await readLedger(path, identity.continuityId!);
    if (!current.sessions.some((item) => item.sessionId === sessionId)) throw new Error("surface_session_not_found");
    const ledger = transition(current, sessionId, "ended", now(), "surface_ended");
    await writeLedger(path, ledger);
    return ledger;
  });
}

async function readLedger(path: string, continuityId: string): Promise<ContinuityLedger> {
  try { return validateLedger(JSON.parse(await readFile(path, "utf8")) as unknown, continuityId); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return Object.freeze({ schemaVersion: CONTINUITY_LEDGER_SCHEMA_VERSION, continuityId, sessions: Object.freeze([]), events: Object.freeze([]) });
    throw error;
  }
}

async function writeLedger(path: string, ledger: ContinuityLedger): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2), "utf8");
  await rename(temporary, path);
}

function transition(ledger: ContinuityLedger, sessionId: string, state: SurfaceSessionState, timestamp: number, eventType: ContinuityLedger["events"][number]["type"]): ContinuityLedger {
  const session = ledger.sessions.find((item) => item.sessionId === sessionId);
  if (session === undefined) throw new Error("surface_session_not_found");
  const sessions = ledger.sessions.map((item) => item.sessionId === sessionId ? Object.freeze({ ...item, state, updatedAtMs: timestamp }) : item);
  const updated = sessions.find((item) => item.sessionId === sessionId)!;
  return boundedLedger(ledger, sessions, [...ledger.events, event(eventType, updated, timestamp)]);
}
function activate(ledger: ContinuityLedger, sessionId: string, timestamp: number, eventType: "surface_resumed"): ContinuityLedger {
  const target = ledger.sessions.find((item) => item.sessionId === sessionId);
  if (target === undefined) throw new Error("surface_session_not_found");
  const suspended = ledger.sessions.filter((item) => item.state === "active" && item.sessionId !== sessionId);
  const sessions = ledger.sessions.map((item) => item.sessionId === sessionId ? Object.freeze({ ...item, state: "active" as const, updatedAtMs: timestamp }) : item.state === "active" ? Object.freeze({ ...item, state: "suspended" as const, updatedAtMs: timestamp }) : item);
  const updated = sessions.find((item) => item.sessionId === sessionId)!;
  return boundedLedger(ledger, sessions, [...ledger.events, ...suspended.map((item) => event("surface_suspended", item, timestamp)), event(eventType, updated, timestamp)]);
}

function boundedLedger(base: ContinuityLedger, sessions: readonly SurfaceSession[], events: readonly ContinuityLedger["events"][number][]): ContinuityLedger {
  const activeOrResumable = sessions.filter((item) => item.state !== "ended");
  // A resumable user-visible session cannot be silently deleted or compacted.
  // Refuse a new lifecycle entry at capacity; callers must explicitly end old
  // sessions rather than losing a player-visible recovery path.
  if (activeOrResumable.length > MAX_CONTINUITY_SESSIONS) throw new Error("continuity_resumable_session_capacity_exhausted");
  const ended = sessions.filter((item) => item.state === "ended").sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  const retainedSessions = [...activeOrResumable, ...ended.slice(0, Math.max(0, MAX_CONTINUITY_SESSIONS - activeOrResumable.length))];
  const retainedIds = new Set(retainedSessions.map((item) => item.sessionId));
  const retainedEvents = events.filter((item) => retainedIds.has(item.sessionId)).slice(-MAX_CONTINUITY_EVENTS);
  return Object.freeze({ ...base, sessions: Object.freeze(retainedSessions), events: Object.freeze(retainedEvents) });
}

function findResumable(sessions: readonly SurfaceSession[], surface: CompanionSurface, world: SurfaceSession["world"]): SurfaceSession | undefined {
  return [...sessions].reverse().find((item) => item.surface === surface && item.state !== "ended" && sameWorld(item.world, world));
}
function requireWorld(world: SurfaceSession["world"]): NonNullable<SurfaceSession["world"]> { if (world === null || world === undefined) throw new Error("game_surface_world_required"); return world; }
function sameWorld(left: SurfaceSession["world"], right: SurfaceSession["world"] | undefined): boolean { return left?.integrationId === right?.integrationId && left?.saveId === right?.saveId && left?.worldId === right?.worldId; }
function event(type: ContinuityLedger["events"][number]["type"], session: SurfaceSession, occurredAtMs: number) { return Object.freeze({ eventId: createHash("sha256").update(`${type}\u001f${session.sessionId}\u001f${occurredAtMs}`).digest("hex"), type, sessionId: session.sessionId, surface: session.surface, occurredAtMs }); }
function assertOpaque(label: string, value: string): void { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`invalid_${label}`); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && typeof error.code === "string"; }

function validateLedger(value: unknown, continuityId: string): ContinuityLedger {
  if (!isRecord(value) || value.schemaVersion !== CONTINUITY_LEDGER_SCHEMA_VERSION || value.continuityId !== continuityId || !Array.isArray(value.sessions) || !Array.isArray(value.events) || value.sessions.length > MAX_CONTINUITY_SESSIONS || value.events.length > MAX_CONTINUITY_EVENTS) throw new Error("invalid_continuity_ledger");
  const sessions = value.sessions.map(validateSession);
  if (new Set(sessions.map((item) => item.sessionId)).size !== sessions.length || sessions.filter((item) => item.state === "active").length > 1) throw new Error("invalid_continuity_ledger");
  const events = value.events.map((item) => {
    if (!isRecord(item) || !isHash(item.eventId) || !isEventType(item.type) || !isOpaqueString(item.sessionId) || !isSurface(item.surface) || !isTimestamp(item.occurredAtMs)) throw new Error("invalid_continuity_ledger");
    return Object.freeze({ eventId: item.eventId, type: item.type, sessionId: item.sessionId, surface: item.surface, occurredAtMs: item.occurredAtMs });
  });
  return Object.freeze({ schemaVersion: CONTINUITY_LEDGER_SCHEMA_VERSION, continuityId, sessions: Object.freeze(sessions), events: Object.freeze(events) });
}
function validateSession(value: unknown): SurfaceSession { if (!isRecord(value) || !isOpaqueString(value.sessionId) || !isSurface(value.surface) || !isState(value.state) || !isTimestamp(value.createdAtMs) || !isTimestamp(value.updatedAtMs) || (value.surface === "chat" && value.world !== null) || (value.surface === "game" && !isWorld(value.world))) throw new Error("invalid_continuity_ledger"); return Object.freeze({ sessionId: value.sessionId, surface: value.surface, state: value.state, createdAtMs: value.createdAtMs, updatedAtMs: value.updatedAtMs, world: value.world === null ? null : Object.freeze({ integrationId: value.world.integrationId, saveId: value.world.saveId, worldId: value.world.worldId }) }); }
function isWorld(value: unknown): value is { integrationId: string; saveId: string; worldId: string } { return isRecord(value) && isOpaqueString(value.integrationId) && isOpaqueString(value.saveId) && isOpaqueString(value.worldId); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOpaqueString(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isSurface(value: unknown): value is CompanionSurface { return value === "chat" || value === "game"; }
function isState(value: unknown): value is SurfaceSessionState { return value === "active" || value === "suspended" || value === "ended"; }
function isEventType(value: unknown): value is ContinuityLedger["events"][number]["type"] { return value === "session_created" || value === "surface_suspended" || value === "surface_resumed" || value === "surface_ended"; }
