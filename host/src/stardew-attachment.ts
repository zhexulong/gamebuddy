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
  /**
   * Physical save-slot basename the Mod observed for the bound world
   * (`{filteredSaveName}_{uniqueIDForThisGame}`), exposed so the Stardew
   * integration seam can consume the world the game itself created as an opaque
   * binding ref. It is redacted to a basename: no path, PID or token. The Mod
   * always writes it into the signed bytes; it stays optional here only because
   * the pre-existing handoff fixtures publish manifests without it.
   */
  observedSaveSlot?: string;
  companionId: string;
  farmhandId: string;
  cabinId: string;
  sessionNonce: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  signature: string;
}>;

/**
 * How far ahead of this Host's clock the Mod's own stamp may be, and how old its publication may be
 * before the advertisement stops being evidence about the world it describes.
 *
 * The skew is the guard `readLiveSession` already applies, named once for both readers. The age is
 * this module's own: the Mod publishes at the top of every tick and stamps an expiry a few seconds
 * out (measured 2026-11-24: a beat every ~1 s, `expiresAtUnixMs` ~2.7-3.0 s after the stamp), so a
 * document five beats old means the publisher stopped while its expiry still claims a live world.
 */
const SESSION_CLOCK_SKEW_MS = 30_000;
const CABIN_OCCUPANCY_PUBLISHED_WITHIN_MS = 5_000;

/**
 * What the Mod's own published advertisement says about THIS companion's cabin, in the save the
 * Player Host currently has loaded.
 *
 * Three answers, and `unknown` is an answer rather than an error: after a cabin press whose signed
 * manifest WAS admitted, the difference between "this save does not hold her" and "the game did not
 * say" is the difference between releasing a quarantined attempt and keeping it. A stale, forged,
 * unreadable or other-world document must never answer `not_bound` - that is the reading that would
 * let a second manifest into the world.
 *
 * `not_bound` is the strong claim, and the two facts it needs are the reason it can be made at all:
 * the Mod writes the farmhand the manifest named into the chosen cabin in the same accepted request
 * that issues the manifest (`readIssuedManifest` reads that binding back before the admission
 * exists), while its FORMAL companion attachment is published on a later beat. So "no cabin holds
 * her" alone would be true of a world where the publication already landed; `not_bound` therefore
 * also requires that no cabin holds the manifest's own farmhand, and is unavailable while no admitted
 * manifest names one.
 */
export type StardewCabinOccupancy =
  | Readonly<{ status: "not_bound" }>
  | Readonly<{
      status: "already_bound";
      cabinId: string;
      /**
       * Which of the advertisement's two columns holds her: the formal companion attachment, or the
       * farmhand the admitted manifest created in that cabin before the attachment caught up.
       */
      boundBy: "companion" | "manifest_farmhand";
    }>
  | Readonly<{ status: "unknown"; reason: StardewCabinOccupancyUnknownReason }>;

/** Every reason a live advertisement could not decide the question, each naming the layer that failed. */
export type StardewCabinOccupancyUnknownReason =
  | "session_document_missing"
  | "session_document_unreadable"
  | "session_document_unauthenticated"
  | "session_document_stale"
  | "session_document_clock_ahead"
  | "session_document_other_world"
  | "session_host_not_ready"
  | "session_protocol_mismatch"
  | "manifest_farmhand_unavailable";

/**
 * The world and the farmhand the answer has to be about.
 *
 * `saveId`/`worldId` come from the attempt's own admitted material: an advertisement of a save the
 * player has since loaded instead says nothing about this attempt's save, and the same per-attempt
 * session directory serves it. `farmhandId` is the manifest the press had admitted, and `null` means
 * no admission is in hand - see `StardewCabinOccupancy` for why absence cannot then be proven.
 */
