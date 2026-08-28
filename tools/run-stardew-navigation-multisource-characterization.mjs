import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFixtureManifest } from './run-stardew-navigation-p4-runtime-probe.mjs';
import { validateMultiSourceTransitionCharacterization } from './stardew-navigation-multisource-characterization-validator.mjs';

const ARM_KEYS = Object.freeze([
  'schemaVersion', 'nonce', 'transactionPath', 'observationPath', 'deadlineUnixMs',
  'productionSha256', 'productionMvid', 'integrityMac',
]);
const ENVELOPE_KEYS = Object.freeze(['nonce', 'observation', 'integrityMac']);
const RAW_OBSERVATION_KEYS = Object.freeze([
  'schemaVersion', 'terminalStatus', 'targetBuild', 'observationScope', 'predicateCode',
  'productionSha256', 'productionMvid', 'productionExtractorInvoked',
  'productionExtractorInvocationCount', 'gameThreadObserved', 'worldReadyObserved',
  'multiSourceObserved', 'ordinaryWarpFamilyObserved', 'correlationApiShapeVerified',
  'gameplayMutationCount', 'playerWarpEventCount', 'executionReceiptCount',
  'bridgeOrCatalogPublicationCount',
]);
const LOWER_HEX_48 = /^[0-9a-f]{48}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_GUID_D = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOADER_ID = 'zhexulong.GameBuddy.NavigationP4Loader';
const PROBE_ID = 'zhexulong.GameBuddy.NavigationTopologyCharacterization';
const LOADER_PROFILE = Object.freeze(['manifest.json', 'StardewNavigationP4Loader.dll', 'fixture-load.json']);
const LOADER_SOURCE = Object.freeze(['manifest.json', 'StardewNavigationP4Loader.dll']);
const PRODUCTION_FILES = Object.freeze(['GameBuddy.Stardew.dll', 'GameBuddy.Stardew.Core.dll', 'Raffinert.FuzzySharp.dll']);
const PROBE_PROFILE = Object.freeze([
  'manifest.json', 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll', ...PRODUCTION_FILES, 'arm.json',
]);
const PROBE_SOURCE = Object.freeze(PROBE_PROFILE.filter((name) => name !== 'arm.json'));
const LAUNCH_ENVIRONMENT_KEYS = Object.freeze([
  'APPDATA', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec',
]);

