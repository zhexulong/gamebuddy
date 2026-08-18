import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PORTFOLIO_TOPOLOGY, inspectPortfolioModBundle } from "./stardew-portfolio-profile.mjs";
import {
  computePortfolioBindingHash as computeContractBindingHash,
  PORTFOLIO_EVIDENCE_SCHEMA_REVISION as PORTFOLIO_CONTRACT_EVIDENCE_SCHEMA_REVISION,
  PORTFOLIO_TARGET_GAME_SHA256 as PORTFOLIO_CONTRACT_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION as PORTFOLIO_CONTRACT_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION as PORTFOLIO_CONTRACT_TARGET_VERSION,
  PORTFOLIO_TARGET_BUILD_NUMBER,
} from "./stardew-portfolio-contract-primitives.mjs";

export const PORTFOLIO_TARGET_VERSION = `${PORTFOLIO_CONTRACT_TARGET_VERSION}.${PORTFOLIO_TARGET_BUILD_NUMBER}`;
export const PORTFOLIO_TARGET_GAME_VERSION = PORTFOLIO_CONTRACT_TARGET_VERSION;
export const PORTFOLIO_TARGET_GAME_BUILD_NUMBER = PORTFOLIO_TARGET_BUILD_NUMBER;
export const PORTFOLIO_TARGET_GAME_SHA256 = PORTFOLIO_CONTRACT_TARGET_GAME_SHA256;
export const PORTFOLIO_TARGET_SMAPI_VERSION = PORTFOLIO_CONTRACT_TARGET_SMAPI_VERSION;
export const PORTFOLIO_START_MANIFEST_SCHEMA_VERSION = 1;
export const PORTFOLIO_INSTALLATION_ATTESTATION_SCHEMA_VERSION = 1;
export const PORTFOLIO_START_MANIFEST_SIGNING_ALGORITHM = "hmac-sha256";
export const PORTFOLIO_EVIDENCE_SCHEMA_REVISION = PORTFOLIO_CONTRACT_EVIDENCE_SCHEMA_REVISION;

export function computePortfolioBindingHash({ saveId, worldId, localPlayerId, companionId, bindingGeneration }) {
  if (
    ![saveId, worldId, localPlayerId, companionId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? "")) ||
    !Number.isSafeInteger(bindingGeneration) ||
    bindingGeneration <= 0
  ) {
    throw new Error("portfolio_binding_hash_input_invalid");
  }
  return computeContractBindingHash({ saveId, worldId, localPlayerId, companionId, bindingGeneration });
}

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_GAME_FILES = Object.freeze(["Stardew Valley.dll", "StardewModdingAPI.dll", "StardewModdingAPI.exe"]);
const REQUIRED_SAVE_FILES = Object.freeze(["SaveGameInfo"]);
const START_MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "topology",
  "saveName",
  "observedSaveSlot",
  "saveFileSha256",
  "saveGameInfoSha256",
  "nativeLifecycle",
  "terminalFacts",
  "fixtureSafety",
  "producer",
  "evidenceSchemaRevision",
  "signature",
  "signatureAlgorithm",
]);
const INSTALLATION_FIELDS = Object.freeze(["schemaVersion", "artifactKind", "topology", "target", "mod", "host"]);

/**
 * P0b is intentionally read-only. It does not load a save, invoke a Stardew
 * API, create a start manifest, or infer terminal facts from a copied XML.
 * The start manifest must be produced by a target-version native run and is
 * checked against the exact bytes observed here.
 */
export async function inspectPortfolioP0b(options = {}) {
  const reasons = [];
  const context = resolveP0bContext(options);
  const dataRoot = await inspectDataRoot(context);
  reasons.push(...dataRoot.reasons);
  const installation = await inspectInstallationAttestation(context, options);
  reasons.push(...installation.reasons);
  const save = await inspectPortfolioSave(context);
  reasons.push(...save.reasons);
  const startManifestBoundary = inspectStartManifestPathBoundary(context);
  reasons.push(...startManifestBoundary.reasons);
  const startManifest =
    startManifestBoundary.state === "ready"
      ? await inspectStartManifest(context, { save, installation })
      : Object.freeze({ state: "blocked", reasons: Object.freeze([]), manifest: null });
  reasons.push(...startManifest.reasons);
  const uniqueReasons = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({
    state: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
    phase: "P0b_read_only_save_and_target_attestation",
    topology: PORTFOLIO_TOPOLOGY,
    reasons: uniqueReasons,
    dataRoot,
    installation,
    save,
    startManifest,
  });
}

