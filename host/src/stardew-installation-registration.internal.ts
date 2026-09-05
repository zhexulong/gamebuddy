import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  atomicWriteFile,
  captureSafeFileIdentity,
  removeOwnedSafeFile,
  verifySafePathBoundary,
  withPathLock,
} from "./path-lock.js";
import { readStrictJsonFile } from "./strict-json-reader.js";

const REGISTRATION_SCHEMA = "gamebuddy-stardew-installation-registration/v1";
const REGISTRATION_DIRECTORY = "stardew-installation-registration";
const REGISTRATION_LEAF = "registration.json";
const OWNER_TRANSACTION_MARKER_LEAF = "owner-transaction.json";
const OWNER_TRANSACTION_MARKER_SCHEMA = "gamebuddy-stardew-installation-owner-transaction/v1";
const MAX_REGISTRATION_BYTES = 64 * 1024;
const MAX_OWNER_TRANSACTION_MARKER_BYTES = 1024;
const MAX_LOCATOR_BYTES = 32 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DRIVE_ROOT = /^[A-Za-z]:\\$/;

export type StardewInstallationRegistrationRecordV1 = Readonly<{
  schema: "gamebuddy-stardew-installation-registration/v1";
  binding: Readonly<{
    rootLayoutVersion: 1;
    productInstallationId: string;
  }>;
  revision: number;
  state: "ready" | "invalid";
  locator: string | null;
  activeAttempt: Readonly<{
    bootstrapCorrelation: string;
  }> | null;
}>;

/**
 * Coordination metadata for the sole bootstrap owner transaction. It names no
 * attempt authority: owner.json remains the only durable lifecycle authority.
 */
export type StardewInstallationRegistrationOwnerTransactionMarker = Readonly<{
  schema: "gamebuddy-stardew-installation-owner-transaction/v1";
  operation: "prepare_bind" | "settlement_release";
  bootstrapCorrelation: string;
  registrationRevision: number;
  ownerRecordRevision: number;
}>;

type StardewInstallationRegistrationOwnerLockedStorage = Readonly<{
  readRegistration(): Promise<StardewInstallationRegistrationRecordV1 | null>;
  bindPreparedPointer(
    expectedRegistrationRevision: number,
    marker: StardewInstallationRegistrationOwnerTransactionMarker,
  ): Promise<StardewInstallationRegistrationRecordV1>;
  releaseSettledPointer(
    expectedRegistrationRevision: number,
    marker: StardewInstallationRegistrationOwnerTransactionMarker,
  ): Promise<StardewInstallationRegistrationRecordV1>;
  readMarker(): Promise<StardewInstallationRegistrationOwnerTransactionMarker | null>;
  writeMarker(marker: StardewInstallationRegistrationOwnerTransactionMarker): Promise<void>;
  clearMarker(marker: StardewInstallationRegistrationOwnerTransactionMarker): Promise<void>;
}>;

/**
 * Sole-owner internal transaction seam. The locked storage object is live only
 * for this callback and is intentionally unavailable to registration publishers
 * or any public consumer. It is coordination plumbing, not another attempt
 * owner or a standalone activeAttempt CAS.
 */
