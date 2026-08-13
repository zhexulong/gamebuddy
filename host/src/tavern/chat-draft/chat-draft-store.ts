import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifySafePathBoundary, withPathLock } from "../../path-lock.js";

/** Drafts are transient composer state: this module deliberately has no message,
 * transcript, export, Magic Context, or model-input dependency. */
export const CHAT_DRAFT_TEXT_MAX_LENGTH = 4_096;
const SCHEMA_VERSION = 1 as const;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f]/u;

/** Opaque ownership facts supplied by the Host's already-authoritative seam. */
export type ChatDraftScope = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;
export type ChatDraft = Readonly<{ revision: number; text: string | null }>;
export type ChatDraftUpdate = Readonly<{ scope: ChatDraftScope; expectedRevision: number; text: string }>;
export type ChatDraftDelete = Readonly<{ scope: ChatDraftScope; expectedRevision: number }>;
export type ChatDraftStore = Readonly<{
  read(scope: ChatDraftScope): Promise<ChatDraft>;
  update(input: ChatDraftUpdate): Promise<ChatDraft>;
  discard(input: ChatDraftDelete): Promise<ChatDraft>;
  delete(input: ChatDraftDelete): Promise<ChatDraft>;
}>;
type ChatDraftStoreOptions = Readonly<{ randomUUID?: () => string }>;

type Index = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  entries: Readonly<Record<string, Readonly<{ scopeDigest: string }>>>;
}>;
type StoredDraft = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  scopeDigest: string;
  revision: number;
  text: string | null;
}>;

/**
 * Durable Host-owned drafts keyed by the exact thread/surface pair. Companion
 * and continuity are recorded only as a one-way digest and must match every
 * access, so a pair cannot be accidentally reused across scope boundaries.
 */
export function createChatDraftStore(root: string, options: ChatDraftStoreOptions = {}): ChatDraftStore {
  const draftRoot = join(root, "tavern", "v1", "chat-drafts");
  const makeTemporaryId = options.randomUUID ?? randomUUID;
  const indexPath = join(draftRoot, "index.json");

  const access = async (
    scope: ChatDraftScope,
    expectedRevision: number | undefined,
    nextText: string | null | undefined,
  ): Promise<ChatDraft> => {
    validateScope(scope);
    if (expectedRevision !== undefined) validateRevision(expectedRevision);
    if (nextText !== undefined && nextText !== null) validateText(nextText);
    const key = digest(`${scope.chatThreadId}\u001f${scope.chatSurfaceSessionId}`);
    const scopeDigest = digest(
      `${scope.chatThreadId}\u001f${scope.chatSurfaceSessionId}\u001f${scope.companionId}\u001f${scope.continuityId}`,
    );
    return withPathLock(
      indexPath,
      async () => {
        const index = await readIndex(indexPath, draftRoot);
        const entry = index.entries[key];
        if (entry !== undefined && entry.scopeDigest !== scopeDigest) throw new Error("chat_draft_scope_mismatch");
        const dataPath = join(draftRoot, "drafts", `${key}.json`);
        // Keep the per-draft parent and leaf behind the same boundary checks as
        // the index. The index lock serializes store operations, while this
        // second lock also protects the data path across Host processes.
        return withPathLock(
          dataPath,
          async () => {
            const existing = entry === undefined ? null : await readDraft(dataPath, scopeDigest, draftRoot);
            const current = existing === null ? draft(0, null) : draft(existing.revision, existing.text);
            if (expectedRevision === undefined) return current;
            if (current.revision !== expectedRevision) throw new Error("chat_draft_revision_conflict");
            const stored: StoredDraft = Object.freeze({
              schemaVersion: SCHEMA_VERSION,
              scopeDigest,
              revision: current.revision + 1,
              text: nextText ?? null,
            });
            await writeAtomic(dataPath, JSON.stringify(stored), draftRoot, makeTemporaryId);
            const nextIndex: Index = Object.freeze({
              schemaVersion: SCHEMA_VERSION,
              entries: Object.freeze({ ...index.entries, [key]: Object.freeze({ scopeDigest }) }),
            });
            await writeAtomic(indexPath, JSON.stringify(nextIndex), draftRoot, makeTemporaryId);
            // Atomic mutation is not acknowledged until both persisted records read back.
            const readBack = await readDraft(dataPath, scopeDigest, draftRoot);
            const indexBack = await readIndex(indexPath, draftRoot);
            if (
              readBack.revision !== stored.revision ||
              readBack.text !== stored.text ||
              indexBack.entries[key]?.scopeDigest !== scopeDigest
            )
              throw new Error("chat_draft_readback_mismatch");
            return draft(readBack.revision, readBack.text);
          },
          { containmentRoot: draftRoot },
        );
      },
      { containmentRoot: draftRoot },
    );
  };

  return Object.freeze({
    read: (scope) => access(scope, undefined, undefined),
    update: ({ scope, expectedRevision, text }) => access(scope, expectedRevision, text),
    discard: ({ scope, expectedRevision }) => access(scope, expectedRevision, null),
    delete: ({ scope, expectedRevision }) => access(scope, expectedRevision, null),
  });
}