export function validatePortfolioStartManifest(value, expected = {}) {
  const errors = [];
  if (!isPlainObject(value))
    return Object.freeze({ valid: false, errors: Object.freeze(["portfolio_start_manifest_invalid_shape"]) });
  rejectUnknownFields(value, START_MANIFEST_FIELDS, "portfolio_start_manifest_unknown_field", errors);
  if (value.schemaVersion !== PORTFOLIO_START_MANIFEST_SCHEMA_VERSION)
    errors.push("portfolio_start_manifest_schema_version_invalid");
  if (value.artifactKind !== "portfolio_start_manifest") errors.push("portfolio_start_manifest_artifact_kind_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_start_manifest_topology_invalid");
  if (typeof expected.saveName === "string" && value.saveName !== expected.saveName)
    errors.push("portfolio_start_manifest_save_name_mismatch");
  if (!isValidSaveName(value.saveName)) errors.push("portfolio_start_manifest_save_name_invalid");
  if (typeof expected.observedSaveSlot === "string" && value.observedSaveSlot !== expected.observedSaveSlot)
    errors.push("portfolio_start_manifest_observed_save_slot_mismatch");
  if (!isValidObservedSaveSlot(value.observedSaveSlot, value.saveName))
    errors.push("portfolio_start_manifest_observed_save_slot_invalid");
  if (!SHA256.test(value.saveFileSha256 ?? "")) errors.push("portfolio_start_manifest_save_hash_invalid");
  if (!SHA256.test(value.saveGameInfoSha256 ?? "")) errors.push("portfolio_start_manifest_save_info_hash_invalid");
  if (value.signatureAlgorithm !== PORTFOLIO_START_MANIFEST_SIGNING_ALGORITHM)
    errors.push("portfolio_start_manifest_signature_algorithm_invalid");
  if (!SHA256.test(value.signature ?? "")) errors.push("portfolio_start_manifest_signature_invalid");
  if (
    typeof expected.signingKey === "string" &&
    value.signature !== signPortfolioStartManifest(value, expected.signingKey).signature
  )
    errors.push("portfolio_start_manifest_signature_mismatch");
  validateNativeLifecycle(value.nativeLifecycle, errors, expected.nativeScope);
  validateTerminalFacts(value.terminalFacts, errors);
  validateFixtureSafety(value.fixtureSafety, errors);
  validateProducer(value.producer, errors);
  if (typeof expected.saveFileSha256 === "string" && value.saveFileSha256 !== expected.saveFileSha256)
    errors.push("portfolio_start_manifest_save_hash_mismatch");
  if (typeof expected.saveGameInfoSha256 === "string" && value.saveGameInfoSha256 !== expected.saveGameInfoSha256)
    errors.push("portfolio_start_manifest_save_info_hash_mismatch");
  if (typeof expected.producerSha256 === "string" && value.producer?.sha256 !== expected.producerSha256)
    errors.push("portfolio_start_manifest_producer_hash_mismatch");
  if (typeof expected.producerVersion === "string" && value.producer?.modVersion !== expected.producerVersion)
    errors.push("portfolio_start_manifest_producer_version_mismatch");
  if (expected.evidenceSchemaRevision !== undefined && value.evidenceSchemaRevision !== expected.evidenceSchemaRevision)
    errors.push("portfolio_start_manifest_evidence_schema_revision_mismatch");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)].sort()) });
}

export function signPortfolioStartManifest(value, signingKey) {
  if (typeof signingKey !== "string" || signingKey.length < 16)
    throw new Error("portfolio_start_manifest_signing_key_invalid");
  const unsigned = { ...value, signatureAlgorithm: PORTFOLIO_START_MANIFEST_SIGNING_ALGORITHM };
  delete unsigned.signature;
  const signature = createHmac("sha256", signingKey).update(canonicalJson(unsigned)).digest("hex");
  return Object.freeze({ ...unsigned, signature });
}

export function validatePortfolioInstallationAttestation(value, expected = {}) {
  const errors = [];
  if (!isPlainObject(value))
    return Object.freeze({ valid: false, errors: Object.freeze(["portfolio_installation_attestation_invalid_shape"]) });
  rejectUnknownFields(value, INSTALLATION_FIELDS, "portfolio_installation_attestation_unknown_field", errors);
  if (value.schemaVersion !== PORTFOLIO_INSTALLATION_ATTESTATION_SCHEMA_VERSION)
    errors.push("portfolio_installation_attestation_schema_version_invalid");
  if (value.artifactKind !== "portfolio_installation_attestation")
    errors.push("portfolio_installation_attestation_artifact_kind_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_installation_attestation_topology_invalid");
  validateTargetAttestation(value.target, errors);
  validateModAttestation(value.mod, errors);
  validateHostAttestation(value.host, errors);
  if (value.target?.gameSha256 !== PORTFOLIO_TARGET_GAME_SHA256)
    errors.push("portfolio_installation_attestation_target_constant_mismatch");
  if (value.target?.gameVersion !== PORTFOLIO_TARGET_VERSION)
    errors.push("portfolio_installation_attestation_target_version_mismatch");
  if (value.target?.smapiVersion !== PORTFOLIO_TARGET_SMAPI_VERSION)
    errors.push("portfolio_installation_attestation_smapi_version_mismatch");
  if (value.target?.smapiExeVersion !== PORTFOLIO_TARGET_SMAPI_VERSION)
    errors.push("portfolio_installation_attestation_smapi_exe_version_mismatch");
  if (typeof expected.modDllSha256 === "string" && value.mod?.dllSha256 !== expected.modDllSha256)
    errors.push("portfolio_installation_attestation_mod_hash_expectation_mismatch");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)].sort()) });
}

