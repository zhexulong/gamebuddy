import { createHmac, randomBytes } from "node:crypto";
import { TextEncoder } from "node:util";
import { pathToFileURL } from "node:url";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { resolveMagicContextExtensionEntry, resolveRuntimePaths } from "../../runtime.js";
import {
  type ComposedTavernProfile,
  isComposedTavernProfile,
  type MemoryItemV1,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";

/** Vendor-owned row; its state token never crosses the Host/browser boundary. */
type MemoryRowView = Readonly<{
  stateToken: string;
  content: string;
  category: "semantic" | "interaction";
  status: "active" | "permanent" | "archived";
}>;

type MemoryReadProjection = Readonly<{
  listMemories(input: Readonly<{ continuityId: string }>): Promise<readonly MemoryRowView[]>;
}>;

/**
 * Ordinary management-only CRUD seam. This is deliberately a vendor facade,
 * not a Pi tool or a callback injected into a provider runtime.
 */
type MemoryCrudFacade = MemoryReadProjection &
  Readonly<{
    create(input: Readonly<{ continuityId: string; content: string }>): Promise<MemoryRowView>;
    update(input: Readonly<{ continuityId: string; stateToken: string; content: string }>): Promise<MemoryRowView>;
    archive(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<void>;
  }>;

export type MemoryManagementService = Readonly<{
  /** Reads the bounded, browser-safe Memory projection for the mounted continuity. */
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
    options.profile.routeIds.includes("memory.mutate") && options.profile.operationIds.includes("memory.mutate");
  const lease = options.lease;
  const handleSecret = randomBytes(32);
  const projectHandle = (stateToken: string): string =>
    createHmac("sha256", handleSecret).update(`memory\0${continuityId}\0${stateToken}`, "utf8").digest("base64url");
  let facadePromise: Promise<MemoryCrudFacade> | undefined;
  let closed = false;

  const assertOpen = (): void => {
    if (closed || !isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  };

  async function facade(): Promise<MemoryCrudFacade> {
    if (injectedFacade !== undefined) return injectedFacade;
    facadePromise ??= (async () => {
      const magicContextEntry = resolveMagicContextExtensionEntry();
      const module = (await import(pathToFileURL(magicContextEntry).href)) as {
        createGameBuddyPlayerMemoryCrudFacade?: (
          args: Readonly<{ continuityId: string; runtimeCwd: string }>,
        ) => unknown;
      };
      const value = module.createGameBuddyPlayerMemoryCrudFacade?.({ continuityId, runtimeCwd });
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
    if (typeof value.create !== "function" || typeof value.update !== "function" || typeof value.archive !== "function")
      throw unavailable();
  };

  const projectRows = (rows: readonly MemoryRowView[]): MemoryReadV1 => {
    if (rows.length > 200) throw unavailable();
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
        pinned: row.status === "permanent",
      });
    });
    memories.sort((left, right) => left.handle.localeCompare(right.handle));
    const projectionRevision = createHmac("sha256", handleSecret)
      .update(JSON.stringify(memories), "utf8")
      .digest("base64url");
    const result: MemoryReadV1 = Object.freeze({
      apiVersion: TAVERN_BROWSER_API_VERSION,
      projectionRevision,
      memories: Object.freeze(memories),
    });
    if (!TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(result)) throw unavailable();
    return result;
  };

  const readRows = async (): Promise<readonly MemoryRowView[]> => {
    const rows = await (await facade()).listMemories({ continuityId });
    assertOpen();
    return rows;
  };

  return Object.freeze({
    async read(): Promise<MemoryReadV1> {
      assertOpen();
      try {
        return projectRows(await readRows());
      } catch (error) {
        throw mapReadError(error);
      }
    },
    ...(mutationEnabled
      ? {
          async mutate(command: MemoryMutationCommandV1): Promise<MemoryReadV1> {
            assertOpen();
            try {
              const rows = await readRows();
              const before = projectRows(rows);
              if (before.projectionRevision !== command.expectedProjectionRevision) throw conflict();
              const vendor = await facade();
              assertMutationFacade(vendor);
              if (command.operation !== "archive" && !isMemoryContent(command.content)) throw unavailable();
              if (command.operation === "create") {
                await vendor.create({ continuityId, content: command.content });
              } else {
                const row = rows.find((candidate) => projectHandle(candidate.stateToken) === command.handle);
                if (row === undefined) throw conflict();
                if (command.operation === "update")
                  await vendor.update({ continuityId, stateToken: row.stateToken, content: command.content });
                else await vendor.archive({ continuityId, stateToken: row.stateToken });
              }
              assertOpen();
              return projectRows(await readRows());
            } catch (error) {
              throw mapMutationError(error);
            }
          },
        }
      : {}),
    async close(): Promise<void> {
      closed = true;
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

function conflict(): Error {
  return new Error("memory_mutation_conflict");
}

function mapReadError(error: unknown): Error {
  if (error instanceof Error && error.message === "memory_read_service_unavailable") return error;
  const message = error instanceof Error ? error.message : "";
  if (/storage|sqlite|eio|enoent/i.test(message)) return new Error("memory_read_storage_unavailable");
  return new Error("memory_read_unavailable");
}

function mapMutationError(error: unknown): Error {
  if (error instanceof Error && /memory_(?:read_service_unavailable|mutation_conflict)/.test(error.message))
    return error;
  const message = error instanceof Error ? error.message : "";
  if (/storage|sqlite|eio|enoent/i.test(message)) return new Error("memory_read_storage_unavailable");
  if (/conflict|stale|not.?found|missing/i.test(message)) return conflict();
  return new Error("memory_read_unavailable");
}