function draft(revision: number, text: string | null): ChatDraft {
  return Object.freeze({ revision, text });
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function validateScope(scope: ChatDraftScope): void {
  if (
    !scope ||
    !ID.test(scope.chatThreadId) ||
    !ID.test(scope.chatSurfaceSessionId) ||
    !ID.test(scope.companionId) ||
    !ID.test(scope.continuityId)
  )
    throw new Error("invalid_chat_draft_scope");
}
function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid_chat_draft_revision");
}
function validateText(text: string): void {
  if (text.length === 0 || text.length > CHAT_DRAFT_TEXT_MAX_LENGTH || FORBIDDEN_TEXT.test(text))
    throw new Error("invalid_chat_draft_text");
}
async function readIndex(path: string, containmentRoot: string): Promise<Index> {
  await verifySafePathBoundary(path, containmentRoot);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || !record(value.entries))
      throw new Error("invalid_chat_draft_index");
    for (const [key, entry] of Object.entries(value.entries))
      if (!/^[a-f0-9]{64}$/u.test(key) || !record(entry) || !hash(entry.scopeDigest))
        throw new Error("invalid_chat_draft_index");
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      entries: Object.freeze(
        Object.fromEntries(
          Object.entries(value.entries).map(([key, entry]) => [
            key,
            Object.freeze({ scopeDigest: (entry as { scopeDigest: string }).scopeDigest }),
          ]),
        ),
      ),
    });
  } catch (error) {
    if (nodeError(error, "ENOENT")) return Object.freeze({ schemaVersion: SCHEMA_VERSION, entries: Object.freeze({}) });
    throw error;
  }
}
async function readDraft(path: string, scopeDigest: string, containmentRoot: string): Promise<StoredDraft> {
  await verifySafePathBoundary(path, containmentRoot);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !record(value) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      value.scopeDigest !== scopeDigest ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 ||
      (value.text !== null &&
        (typeof value.text !== "string" ||
          value.text.length === 0 ||
          value.text.length > CHAT_DRAFT_TEXT_MAX_LENGTH ||
          FORBIDDEN_TEXT.test(value.text)))
    )
      throw new Error("chat_draft_scope_mismatch");
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      scopeDigest,
      revision: value.revision as number,
      text: value.text as string | null,
    });
  } catch (error) {
    if (nodeError(error, "ENOENT")) throw new Error("chat_draft_scope_mismatch");
    throw error;
  }
}
async function writeAtomic(
  path: string,
  content: string,
  containmentRoot: string,
  makeTemporaryId: () => string = randomUUID,
): Promise<void> {
  await verifySafePathBoundary(path, containmentRoot);
  const temporary = `${path}.${process.pid}.${makeTemporaryId()}.tmp`;
  let created = false;
  try {
    // wx prevents a pre-existing or raced replacement from turning the temp
    // path into an overwrite target. Boundary checks narrow, but cannot make
    // this sequence fully race-free without descriptor-relative APIs.
    await verifySafePathBoundary(temporary, containmentRoot);
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    created = true;
    await verifySafePathBoundary(temporary, containmentRoot);
    await verifySafePathBoundary(path, containmentRoot);
    await rename(temporary, path);
    await verifySafePathBoundary(path, containmentRoot);
  } finally {
    if (created) {
      try {
        await verifySafePathBoundary(temporary, containmentRoot);
        await rm(temporary, { force: true });
      } catch {
        // Cleanup is best effort and must not replace a write or rename error.
        // Leave an unexpected replacement in place rather than deleting through
        // an unverified path.
      }
    }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