async function inspectInstallationAttestation(context, options) {
  const reasons = [];
  const attestation = await readJsonIfPresent(
    context.installationAttestationPath,
    reasons,
    "portfolio_installation_attestation",
  );
  if (!attestation)
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze([...new Set(reasons)].sort()),
      attestation: null,
      target: null,
      mod: null,
      host: null,
    });
  const schema = validatePortfolioInstallationAttestation(attestation);
  reasons.push(...schema.errors);
  const target = await inspectTargetInstallation(context.gamePath, attestation.target);
  reasons.push(...target.reasons);
  const mod = await inspectModBundle(context.profileRoot, attestation.mod);
  reasons.push(...mod.reasons);
  const host = await inspectHostArtifact(attestation.host, context.hostArtifactPath);
  reasons.push(...host.reasons);
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    attestation,
    target,
    mod,
    host,
  });
}

async function inspectTargetInstallation(gamePath, expected) {
  const reasons = [];
  if (typeof gamePath !== "string" || !isAbsolute(gamePath))
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze(["portfolio_game_path_missing_or_not_absolute"]),
      files: [],
    });
  const files = [];
  for (const fileName of REQUIRED_GAME_FILES) {
    const filePath = join(gamePath, fileName);
    const observed = await hashAndVersion(
      filePath,
      fileName === "Stardew Valley.dll" || fileName === "StardewModdingAPI.dll" || fileName === "StardewModdingAPI.exe",
    );
    files.push(observed);
    if (!observed.exists) reasons.push(`portfolio_target_file_missing:${fileName}`);
  }
  const game = files.find((file) => file.fileName === "Stardew Valley.dll");
  const smapi = files.find((file) => file.fileName === "StardewModdingAPI.dll");
  const smapiExe = files.find((file) => file.fileName === "StardewModdingAPI.exe");
  if (game?.sha256 !== PORTFOLIO_TARGET_GAME_SHA256) reasons.push("portfolio_target_game_hash_mismatch");
  if (game?.fileVersion !== PORTFOLIO_TARGET_VERSION) reasons.push("portfolio_target_game_version_mismatch");
  if (smapi?.fileVersion && normalizeSmapiVersion(smapi.fileVersion) !== PORTFOLIO_TARGET_SMAPI_VERSION)
    reasons.push("portfolio_target_smapi_version_mismatch");
  if (!smapi?.fileVersion) reasons.push("portfolio_target_smapi_file_version_unavailable");
  if (expected?.gameSha256 !== game?.sha256) reasons.push("portfolio_attestation_observed_game_hash_mismatch");
  if (expected?.gameVersion !== game?.fileVersion) reasons.push("portfolio_attestation_observed_game_version_mismatch");
  if (expected?.smapiSha256 !== smapi?.sha256) reasons.push("portfolio_attestation_observed_smapi_hash_mismatch");
  if (expected?.smapiVersion !== normalizeSmapiVersion(smapi?.fileVersion))
    reasons.push("portfolio_attestation_observed_smapi_version_mismatch");
  if (normalizeSmapiVersion(smapiExe?.fileVersion) !== PORTFOLIO_TARGET_SMAPI_VERSION)
    reasons.push("portfolio_target_smapi_exe_version_mismatch");
  if (expected?.smapiExeSha256 !== smapiExe?.sha256)
    reasons.push("portfolio_attestation_observed_smapi_exe_hash_mismatch");
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    files: Object.freeze(files),
  });
}