function fail(reason) { throw new Error(`multisource_${reason}`); }
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function requireExactKeys(value, expectedKeys, name) {
  if (!isPlainRecord(value)) fail(`${name}_must_be_plain_record`);
  const actual = Object.keys(value).sort(), expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name}_keys_invalid`);
}
function requireNonemptyString(value, name) { if (typeof value !== 'string' || !value.length) fail(`${name}_invalid`); }
function requireLowerHex(value, expression, name) { if (typeof value !== 'string' || !expression.test(value)) fail(`${name}_invalid`); }
function requireSafeFutureDeadline(deadlineUnixMs, now) {
  if (!Number.isSafeInteger(deadlineUnixMs) || !Number.isSafeInteger(now) || deadlineUnixMs <= now) fail('deadline_invalid');
}
function requireAbsolutePath(value, name) { requireNonemptyString(value, name); if (!isAbsolute(value)) fail(`${name}_must_be_absolute`); }
function requireEqual(actual, expected, name) { if (actual !== expected) fail(`${name}_mismatch`); }
function requireDirectObservationChild(transactionPath, observationPath) {
  const transaction = resolve(transactionPath), observation = resolve(observationPath), expected = resolve(transaction, 'observation.json');
  if (observationPath !== observation || observation !== expected || relative(transaction, observation) !== 'observation.json') fail('observation_path_not_direct_child');
}

/** Returns the lowercase hexadecimal HMAC-SHA256 for a canonical protocol string. */
export function createMultiSourceHmac(key, canonicalValue) {
  if (typeof canonicalValue !== 'string') fail('canonical_value_invalid');
  try { return createHmac('sha256', key).update(canonicalValue, 'utf8').digest('hex'); } catch { fail('hmac_key_invalid'); }
}
function requireAuthenticatedMac(receivedMac, key, canonicalValue) {
  requireLowerHex(receivedMac, LOWER_HEX_64, 'integrity_mac');
  const expected = createMultiSourceHmac(key, canonicalValue);
  if (!timingSafeEqual(Buffer.from(receivedMac), Buffer.from(expected))) fail('integrity_mac_mismatch');
}
function requireArmForObservation(arm, now) {
  requireExactKeys(arm, ARM_KEYS.slice(0, -1), 'arm');
  if (arm.schemaVersion !== 1) fail('arm_schema_version_invalid');
  requireLowerHex(arm.nonce, LOWER_HEX_48, 'arm_nonce');
  requireAbsolutePath(arm.transactionPath, 'arm_transaction_path');
  requireAbsolutePath(arm.observationPath, 'arm_observation_path');
  requireSafeFutureDeadline(arm.deadlineUnixMs, now);
  requireLowerHex(arm.productionSha256, LOWER_HEX_64, 'arm_production_sha256');
  if (typeof arm.productionMvid !== 'string' || !LOWER_GUID_D.test(arm.productionMvid)) fail('arm_production_mvid_invalid');
  requireDirectObservationChild(arm.transactionPath, arm.observationPath);
}

export function validateMultiSourceArm(arm, key, expectations) {
  requireExactKeys(expectations, ['now', 'expectedTransactionPath', 'expectedObservationPath', 'expectedProductionSha256', 'expectedProductionMvid'], 'expectations');
  requireExactKeys(arm, ARM_KEYS, 'arm');
  if (arm.schemaVersion !== 1) fail('arm_schema_version_invalid');
  requireLowerHex(arm.nonce, LOWER_HEX_48, 'arm_nonce');
  requireAbsolutePath(arm.transactionPath, 'arm_transaction_path');
  requireAbsolutePath(arm.observationPath, 'arm_observation_path');
  requireSafeFutureDeadline(arm.deadlineUnixMs, expectations.now);
  requireLowerHex(arm.productionSha256, LOWER_HEX_64, 'arm_production_sha256');
  if (typeof arm.productionMvid !== 'string' || !LOWER_GUID_D.test(arm.productionMvid)) fail('arm_production_mvid_invalid');
  requireAbsolutePath(expectations.expectedTransactionPath, 'expected_transaction_path');
  requireAbsolutePath(expectations.expectedObservationPath, 'expected_observation_path');
  requireLowerHex(expectations.expectedProductionSha256, LOWER_HEX_64, 'expected_production_sha256');
  if (typeof expectations.expectedProductionMvid !== 'string' || !LOWER_GUID_D.test(expectations.expectedProductionMvid)) fail('expected_production_mvid_invalid');
  requireEqual(arm.transactionPath, expectations.expectedTransactionPath, 'transaction_path');
  requireEqual(arm.observationPath, expectations.expectedObservationPath, 'observation_path');
  requireEqual(arm.productionSha256, expectations.expectedProductionSha256, 'production_sha256');
  requireEqual(arm.productionMvid, expectations.expectedProductionMvid, 'production_mvid');
  requireDirectObservationChild(arm.transactionPath, arm.observationPath);
  requireAuthenticatedMac(arm.integrityMac, key, `arm|${arm.nonce}|${arm.transactionPath}|${arm.observationPath}|${arm.deadlineUnixMs}|${arm.productionSha256}|${arm.productionMvid}`);
  return Object.freeze({ schemaVersion: arm.schemaVersion, nonce: arm.nonce, transactionPath: arm.transactionPath, observationPath: arm.observationPath, deadlineUnixMs: arm.deadlineUnixMs, productionSha256: arm.productionSha256, productionMvid: arm.productionMvid });
}

export function validateMultiSourceRawObservation(envelope, key, arm, { now }) {
  requireExactKeys(envelope, ENVELOPE_KEYS, 'observation_envelope');
  requireArmForObservation(arm, now);
  requireEqual(envelope.nonce, arm.nonce, 'observation_nonce');
  requireNonemptyString(envelope.observation, 'observation');
  requireAuthenticatedMac(envelope.integrityMac, key, `observation|${envelope.nonce}|${arm.transactionPath}|${arm.observationPath}|${envelope.observation}`);
  let raw;
  try { raw = JSON.parse(envelope.observation); } catch { fail('observation_json_invalid'); }
  requireExactKeys(raw, RAW_OBSERVATION_KEYS, 'raw_observation');
  if (raw.schemaVersion !== 1) fail('raw_observation_schema_version_invalid');
  if (raw.terminalStatus !== 'passed' && raw.terminalStatus !== 'blocked') fail('raw_observation_terminal_status_invalid');
  for (const field of ['targetBuild', 'observationScope', 'predicateCode']) requireNonemptyString(raw[field], `raw_observation_${field}`);
  requireEqual(raw.productionSha256, arm.productionSha256, 'raw_observation_production_sha256');
  requireEqual(raw.productionMvid, arm.productionMvid, 'raw_observation_production_mvid');
  for (const field of ['productionExtractorInvoked', 'gameThreadObserved', 'worldReadyObserved', 'multiSourceObserved', 'ordinaryWarpFamilyObserved', 'correlationApiShapeVerified']) if (typeof raw[field] !== 'boolean') fail(`raw_observation_${field}_invalid`);
  for (const field of ['productionExtractorInvocationCount', 'gameplayMutationCount', 'playerWarpEventCount', 'executionReceiptCount', 'bridgeOrCatalogPublicationCount']) if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) fail(`raw_observation_${field}_invalid`);
  return Object.freeze({ ...raw });
}

function requiredPath(value, error) { if (typeof value !== 'string' || !value.length || !isAbsolute(value)) fail(error); return resolve(value); }
export function validateMultiSourceRunEnvironment(env = process.env) {
  return Object.freeze({
    gamePath: requiredPath(env.GAMEBUDDY_STARDEW_GAME_PATH, 'game_path_missing_or_relative'),
    productionBuildPath: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_PRODUCTION_BUILD_PATH, 'production_build_path_missing_or_relative'),
    probeBuildPath: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_PROBE_BUILD_PATH, 'probe_build_path_missing_or_relative'),
    loaderBuildPath: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_LOADER_BUILD_PATH, 'loader_build_path_missing_or_relative'),
    fixtureRoot: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_FIXTURE_ROOT, 'fixture_root_missing_or_relative'),
    saveRoot: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_SAVE_ROOT, 'save_root_missing_or_relative'),
    artifactPath: requiredPath(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH, 'artifact_path_missing_or_relative'),
  });
}
export function assertMultiSourceProfile(entries) { return assertExactDirectory(entries, ['GameBuddy.NavigationP4Loader', 'GameBuddy.NavigationTopologyCharacterization'], 'profile'); }
export function assertExactDirectory(entries, expected, name = 'directory') {
  if (!Array.isArray(entries) || entries.length !== expected.length || entries.some((entry) => !expected.includes(entry))) fail(`${name}_not_exact`);
  return true;
}
export function assertExactSmapiLaunch(executable, args, gamePath, profileRoot) {
  if (resolve(executable) !== join(resolve(gamePath), 'StardewModdingAPI.exe') || !Array.isArray(args) || args.length !== 2 || args[0] !== '--mods-path' || resolve(args[1]) !== resolve(profileRoot)) fail('smapi_identity_or_mods_path_invalid');
  return true;
}
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const absent = async (path, io) => {
  try { await io.lstat(path); return false; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
};
async function assertRegular(path, io, error) {
  let meta;
  try { meta = await io.lstat(path); } catch { fail(error); }
  if (meta.isSymbolicLink() || !meta.isFile()) fail(error);
  return meta;
}
async function assertDirectory(path, io, error) {
  const meta = await io.lstat(path);
  if (meta.isSymbolicLink() || !meta.isDirectory()) fail(error);
}
async function assertSourceClosure(root, names, io, label) {
  await assertDirectory(root, io, `${label}_source_not_directory_or_link`);
  for (const name of names) await assertRegular(join(root, name), io, `${label}_source_member_not_regular`);
}
async function copyVerified(source, destination, io, label) {
  await assertRegular(source, io, `${label}_source_member_not_regular`);
  const bytes = await io.readFile(source);
  await io.writeFile(destination, bytes, { flag: 'wx' });
  await assertRegular(destination, io, `${label}_staged_member_not_regular`);
  if (hashBytes(await io.readFile(destination)) !== hashBytes(bytes)) fail(`${label}_staged_member_hash_mismatch`);
}
async function verifyStagedFiles(sourceRoot, stageRoot, names, io, label) {
  for (const name of names) {
    await assertRegular(join(stageRoot, name), io, `${label}_staged_member_not_regular`);
    if (hashBytes(await io.readFile(join(sourceRoot, name))) !== hashBytes(await io.readFile(join(stageRoot, name))))
      fail(`${label}_staged_member_hash_mismatch`);
  }
}
async function verifyFixtureCopy(root, fixture, io, error) {
  await assertDirectory(root, io, `${error}_not_directory_or_link`);
  const expected = [...fixture.files.keys()].map((path) => path.slice(fixture.saveDirectoryName.length + 1)).sort();
  const actual = await listRegularTree(root, io, error);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${error}_entries_mismatch`);
  for (const [path, digest] of fixture.files) {
    const bytes = await io.readFile(join(root, path.slice(fixture.saveDirectoryName.length + 1)));
    if (hashBytes(bytes) !== digest) fail(`${error}_hash_mismatch`);
  }
}
async function listRegularTree(root, io, error, prefix = '') {
  const files = [];
  for (const name of (await io.readdir(root)).sort()) {
    const path = join(root, name), meta = await io.lstat(path);
    if (meta.isSymbolicLink()) fail(`${error}_link_or_reparse_forbidden`);
    if (meta.isDirectory()) files.push(...(await listRegularTree(path, io, error, `${prefix}${name}/`)));
    else if (meta.isFile()) files.push(`${prefix}${name}`);
    else fail(`${error}_entry_not_regular`);
  }
  return files;
}
function defaultListProcesses() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Get-Process StardewValley,StardewModdingAPI -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', () => resolvePromise(output.trim() ? output.trim().split(/\s+/) : []));
  });
}
function inside(root, path) { const value = relative(resolve(root), resolve(path)); return !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value); }
function randomHex(random, bytes, expression, name) { const value = random(bytes)?.toString('hex'); requireLowerHex(value, expression, name); return value; }
function buildLaunchEnvironment(sourceEnv, transactionKey) {
  const environment = {};
  for (const name of LAUNCH_ENVIRONMENT_KEYS) {
    if (typeof sourceEnv[name] === 'string' && sourceEnv[name].length) environment[name] = sourceEnv[name];
  }
  // The existing loader and this probe deliberately receive the same one-time
  // key under their respective typed ingress names; no parent GAMEBUDDY_* value
  // is inherited into the isolated launch environment.
  environment.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY = transactionKey;
  environment.GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY = transactionKey;
  return Object.freeze(environment);
}