export async function withStardewInstallationRegistrationOwnerTransaction<T>(
  runtimeRoot: string,
  callback: (storage: StardewInstallationRegistrationOwnerLockedStorage) => Promise<T>,
): Promise<T> {
  try {
    if (typeof callback !== "function") throw unavailable();
    const path = registrationPath(runtimeRoot);
    const root = resolve(runtimeRoot);
    return await withPathLock(path, async () => {
      await verifySafePathBoundary(path, root);
      let active = true;
      const requireActive = (): void => {
        if (!active) throw unavailable();
      };
      const storage: StardewInstallationRegistrationOwnerLockedStorage = Object.freeze({
        readRegistration: async () => {
          requireActive();
          return await readCurrentRecord(path, root);
        },
        bindPreparedPointer: async (expectedRegistrationRevision, marker) => {
          requireActive();
          const checked = validateOwnerTransactionMarker(marker);
          if (checked.operation !== "prepare_bind" || checked.registrationRevision !== expectedRegistrationRevision + 1) {
            throw unavailable();
          }
          const persistedMarker = await readOwnerTransactionMarker(ownerTransactionMarkerPath(root), root);
          if (persistedMarker === null || serializeOwnerTransactionMarker(persistedMarker) !== serializeOwnerTransactionMarker(checked)) {
            throw unavailable();
          }
          const current = await readCurrentRecord(path, root);
          if (current === null || current.revision !== expectedRegistrationRevision || current.state !== "ready" || current.activeAttempt !== null) {
            throw unavailable();
          }
          return await writeOwnerTransactionRecord(path, root, {
            ...current,
            revision: current.revision + 1,
            activeAttempt: { bootstrapCorrelation: checked.bootstrapCorrelation },
          });
        },
        releaseSettledPointer: async (expectedRegistrationRevision, marker) => {
          requireActive();
          const checked = validateOwnerTransactionMarker(marker);
          if (checked.operation !== "settlement_release" || checked.registrationRevision !== expectedRegistrationRevision + 1) {
            throw unavailable();
          }
          const persistedMarker = await readOwnerTransactionMarker(ownerTransactionMarkerPath(root), root);
          if (persistedMarker === null || serializeOwnerTransactionMarker(persistedMarker) !== serializeOwnerTransactionMarker(checked)) {
            throw unavailable();
          }
          const current = await readCurrentRecord(path, root);
          if (current === null || current.revision !== expectedRegistrationRevision || current.state !== "ready" ||
              current.activeAttempt?.bootstrapCorrelation !== checked.bootstrapCorrelation) {
            throw unavailable();
          }
          return await writeOwnerTransactionRecord(path, root, {
            ...current,
            revision: current.revision + 1,
            activeAttempt: null,
          });
        },
        readMarker: async () => {
          requireActive();
          return await readOwnerTransactionMarker(ownerTransactionMarkerPath(root), root);
        },
        writeMarker: async (marker) => {
          requireActive();
          const checked = validateOwnerTransactionMarker(marker);
          const markerPath = ownerTransactionMarkerPath(root);
          if (await readOwnerTransactionMarker(markerPath, root) !== null) throw unavailable();
          const current = await readCurrentRecord(path, root);
          if (current === null || current.state !== "ready" || checked.registrationRevision !== current.revision + 1) {
            throw unavailable();
          }
          if (checked.operation === "prepare_bind") {
            if (current.activeAttempt !== null || checked.ownerRecordRevision !== 1) throw unavailable();
          } else if (current.activeAttempt?.bootstrapCorrelation !== checked.bootstrapCorrelation) {
            throw unavailable();
          }
          const encoded = serializeOwnerTransactionMarker(checked);
          await atomicWriteFile(markerPath, encoded, root);
          const reread = await readOwnerTransactionMarker(markerPath, root);
          if (reread === null || serializeOwnerTransactionMarker(reread) !== encoded) throw unavailable();
        },
        clearMarker: async (marker) => {
          requireActive();
          const checked = validateOwnerTransactionMarker(marker);
          const markerPath = ownerTransactionMarkerPath(root);
          const current = await readOwnerTransactionMarker(markerPath, root);
          if (current === null || serializeOwnerTransactionMarker(current) !== serializeOwnerTransactionMarker(checked)) {
            throw unavailable();
          }
          const identity = await captureSafeFileIdentity(markerPath, root);
          if (identity === undefined) throw unavailable();
          await removeOwnedSafeFile(markerPath, identity, root);
          if (await readOwnerTransactionMarker(markerPath, root) !== null) throw unavailable();
        },
      });
      try {
        return await callback(storage);
      } finally {
        active = false;
      }
    }, { containmentRoot: root });
  } catch (error) {
    if (error instanceof Error && isKnownError(error.message)) throw error;
    throw unavailable();
  }
}

/**
 * Reads the one Host-private registration record rooted at the caller's
 * canonical runtime root. Missing storage is distinct from malformed storage;
 * neither condition projects a browser-visible state from this isolated slice.
 */
export async function readStardewInstallationRegistration(
  runtimeRoot: string,
): Promise<StardewInstallationRegistrationRecordV1 | null> {
  try {
    const path = registrationPath(runtimeRoot);
    return await withPathLock(path, async () => {
      const root = resolve(runtimeRoot);
      if (await readOwnerTransactionMarker(ownerTransactionMarkerPath(root), root) !== null) throw unavailable();
      return await readCurrentRecord(path, runtimeRoot);
    }, { containmentRoot: runtimeRoot });
  } catch {
    throw unavailable();
  }
}

/**
 * Atomically publishes one ready/invalid replacement after checking the exact
 * predecessor revision. This selector never creates, clears, or changes an
 * active attempt pointer: both the current and replacement records must have
 * no active attempt.
 */