async function inspectModBundle(profileRoot, expected) {
  const reasons = [];
  if (typeof profileRoot !== "string" || !isAbsolute(profileRoot))
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze(["portfolio_profile_root_missing_or_not_absolute"]),
      files: [],
    });
  // Resolve the one approved bundle layout through the P0a profile inspector.
  // P0b must not hard-code `<profileRoot>/Mods/GameBuddy`: P0a explicitly
  // permits either `<profileRoot>/GameBuddy` or `<profileRoot>/Mods/GameBuddy`,
  // while still rejecting duplicates, partial bundles, and unmanaged files.
  const bundle = await inspectPortfolioModBundle(profileRoot);
  if (bundle.state !== "single_bundle" || !bundle.directory)
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze([...(bundle.reasons ?? []), "portfolio_mod_bundle_unavailable"]),
      files: Object.freeze([]),
      directory: null,
      manifest: null,
    });
  const root = bundle.directory;
  const files = [];
  for (const fileName of ["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"]) {
    const observed = await hashAndVersion(join(root, fileName), false);
    files.push(observed);
    if (!observed.exists) reasons.push(`portfolio_mod_file_missing:${fileName}`);
    if (expected?.[fileKey(fileName)] !== observed.sha256)
      reasons.push(`portfolio_attestation_observed_mod_hash_mismatch:${fileName}`);
  }
  const manifest = await readJsonIfPresent(join(root, "manifest.json"), reasons, "portfolio_mod_manifest");
  if (manifest?.UniqueID !== "zhexulong.GameBuddy") reasons.push("portfolio_mod_manifest_identity_invalid");
  if (manifest?.EntryDll !== "GameBuddy.Stardew.dll") reasons.push("portfolio_mod_manifest_entry_invalid");
  if (typeof expected?.version === "string" && manifest?.Version !== expected.version)
    reasons.push("portfolio_mod_manifest_version_mismatch");
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    files: Object.freeze(files),
    directory: root,
    manifest,
  });
}

async function inspectHostArtifact(expected, artifactPath) {
  const reasons = [];
  if (!isPlainObject(expected) || typeof artifactPath !== "string" || !isAbsolute(artifactPath))
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze(["portfolio_host_attestation_artifact_path_invalid"]),
      artifact: null,
    });
  if (!SHA256.test(expected.sha256 ?? "")) reasons.push("portfolio_host_attestation_hash_invalid");
  const observed = await hashAndVersion(artifactPath, false);
  if (!observed.exists) reasons.push("portfolio_host_attestation_artifact_missing");
  if (expected.sha256 !== observed.sha256) reasons.push("portfolio_host_attestation_hash_mismatch");
  if (typeof expected.buildId !== "string" || expected.buildId.length < 1 || expected.buildId.length > 128)
    reasons.push("portfolio_host_attestation_build_id_invalid");
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    artifact: observed,
    buildId: expected.buildId ?? null,
  });
}

async function inspectPortfolioSave(context) {
  const reasons = [];
  const saveRoot = context.saveRoot;
  if (typeof saveRoot !== "string" || !isAbsolute(saveRoot))
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze(["portfolio_save_root_missing_or_not_absolute"]),
      savePath: null,
      files: [],
    });
  // Do not resolve or read an observed slot through a symlink/reparse save
  // root. A lexical containment check cannot establish where such a root
  // ultimately points, so this boundary must fail closed before slot access.
  const saveRootDirectory = await inspectSaveRootDirectory(saveRoot);
  if (saveRootDirectory.state !== "ready")
    return Object.freeze({ state: "blocked", reasons: saveRootDirectory.reasons, savePath: null, files: [] });
  const savePath = resolve(saveRoot, context.observedSaveSlot ?? "");
  const rootRelative = relative(resolve(saveRoot), savePath);
  if (
    isAbsolute(rootRelative) ||
    rootRelative === ".." ||
    rootRelative.startsWith("../") ||
    rootRelative.startsWith("..\\")
  )
    reasons.push("portfolio_save_path_escape");
  if (!isValidSaveName(context.saveName)) reasons.push("portfolio_save_name_invalid");
  if (
    !isValidObservedSaveSlot(context.observedSaveSlot, context.saveName) ||
    basename(savePath) !== context.observedSaveSlot
  )
    reasons.push("portfolio_observed_save_slot_invalid");
  if (sharesRoot(saveRoot, context.profileRoot) || sharesRoot(saveRoot, context.dataRoot))
    reasons.push("portfolio_save_root_overlaps_runtime_root");
  const saveDirectory = await inspectSaveDirectory(savePath);
  if (saveDirectory.state !== "ready") reasons.push(...saveDirectory.reasons);
  const filePaths = [
    join(savePath, context.observedSaveSlot),
    ...REQUIRED_SAVE_FILES.map((file) => join(savePath, file)),
  ];
  const files = [];
  for (const filePath of filePaths) {
    const fileName = basename(filePath);
    const observed = await hashAndVersion(filePath, false);
    files.push(observed);
    if (!observed.exists) reasons.push(`portfolio_save_file_missing:${fileName}`);
    if (observed.symlink) reasons.push(`portfolio_save_symlink_forbidden:${fileName}`);
  }
  const saveFile = files.find((file) => file.fileName === context.observedSaveSlot);
  if (saveFile?.exists) {
    const nativeShape = await inspectNativeSaveShape(join(savePath, context.observedSaveSlot));
    reasons.push(...nativeShape.reasons);
  }
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    savePath,
    files: Object.freeze(files),
  });
}

