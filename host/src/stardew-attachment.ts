import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export const STARDew_PROVISIONING_VERSION = 1;
export const STARDew_INTEGRATION_ID = "stardew";

declare const stardewVerifiedCabinChoiceBrand: unique symbol;

export type StardewVerifiedCabinChoice = Readonly<{
  readonly [stardewVerifiedCabinChoiceBrand]: never;
}>;

export type StardewSessionAdvertisement = Readonly<{
  schemaVersion: number;
  integrationId: string;
  integrationVersion: string;
  gameVersion: string;
  gameBuildNumber: number;
  smapiVersion: string;
  multiplayerProtocol: string;
  endpoint: string;
  saveId: string;
  worldId: string;
  publishedAtUnixMs: number;
  expiresAtUnixMs: number;
  nonce: string;
  state: string;
  hostPlayerId: string;
  runtimeRole: string;
  launchGeneration: string;
  cabins: readonly Readonly<{
    cabinId: string;
    ownerFarmhandId: string;
    boundCompanionId: string;
    isBusy: boolean;
  }>[];
  signature: string;
}>;

export type StardewAttachmentRequest = Readonly<{
  schemaVersion: number;
  integrationId: string;
  sessionNonce: string;
  saveId: string;
  worldId: string;
  companionId: string;
  cabinId: string;
  expectedFarmhandId: string;
  confirmedAtUnixMs: number;
  requestId: string;
  signature: string;
}>;

export type StardewAttachmentResponse = Readonly<{
  schemaVersion: number;
  requestId: string;
  state: string;
  reasonCode: string;
  updatedAtUnixMs: number;
  manifestPath?: string;
  signature: string;
}>;

export type StardewJoinManifest = Readonly<{
  schemaVersion: number;
  requestId: string;
  integrationId: string;
  integrationVersion: string;
  gameVersion: string;
  gameBuildNumber: number;
  smapiVersion: string;
  multiplayerProtocol: string;
  endpoint: string;
  saveId: string;
  worldId: string;
  companionId: string;
  farmhandId: string;
  cabinId: string;
  sessionNonce: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  signature: string;
}>;

export type StardewAttachmentOptions = Readonly<{
  sessionDirectory: string;
  sessionToken: string;
  companionId: string;
  cabinId?: string;
  expectedFarmhandId?: string;
  nowMs?: () => number;
}>;

/**
 * Companion App-owned Stardew attachment flow. The app only consumes the
 * Integration advertisement and emits a signed request after explicit user
 * confirmation. Agent tools are intentionally absent from this module.
 */
