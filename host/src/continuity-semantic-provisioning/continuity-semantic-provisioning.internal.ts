import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  openProductionContinuityStore,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
  type ProductionBootstrapInput,
  type ProductionPrincipal as AuthenticatedContinuityPrincipal,
  type ProductionContinuityStore,
  type ProductionSagaStore,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";

const AUTHORITY_DIRECTORY_NAME = ".gamebuddy-semantic-continuity-v1";
const DATABASE_NAME = "gamebuddy-continuity-v1.sqlite";
const AUTHORITY_MARKER_NAME = "production-authority-marker.json";
const PRODUCTION_SCHEMA_VERSION = PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION;
const FRESH_LEGACY_SENTINEL = "0".repeat(64);
const LEGACY_ROOT_ARTIFACTS = new Set([
  "companion-continuity.json",
  "game-runtime-owner.json",
  "continuity-transition.json",
  "continuity-transition-lock.json",
]);

const canonicalAdmissions = new WeakSet<object>();
/** The immutable identity recorded at admission construction is the validation authority. */
const canonicalAdmissionIdentities = new WeakMap<object, string>();

export type FreshContinuityProvisionOptions = Readonly<{
  runtimeCwd: string;
  principal: AuthenticatedContinuityPrincipal;
  bootstrapOperationId: string;
  authorityGeneration: number;
}>;

/**
 * Root admission constructed before mutex acquisition. Its canonical path and
 * identity are inseparable: locked provisioning never resolves caller paths.
 * @internal
 */
export type CanonicalProductionAuthorityAdmission = Readonly<{
  runtimeCwd: string;
  authorityRootIdentity: string;
}>;

/** Production callers receive only typed authority commands, never lifecycle or adoption internals. */
export type ProductionContinuitySemanticStore = ProductionSagaStore;

export type FreshContinuityProvision = Readonly<{
  store: ProductionContinuitySemanticStore;
  runtimeCwd: string;
  storePath: string;
  storeId: string;
  schemaVersion: number;
  principal: AuthenticatedContinuityPrincipal;
  authority: "SEMANTIC";
  /** Exact validated bootstrap facts; coordinator-only holder construction consumes these. */
  bootstrapOperationId: string;
  authorityGeneration: number;
  /** @internal coordinator-only root identity. */
  authorityRootIdentity: string;
  close(): void;
}>;

export class FreshContinuityProvisionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "FreshContinuityProvisionError";
  }
}

/**
 * Creates a fresh production authority in a new, exclusively-created child
 * directory. This is a supported-process concurrency boundary, not a hostile
 * same-identity filesystem security boundary: Node/Windows exposes no durable
 * directory handle capability that can prove a path was never replaced after
 * creation. We therefore never clean up a failed authority directory, and
 * never open a directory whose admission invariants are not currently exact.
 */
export function provisionFreshProductionContinuity(options: FreshContinuityProvisionOptions): FreshContinuityProvision {
  validateOptions(options);
  return provisionFreshProductionContinuityFromCanonicalAdmission(
    options,
    createCanonicalProductionAuthorityAdmission(options.runtimeCwd),
  );
}