function inspectStartManifestPathBoundary(context) {
  const reasons = [];
  if (typeof context.startManifestPath !== "string" || !isAbsolute(context.startManifestPath)) {
    reasons.push("portfolio_start_manifest_path_missing_or_not_absolute");
  } else if (isPathWithin(context.startManifestPath, context.saveRoot)) {
    reasons.push("portfolio_start_manifest_path_overlap");
  }
  return Object.freeze({ state: reasons.length === 0 ? "ready" : "blocked", reasons: Object.freeze(reasons) });
}

async function inspectStartManifest(context, { save, installation }) {
  const reasons = [];
  const manifest = await readJsonIfPresent(context.startManifestPath, reasons, "portfolio_start_manifest");
  if (!manifest)
    return Object.freeze({ state: "blocked", reasons: Object.freeze([...new Set(reasons)].sort()), manifest: null });
  const expected = {
    saveName: context.saveName,
    observedSaveSlot: context.observedSaveSlot,
    saveFileSha256: save.files.find((file) => file.fileName === context.observedSaveSlot)?.sha256,
    saveGameInfoSha256: save.files.find((file) => file.fileName === "SaveGameInfo")?.sha256,
    producerSha256: installation.mod?.files?.find((file) => file.fileName === "GameBuddy.Stardew.dll")?.sha256,
    producerVersion: installation.mod?.manifest?.Version,
    nativeScope: context.nativeScope,
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  };
  if (typeof context.signingKey !== "string" || context.signingKey.length < 16)
    reasons.push("portfolio_start_manifest_signing_key_missing");
  const schema = validatePortfolioStartManifest(manifest, { ...expected, signingKey: context.signingKey });
  reasons.push(...schema.errors);
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    manifest,
  });
}

async function inspectNativeSaveShape(savePath) {
  const reasons = [];
  let text;
  try {
    const bytes = await readStableFile(savePath);
    if (!bytes) throw new Error("unstable");
    text = bytes.toString("utf8");
  } catch {
    return Object.freeze({ reasons: Object.freeze(["portfolio_save_read_failed"]) });
  }
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (!trimmed.startsWith("<SaveGame")) reasons.push("portfolio_save_native_xml_root_invalid");
  // These are artifact markers, not normal Stardew state. A match blocks the
  // save before any start manifest can be accepted.
  const lower = text.toLocaleLowerCase("en-US");
  if (
    lower.includes("gamebuddyfixture_") ||
    lower.includes("stardew-farmhand-manifest") ||
    lower.includes("stardew-fixture-readiness") ||
    lower.includes("portfolio_receipt") ||
    lower.includes("postcondition_evidence")
  ) {
    reasons.push("portfolio_save_cross_topology_or_receipt_artifact");
  }
  return Object.freeze({
    reasons: Object.freeze([...new Set(reasons)].sort()),
    byteLength: Buffer.byteLength(text, "utf8"),
  });
}

function validateNativeLifecycle(value, errors, expectedScope) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_start_manifest_native_lifecycle_invalid");
    return;
  }
  const allowed = [
    "loadApi",
    "saveEvents",
    "reopenVerified",
    "nativePlayerScopeObserved",
    "nativePlayerScope",
    "observedAtUnixMs",
  ];
  rejectUnknownFields(value, allowed, "portfolio_start_manifest_native_lifecycle_unknown_field", errors);
  if (value.loadApi !== "SaveGame.Load") errors.push("portfolio_start_manifest_native_load_api_invalid");
  if (
    !Array.isArray(value.saveEvents) ||
    value.saveEvents.length !== 2 ||
    value.saveEvents[0] !== "Saving" ||
    value.saveEvents[1] !== "Saved"
  )
    errors.push("portfolio_start_manifest_save_events_invalid");
  if (value.reopenVerified !== true) errors.push("portfolio_start_manifest_reopen_not_verified");
  if (value.nativePlayerScopeObserved !== true) errors.push("portfolio_start_manifest_native_player_scope_missing");
  // Scope evidence is mandatory even when P0b is invoked without the later
  // live runner. The live runner may add an exact expected scope, but P0b
  // never accepts an unvalidated or absent native-player identity object.
  validateNativePlayerScope(value.nativePlayerScope, expectedScope ?? {}, errors);
  if (!Number.isSafeInteger(value.observedAtUnixMs) || value.observedAtUnixMs <= 0)
    errors.push("portfolio_start_manifest_observation_time_invalid");
}