export type StardewCabinOccupancyExpectation = Readonly<{
  saveId: string;
  worldId: string;
  farmhandId: string | null;
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
  readonly #verifiedCabinChoices = new WeakMap<
    object,
    Readonly<{
      session: StardewSessionAdvertisement;
      cabinId: string;
    }>
  >();

  public constructor(options: StardewAttachmentOptions) {
    if (
      !isAbsoluteSafePath(options.sessionDirectory) ||
      !isToken(options.sessionToken) ||
      !isOpaque(options.companionId) ||
      (options.cabinId !== undefined && !isOpaque(options.cabinId))
    ) {
      throw new Error("invalid_stardew_attachment_options");
    }
    // The EMPTY expected id is a MEANINGFUL value on this flow, not a missing one: it is how a request
    // addresses an ownerless cabin (the advertisement writes "" for a Cabin whose owner has no farmhand,
    // HostFarmhandProvisioner.cs:405) and it is the ONLY value a first binding accepts
    // (HostFarmhandProvisioner.cs:535 `new_binding_requires_empty_expected_id`). The request path already
    // treats it that way (`expectedFarmhandId !== ""` below); the constructor refused it, so the one mode
    // that creates a binding could not be expressed through this class at all.
    if (
      options.expectedFarmhandId !== undefined &&
      options.expectedFarmhandId !== "" &&
      !isNativeId(options.expectedFarmhandId)
    )
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
    if (session.publishedAtUnixMs > now + SESSION_CLOCK_SKEW_MS) throw new Error("stardew_session_clock_invalid");
    if (!verifySignature(session, this.#options.sessionToken)) throw new Error("stardew_session_authentication_failed");
    if (session.integrationId !== STARDew_INTEGRATION_ID || session.schemaVersion !== STARDew_PROVISIONING_VERSION)
      throw new Error("stardew_protocol_mismatch");
    if (session.state !== "ready") throw new Error(`stardew_${session.state}`);
    return session;
  }

  /**
   * The bounded, non-mutating read behind the cabin-occupancy answer: one `stardew-session.json`
   * read through the same validator, signature and liveness rules `readLiveSession` applies, and no
   * write, reservation, arm or bridge command of any kind.
   *
   * It answers instead of throwing, because every way of not knowing is one of the THREE answers the
   * forward step is decided from; the refusals it can give are the ones `StardewCabinOccupancy`
   * enumerates. A malformed EXPECTATION is not an answer: that is a caller defect and refuses.
   *
   * NOTHING CALLS THIS YET, and that is deliberate. The player-visible control that asks it is declared
   * (`read_game_again` in `dialogue-web/src/game-lifecycle-controls.ts`), and the step its answer licenses
   * is decided in `host/src/games/stardew/lifecycle/stardew-cabin-quarantine-forward-step.internal.ts`;
   * the release that step names has its own seam and its own preconditions there. Until that seam is
   * wired, this is a proof with no production caller rather than a wired one.
   */
  public async readCabinOccupancy(expected: StardewCabinOccupancyExpectation): Promise<StardewCabinOccupancy> {
    if (!isOpaque(expected.saveId) || !isOpaque(expected.worldId))
      throw new Error("invalid_cabin_occupancy_expectation");
    if (expected.farmhandId !== null && !isNativeId(expected.farmhandId))
      throw new Error("invalid_cabin_occupancy_expectation");
    let raw: string;
    try {
      raw = await readFile(resolve(this.#options.sessionDirectory, "stardew-session.json"), "utf8");
    } catch (error) {
      return unknownOccupancy(isFileNotFound(error) ? "session_document_missing" : "session_document_unreadable");
    }
    let session: StardewSessionAdvertisement;
    try {
      session = validateSession(JSON.parse(raw) as unknown);
    } catch {
      return unknownOccupancy("session_document_unreadable");
    }
    if (!verifySignature(session, this.#options.sessionToken))
      return unknownOccupancy("session_document_unauthenticated");
    const now = this.now();
    if (session.expiresAtUnixMs <= now || now - session.publishedAtUnixMs > CABIN_OCCUPANCY_PUBLISHED_WITHIN_MS)
      return unknownOccupancy("session_document_stale");
    if (session.publishedAtUnixMs > now + SESSION_CLOCK_SKEW_MS)
      return unknownOccupancy("session_document_clock_ahead");
    if (session.saveId !== expected.saveId || session.worldId !== expected.worldId)
      return unknownOccupancy("session_document_other_world");
    if (session.state === "protocol_mismatch") return unknownOccupancy("session_protocol_mismatch");
    if (session.state !== "ready") return unknownOccupancy("session_host_not_ready");
    const held = session.cabins.find((cabin) => cabin.boundCompanionId === this.#options.companionId);
    if (held !== undefined)
      return Object.freeze({ status: "already_bound" as const, cabinId: held.cabinId, boundBy: "companion" as const });
    if (expected.farmhandId === null) return unknownOccupancy("manifest_farmhand_unavailable");
    const farmhandCabin = session.cabins.find((cabin) => cabin.ownerFarmhandId === expected.farmhandId);
    if (farmhandCabin !== undefined)
      return Object.freeze({
        status: "already_bound" as const,
        cabinId: farmhandCabin.cabinId,
        boundBy: "manifest_farmhand" as const,
      });
    return Object.freeze({ status: "not_bound" as const });
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
    const choiceFacts =
      typeof sessionOrChoice === "object" && sessionOrChoice !== null
        ? this.#verifiedCabinChoices.get(sessionOrChoice)
        : undefined;
    const session = choiceFacts?.session ?? (sessionOrChoice as StardewSessionAdvertisement);
    const cabinId = choiceFacts?.cabinId ?? this.#options.cabinId;
    if (!isOpaque(cabinId)) throw new Error("invalid_cabin_id");
    if (choiceFacts === undefined && !isRecord(sessionOrChoice)) throw new Error("invalid_stardew_cabin_choice");
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

  public async readCompatibilityOutcome(): Promise<
    Readonly<{
      status: "compatible_unverified";
      attachmentAllowed: true;
    }>
  > {
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
        if (response.requestId !== requestId) {
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
    if (
      manifest.companionId !== this.#options.companionId ||
      (this.#options.cabinId !== undefined && manifest.cabinId !== this.#options.cabinId)
    )
      throw new Error("stardew_manifest_identity_mismatch");
    const cabinMatches = current.cabins.filter((cabin) => cabin.cabinId === manifest.cabinId);
    const boundCabin = cabinMatches.length === 1 ? cabinMatches[0] : undefined;
    if (boundCabin === undefined) throw new Error("stardew_manifest_cabin_binding_mismatch");
    if (
      boundCabin.ownerFarmhandId !== manifest.farmhandId ||
      (boundCabin.boundCompanionId !== "" && boundCabin.boundCompanionId !== manifest.companionId)
    ) {
      // THE BINDING THIS MANIFEST NAMES IS A FACT THE REQUEST ITSELF CREATED. The Mod draws the
      // Farmhand and binds it to the Cabin inside the request it accepts, and it publishes the
      // advertisement that carries that binding on its own one-second beat - it publishes at the
      // top of a tick and processes a pending request in the same tick, never twice in one beat
      // (HostFarmhandProvisioner.cs:143-150). An advertisement published at or before this
      // manifest's own issuance therefore CANNOT hold the binding yet, and demanding it of that
      // beat refused a live handoff 106 ms after the press (run r19, 2026-11-21) while the Mod's
      // own answer said `manifest_issued`. That beat is a hand-off, not a disagreement: the caller
      // waits for the next one. A beat published AFTER the issuance that still disagrees is the
      // real thing this check exists for, and refuses here.
      throw new Error(
        current.publishedAtUnixMs <= manifest.issuedAtUnixMs
          ? "stardew_manifest_binding_not_yet_published"
          : "stardew_manifest_cabin_binding_mismatch",
      );
    }
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

function unknownOccupancy(reason: StardewCabinOccupancyUnknownReason): StardewCabinOccupancy {
  return Object.freeze({ status: "unknown" as const, reason });
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isTransientManifestPublicationError(error: unknown): boolean {
  if (isFileNotFound(error) || error instanceof SyntaxError) return true;
  return (
    error instanceof Error &&
    [
      "stardew_session_expired",
      "stardew_host_not_ready",
      "invalid_stardew_session",
      "stardew_manifest_binding_not_yet_published",
    ].includes(error.message)
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
    (value.state !== "ready" && value.state !== "rejected" && value.state !== "uncertain") ||
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
    (value.observedSaveSlot !== undefined && !isObservedSaveSlot(value.observedSaveSlot)) ||
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
/**
 * Physical save-slot basename shape: the native save identity the game assigned
 * plus its unique ID. Stricter than the generic opaque alphabet on purpose so a
 * path separator, a space, punctuation or a leading '-' can never be smuggled
 * through the redacted slot channel.
 */
function isObservedSaveSlot(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{1,64}_[0-9]{1,32}$/.test(value);
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
