import { createHmac, randomBytes } from "node:crypto";
import { TextEncoder } from "node:util";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { resolveRuntimePaths } from "../../runtime.js";
import {
  type ComposedTavernProfile,
  isComposedTavernProfile,
  type MemoryItemV1,
  type MemoryChapterV1,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";

import type {
  GameBuddyMemoryView as MemoryRowView,
  GameBuddyPlayerMemoryCrudFacade as MemoryCrudFacade,
  GameBuddyPlayerMemoryReadProjection as MemoryReadProjection,
  GameBuddyPlayerChapterView as MemoryChapterRowView,
} from "@cortexkit/pi-magic-context/memory";

export type MemoryManagementService = Readonly<{
  /** Reads the complete browser-safe Memory projection for the mounted continuity. */
  read(): Promise<MemoryReadV1>;
  /** Performs one ordinary management CRUD operation then returns a fresh safe reread. */
  mutate?(command: MemoryMutationCommandV1): Promise<MemoryReadV1>;
  /** Rejects future reads and mutations. */
  close(): Promise<void>;
}>;

export type MemoryManagementServiceOptions = Readonly<{
  manifest: HostDeploymentManifest;
  lease: MountedChatRuntimeLease;
  profile: ComposedTavernProfile;
}>;

/**
 * Management HTTP Memory service for the exact mounted continuity. It never
 * exposes vendor state tokens: browser opaque handles are resolved only after
 * rereading the current vendor projection, and each vendor write receives the
 * exact current state token before a fresh safe reread is returned.
 */
export function createMemoryManagementService(
  options: MemoryManagementServiceOptions,
  injectedFacade?: MemoryCrudFacade,
): MemoryManagementService {
  if (!isCurrentMountedChatRuntimeLease(options.lease)) throw unavailable();
  if (!isComposedTavernProfile(options.profile) || !options.profile.routeIds.includes("memory.read"))
    throw unavailable();
  if (!identifier(options.manifest.principal.continuityId)) throw unavailable();

  const continuityId = options.manifest.principal.continuityId;
  // Magic Context's SQLite and process-scoped data root belong to the exact
  // mounted identity runtime, not the host's wider semantic authority root.
  // The surface session only partitions Pi sessions; Memory remains continuity
  // scoped at this shared runtime root.
  const runtimeCwd = resolveRuntimePaths(
    options.manifest.principal,
    options.manifest.runtimeRoot,
    options.lease.chatSurfaceSessionId,
  ).runtimeCwd;
  const mutationEnabled =
    options.profile.routeIds.includes("memory.mutate") &&
    options.profile.operationIds.includes("memory.mutate");
  const lease = options.lease;
  const identityProfile = options.lease.runtimeSession?.profile;
  if (!identityProfile) throw unavailable();
  const profileBinding = Object.freeze({
    profileId: identityProfile.profileId,
    profileRevision: identityProfile.revision,
  });
  const handleSecret = randomBytes(32);
  const projectHandle = (stateToken: string): string =>
    createHmac("sha256", handleSecret).update(`memory\0${continuityId}\0${stateToken}`, "utf8").digest("base64url");
  let facadePromise: Promise<MemoryCrudFacade> | undefined;
  let closed = false;
  let inFlight = 0;
  let drainResolve: (() => void) | undefined;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  const assertOpen = (): void => {
    if (closed || !isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  };

  async function facade(): Promise<MemoryCrudFacade> {
    if (injectedFacade !== undefined) return injectedFacade;
    facadePromise ??= (async () => {
      const { createGameBuddyPlayerMemoryCrudFacade } = await import("@cortexkit/pi-magic-context/memory");
      const value = createGameBuddyPlayerMemoryCrudFacade({ continuityId, runtimeCwd, ...profileBinding });
      if (
        value === null ||
        typeof value !== "object" ||
        typeof (value as Partial<MemoryReadProjection>).listMemories !== "function"
      )
        throw unavailable();
      return value as MemoryCrudFacade;
    })();
    return facadePromise;
  }

  const assertMutationFacade = (value: MemoryCrudFacade): void => {
    if (
      typeof value.create !== "function" ||
      typeof value.update !== "function" ||
      typeof value.archive !== "function" ||
      typeof value.updateChapter !== "function" ||
      typeof value.deleteChapter !== "function"
    )
      throw unavailable();
  };

  /**
   * A chapter's opaque handle. Same construction as a memory handle - an HMAC over the continuity and a
   * subject - so a chapter id never reaches the browser and two continuities cannot address each other's
   * chapters.
   */
  const projectChapterHandle = (chapterId: number): string =>
    createHmac("sha256", handleSecret).update(`chapter\0${continuityId}\0${chapterId}`, "utf8").digest("base64url");

  const projectChapters = (rows: readonly MemoryChapterRowView[]): MemoryChapterV1[] =>
    rows.map((row) => {
      if (
        typeof row.chapterId !== "number" ||
        !isMemoryContent(row.content) ||
        (row.status !== "sealed" && row.status !== "edited" && row.status !== "deleted")
      )
        throw unavailable();
      const span =
        row.startDate === row.endDate ? row.startDate : `${row.startDate}\u2192${row.endDate}`;
      return Object.freeze({
        handle: projectChapterHandle(row.chapterId),
        title: typeof row.title === "string" && row.title.length > 0 ? row.title : "Chapter",
        span: span.length > 0 ? span : "unrecorded",
        content: row.content,
        status: row.status,
        // The panel says whose words these are, so a player can tell what they changed from what the
        // companion wrote.
        editedByPlayer: row.status !== "sealed",
      });
    });


  const projectRows = (rows: readonly MemoryRowView[], chapters: readonly MemoryChapterV1[]): MemoryReadV1 => {
    const memories: MemoryItemV1[] = rows.map((row) => {
      if (
        typeof row.stateToken !== "string" ||
        !isMemoryContent(row.content) ||
        (row.category !== "semantic" && row.category !== "interaction") ||
        (row.status !== "active" && row.status !== "permanent" && row.status !== "archived")
      )
        throw unavailable();
      return Object.freeze({
        handle: projectHandle(row.stateToken),
        title: row.category === "semantic" ? "Semantic memory" : "Interaction memory",
        content: row.content,
        category: row.category,
        status: row.status,
        // The product's own vocabulary, mapped once here: the store says `historian | agent |
        // dreamer | user`, and the player only needs to know whose memory it is. Everything that is
        // not the player's own writing is the companion's, including her own `ctx_memory` writes.
        origin: row.sourceType === "user" ? ("player" as const) : ("companion" as const),
        pinned: row.status === "permanent",
      });
    });
    memories.sort((left, right) => left.handle.localeCompare(right.handle));
    const projectionRevision = createHmac("sha256", handleSecret)
      .update(JSON.stringify({ memories, chapters }), "utf8")
      .digest("base64url");
    const result: MemoryReadV1 = Object.freeze({
      apiVersion: TAVERN_BROWSER_API_VERSION,
      projectionRevision,
      memories: Object.freeze(memories),
      chapters: Object.freeze(chapters),
    });
    if (!TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(result)) throw unavailable();
    return result;
  };

  const readChapters = async (): Promise<readonly MemoryChapterRowView[]> => {
    const chapters = await (await facade()).listChapters({ continuityId, ...profileBinding });
    assertOpen();
    return chapters;
  };

  const readRows = async (): Promise<readonly MemoryRowView[]> => {
    const rows = await (await facade()).listMemories({ continuityId, ...profileBinding });
    assertOpen();
    return rows;
  };

  return Object.freeze({
    async read(): Promise<MemoryReadV1> {
      assertOpen();
      inFlight += 1;
      try {
      return projectRows(await readRows(), projectChapters(await readChapters()));
      } catch (error) {
        throw mapReadError(error);
      } finally {
        inFlight -= 1;
        if (inFlight === 0 && drainResolve) {
          drainResolve();
        }
      }
    },
    ...(mutationEnabled
      ? {
          async mutate(command: MemoryMutationCommandV1): Promise<MemoryReadV1> {
            assertOpen();
            inFlight += 1;
            try {
              const operation = async () => {
                assertOpen();
                const rows = await readRows();
                // Both forms are needed: the projected chapters build the read model a client compares,
                // and the vendor rows carry the chapter id a mutation addresses. The id never leaves the
                // Host - the browser only ever sees the projected handle.
                const chapterRows = await readChapters();
                const chapters = projectChapters(chapterRows);
                const before = projectRows(rows, chapters);
                if (before.projectionRevision !== command.expectedProjectionRevision) throw conflict();
                const vendor = await facade();
                assertMutationFacade(vendor);
                if (
                  command.operation !== "archive" &&
                  command.operation !== "delete_chapter" &&
                  !isMemoryContent(command.content)
                )
                  throw unavailable();
                // Chapter commands address a chapter, not a memory row, so they resolve their own
                // handle and never touch the Memory store.
                if (command.operation === "update_chapter" || command.operation === "delete_chapter") {
                  const chapter = chapterRows.find(
                    (candidate) => projectChapterHandle(candidate.chapterId) === command.handle,
                  );
                  if (chapter === undefined) throw conflict();
                  if (command.operation === "update_chapter")
                    await vendor.updateChapter({
                      continuityId,
                      ...profileBinding,
                      chapterId: chapter.chapterId,
                      content: command.content,
                    });
                  else
                    await vendor.deleteChapter({
                      continuityId,
                      ...profileBinding,
                      chapterId: chapter.chapterId,
                    });
                  assertOpen();
                  return projectRows(await readRows(), projectChapters(await readChapters()));
                }

                if (command.operation === "create") {
                  await vendor.create({ continuityId, ...profileBinding, content: command.content });
                } else {
                  const row = rows.find((candidate) => projectHandle(candidate.stateToken) === command.handle);
                  if (row === undefined) throw conflict();
                  if (command.operation === "update")
                    await vendor.update({ continuityId, ...profileBinding, stateToken: row.stateToken, content: command.content });
                  else await vendor.archive({ continuityId, ...profileBinding, stateToken: row.stateToken });
                }
                assertOpen();
                return projectRows(await readRows(), projectChapters(await readChapters()));
              };
              const queued = mutationQueue.then(operation, operation);
              mutationQueue = queued.catch(() => {});
              return (await queued) as MemoryReadV1;
            } catch (error) {
              throw mapMutationError(error);
            } finally {
              inFlight -= 1;
              if (inFlight === 0 && drainResolve) {
                drainResolve();
              }
            }
          },
        }
      : {}),
    async close(): Promise<void> {
      closed = true;
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          drainResolve = resolve;
        });
      }
    },
  });
}