export async function publishStardewInstallationRegistration(
  runtimeRoot: string,
  expectedRevision: number | null,
  record: StardewInstallationRegistrationRecordV1,
): Promise<StardewInstallationRegistrationRecordV1> {
  try {
    const path = registrationPath(runtimeRoot);
    const candidate = validateRecord(record);
    assertExpectedRevision(expectedRevision);
    if (candidate.activeAttempt !== null) throw invalidPublish();
    if (candidate.revision !== nextRevision(expectedRevision)) throw invalidPublish();
    const encoded = serializeRecord(candidate);

    return await withPathLock(path, async () => {
      await verifySafePathBoundary(path, runtimeRoot);
      if (await readOwnerTransactionMarker(ownerTransactionMarkerPath(resolve(runtimeRoot)), resolve(runtimeRoot)) !== null) throw unavailable();
      const current = await readCurrentRecord(path, runtimeRoot);
      if (current !== null && current.activeAttempt !== null) throw busy();
      if (current === null ? expectedRevision !== null : current.revision !== expectedRevision) throw conflict();

      await atomicWriteFile(path, encoded, runtimeRoot);
      const reread = await readCurrentRecord(path, runtimeRoot);
      if (reread === null || serializeRecord(reread) !== encoded) throw unavailable();
      return reread;
    }, { containmentRoot: runtimeRoot });
  } catch (error) {
    if (error instanceof Error && isKnownError(error.message)) throw error;
    throw unavailable();
  }
}

function registrationPath(runtimeRoot: string): string {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0 || runtimeRoot.includes("\u0000") || !isAbsolute(runtimeRoot)) {
    throw unavailable();
  }
  const root = resolve(runtimeRoot);
  const path = join(root, REGISTRATION_DIRECTORY, REGISTRATION_LEAF);
  if (resolve(path) !== path || !path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw unavailable();
  return path;
}

function ownerTransactionMarkerPath(runtimeRoot: string): string {
  const root = resolve(runtimeRoot);
  const path = join(root, REGISTRATION_DIRECTORY, OWNER_TRANSACTION_MARKER_LEAF);
  if (resolve(path) !== path || !path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw unavailable();
  return path;
}

async function writeOwnerTransactionRecord(
  path: string,
  runtimeRoot: string,
  candidate: StardewInstallationRegistrationRecordV1,
): Promise<StardewInstallationRegistrationRecordV1> {
  const encoded = serializeRecord(candidate);
  await atomicWriteFile(path, encoded, runtimeRoot);
  const reread = await readCurrentRecord(path, runtimeRoot);
  if (reread === null || serializeRecord(reread) !== encoded) throw unavailable();
  return reread;
}

async function readOwnerTransactionMarker(
  path: string,
  runtimeRoot: string,
): Promise<StardewInstallationRegistrationOwnerTransactionMarker | null> {
  let parsed: unknown;
  try {
    parsed = await readStrictJsonFile(path, MAX_OWNER_TRANSACTION_MARKER_BYTES);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const marker = validateOwnerTransactionMarker(parsed);
  const bytes = await readFile(path);
  await verifySafePathBoundary(path, runtimeRoot);
  if (bytes.length > MAX_OWNER_TRANSACTION_MARKER_BYTES || !bytes.equals(Buffer.from(serializeOwnerTransactionMarker(marker), "utf8"))) {
    throw unavailable();
  }
  return marker;
}

function validateOwnerTransactionMarker(value: unknown): StardewInstallationRegistrationOwnerTransactionMarker {
  const marker = requireExactObject(value, ["schema", "operation", "bootstrapCorrelation", "registrationRevision", "ownerRecordRevision"]);
  if (marker.schema !== OWNER_TRANSACTION_MARKER_SCHEMA ||
      (marker.operation !== "prepare_bind" && marker.operation !== "settlement_release") ||
      !isOpaqueId(marker.bootstrapCorrelation) ||
      !isPositiveSafeInteger(marker.registrationRevision) ||
      !isPositiveSafeInteger(marker.ownerRecordRevision)) {
    throw unavailable();
  }
  return Object.freeze({
    schema: OWNER_TRANSACTION_MARKER_SCHEMA,
    operation: marker.operation,
    bootstrapCorrelation: marker.bootstrapCorrelation,
    registrationRevision: marker.registrationRevision,
    ownerRecordRevision: marker.ownerRecordRevision,
  });
}

function serializeOwnerTransactionMarker(marker: StardewInstallationRegistrationOwnerTransactionMarker): string {
  const checked = validateOwnerTransactionMarker(marker);
  return JSON.stringify({
    schema: checked.schema,
    operation: checked.operation,
    bootstrapCorrelation: checked.bootstrapCorrelation,
    registrationRevision: checked.registrationRevision,
    ownerRecordRevision: checked.ownerRecordRevision,
  });
}

async function readCurrentRecord(
  path: string,
  runtimeRoot: string,
): Promise<StardewInstallationRegistrationRecordV1 | null> {
  let parsed: unknown;
  try {
    parsed = await readStrictJsonFile(path, MAX_REGISTRATION_BYTES);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const record = validateRecord(parsed);
  const bytes = await readFile(path);
  await verifySafePathBoundary(path, runtimeRoot);
  if (bytes.length > MAX_REGISTRATION_BYTES || !bytes.equals(Buffer.from(serializeRecord(record), "utf8"))) {
    throw unavailable();
  }
  return record;
}

function validateRecord(value: unknown): StardewInstallationRegistrationRecordV1 {
  const record = requireExactObject(value, ["schema", "binding", "revision", "state", "locator", "activeAttempt"]);
  if (record.schema !== REGISTRATION_SCHEMA || !isPositiveSafeInteger(record.revision)) throw unavailable();

  const binding = requireExactObject(record.binding, ["rootLayoutVersion", "productInstallationId"]);
  if (binding.rootLayoutVersion !== 1 || !isOpaqueId(binding.productInstallationId)) throw unavailable();

  if (record.state !== "ready" && record.state !== "invalid") throw unavailable();
  if ((record.state === "ready" && !isCanonicalWindowsDirectory(record.locator)) || (record.state === "invalid" && record.locator !== null)) {
    throw unavailable();
  }

  let activeAttempt: StardewInstallationRegistrationRecordV1["activeAttempt"];
  if (record.activeAttempt === null) activeAttempt = null;
  else {
    const pointer = requireExactObject(record.activeAttempt, ["bootstrapCorrelation"]);
    if (!isOpaqueId(pointer.bootstrapCorrelation)) throw unavailable();
    activeAttempt = Object.freeze({ bootstrapCorrelation: pointer.bootstrapCorrelation });
  }

  const locator = record.locator === null ? null : record.locator as string;
  return Object.freeze({
    schema: REGISTRATION_SCHEMA,
    binding: Object.freeze({ rootLayoutVersion: 1, productInstallationId: binding.productInstallationId }),
    revision: record.revision,
    state: record.state,
    locator,
    activeAttempt,
  });
}

function serializeRecord(record: StardewInstallationRegistrationRecordV1): string {
  const normalized = validateRecord(record);
  return JSON.stringify({
    schema: normalized.schema,
    binding: {
      rootLayoutVersion: normalized.binding.rootLayoutVersion,
      productInstallationId: normalized.binding.productInstallationId,
    },
    revision: normalized.revision,
    state: normalized.state,
    locator: normalized.locator,
    activeAttempt: normalized.activeAttempt === null ? null : {
      bootstrapCorrelation: normalized.activeAttempt.bootstrapCorrelation,
    },
  });
}

function requireExactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw unavailable();
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) throw unavailable();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw unavailable();
  }
  return value as Record<string, unknown>;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 128 && OPAQUE_ID.test(value);
}