function validateNativePlayerScope(value, expected, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_start_manifest_native_player_scope_invalid");
    return;
  }
  rejectUnknownFields(
    value,
    [
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
      "singlePlayer",
      "masterGame",
    ],
    "portfolio_start_manifest_native_player_scope_unknown_field",
    errors,
  );
  for (const field of ["saveId", "worldId", "localPlayerId", "companionId"]) {
    if (typeof expected[field] === "string" && value[field] !== expected[field])
      errors.push(`portfolio_start_manifest_native_player_scope_${field}_mismatch`);
  }
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.saveId ?? "") ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.worldId ?? "") ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.localPlayerId ?? "") ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.companionId ?? "")
  )
    errors.push("portfolio_start_manifest_native_player_scope_id_invalid");
  if (
    !Number.isSafeInteger(value.bindingGeneration) ||
    value.bindingGeneration <= 0 ||
    !SHA256.test(value.bindingHash ?? "")
  )
    errors.push("portfolio_start_manifest_native_player_scope_binding_invalid");
  else if (value.bindingHash !== computePortfolioBindingHash(value))
    errors.push("portfolio_start_manifest_native_player_scope_binding_hash_mismatch");
  if (value.singlePlayer !== true || value.masterGame !== true)
    errors.push("portfolio_start_manifest_native_player_scope_not_single_player");
}

function validateTerminalFacts(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_start_manifest_terminal_facts_invalid");
    return;
  }
  const allowed = [
    "state",
    "checkedMilestones",
    "terminalRewards",
    "finalStepState",
    "receiptsWritten",
    "postconditionsWritten",
  ];
  rejectUnknownFields(value, allowed, "portfolio_start_manifest_terminal_facts_unknown_field", errors);
  if (value.state !== "none") errors.push("portfolio_start_manifest_terminal_facts_not_empty");
  if (
    !Array.isArray(value.checkedMilestones) ||
    value.checkedMilestones.length !== 10 ||
    value.checkedMilestones.join(",") !== "M1,M2,M3,M4,M5,M6,M7,M8,M9,M10"
  )
    errors.push("portfolio_start_manifest_milestone_scan_incomplete");
  if (value.terminalRewards !== 0 || value.receiptsWritten !== 0 || value.postconditionsWritten !== 0)
    errors.push("portfolio_start_manifest_preloaded_result");
  if (value.finalStepState !== "absent") errors.push("portfolio_start_manifest_final_step_state_invalid");
}

function validateFixtureSafety(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_start_manifest_fixture_safety_invalid");
    return;
  }
  const allowed = [
    "sourceKind",
    "debugSetup",
    "saveMutation",
    "preloadedFinalResult",
    "fixtureNamespace",
    "manualTargetSelection",
  ];
  rejectUnknownFields(value, allowed, "portfolio_start_manifest_fixture_safety_unknown_field", errors);
  if (value.sourceKind !== "native_clean_save") errors.push("portfolio_start_manifest_source_kind_invalid");
  if (value.debugSetup !== false || value.saveMutation !== false || value.preloadedFinalResult !== false)
    errors.push("portfolio_start_manifest_fixture_safety_violation");
  if (value.fixtureNamespace !== null) errors.push("portfolio_start_manifest_fixture_namespace_present");
  if (value.manualTargetSelection !== false) errors.push("portfolio_start_manifest_manual_target_selection_present");
}

function validateProducer(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_start_manifest_producer_invalid");
    return;
  }
  const allowed = ["kind", "modUniqueId", "modVersion", "sha256"];
  rejectUnknownFields(value, allowed, "portfolio_start_manifest_producer_unknown_field", errors);
  if (value.kind !== "target_version_native_mod") errors.push("portfolio_start_manifest_producer_kind_invalid");
  if (value.modUniqueId !== "zhexulong.GameBuddy") errors.push("portfolio_start_manifest_producer_identity_invalid");
  if (typeof value.modVersion !== "string" || value.modVersion.length < 1)
    errors.push("portfolio_start_manifest_producer_version_invalid");
  if (!SHA256.test(value.sha256 ?? "")) errors.push("portfolio_start_manifest_producer_hash_invalid");
}

function validateTargetAttestation(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_installation_target_invalid");
    return;
  }
  rejectUnknownFields(
    value,
    ["gameVersion", "gameSha256", "smapiVersion", "smapiSha256", "smapiExeVersion", "smapiExeSha256"],
    "portfolio_installation_target_unknown_field",
    errors,
  );
  if (
    typeof value.gameVersion !== "string" ||
    !SHA256.test(value.gameSha256 ?? "") ||
    typeof value.smapiVersion !== "string" ||
    !SHA256.test(value.smapiSha256 ?? "") ||
    typeof value.smapiExeVersion !== "string" ||
    !SHA256.test(value.smapiExeSha256 ?? "")
  )
    errors.push("portfolio_installation_target_fields_invalid");
}
function validateModAttestation(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_installation_mod_invalid");
    return;
  }
  rejectUnknownFields(
    value,
    ["version", "dllSha256", "manifestSha256", "depsSha256"],
    "portfolio_installation_mod_unknown_field",
    errors,
  );
  if (
    typeof value.version !== "string" ||
    !SHA256.test(value.dllSha256 ?? "") ||
    !SHA256.test(value.manifestSha256 ?? "") ||
    !SHA256.test(value.depsSha256 ?? "")
  )
    errors.push("portfolio_installation_mod_fields_invalid");
}
function validateHostAttestation(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_installation_host_invalid");
    return;
  }
  rejectUnknownFields(value, ["sha256", "buildId"], "portfolio_installation_host_unknown_field", errors);
  if (!SHA256.test(value.sha256 ?? "") || typeof value.buildId !== "string")
    errors.push("portfolio_installation_host_fields_invalid");
}

