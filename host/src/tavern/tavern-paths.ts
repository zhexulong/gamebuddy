import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CompanionIdentity, RuntimePaths } from "../runtime.js";
import { identityKey } from "../runtime.js";

export type TavernPaths = Readonly<{
  root: string;
  playerRoot: string;
  companionRoot: string;
  continuityRoot: string;
  companionId: string;
  continuityId: string;
}>;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
export function resolveTavernPaths(paths: RuntimePaths, identity: CompanionIdentity): TavernPaths {
  valid(identity.playerId);
  valid(identity.companionId);
  if (identity.continuityId === undefined) throw new Error("tavern_continuity_id_required");
  valid(identity.continuityId);
  const root = join(resolve(paths.root), "tavern", "v1");
  return Object.freeze({
    root,
    playerRoot: join(root, "players", digest(identity.playerId)),
    companionRoot: join(root, "companions", digest(`${identity.playerId}\u001f${identity.companionId}`)),
    continuityRoot: join(root, "continuities", identityKey(identity)),
    companionId: identity.companionId,
    continuityId: identity.continuityId,
  });
}
export function tavernRootForPath(path: string): string {
  const resolved = resolve(path);
  const normalized = resolved.replaceAll("\\", "/");
  const match = /^(.*\/tavern\/v1)(?:\/|$)/iu.exec(normalized);
  if (match === null) throw new Error("unsafe_tavern_path");
  return resolve(match[1]);
}
export function tavernRevisionPath(directory: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_tavern_revision");
  return join(safeDirectory(directory), "revisions", `${revision}.json`);
}
export function tavernThreadPath(paths: TavernPaths, threadId: string, file: "thread.json" | "messages.json"): string {
  valid(threadId);
  return join(paths.continuityRoot, "threads", threadId, file);
}
export function tavernImportPath(paths: TavernPaths, importId: string, file: "candidate.json" | "report.json"): string {
  valid(importId);
  return join(paths.playerRoot, "imports", importId, file);
}
function safeDirectory(path: string): string {
  const resolved = resolve(path);
  const normalized = resolved.replaceAll("\\", "/").split("/").filter(Boolean);
  const hasTavernV1 = normalized.some((part, index) =>
    part.toLowerCase() === "tavern" && normalized[index + 1]?.toLowerCase() === "v1",
  );
  if (!hasTavernV1) throw new Error("unsafe_tavern_path");
  return resolved;
}
function valid(v: string): void {
  if (!ID.test(v)) throw new Error("invalid_tavern_id");
}
function digest(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}