/** @internal Locked callers must supply the pre-mutex canonical admission. */
export function provisionFreshProductionContinuityFromCanonicalAdmission(
  options: FreshContinuityProvisionOptions,
  admission: CanonicalProductionAuthorityAdmission,
): FreshContinuityProvision {
  validateOptions(options);
  const { runtimeCwd, authorityRootIdentity } = validateCanonicalAdmission(admission);
  inspectRuntimeAdmission(runtimeCwd);
  const authorityRoot = createFreshAuthorityRoot(runtimeCwd);

  // No cleanup: after atomic creation, any partial state is retained for inspection.
  inspectFreshAuthorityRoot(authorityRoot);
  let control: ProductionContinuityStore | undefined;
  try {
    control = openProductionStore(authorityRoot);
    const configuration = control.configuration();
    if (
      configuration.journalMode !== "delete" ||
      configuration.synchronous !== 2 ||
      configuration.busyTimeoutMs !== 250
    )
      throw failure("production_store_not_admitted");
    const metadata = control.bootstrapFresh(bootstrapInput(options, authorityRootIdentity));
    const databaseFingerprint = fingerprintDatabase(authorityRoot);
    assertAuthorityRootContainsOnly(authorityRoot, [DATABASE_NAME]);
    inspectRuntimeAdmission(runtimeCwd);
    writeFreshAuthorityMarker(authorityRoot, options, authorityRootIdentity, metadata.storeId);
    if (fingerprintDatabase(authorityRoot) !== databaseFingerprint)
      throw failure("production_store_changed_during_open");
    inspectRuntimeAdmission(runtimeCwd);
    assertKnownAuthorityRoot(authorityRoot, options, authorityRootIdentity);
    const reread = control.validateBootstrap(bootstrapInput(options, authorityRootIdentity));
    if (reread.storeId !== metadata.storeId) throw failure("production_store_changed_during_open");
    validateAuthorityMarker(authorityRoot, options, authorityRootIdentity, reread.storeId);
    return provision(
      control,
      runtimeCwd,
      authorityRoot,
      options.principal,
      authorityRootIdentity,
      reread,
      bootstrapInput(options, authorityRootIdentity),
    );
  } catch (error) {
    control?.close();
    throw provisionFailure(error);
  }
}

/** Opens only an exact, already-bootstrapped production authority directory. */
export function openKnownProductionContinuity(options: FreshContinuityProvisionOptions): FreshContinuityProvision {
  validateOptions(options);
  return openKnownProductionContinuityFromCanonicalAdmission(
    options,
    createCanonicalProductionAuthorityAdmission(options.runtimeCwd),
  );
}

/** @internal Locked callers must supply the pre-mutex canonical admission. */
export function openKnownProductionContinuityFromCanonicalAdmission(
  options: FreshContinuityProvisionOptions,
  admission: CanonicalProductionAuthorityAdmission,
): FreshContinuityProvision {
  validateOptions(options);
  const { runtimeCwd, authorityRootIdentity } = validateCanonicalAdmission(admission);
  inspectRuntimeAdmission(runtimeCwd);
  const authorityRoot = knownAuthorityRoot(runtimeCwd);
  assertKnownAuthorityRoot(authorityRoot, options, authorityRootIdentity);
  let control: ProductionContinuityStore | undefined;
  try {
    control = openProductionStore(authorityRoot);
    const configuration = control.configuration();
    if (
      configuration.journalMode !== "delete" ||
      configuration.synchronous !== 2 ||
      configuration.busyTimeoutMs !== 250
    )
      throw failure("production_store_not_admitted");
    const metadata = control.validateBootstrap(bootstrapInput(options, authorityRootIdentity));
    validateAuthorityMarker(authorityRoot, options, authorityRootIdentity, metadata.storeId);
    inspectRuntimeAdmission(runtimeCwd);
    assertKnownAuthorityRoot(authorityRoot, options, authorityRootIdentity);
    const reread = control.validateBootstrap(bootstrapInput(options, authorityRootIdentity));
    if (reread.storeId !== metadata.storeId) throw failure("production_store_changed_during_open");
    validateAuthorityMarker(authorityRoot, options, authorityRootIdentity, reread.storeId);
    return provision(
      control,
      runtimeCwd,
      authorityRoot,
      options.principal,
      authorityRootIdentity,
      reread,
      bootstrapInput(options, authorityRootIdentity),
    );
  } catch (error) {
    control?.close();
    throw provisionFailure(error);
  }
}