export class StardewAttachmentFlow {
  readonly #options: StardewAttachmentOptions;
  readonly #verifiedCabinChoices = new WeakMap<object, Readonly<{
    session: StardewSessionAdvertisement;
    cabinId: string;
  }>>();

  public constructor(options: StardewAttachmentOptions) {
    if (
      !isAbsoluteSafePath(options.sessionDirectory) ||
      !isToken(options.sessionToken) ||
      !isOpaque(options.companionId) ||
      (options.cabinId !== undefined && !isOpaque(options.cabinId))
    ) {
      throw new Error("invalid_stardew_attachment_options");
    }
    if (options.expectedFarmhandId !== undefined && !isNativeId(options.expectedFarmhandId))
      throw new Error("invalid_expected_farmhand_id");
    this.#options = options;
  }

  public async readLiveSession(): Promise<StardewSessionAdvertisement> {
    const value = JSON.parse(
      await readFile(resolve(this.#options.sessionDirectory, "stardew-session.json"), "utf8"),
    ) as unknown;
    const session = validateSession(value);
    const now = this.now();
    if (session.expiresAtUnixMs <= now) throw new Error("stardew_session_expired");
    if (session.publishedAtUnixMs > now + 30_000) throw new Error("stardew_session_clock_invalid");
    if (!verifySignature(session, this.#options.sessionToken)) throw new Error("stardew_session_authentication_failed");
    if (session.integrationId !== STARDew_INTEGRATION_ID || session.schemaVersion !== STARDew_PROVISIONING_VERSION)
      throw new Error("stardew_protocol_mismatch");
    if (session.state !== "ready") throw new Error(`stardew_${session.state}`);
    return session;
  }

  public async verifyCabinChoice(
    candidateCabinId: string,
    expectedPlayerHostLaunchGeneration?: string,
  ): Promise<StardewVerifiedCabinChoice> {
    if (!isOpaque(candidateCabinId)) throw new Error("invalid_cabin_id");
    if (expectedPlayerHostLaunchGeneration !== undefined && !isOpaque(expectedPlayerHostLaunchGeneration))
      throw new Error("invalid_player_host_launch_generation");
    const session = await this.readLiveSession();
    if (
      expectedPlayerHostLaunchGeneration !== undefined &&
      session.launchGeneration !== expectedPlayerHostLaunchGeneration
    )
      throw new Error("stardew_player_host_generation_mismatch");
    const cabin = session.cabins.find((candidate) => candidate.cabinId === candidateCabinId);
    if (cabin === undefined) throw new Error("cabin_missing");
    if (cabin.isBusy) throw new Error("target_farmhand_busy");
    if (cabin.boundCompanionId !== "" && cabin.boundCompanionId !== this.#options.companionId)
      throw new Error("cabin_bound_to_other_companion");
    const choice = Object.freeze(Object.create(null)) as StardewVerifiedCabinChoice;
    this.#verifiedCabinChoices.set(choice, Object.freeze({ session, cabinId: candidateCabinId }));
    return choice;
  }

  public async confirmAndRequest(
    sessionOrChoice: StardewSessionAdvertisement | StardewVerifiedCabinChoice,
    confirmation: Readonly<{ confirmed: boolean; expectedFarmhandId?: string }> = { confirmed: false },
  ): Promise<string> {
    if (!confirmation.confirmed) throw new Error("user_confirmation_required");
    const choiceFacts = typeof sessionOrChoice === "object" && sessionOrChoice !== null
      ? this.#verifiedCabinChoices.get(sessionOrChoice)
      : undefined;
    const session = choiceFacts?.session ?? sessionOrChoice as StardewSessionAdvertisement;
    const cabinId = choiceFacts?.cabinId ?? this.#options.cabinId;
    if (!isOpaque(cabinId)) throw new Error("invalid_cabin_id");
    if (choiceFacts === undefined && !isRecord(sessionOrChoice))
      throw new Error("invalid_stardew_cabin_choice");
    const current = await this.readLiveSession();
    if (
      !verifySignature(session, this.#options.sessionToken) ||
      session.schemaVersion !== current.schemaVersion ||
      session.integrationId !== current.integrationId ||
      session.integrationVersion !== current.integrationVersion ||
      session.gameVersion !== current.gameVersion ||
      session.gameBuildNumber !== current.gameBuildNumber ||
      session.smapiVersion !== current.smapiVersion ||
      session.multiplayerProtocol !== current.multiplayerProtocol ||
      session.endpoint !== current.endpoint ||
      session.saveId !== current.saveId ||
      session.worldId !== current.worldId ||
      session.hostPlayerId !== current.hostPlayerId ||
      session.runtimeRole !== current.runtimeRole ||
      session.launchGeneration !== current.launchGeneration ||
      session.nonce !== current.nonce
    )
      throw new Error("stardew_session_changed");
    const cabin = current.cabins.find((candidate) => candidate.cabinId === cabinId);
    if (cabin === undefined) throw new Error("cabin_missing");
    if (cabin.isBusy) throw new Error("target_farmhand_busy");
    if (cabin.boundCompanionId !== "" && cabin.boundCompanionId !== this.#options.companionId)
      throw new Error("cabin_bound_to_other_companion");
    const expectedFarmhandId =
      confirmation.expectedFarmhandId ?? this.#options.expectedFarmhandId ?? cabin.ownerFarmhandId;
    if (expectedFarmhandId !== "" && !isNativeId(expectedFarmhandId)) throw new Error("invalid_expected_farmhand_id");
    const request: StardewAttachmentRequest = {
      schemaVersion: STARDew_PROVISIONING_VERSION,
      integrationId: STARDew_INTEGRATION_ID,
      sessionNonce: current.nonce,
      saveId: current.saveId,
      worldId: current.worldId,
      companionId: this.#options.companionId,
      cabinId,
      expectedFarmhandId,
      confirmedAtUnixMs: this.now(),
      requestId: randomUUID().replaceAll("-", ""),
      signature: "",
    };
    const signed = { ...request, signature: sign(request, this.#options.sessionToken) };
    await atomicWrite(
      resolve(this.#options.sessionDirectory, "stardew-attachment-request.json"),
      JSON.stringify(signed),
    );
    return request.requestId;
  }

  public async readCompatibilityOutcome(): Promise<Readonly<{
    status: "compatible_unverified";
    attachmentAllowed: true;
  }>> {
    await this.readLiveSession();
    return Object.freeze({ status: "compatible_unverified" as const, attachmentAllowed: true as const });
  }

  public async waitForResponse(requestId: string, timeoutMs = 60_000): Promise<StardewAttachmentResponse> {
    if (!isOpaque(requestId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new Error("invalid_attachment_timeout");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(
          await readFile(resolve(this.#options.sessionDirectory, "stardew-attachment-response.json"), "utf8"),
        ) as unknown;
        const response = validateResponse(value);
        if (!verifySignature(response, this.#options.sessionToken))
          throw new Error("stardew_response_authentication_failed");
        if (response.requestId !== requestId || response.state === "awaiting_save") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
          continue;
        }
        return response;
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    throw new Error("stardew_attachment_timeout");
  }

  public async waitForManifest(requestId: string, timeoutMs = 60_000): Promise<StardewJoinManifest> {
    const deadline = Date.now() + timeoutMs;
    const response = await this.waitForResponse(requestId, timeoutMs);
    if (response.state !== "ready" || response.manifestPath === undefined)
      throw new Error(`stardew_attachment_rejected_${response.reasonCode}`);

    // `ready` response, manifest, and fresh signed advertisement are separate
    // atomically replaced files written from the Host game thread. Never accept
    // a manifest against a stale advertisement, but tolerate their short
    // publication hand-off by retrying only transient file/session conditions.
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.readIssuedManifest(response.manifestPath, requestId);
      } catch (error) {
        lastError = error;
        if (!isTransientManifestPublicationError(error)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    throw lastError ?? new Error("stardew_attachment_timeout");
  }

  public async readIssuedManifest(manifestPath: string, requestId: string): Promise<StardewJoinManifest> {
    if (!isOpaque(requestId)) throw new Error("invalid_request_id");
    const safePath = this.resolveManifestPath(manifestPath);
    const manifest = validateManifest(JSON.parse(await readFile(safePath, "utf8")) as unknown);
    const current = await this.readLiveSession();
    const now = this.now();
    if (manifest.requestId !== requestId) throw new Error("stardew_manifest_request_mismatch");
    if (manifest.expiresAtUnixMs <= now || manifest.issuedAtUnixMs > now + 30_000)
      throw new Error("stardew_manifest_expired");
    if (manifest.companionId !== this.#options.companionId ||
      (this.#options.cabinId !== undefined && manifest.cabinId !== this.#options.cabinId))
      throw new Error("stardew_manifest_identity_mismatch");
    const cabinMatches = current.cabins.filter((cabin) => cabin.cabinId === manifest.cabinId);
    if (
      cabinMatches.length !== 1 ||
      cabinMatches[0].ownerFarmhandId !== manifest.farmhandId ||
      (cabinMatches[0].boundCompanionId !== "" && cabinMatches[0].boundCompanionId !== manifest.companionId)
    )
      throw new Error("stardew_manifest_cabin_binding_mismatch");
    if (
      manifest.sessionNonce !== current.nonce ||
      manifest.saveId !== current.saveId ||
      manifest.worldId !== current.worldId ||
      manifest.endpoint !== current.endpoint ||
      manifest.integrationVersion !== current.integrationVersion ||
      manifest.gameVersion !== current.gameVersion ||
      manifest.gameBuildNumber !== current.gameBuildNumber ||
      manifest.smapiVersion !== current.smapiVersion ||
      manifest.multiplayerProtocol !== current.multiplayerProtocol
    )
      throw new Error("stardew_manifest_session_mismatch");
    if (!verifySignature(manifest, this.#options.sessionToken))
      throw new Error("stardew_manifest_authentication_failed");
    return manifest;
  }

  private resolveManifestPath(manifestPath: string): string {
    const expected = resolve(this.#options.sessionDirectory, "stardew-farmhand-manifest.json");
    if (manifestPath === "stardew-farmhand-manifest.json") return expected;
    if (!isAbsoluteSafePath(manifestPath) || resolve(manifestPath) !== expected)
      throw new Error("invalid_manifest_path");
    return expected;
  }

  private now(): number {
    return this.#options.nowMs?.() ?? Date.now();
  }
}

function sign(value: object, token: string): string {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url");
}

function verifySignature(value: object & { signature: string }, token: string): boolean {
  const expected = sign(value, token);
  const actual = Buffer.from(value.signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (!isRetryableFileReplaceError(error)) throw error;
        try {
          await unlink(path);
        } catch (unlinkError) {
          if (!isRetryableFileReplaceError(unlinkError) && !isFileNotFound(unlinkError)) throw unlinkError;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
      }
    }
    throw new Error("stardew_attachment_file_replace_failed");
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }
}

function isRetryableFileReplaceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ["EEXIST", "EPERM", "EBUSY", "ETXTBSY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isTransientManifestPublicationError(error: unknown): boolean {
  if (isFileNotFound(error) || error instanceof SyntaxError) return true;
  return (
    error instanceof Error &&
    ["stardew_session_expired", "stardew_host_not_ready", "invalid_stardew_session"].includes(error.message)
  );
}

function validateSession(value: unknown): StardewSessionAdvertisement {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STARDew_PROVISIONING_VERSION ||
    value.integrationId !== STARDew_INTEGRATION_ID ||
    !isVersion(value.integrationVersion) ||
    !isVersion(value.gameVersion) ||
    !Number.isSafeInteger(value.gameBuildNumber) ||
    !isVersion(value.smapiVersion) ||
    !isVersion(value.multiplayerProtocol) ||
    !isEndpoint(value.endpoint) ||
    !isOpaque(value.saveId) ||
    !isOpaque(value.worldId) ||
     !isOpaque(value.hostPlayerId) ||
     value.runtimeRole !== "player_host" ||
     !isOpaque(value.launchGeneration) ||
     !isTimestamp(value.publishedAtUnixMs) ||
    !isTimestamp(value.expiresAtUnixMs) ||
    value.expiresAtUnixMs <= value.publishedAtUnixMs ||
    !isOpaque(value.nonce) ||
    (value.state !== "ready" && value.state !== "host_not_ready" && value.state !== "protocol_mismatch") ||
    !isToken(value.signature) ||
    !validateCabins(value.cabins)
  )
    throw new Error("invalid_stardew_session");
  return value as unknown as StardewSessionAdvertisement;
}

function validateResponse(value: unknown): StardewAttachmentResponse {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STARDew_PROVISIONING_VERSION ||
    !isOpaque(value.requestId) ||
    (value.state !== "awaiting_save" && value.state !== "ready" && value.state !== "rejected") ||
    !isReason(value.reasonCode) ||
    !isTimestamp(value.updatedAtUnixMs) ||
    (value.manifestPath !== undefined && value.manifestPath !== "stardew-farmhand-manifest.json") ||
    (value.state === "ready"
      ? value.manifestPath !== "stardew-farmhand-manifest.json"
      : value.manifestPath !== undefined) ||
    !isToken(value.signature)
  )
    throw new Error("invalid_stardew_response");
  return value as unknown as StardewAttachmentResponse;
}

function validateManifest(value: unknown): StardewJoinManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STARDew_PROVISIONING_VERSION ||
    !isOpaque(value.requestId) ||
    value.integrationId !== STARDew_INTEGRATION_ID ||
    !isVersion(value.integrationVersion) ||
    !isVersion(value.gameVersion) ||
    !Number.isSafeInteger(value.gameBuildNumber) ||
    !isVersion(value.smapiVersion) ||
    !isVersion(value.multiplayerProtocol) ||
    !isEndpoint(value.endpoint) ||
    !isOpaque(value.saveId) ||
    !isOpaque(value.worldId) ||
    !isOpaque(value.companionId) ||
    !isNativeId(value.farmhandId) ||
    !isOpaque(value.cabinId) ||
    !isOpaque(value.sessionNonce) ||
    !isTimestamp(value.issuedAtUnixMs) ||
    !isTimestamp(value.expiresAtUnixMs) ||
    value.expiresAtUnixMs <= value.issuedAtUnixMs ||
    !isToken(value.signature)
  )
    throw new Error("invalid_stardew_manifest");
  return value as unknown as StardewJoinManifest;
}

function validateCabins(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (candidate) =>
        isRecord(candidate) &&
        isOpaque(candidate.cabinId) &&
        (candidate.ownerFarmhandId === "" || isNativeId(candidate.ownerFarmhandId)) &&
        (candidate.boundCompanionId === "" || isOpaque(candidate.boundCompanionId)) &&
        typeof candidate.isBusy === "boolean",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isNativeId(value: unknown): value is string {
  if (typeof value !== "string" || !/^-?[0-9]{1,19}$/.test(value)) return false;
  const id = BigInt(value);
  return id !== 0n && id >= -9223372036854775808n && id <= 9223372036854775807n;
}
function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{16,256}$/.test(value);
}
function isReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value);
}
function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(value);
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 255 || !/^[A-Za-z0-9.-]+:[0-9]{1,5}$/.test(value))
    return false;
  const port = Number(value.slice(value.lastIndexOf(":") + 1));
  return port >= 1 && port <= 65535;
}
function isAbsoluteSafePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && !basename(value).includes("..");
}