function isCanonicalWindowsDirectory(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_LOCATOR_BYTES ||
    value.includes("/") ||
    !/^[A-Za-z]:\\/.test(value)
  ) {
    return false;
  }
  if (DRIVE_ROOT.test(value)) return true;

  const components = value.slice(3).split("\\");
  if (components.length === 0 || components.length > 511) return false;
  return components.every((component) => (
    component.length > 0 &&
    component !== "." &&
    component !== ".." &&
    !/[\\/:*?<>"|\u0000-\u001f]/.test(component) &&
    !component.endsWith(".") &&
    !component.endsWith(" ") &&
    !isReservedWindowsName(component)
  ));
}

function isReservedWindowsName(component: string): boolean {
  const baseName = component.split(".", 1)[0]?.toUpperCase();
  return baseName !== undefined && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName);
}

function assertExpectedRevision(value: number | null): void {
  if (value !== null && !isPositiveSafeInteger(value)) throw invalidPublish();
}

function nextRevision(expectedRevision: number | null): number {
  const revision = expectedRevision === null ? 1 : expectedRevision + 1;
  if (!isPositiveSafeInteger(revision)) throw invalidPublish();
  return revision;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isKnownError(message: string): boolean {
  return message === "stardew_installation_registration_busy" ||
    message === "stardew_installation_registration_conflict" ||
    message === "invalid_stardew_installation_registration_publish" ||
    message === "stardew_installation_registration_unavailable";
}

function unavailable(): Error {
  return new Error("stardew_installation_registration_unavailable");
}

function busy(): Error {
  return new Error("stardew_installation_registration_busy");
}

function conflict(): Error {
  return new Error("stardew_installation_registration_conflict");
}

function invalidPublish(): Error {
  return new Error("invalid_stardew_installation_registration_publish");
}