function openProductionStore(authorityRoot: string): ProductionContinuityStore {
  try {
    return openProductionContinuityStore({ runtimeRoot: authorityRoot });
  } catch (error) {
    if (error instanceof Error && error.message === "unsupported_production_store_schema")
      throw failure("production_store_schema_invalid");
    throw failure("production_store_not_admitted");
  }
}
function bootstrapInput(
  options: FreshContinuityProvisionOptions,
  authorityRootIdentity: string,
): ProductionBootstrapInput {
  return Object.freeze({
    principal: options.principal,
    bootstrapOperationId: options.bootstrapOperationId,
    authorityGeneration: options.authorityGeneration,
    authorityRootIdentity,
  });
}
function provisionFailure(error: unknown): FreshContinuityProvisionError {
  return error instanceof FreshContinuityProvisionError ? error : failure("production_store_schema_invalid");
}

function provision(
  control: ProductionContinuityStore,
  runtimeCwd: string,
  authorityRoot: string,
  principal: AuthenticatedContinuityPrincipal,
  authorityRootIdentity: string,
  metadata: Metadata,
  bootstrap: ProductionBootstrapInput,
): FreshContinuityProvision {
  const rawStore = control.bindBootstrapContext(
    Object.freeze({
      bootstrap,
      metadata: Object.freeze({ storeId: metadata.storeId, schemaVersion: PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION }),
    }),
  );
  let closing = false;
  let closed = false;
  const requireOpen = (): void => {
    if (closing || closed) throw failure("production_store_already_closed");
  };
  const store: ProductionContinuitySemanticStore = Object.freeze({
    claim(input) {
      requireOpen();
      return rawStore.claim(input);
    },
    register(input) {
      requireOpen();
      return rawStore.register(input);
    },
    verify(input, receipt) {
      requireOpen();
      return rawStore.verify(input, receipt);
    },
    select(input) {
      requireOpen();
      return rawStore.select(input);
    },
    readGameAdmission() {
      requireOpen();
      return rawStore.readGameAdmission();
    },
    readChatCatalog() {
      requireOpen();
      return rawStore.readChatCatalog();
    },
    registerChat(input) {
      requireOpen();
      return rawStore.registerChat(input);
    },
    verifyChatContent(input, receipt) {
      requireOpen();
      return rawStore.verifyChatContent(input, receipt);
    },
    selectChat(input) {
      requireOpen();
      return rawStore.selectChat(input);
    },
    transitionChatLifecycle(input) {
      requireOpen();
      return rawStore.transitionChatLifecycle(input);
    },
    prepareChatRuntime(input) {
      requireOpen();
      return rawStore.prepareChatRuntime(input);
    },
    commitChatRuntime(input) {
      requireOpen();
      return rawStore.commitChatRuntime(input);
    },
    prepareChatRuntimeTeardown(input) {
      requireOpen();
      return rawStore.prepareChatRuntimeTeardown(input);
    },
    commitChatRuntimeTeardown(input) {
      requireOpen();
      return rawStore.commitChatRuntimeTeardown(input);
    },
    failChatRuntimeTeardown(input) {
      requireOpen();
      return rawStore.failChatRuntimeTeardown(input);
    },
    recoverChatRuntimeTeardown(input) {
      requireOpen();
      return rawStore.recoverChatRuntimeTeardown(input);
    },
    failChatRuntime(input) {
      requireOpen();
      return rawStore.failChatRuntime(input);
    },
    recoverChatRuntime(input) {
      requireOpen();
      return rawStore.recoverChatRuntime(input);
    },
    resume(holderBindingDigest) {
      requireOpen();
      return rawStore.resume(holderBindingDigest);
    },
    quarantineAfterAbandonedMutex() {
      requireOpen();
      rawStore.quarantineAfterAbandonedMutex();
    },
    readQuarantine() {
      requireOpen();
      return rawStore.readQuarantine();
    },
    prepareGame(input) {
      requireOpen();
      return rawStore.prepareGame(input);
    },
    commitGameTerminal(input) {
      requireOpen();
      return rawStore.commitGameTerminal(input);
    },
    failGame(input) {
      requireOpen();
      return rawStore.failGame(input);
    },
    recoverGame(input) {
      requireOpen();
      return rawStore.recoverGame(input);
    },
    readGameRecoveryTarget(input) {
      requireOpen();
      return rawStore.readGameRecoveryTarget(input);
    },
    readGameOperation(input) {
      requireOpen();
      return rawStore.readGameOperation(input);
    },
  });
  return Object.freeze({
    store,
    runtimeCwd,
    storePath: join(authorityRoot, DATABASE_NAME),
    storeId: metadata.storeId,
    schemaVersion: PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
    principal: Object.freeze({ ...principal }),
    authority: "SEMANTIC" as const,
    bootstrapOperationId: bootstrap.bootstrapOperationId,
    authorityGeneration: bootstrap.authorityGeneration,
    authorityRootIdentity,
    close() {
      if (closed) throw failure("production_store_already_closed");
      // Synchronous control closure has no concurrent in-flight window. A
      // failed attempt remains close-only and is retried at this same stage.
      closing = true;
      try {
        control.close();
      } catch (error) {
        // The authority remains close-only, but a failed control close has not
        // established successful closure. A later owner close may retry it.
        throw error;
      }
      closed = true;
    },
  });
}