export async function runNavigationMultiSourceCharacterization(options = {}) {
  const sourceEnv = options.env ?? process.env;
  const input = validateMultiSourceRunEnvironment(sourceEnv);
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 300_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10_000 || deadlineMs > 900_000) fail('deadline_invalid');
  if (typeof options.verifyStaticContract !== 'function') fail('static_contract_verifier_not_admitted');
  requireLowerHex(options.productionSha256, LOWER_HEX_64, 'production_sha256');
  const productionDll = join(input.productionBuildPath, 'GameBuddy.Stardew.dll');
  const probeDll = join(input.probeBuildPath, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll');
  const staticContract = Object.freeze({ productionDllPath: productionDll, probeDllPath: probeDll, productionSha256: options.productionSha256 });
  if ((await options.verifyStaticContract(staticContract)) !== true) fail('static_contract_invalid');
  // Both capabilities are deliberately admitted before any filesystem or process operation after static admission.
  if (typeof options.launch !== 'function') fail('launcher_not_admitted');
  if (typeof options.readMvid !== 'function') fail('mvid_reader_not_admitted');
  const io = options.io ?? { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile };
  if (!(await absent(input.artifactPath, io))) fail('artifact_already_exists');
  const random = options.randomBytes ?? nodeRandomBytes;
  if (typeof now !== 'function' || typeof random !== 'function') fail('injected_seam_invalid');
  await assertSourceClosure(input.loaderBuildPath, LOADER_SOURCE, io, 'loader');
  await assertSourceClosure(input.probeBuildPath, PROBE_SOURCE, io, 'probe');
  await assertSourceClosure(input.productionBuildPath, PRODUCTION_FILES, io, 'production');
  for (const name of PRODUCTION_FILES) {
    if (hashBytes(await io.readFile(join(input.probeBuildPath, name))) !== hashBytes(await io.readFile(join(input.productionBuildPath, name)))) fail('probe_production_bytes_mismatch');
  }
  const productionSha256 = hashBytes(await io.readFile(productionDll));
  if (productionSha256 !== options.productionSha256) fail('production_sha256_mismatch');
  const productionMvid = await options.readMvid(productionDll);
  if (typeof productionMvid !== 'string' || !LOWER_GUID_D.test(productionMvid)) fail('production_mvid_invalid');
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  if (typeof listProcesses !== 'function') fail('process_lister_invalid');
  if ((await listProcesses()).length) fail('existing_stardew_or_smapi_process');
  const fixture = await readFixtureManifest(input.fixtureRoot, io);
  const fixtureManifestHash = hashBytes(await io.readFile(join(input.fixtureRoot, 'fixture-manifest.json')));
  if (resolve(input.saveRoot) !== join(resolve(sourceEnv.APPDATA ?? ''), 'StardewValley', 'Saves')) fail('save_root_is_not_current_windows_appdata_saves');
  const tx = await io.mkdtemp(join(options.tempRoot ?? tmpdir(), 'gamebuddy-navigation-multisource-'));
  const profile = join(tx, 'Mods'), observationPath = join(tx, 'observation.json');
  const workingSavePath = join(input.saveRoot, fixture.saveDirectoryName);
  const stageNonce = randomHex(random, 24, LOWER_HEX_48, 'stage_nonce');
  const stagingSavePath = join(input.saveRoot, `.${fixture.saveDirectoryName}.multisource-stage-${stageNonce}`);
  const stagingOwnerPath = `${stagingSavePath}.owner`, stagingOwner = randomHex(random, 24, LOWER_HEX_48, 'stage_owner');
  let workingOwned = false, stagingOwned = false, stagingOwnerOwned = false, primaryError, integrityError, cleanupError, raw;
  try {
    if (!(await absent(workingSavePath, io))) fail('transaction_save_slot_already_exists');
    await io.mkdir(input.saveRoot, { recursive: true });
    await io.writeFile(stagingOwnerPath, stagingOwner, { encoding: 'utf8', flag: 'wx' });
    stagingOwnerOwned = true;
    await io.mkdir(stagingSavePath);
    stagingOwned = true;
    for (const [fixturePath] of fixture.files) {
      const relativePath = fixturePath.slice(fixture.saveDirectoryName.length + 1);
      // The supported loader fixture convention is flat, so this transaction never recursively copies arbitrary trees.
      if (relativePath.includes('/')) fail('fixture_shape_not_supported_by_loader');
      await copyVerified(join(fixture.saveRoot, relativePath), join(stagingSavePath, relativePath), io, 'fixture');
    }
    if ((await io.readFile(stagingOwnerPath, 'utf8')) !== stagingOwner) fail('stage_ownership_unproven');
    await assertRegular(stagingOwnerPath, io, 'stage_owner_not_regular');
    await verifyFixtureCopy(stagingSavePath, fixture, io, 'staging_save');
    await io.rename(stagingSavePath, workingSavePath);
    workingOwned = true;
    stagingOwned = false;
    try {
      await io.rm(stagingOwnerPath, { force: false });
      stagingOwnerOwned = false;
    } catch (error) {
      cleanupError ??= error;
      throw error;
    }
    await verifyFixtureCopy(workingSavePath, fixture, io, 'working_save');

    const loaderProfile = join(profile, 'GameBuddy.NavigationP4Loader');
    const probeProfile = join(profile, 'GameBuddy.NavigationTopologyCharacterization');
    await io.mkdir(loaderProfile, { recursive: true }); await io.mkdir(probeProfile);
    for (const name of LOADER_SOURCE) await copyVerified(join(input.loaderBuildPath, name), join(loaderProfile, name), io, 'loader');
    for (const name of PROBE_SOURCE) await copyVerified(join(input.probeBuildPath, name), join(probeProfile, name), io, 'probe');
    if (JSON.parse(await io.readFile(join(loaderProfile, 'manifest.json'), 'utf8'))?.UniqueID !== LOADER_ID) fail('loader_manifest_invalid');
    if (JSON.parse(await io.readFile(join(probeProfile, 'manifest.json'), 'utf8'))?.UniqueID !== PROBE_ID) fail('probe_manifest_invalid');
    const key = randomHex(random, 32, LOWER_HEX_64, 'transaction_key'), nonce = randomHex(random, 24, LOWER_HEX_48, 'nonce');
    const deadlineUnixMs = now() + deadlineMs;
    if (!Number.isSafeInteger(deadlineUnixMs)) fail('deadline_invalid');
    const arm = { schemaVersion: 1, nonce, transactionPath: tx, observationPath, deadlineUnixMs, productionSha256, productionMvid };
    arm.integrityMac = createMultiSourceHmac(key, `arm|${nonce}|${tx}|${observationPath}|${deadlineUnixMs}|${productionSha256}|${productionMvid}`);
    await io.writeFile(join(probeProfile, 'arm.json'), JSON.stringify(arm), { encoding: 'utf8', flag: 'wx' });
    const files = [...fixture.files].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    if (files.length !== 2 || files.some((file) => file.path.slice(fixture.saveDirectoryName.length + 1).includes('/'))) fail('fixture_shape_not_supported_by_loader');
    const loadCanonical = `load|${fixture.saveDirectoryName}|${deadlineUnixMs}|${files.map((file) => `${file.path}:${file.sha256}`).join('|')}`;
    await io.writeFile(join(loaderProfile, 'fixture-load.json'), JSON.stringify({ observedSaveSlot: fixture.saveDirectoryName, deadlineUnixMs, files, integrityMac: createMultiSourceHmac(key, loadCanonical) }), { encoding: 'utf8', flag: 'wx' });
    assertMultiSourceProfile(await io.readdir(profile));
    assertExactDirectory(await io.readdir(loaderProfile), LOADER_PROFILE, 'loader_profile');
    assertExactDirectory(await io.readdir(probeProfile), PROBE_PROFILE, 'probe_profile');
    await verifyStagedFiles(input.loaderBuildPath, loaderProfile, LOADER_SOURCE, io, 'loader');
    await verifyStagedFiles(input.probeBuildPath, probeProfile, PROBE_SOURCE, io, 'probe');
    assertExactSmapiLaunch(join(input.gamePath, 'StardewModdingAPI.exe'), ['--mods-path', profile], input.gamePath, profile);
    await options.launch(Object.freeze({ executable: join(input.gamePath, 'StardewModdingAPI.exe'), args: Object.freeze(['--mods-path', profile]), profileRoot: profile, env: buildLaunchEnvironment(sourceEnv, key), observedSaveSlot: fixture.saveDirectoryName, observationPath, deadlineUnixMs, transactionPath: tx }));
    assertMultiSourceProfile(await io.readdir(profile));
    assertExactDirectory(await io.readdir(loaderProfile), LOADER_PROFILE, 'loader_profile');
    assertExactDirectory(await io.readdir(probeProfile), PROBE_PROFILE, 'probe_profile');
    await verifyStagedFiles(input.loaderBuildPath, loaderProfile, LOADER_SOURCE, io, 'loader');
    await verifyStagedFiles(input.probeBuildPath, probeProfile, PROBE_SOURCE, io, 'probe');
    assertExactDirectory(await io.readdir(tx), ['Mods', 'observation.json'], 'transaction_children');
    await assertRegular(observationPath, io, 'observation_not_regular');
    const envelope = JSON.parse(await io.readFile(observationPath, 'utf8'));
    if (now() >= deadlineUnixMs) fail('terminal_after_deadline');
    const validatedArm = validateMultiSourceArm(arm, key, { now: now(), expectedTransactionPath: tx, expectedObservationPath: observationPath, expectedProductionSha256: productionSha256, expectedProductionMvid: productionMvid });
    raw = validateMultiSourceRawObservation(envelope, key, validatedArm, { now: now() });
  } catch (error) { primaryError = error; } finally {
    try {
      await readFixtureManifest(input.fixtureRoot, io);
      if (hashBytes(await io.readFile(join(input.fixtureRoot, 'fixture-manifest.json'))) !== fixtureManifestHash)
        fail('fixture_manifest_changed');
    } catch (error) { integrityError = error; }
    // A residual target may still be reading the working save and staged profile.
    // Preserve both until a separate, process-safe recovery can prove it exited.
    let targetProcessResidual = false;
    try {
      if ((await listProcesses()).length) {
        targetProcessResidual = true;
        fail('stardew_process_still_running');
      }
    } catch (error) {
      // An unreadable process table cannot prove the staged files are no longer in use.
      targetProcessResidual = true;
      cleanupError ??= error;
    }
    if (!targetProcessResidual) {
      if (workingOwned) try { await verifyFixtureCopy(workingSavePath, fixture, io, 'working_save'); await io.rm(workingSavePath, { recursive: true, force: false }); } catch (error) { cleanupError ??= error; }
      if (stagingOwned) try {
        await assertRegular(stagingOwnerPath, io, 'stage_owner_not_regular');
        if ((await io.readFile(stagingOwnerPath, 'utf8')) !== stagingOwner) fail('stage_ownership_unproven');
        await verifyFixtureCopy(stagingSavePath, fixture, io, 'staging_save');
        await io.rm(stagingSavePath, { recursive: true, force: false });
        stagingOwned = false;
      } catch (error) { cleanupError ??= error; }
      if (stagingOwnerOwned) try {
        await assertRegular(stagingOwnerPath, io, 'stage_owner_not_regular');
        if ((await io.readFile(stagingOwnerPath, 'utf8')) !== stagingOwner) fail('stage_ownership_unproven');
        await io.rm(stagingOwnerPath, { force: false });
        stagingOwnerOwned = false;
      } catch (error) { cleanupError ??= error; }
      if (!cleanupError) try { await io.rm(tx, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); } catch (error) { cleanupError ??= error; }
    }
  }
  const errors = [primaryError, integrityError, cleanupError].filter(Boolean);
  if (cleanupError) throw new AggregateError(errors, `multisource_cleanup_incomplete:${errors.map((error) => error.message).join(';')}`);
  if (errors.length > 1) throw new AggregateError(errors, `multisource_failed:${errors.map((error) => error.message).join(';')}`);
  if (errors.length) throw errors[0];
  if (inside(tx, input.artifactPath)) fail('artifact_must_not_be_inside_transaction');
  if (!(await absent(input.artifactPath, io))) fail('artifact_already_exists');
  const { productionSha256: _sha, productionMvid: _mvid, ...publicObservation } = raw;
  const artifact = Object.freeze({ ...publicObservation, fixtureCleanup: Object.freeze({ restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true }) });
  const validation = validateMultiSourceTransitionCharacterization(artifact);
  if (!validation.valid) fail(`artifact_invalid:${validation.errors.join(',')}`);
  await io.writeFile(input.artifactPath, JSON.stringify(artifact), { encoding: 'utf8', flag: 'wx' });
  return Object.freeze({ artifact, validation });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runNavigationMultiSourceCharacterization()));
