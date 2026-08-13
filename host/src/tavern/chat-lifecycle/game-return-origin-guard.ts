import { readFile } from "node:fs/promises";

import { continuityLedgerPath } from "../../continuity.js";
import { resolveRuntimePaths, type CompanionIdentity } from "../../runtime.js";

/** The only metadata the guard may obtain from Tavern thread persistence. */
export type GameReturnOriginThread = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;

/** Host-owned exact lookup; it must not expose a browser-selected or raw-ledger projection. */
export type GameReturnOriginThreadLookup = (
  input: Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
  }>,
) => Promise<GameReturnOriginThread | null>;

export type CreateGameReturnOriginGuardOptions = Readonly<{
  /** Authoritative Host identity; runtime paths are always derived from this binding. */
  identity: CompanionIdentity;
  runtimeRoot?: string;
  lookupThread: GameReturnOriginThreadLookup;
}>;

export type GameReturnOriginGuard = (
  input: Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    companionId: string;
    continuityId: string;
  }>,
) => Promise<boolean>;

type LedgerSession = Readonly<{
  sessionId: string;
  surface: "chat" | "game";
  state: "active" | "suspended" | "returning" | "recovery_required" | "ended";
  world: unknown;
  origin: GameReturnOrigin | null;
}>;
type GameReturnOrigin = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
}>;

/**
 * Creates the Host-only lifecycle safety predicate. It deliberately returns a
 * boolean rather than a cause or ledger-derived value: callers learn only
 * whether a lifecycle mutation is safe. Any unavailable or malformed durable
 * state is unsafe.
 */
export function createGameReturnOriginGuard(options: CreateGameReturnOriginGuardOptions): GameReturnOriginGuard {
  const identity = options.identity;
  const continuityId = identity.continuityId;
  if (
    !isOpaque(identity.playerId) ||
    !isOpaque(identity.companionId) ||
    !isOpaque(continuityId) ||
    typeof options.lookupThread !== "function"
  ) {
    return async () => false;
  }
  const paths = resolveRuntimePaths(identity, options.runtimeRoot);
  const ledgerPath = continuityLedgerPath(paths);

  return async (input): Promise<boolean> => {
    if (!isThreadBinding(input) || input.companionId !== identity.companionId || input.continuityId !== continuityId)
      return false;
    try {
      const thread = await options.lookupThread({
        chatThreadId: input.chatThreadId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
      });
      if (!isExactThread(thread, input)) return false;
      const sessions = parseLedger(await readFile(ledgerPath, "utf8"), continuityId);
      if (sessions === null) return false;

      const unresolvedGames = sessions.filter((session) => session.surface === "game" && session.state !== "ended");
      // A recovery-required Game has no safely usable return origin. Multiple
      // live rows are likewise ambiguous, regardless of their apparent IDs.
      if (unresolvedGames.length > 1 || unresolvedGames.some((session) => session.state === "recovery_required"))
        return false;
      if (unresolvedGames.length === 0) return true;

      const game = unresolvedGames[0]!;
      if (game.origin === null || !isWorld(game.world)) return false;
      const origin = game.origin;
      // A v3 Game row protects only its complete durable origin tuple. Every
      // scope field and the referenced Chat surface are verified before any
      // different target can be considered safe.
      if (
        origin.playerId !== identity.playerId ||
        origin.companionId !== identity.companionId ||
        origin.continuityId !== continuityId
      )
        return false;
      const originSurface = sessions.find((session) => session.sessionId === origin.chatSurfaceSessionId);
      if (originSurface === undefined || originSurface.surface !== "chat" || originSurface.state === "ended")
        return false;
      // Exact return origins are protected for the whole active/returning
      // interval. No active-selection, latest-thread, or fallback lookup is used.
      return origin.chatThreadId !== input.chatThreadId || origin.chatSurfaceSessionId !== input.chatSurfaceSessionId;
    } catch {
      return false;
    }
  };
}

function parseLedger(source: string, continuityId: string): readonly LedgerSession[] | null {
  const value: unknown = JSON.parse(source);
  // Lifecycle management consumes only the current v3 ledger with its full
  // immutable origin tuple. Legacy and pre-origin schemas fail closed.
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    value.continuityId !== continuityId ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.events)
  )
    return null;
  const sessions = value.sessions.map(parseSession);
  if (sessions.some((session) => session === null)) return null;
  const parsed = sessions as LedgerSession[];
  if (
    new Set(parsed.map((session) => session.sessionId)).size !== parsed.length ||
    parsed.filter((session) => session.state === "active").length > 1
  )
    return null;
  return parsed;
}

function parseSession(value: unknown): LedgerSession | null {
  if (
    !isRecord(value) ||
    !isOpaque(value.sessionId) ||
    !isSurface(value.surface) ||
    !isState(value.state) ||
    !Object.hasOwn(value, "world") ||
    !Object.hasOwn(value, "origin")
  )
    return null;
  if (value.surface === "chat" && (value.world !== null || value.origin !== null)) return null;
  if (value.surface === "game" && (!isWorld(value.world) || !isOrigin(value.origin))) return null;
  return Object.freeze({
    sessionId: value.sessionId,
    surface: value.surface,
    state: value.state,
    world: value.world,
    origin: value.origin as GameReturnOrigin | null,
  });
}

function isExactThread(value: GameReturnOriginThread | null, input: Parameters<GameReturnOriginGuard>[0]): boolean {
  return (
    value !== null &&
    isThreadBinding(value) &&
    value.chatThreadId === input.chatThreadId &&
    value.chatSurfaceSessionId === input.chatSurfaceSessionId &&
    value.companionId === input.companionId &&
    value.continuityId === input.continuityId
  );
}
function isThreadBinding(value: unknown): value is GameReturnOriginThread {
  return (
    isRecord(value) &&
    isOpaque(value.chatThreadId) &&
    isOpaque(value.chatSurfaceSessionId) &&
    isOpaque(value.companionId) &&
    isOpaque(value.continuityId)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isOrigin(value: unknown): value is GameReturnOrigin {
  return (
    isRecord(value) &&
    isOpaque(value.chatThreadId) &&
    isOpaque(value.chatSurfaceSessionId) &&
    isOpaque(value.playerId) &&
    isOpaque(value.companionId) &&
    isOpaque(value.continuityId)
  );
}
function isWorld(value: unknown): boolean {
  return isRecord(value) && isOpaque(value.integrationId) && isOpaque(value.saveId) && isOpaque(value.worldId);
}
function isSurface(value: unknown): value is "chat" | "game" {
  return value === "chat" || value === "game";
}
function isState(value: unknown): value is LedgerSession["state"] {
  return (
    value === "active" ||
    value === "suspended" ||
    value === "returning" ||
    value === "recovery_required" ||
    value === "ended"
  );
}