type Metadata = Readonly<{ storeId: string }>;

function ensureRuntimeRoot(root: string): void {
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    throw failure("production_root_unreadable");
  }
}
function authorityRoot(root: string): string {
  return join(root, AUTHORITY_DIRECTORY_NAME);
}
function databasePath(root: string): string {
  return join(root, DATABASE_NAME);
}
function fingerprintDatabase(root: string): string {
  try {
    return createHash("sha256")
      .update(readFileSync(databasePath(root)))
      .digest("hex");
  } catch {
    throw failure("production_store_not_admitted");
  }
}
function knownAuthorityRoot(runtimeCwd: string): string {
  const root = authorityRoot(runtimeCwd);
  if (!isDirectory(root)) throw failure("production_store_not_admitted");
  return root;
}
function createFreshAuthorityRoot(runtimeCwd: string): string {
  const root = authorityRoot(runtimeCwd);
  try {
    mkdirSync(root);
  } catch {
    throw failure("production_authority_artifact_present");
  }
  if (!isDirectory(root)) throw failure("production_authority_artifact_present");
  return root;
}

/** Checks shared runtime root on every fresh/open admission before SQLite opens. */
function inspectRuntimeAdmission(root: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw failure("production_root_unreadable");
  }
  for (const entry of entries) {
    if (entry === AUTHORITY_DIRECTORY_NAME) continue;
    // Unrelated profile/world/transcript data may coexist in the runtime root.
    // Only authority-named root artifacts and legacy authority artifacts block it.
    if (entry.toLowerCase() === DATABASE_NAME || entry.toLowerCase().startsWith(`${DATABASE_NAME}-`))
      throw failure("production_authority_artifact_present");
    if (LEGACY_ROOT_ARTIFACTS.has(entry) || entry === "surface-sessions")
      throw failure("legacy_authority_artifact_present");
  }
}
/** Before SQLite opens, a fresh authority directory must have no contents at all. */
function inspectFreshAuthorityRoot(root: string): void {
  if (!isDirectory(root)) throw failure("production_authority_root_changed");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw failure("production_authority_root_unreadable");
  }
  if (entries.length !== 0) throw failure("production_authority_artifact_present");
}
/** Known roots allow only the SQLite files and reject all injected legacy/unknown artifacts. */
/** Validates authority-root shape before opening SQLite; store ID is bound after DB readback. */
function assertKnownAuthorityRoot(
  root: string,
  options: FreshContinuityProvisionOptions,
  authorityRootIdentity: string,
): void {
  if (!isDirectory(root)) throw failure("production_authority_root_changed");
  assertAuthorityRootContainsOnly(root, [DATABASE_NAME, AUTHORITY_MARKER_NAME]);
  if (!isRegularFile(databasePath(root))) throw failure("production_store_not_admitted");
  validateAuthorityMarker(root, options, authorityRootIdentity);
}
function writeFreshAuthorityMarker(
  root: string,
  options: FreshContinuityProvisionOptions,
  authorityRootIdentity: string,
  storeId: string,
): void {
  const marker = JSON.stringify({
    version: 21,
    schemaVersion: PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
    bootstrapOperationId: options.bootstrapOperationId,
    authorityGeneration: options.authorityGeneration,
    authorityRootIdentity,
    continuityId: options.principal.continuityId,
    companionId: options.principal.companionId,
    playerId: options.principal.playerId,
    storeId,
  });
  try {
    writeFileSync(join(root, AUTHORITY_MARKER_NAME), marker, { encoding: "utf8", flag: "wx" });
  } catch {
    throw failure("production_authority_marker_write_failed");
  }
}
/**
 * Marker identity is valid only when it exactly matches the store ID verified
 * from both `store_meta` and the production bootstrap row in this opening flow.
 */