async function hashAndVersion(filePath, readVersion) {
  const fileName = basename(filePath);
  let handle;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || !(await isRealPath(filePath)))
      return Object.freeze({
        fileName,
        path: filePath,
        exists: false,
        symlink: info.isSymbolicLink(),
        reparse: info.isSymbolicLink() || !(await isRealPath(filePath)),
        sha256: null,
        fileVersion: null,
      });
    const beforePath = fileIdentity(info);
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(beforePath, fileIdentity(opened))) throw new Error("changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !(await isRealPath(filePath)) ||
      !sameFileIdentity(beforePath, fileIdentity(after)) ||
      !sameFileIdentity(beforePath, fileIdentity(afterPath))
    )
      throw new Error("changed");
    const fileVersion = readVersion ? await windowsFileVersion(filePath) : null;
    const finalPath = await lstat(filePath);
    if (
      !sameFileIdentity(beforePath, fileIdentity(finalPath)) ||
      finalPath.isSymbolicLink() ||
      !(await isRealPath(filePath))
    )
      throw new Error("changed");
    return Object.freeze({
      fileName,
      path: filePath,
      exists: true,
      symlink: false,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      fileVersion,
    });
  } catch {
    return Object.freeze({
      fileName,
      path: filePath,
      exists: false,
      symlink: false,
      reparse: false,
      sha256: null,
      fileVersion: null,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function windowsFileVersion(filePath) {
  if (process.platform !== "win32") return null;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$p=$env:GAMEBUDDY_INSPECT_FILE; (Get-Item -LiteralPath $p).VersionInfo.FileVersion"],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_FILE: filePath } },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readJsonIfPresent(filePath, reasons, label) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    reasons.push(`${label}_path_missing_or_not_absolute`);
    return null;
  }
  try {
    const info = await lstat(filePath).catch(() => null);
    if (!info) {
      reasons.push(`${label}_missing_or_invalid_json`);
      return null;
    }
    if (!info.isFile() || info.isSymbolicLink() || !(await isRealPath(filePath))) {
      reasons.push(`${label}_symlink_or_reparse_forbidden`);
      return null;
    }
    const value = await readStableJsonFile(filePath);
    if (value === null) {
      reasons.push(`${label}_unstable_or_invalid_file`);
      return null;
    }
    return value;
  } catch {
    reasons.push(`${label}_missing_or_invalid_json`);
    return null;
  }
}

function resolveP0bContext(options) {
  const profileRoot = options.profileRoot;
  const dataRoot = options.dataRoot;
  const saveRoot = options.saveRoot;
  const saveName = options.saveName;
  return Object.freeze({
    gamePath: options.gamePath,
    profileRoot,
    dataRoot,
    saveRoot,
    saveName,
    observedSaveSlot: options.observedSaveSlot,
    installationAttestationPath: options.installationAttestationPath,
    startManifestPath: options.startManifestPath,
    signingKey: options.signingKey,
    hostArtifactPath: options.hostArtifactPath,
    nativeScope: options.nativeScope,
  });
}

async function inspectDataRoot(context) {
  const reasons = [];
  const dataRoot = context.dataRoot;
  if (typeof dataRoot !== "string" || !isAbsolute(dataRoot)) {
    reasons.push("portfolio_data_root_not_absolute");
    return Object.freeze({ state: "blocked", reasons: Object.freeze(reasons) });
  }
  const canonicalDataRoot = await realpath(dataRoot).catch(() => null);
  const info = await lstat(dataRoot).catch(() => null);
  if (!info) reasons.push("portfolio_data_root_missing");
  else if (info.isSymbolicLink()) reasons.push("portfolio_data_root_symlink_or_reparse_forbidden");
  else if (!info.isDirectory()) reasons.push("portfolio_data_root_not_directory");
  if (info && (!canonicalDataRoot || !samePath(canonicalDataRoot, dataRoot)))
    reasons.push("portfolio_data_root_symlink_or_reparse_forbidden");
  const roots = [
    ["game", context.gamePath],
    ["profile", context.profileRoot],
    ["save", context.saveRoot],
  ];
  for (const [name, root] of roots) {
    if (typeof root !== "string" || !isAbsolute(root)) continue;
    const canonicalRoot = await realpath(root).catch(() => null);
    if (canonicalRoot && canonicalDataRoot && sharesRoot(canonicalDataRoot, canonicalRoot))
      reasons.push(`portfolio_data_root_${name}_root_overlap`);
    else if (canonicalRoot === null && sharesRoot(dataRoot, root))
      reasons.push(`portfolio_data_root_${name}_root_overlap`);
  }
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    path: dataRoot,
  });
}