function isMemoryContent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !hasUnpairedUtf16Surrogate(value) &&
    new TextEncoder().encode(value).byteLength <= 4096
  );
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function unavailable(): Error {
  return new Error("memory_read_service_unavailable");
}

/** One bounded line naming what actually went wrong: never content, never a stack. */
function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 300);
}

function conflict(): Error {
  return new Error("memory_mutation_conflict");
}

function mapReadError(error: unknown): Error {
  process.stderr.write(`[memory] read failed: ${boundedReason(error)}\n`);
  if (error instanceof Error && error.message === "memory_read_service_unavailable") return error;
  const message = error instanceof Error ? error.message : "";
  if (/storage|sqlite|eio|enoent/i.test(message)) return new Error("memory_read_storage_unavailable");
  return new Error("memory_read_unavailable");
}

function mapMutationError(error: unknown): Error {
  process.stderr.write(`[memory] mutation failed: ${boundedReason(error)}\n`);
  if (error instanceof Error && /memory_(?:read_service_unavailable|mutation_conflict)/.test(error.message)) return error;
  const message = error instanceof Error ? error.message : "";
  if (/storage|sqlite|eio|enoent/i.test(message)) return new Error("memory_read_storage_unavailable");
  if (/conflict|stale|not.?found|missing/i.test(message)) return conflict();
  return new Error("memory_read_unavailable");
}