function validateAuthorityMarker(
  root: string,
  options: FreshContinuityProvisionOptions,
  authorityRootIdentity: string,
  expectedStoreId?: string,
): void {
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      readBoundedRegularFile(join(root, AUTHORITY_MARKER_NAME), 4096),
    );
    rejectDuplicateJsonObjectKeys(source);
    value = JSON.parse(source);
  } catch {
    throw failure("production_authority_artifact_present");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("production_authority_artifact_present");
  const marker = value as Record<string, unknown>,
    fields = [
      "version",
      "schemaVersion",
      "bootstrapOperationId",
      "authorityGeneration",
      "authorityRootIdentity",
      "continuityId",
      "companionId",
      "playerId",
      "storeId",
    ];
  if (
    Object.keys(marker).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(marker, field)) ||
    marker.version !== 21 ||
    marker.schemaVersion !== PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION ||
    marker.bootstrapOperationId !== options.bootstrapOperationId ||
    marker.authorityGeneration !== options.authorityGeneration ||
    marker.authorityRootIdentity !== authorityRootIdentity ||
    marker.continuityId !== options.principal.continuityId ||
    marker.companionId !== options.principal.companionId ||
    marker.playerId !== options.principal.playerId ||
    typeof marker.storeId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(marker.storeId) ||
    (expectedStoreId !== undefined && marker.storeId !== expectedStoreId)
  )
    throw failure("production_authority_artifact_present");
}
function assertAuthorityRootContainsOnly(root: string, allowed: readonly string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw failure("production_authority_root_unreadable");
  }
  if (entries.some((entry) => !allowed.includes(entry))) throw failure("production_authority_artifact_present");
}
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function validateOptions(options: FreshContinuityProvisionOptions): void {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.runtimeCwd !== "string" ||
    options.runtimeCwd.length === 0 ||
    !id(options.bootstrapOperationId) ||
    !principal(options.principal) ||
    !Number.isSafeInteger(options.authorityGeneration) ||
    options.authorityGeneration <= 0
  )
    throw failure("invalid_production_provision_options");
}
/** @internal The sole root canonicalization and identity derivation, before lock acquisition. */
export function createCanonicalProductionAuthorityAdmission(runtimeCwd: string): CanonicalProductionAuthorityAdmission {
  const lexicalRoot = resolve(runtimeCwd);
  ensureRuntimeRoot(lexicalRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch {
    throw failure("production_root_unreadable");
  }
  const admission = Object.freeze({
    runtimeCwd: canonicalRoot,
    authorityRootIdentity: deriveAuthorityRootIdentityFromCanonicalRoot(canonicalRoot),
  });
  canonicalAdmissions.add(admission);
  canonicalAdmissionIdentities.set(admission, admission.authorityRootIdentity);
  return admission;
}
function validateCanonicalAdmission(value: unknown): CanonicalProductionAuthorityAdmission {
  if (
    !value ||
    typeof value !== "object" ||
    !canonicalAdmissions.has(value) ||
    !Object.isFrozen(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw failure("invalid_production_canonical_admission");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertyNames(descriptors).length !== 2 ||
    !Object.hasOwn(descriptors, "runtimeCwd") ||
    !Object.hasOwn(descriptors, "authorityRootIdentity")
  )
    throw failure("invalid_production_canonical_admission");
  const root = descriptors.runtimeCwd,
    identity = descriptors.authorityRootIdentity;
  const expectedIdentity = canonicalAdmissionIdentities.get(value);
  if (
    !root ||
    !("value" in root) ||
    typeof root.value !== "string" ||
    resolve(root.value) !== root.value ||
    !identity ||
    !("value" in identity) ||
    typeof identity.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.value) ||
    expectedIdentity === undefined ||
    identity.value !== expectedIdentity
  )
    throw failure("invalid_production_canonical_admission");
  try {
    if (realpathSync(root.value) !== root.value) throw failure("invalid_production_canonical_admission");
  } catch (error) {
    if (error instanceof FreshContinuityProvisionError) throw error;
    throw failure("invalid_production_canonical_admission");
  }
  return Object.freeze({ runtimeCwd: root.value, authorityRootIdentity: expectedIdentity });
}
function deriveAuthorityRootIdentityFromCanonicalRoot(canonicalRoot: string): string {
  return createHash("sha256")
    .update(`GameBuddy semantic authority root v1\0${canonicalRoot}\0${AUTHORITY_DIRECTORY_NAME}`, "utf8")
    .digest("hex");
}
function sameNode(
  left: NonNullable<ReturnType<typeof lstatSync>>,
  right: NonNullable<ReturnType<typeof lstatSync>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function readBoundedRegularFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    // lstat, rather than fstat after following open, rejects symbolic links
    // and Windows reparse-point links even where their targets are valid files.
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("marker_not_regular_directory_entry");
    descriptor = openSync(path, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameNode(before, opened) || opened.size < 0 || opened.size > maximumBytes)
      throw new Error("marker_not_bounded_regular_file");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("marker_short_read");
      offset += count;
    }
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameNode(before, after) || !sameNode(opened, after))
      throw new Error("marker_directory_entry_changed");
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
/** Reject duplicate decoded JSON object keys before JSON.parse discards them. */
function rejectDuplicateJsonObjectKeys(source: string): void {
  let offset = 0;
  const whitespace = (): void => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset++;
  };
  const string = (): string => {
    if (source[offset++] !== '"') throw new Error("invalid_json");
    let decoded = "";
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return decoded;
      if (character < " ") throw new Error("invalid_json");
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const escape = source[offset++];
      if (escape === '"' || escape === "\\" || escape === "/") decoded += escape;
      else if (escape === "b") decoded += "\b";
      else if (escape === "f") decoded += "\f";
      else if (escape === "n") decoded += "\n";
      else if (escape === "r") decoded += "\r";
      else if (escape === "t") decoded += "\t";
      else if (escape === "u") {
        const hex = source.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("invalid_json");
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else throw new Error("invalid_json");
    }
    throw new Error("invalid_json");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset++;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate_json_key");
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") throw new Error("invalid_json");
        value();
        whitespace();
        if (source[offset] === "}") {
          offset++;
          return;
        }
        if (source[offset++] !== ",") throw new Error("invalid_json");
      }
    }
    if (source[offset] === "[") {
      offset++;
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (source[offset] === "]") {
          offset++;
          return;
        }
        if (source[offset++] !== ",") throw new Error("invalid_json");
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(offset),
    );
    if (!token) throw new Error("invalid_json");
    offset += token[0].length;
  };
  whitespace();
  value();
  whitespace();
  if (offset !== source.length) throw new Error("invalid_json");
}
function principal(value: unknown): value is AuthenticatedContinuityPrincipal {
  return (
    !!value &&
    typeof value === "object" &&
    id((value as AuthenticatedContinuityPrincipal).continuityId) &&
    id((value as AuthenticatedContinuityPrincipal).companionId) &&
    id((value as AuthenticatedContinuityPrincipal).playerId)
  );
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function failure(code: string): FreshContinuityProvisionError {
  return new FreshContinuityProvisionError(code);
}