function isPathWithin(candidate, root) {
  if (typeof candidate !== "string" || typeof root !== "string" || !isAbsolute(candidate) || !isAbsolute(root))
    return false;
  const suffix = relative(resolve(root), resolve(candidate));
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\"))
  );
}

function samePath(first, second) {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sharesRoot(first, second) {
  if (typeof first !== "string" || typeof second !== "string" || !isAbsolute(first) || !isAbsolute(second))
    return false;
  const left = process.platform === "win32" ? resolve(first).toLowerCase() : resolve(first);
  const right = process.platform === "win32" ? resolve(second).toLowerCase() : resolve(second);
  return (
    left === right ||
    relative(left, right) === "" ||
    relative(left, right) === ".." ||
    relative(left, right).startsWith("../") ||
    relative(left, right).startsWith("..\\") ||
    relative(right, left) === "" ||
    relative(right, left) === ".." ||
    relative(right, left).startsWith("../") ||
    relative(right, left).startsWith("..\\")
  );
}

function isValidSaveName(value) {
  return typeof value === "string" && /^GameBuddyPortfolio[A-Za-z0-9_-]{0,108}$/.test(value) && !value.endsWith("_");
}
function isValidObservedSaveSlot(value, logicalSaveName) {
  return (
    typeof value === "string" &&
    typeof logicalSaveName === "string" &&
    isValidSaveName(logicalSaveName) &&
    new RegExp(`^${escapeRegExp(logicalSaveName)}_[1-9][0-9]*$`).test(value)
  );
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rejectUnknownFields(value, allowed, reason, errors) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push(reason);
}
function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
}
function sameFileIdentity(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs
  );
}
async function isRealPath(filePath) {
  const canonical = await realpath(filePath).catch(() => null);
  return canonical !== null && resolve(canonical) === resolve(filePath);
}
async function readStableFile(filePath) {
  let handle;
  try {
    const beforePath = await lstat(filePath);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || !(await isRealPath(filePath))) return null;
    const identity = fileIdentity(beforePath);
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (!sameFileIdentity(identity, fileIdentity(opened))) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      !sameFileIdentity(identity, fileIdentity(after)) ||
      !sameFileIdentity(identity, fileIdentity(afterPath)) ||
      afterPath.isSymbolicLink() ||
      !(await isRealPath(filePath))
    )
      return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
async function readStableJsonFile(filePath) {
  let handle;
  try {
    const beforePath = await lstat(filePath);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || !(await isRealPath(filePath))) return null;
    const identity = fileIdentity(beforePath);
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (!sameFileIdentity(identity, fileIdentity(opened))) return null;
    const text = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      !sameFileIdentity(identity, fileIdentity(after)) ||
      !sameFileIdentity(identity, fileIdentity(afterPath)) ||
      afterPath.isSymbolicLink() ||
      !(await isRealPath(filePath))
    )
      return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
function fileKey(fileName) {
  return fileName === "GameBuddy.Stardew.dll"
    ? "dllSha256"
    : fileName === "manifest.json"
      ? "manifestSha256"
      : "depsSha256";
}
function normalizeSmapiVersion(value) {
  const match = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(value ?? "");
  return match?.[1] ?? value;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function inspectSaveRootDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(await isRealPath(path)))
      return Object.freeze({
        state: "blocked",
        reasons: Object.freeze(["portfolio_save_root_symlink_or_reparse_forbidden"]),
      });
    if (!info.isDirectory())
      return Object.freeze({ state: "blocked", reasons: Object.freeze(["portfolio_save_root_not_directory"]) });
    return Object.freeze({ state: "ready", reasons: Object.freeze([]) });
  } catch {
    return Object.freeze({ state: "blocked", reasons: Object.freeze(["portfolio_save_root_missing"]) });
  }
}
function inspectSaveDirectory(path) {
  // `portfolio_save_directory_missing` is the public fail-closed blocker for
  // an absent observed native slot.
  return inspectDirectory(path, "portfolio_save_directory");
}
async function inspectDirectory(path, reasonPrefix) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(await isRealPath(path)))
      return Object.freeze({
        state: "blocked",
        reasons: Object.freeze([`${reasonPrefix}_symlink_or_reparse_forbidden`]),
      });
    if (!info.isDirectory())
      return Object.freeze({ state: "blocked", reasons: Object.freeze([`${reasonPrefix}_not_directory`]) });
    return Object.freeze({ state: "ready", reasons: Object.freeze([]) });
  } catch {
    return Object.freeze({ state: "blocked", reasons: Object.freeze([`${reasonPrefix}_missing`]) });
  }
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
