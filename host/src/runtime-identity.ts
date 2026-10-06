/**
 * Pure identity/path leaf shared by runtime construction and Tavern path
 * derivation. It carries no store authority, no lifecycle, and no runtime
 * imports: construction and Tavern modules import this leaf instead of the
 * public `runtime.ts` facade so the Host production graph stays one-way.
 *
 * Keep this module free of project imports. Only `node:crypto`/`node:os`/
 * `node:path` pure helpers live here.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CompanionIdentity = Readonly<{
  playerId: string;
  companionId: string;
  continuityId?: string;
  saveId?: string;
  worldId?: string;
}>;

export type RuntimePaths = Readonly<{
  root: string;
  runtimeCwd: string;
  agentDir: string;
  sessionDir: string;
  identityProfilePath: string;
  identityProfileBindingPath: string;
  runManifestPath: string;
  /** Explicit user-visible surface session ID when the continuity ledger selects one. */
  surfaceSessionId?: string;
}>;

/** Thinking levels a Host-owned catalog model advertises for selection. */
export type CompanionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The thinking levels the embedded runtime accepts, in pi's own order.
 *
 * The authority is pi's `VALID_THINKING_LEVELS` (pi-coding-agent/dist/cli/args.js). A
 * level outside this set is not a preference the runtime can express: pi's own parser
 * refuses it. So this mirrors that set rather than choosing a subset of its own.
 */
export const COMPANION_THINKING_LEVELS: readonly CompanionThinkingLevel[] = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Bounded player-supplied model id. One spelling for every store that accepts a
 * player's own model id: the connection record's endpoint model and the Chat /
 * Game model profile both name a model the player typed, never a provider
 * payload and never a closed catalog union (design/28 §2.3).
 */
export const PLAYER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

/**
 * The exact provider/model/thinking selection one runtime is constructed with.
 * Every field is an open string because the player's own connection or model
 * profile selection decides it (design/28 §5.3, §2.3); the runtime still fails
 * closed when the selected model is not resolvable from the provider store. The
 * thinking level is forwarded to the embedded runtime exactly as the player
 * typed it — that runtime clamps a level the selected model does not advertise.
 */
export type CompanionModelConfig = Readonly<{
  provider: string;
  modelId: string;
  thinkingLevel: string;
}>;

function requireOpaqueSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(
      `${label} must be a 1–128 character opaque identifier using only letters, digits, _ and -.`,
    );
  }
  return value;
}

function requiredGameId(
  label: "saveId" | "worldId",
  value: string | undefined,
): string {
  if (value === undefined)
    throw new Error(`${label} is required when continuityId is absent.`);
  return value;
}

export function identityKey(identity: CompanionIdentity): string {
  const canonical =
    identity.continuityId === undefined
      ? [
          requireOpaqueSegment("playerId", identity.playerId),
          requireOpaqueSegment(
            "saveId",
            requiredGameId("saveId", identity.saveId),
          ),
          requireOpaqueSegment(
            "worldId",
            requiredGameId("worldId", identity.worldId),
          ),
          requireOpaqueSegment("companionId", identity.companionId),
        ]
      : [
          requireOpaqueSegment("playerId", identity.playerId),
          requireOpaqueSegment("companionId", identity.companionId),
          requireOpaqueSegment("continuityId", identity.continuityId),
        ];
  return createHash("sha256").update(canonical.join("\u001f")).digest("hex");
}

export function resolveRuntimePaths(
  identity: CompanionIdentity,
  root = join(homedir(), ".gamebuddy"),
  surfaceSessionId?: string,
): RuntimePaths {
  const key = identityKey(identity);
  const resolvedRoot = resolve(root);
  const runtimeCwd = join(resolvedRoot, "contexts", key);
  if (surfaceSessionId !== undefined)
    requireOpaqueSegment("surfaceSessionId", surfaceSessionId);
  const sessionRoot =
    surfaceSessionId === undefined
      ? runtimeCwd
      : join(runtimeCwd, "surface-sessions", surfaceSessionId);

  return {
    root: resolvedRoot,
    runtimeCwd,
    agentDir: join(runtimeCwd, "pi-agent"),
    sessionDir: join(sessionRoot, "sessions"),
    identityProfilePath: join(runtimeCwd, "identity-profile.json"),
    identityProfileBindingPath:
      surfaceSessionId === undefined
        ? join(runtimeCwd, "identity-profile-binding.json")
        : join(sessionRoot, "identity-profile-binding.json"),
    runManifestPath:
      surfaceSessionId === undefined
        ? join(runtimeCwd, "companion-run-manifest.json")
        : join(sessionRoot, "companion-run-manifest.json"),
    ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
  };
}