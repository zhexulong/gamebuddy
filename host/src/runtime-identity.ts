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

export type CompanionThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The exact provider/model/thinking selection one runtime is constructed with.
 * `provider` and `modelId` are open strings because the player's own connection
 * selection decides them (
 * design/28 §5.3); the runtime still fails closed when the selected model is not
 * resolvable from the provider store, and every writer that does not come from a
 * player connection keeps using the frozen constants below.
 */
export type CompanionModelConfig = Readonly<{
  provider: string;
  modelId: string;
  thinkingLevel: CompanionThinkingLevel;
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