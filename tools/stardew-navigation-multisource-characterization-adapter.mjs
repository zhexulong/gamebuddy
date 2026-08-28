import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_GUID_D = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_MVID_OUTPUT = new RegExp(`^(${LOWER_GUID_D})\\r?\\n$`);
const PRODUCTION_DLL = 'GameBuddy.Stardew.dll';
const PROBE_DLL = 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll';
const SMAPI_EXECUTABLE = 'StardewModdingAPI.exe';
const STATIC_CONTRACT_SUCCESS = /^NavigationTopologyCharacterization\.Contract passed\.\r?\n$/;
const LAUNCH_ENVIRONMENT_KEYS = Object.freeze([
  'APPDATA', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec',
  'GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY',
  'GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY',
]);

function fail(reason) { throw new Error(`multisource_adapter_${reason}`); }
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function requireExactKeys(value, keys, name) {
  if (!isRecord(value)) fail(`${name}_must_be_record`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name}_keys_invalid`);
}
function requireAbsoluteCanonicalPath(value, name) {
  if (typeof value !== 'string' || !value.length || !isAbsolute(value) || value !== resolve(value) || normalize(value) !== value) fail(`${name}_must_be_canonical_absolute`);
  return value;
}
function requireLowerHex(value, name) { if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) fail(`${name}_invalid`); }
function requireDirectNamedChild(path, root, name, label) {
  requireAbsoluteCanonicalPath(path, `${label}_path`);
  requireAbsoluteCanonicalPath(root, `${label}_root`);
  if (parse(path).base !== name || resolve(root, name) !== path || relative(root, path) !== name) fail(`${label}_not_direct_expected_child`);
}
async function requireRegularNonLink(path, io, name) {
  let stat;
  try { stat = await io.lstat(path); } catch { fail(`${name}_not_regular`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name}_not_regular`);
}
async function requireDirectoryNonLink(path, io, name) {
  let stat;
  try { stat = await io.lstat(path); } catch { fail(`${name}_not_directory`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name}_not_directory`);
}
function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '', stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
function spawnExact(spawnProcess, executable, args, options) {
  let child;
  try { child = spawnProcess(executable, args, options); } catch { fail('spawn_failed'); }
  if (!child || typeof child.once !== 'function') fail('spawn_invalid_child');
  return waitForExit(child);
}
function validateStaticDescriptor(descriptor) {
  requireExactKeys(descriptor, ['productionDllPath', 'probeDllPath', 'productionSha256'], 'static_descriptor');
  requireLowerHex(descriptor.productionSha256, 'production_sha256');
  const productionRoot = parse(requireAbsoluteCanonicalPath(descriptor.productionDllPath, 'production_dll')).dir;
  const probeRoot = parse(requireAbsoluteCanonicalPath(descriptor.probeDllPath, 'probe_dll')).dir;
  requireDirectNamedChild(descriptor.productionDllPath, productionRoot, PRODUCTION_DLL, 'production_dll');
  requireDirectNamedChild(descriptor.probeDllPath, probeRoot, PROBE_DLL, 'probe_dll');
  return Object.freeze({ productionDllPath: descriptor.productionDllPath, probeDllPath: descriptor.probeDllPath, productionSha256: descriptor.productionSha256 });
}
function validateLaunchEnvironment(env) {
  if (!isRecord(env)) fail('launch_env_must_be_record');
  const keys = Object.keys(env).sort();
  if (keys.some((key) => !LAUNCH_ENVIRONMENT_KEYS.includes(key))) fail('launch_env_unexpected_key');
  for (const [key, value] of Object.entries(env)) if (typeof value !== 'string' || !value.length) fail(`launch_env_${key}_invalid`);
  const p4 = env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
  const multisource = env.GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY;
  requireLowerHex(p4, 'p4_transaction_key');
  requireLowerHex(multisource, 'multisource_transaction_key');
  if (p4 !== multisource) fail('transaction_keys_mismatch');
  return env;
}
function validateLaunchDescriptor(descriptor, gameRoot) {
  requireExactKeys(descriptor, ['executable', 'args', 'profileRoot', 'env', 'observedSaveSlot', 'observationPath', 'deadlineUnixMs', 'transactionPath'], 'launch_descriptor');
  const executable = requireAbsoluteCanonicalPath(descriptor.executable, 'launch_executable');
  const profileRoot = requireAbsoluteCanonicalPath(descriptor.profileRoot, 'profile_root');
  const transactionPath = requireAbsoluteCanonicalPath(descriptor.transactionPath, 'transaction_path');
  const observationPath = requireAbsoluteCanonicalPath(descriptor.observationPath, 'observation_path');
  if (executable !== join(gameRoot, SMAPI_EXECUTABLE)) fail('launch_executable_not_exact_smapi');
  if (!Array.isArray(descriptor.args) || descriptor.args.length !== 2 || descriptor.args[0] !== '--mods-path' || descriptor.args[1] !== profileRoot) fail('launch_args_not_exact');
  if (resolve(transactionPath, 'observation.json') !== observationPath || relative(transactionPath, observationPath) !== 'observation.json') fail('observation_path_not_direct_child');
  if (typeof descriptor.observedSaveSlot !== 'string' || !/^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/.test(descriptor.observedSaveSlot)) fail('observed_save_slot_invalid');
  if (!Number.isSafeInteger(descriptor.deadlineUnixMs) || descriptor.deadlineUnixMs <= Date.now()) fail('deadline_invalid');
  return Object.freeze({ executable, profileRoot, transactionPath, observationPath, observedSaveSlot: descriptor.observedSaveSlot, deadlineUnixMs: descriptor.deadlineUnixMs, env: validateLaunchEnvironment(descriptor.env) });
}

/** Creates the three fixed runner seams. The factory only validates and composes; it never starts a target process. */
export async function createNavigationMultiSourceCharacterizationAdapter(paths, dependencies = {}) {
  requireExactKeys(paths, ['contractExecutable', 'launcherPs1', 'gameRoot'], 'factory_paths');
  const contractExecutable = requireAbsoluteCanonicalPath(paths.contractExecutable, 'contract_executable');
  const launcherPs1 = requireAbsoluteCanonicalPath(paths.launcherPs1, 'launcher_ps1');
  const gameRoot = requireAbsoluteCanonicalPath(paths.gameRoot, 'game_root');
  const io = dependencies.io ?? { lstat };
  const spawnProcess = dependencies.spawn ?? nodeSpawn;
  if (!io || typeof io.lstat !== 'function' || typeof spawnProcess !== 'function') fail('dependency_invalid');
  await requireRegularNonLink(contractExecutable, io, 'contract_executable');
  await requireRegularNonLink(launcherPs1, io, 'launcher_ps1');
  await requireDirectoryNonLink(gameRoot, io, 'game_root');
  await requireRegularNonLink(join(gameRoot, SMAPI_EXECUTABLE), io, 'smapi_executable');

  const verifyStaticContract = async (descriptor) => {
    const input = validateStaticDescriptor(descriptor);
    await requireRegularNonLink(input.productionDllPath, io, 'production_dll');
    await requireRegularNonLink(input.probeDllPath, io, 'probe_dll');
    const result = await spawnExact(spawnProcess, contractExecutable, ['--production-sha256', input.productionSha256, '--production-dll', input.productionDllPath, '--probe-dll', input.probeDllPath], { shell: false, windowsHide: true });
    if (result.code !== 0 || result.signal !== null || result.stdout !== '' || !STATIC_CONTRACT_SUCCESS.test(result.stderr)) fail('static_contract_failed');
    return true;
  };
  const readMvid = async (productionDll) => {
    requireDirectNamedChild(productionDll, parse(requireAbsoluteCanonicalPath(productionDll, 'production_dll')).dir, PRODUCTION_DLL, 'production_dll');
    await requireRegularNonLink(productionDll, io, 'production_dll');
    const result = await spawnExact(spawnProcess, contractExecutable, ['--print-production-mvid', '--production-dll', productionDll], { shell: false, windowsHide: true });
    const mvidMatch = CANONICAL_MVID_OUTPUT.exec(result.stdout);
    if (result.code !== 0 || result.signal !== null || result.stderr !== '' || mvidMatch === null) fail('production_mvid_read_failed');
    return mvidMatch[1];
  };
  const launch = async (descriptor) => {
    const input = validateLaunchDescriptor(descriptor, gameRoot);
    await requireDirectoryNonLink(input.profileRoot, io, 'profile_root');
    await requireDirectoryNonLink(input.transactionPath, io, 'transaction_path');
    const result = await spawnExact(spawnProcess, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPs1, '-GamePath', gameRoot, '-ProfilePath', input.profileRoot, '-ObservedSaveSlot', input.observedSaveSlot, '-ObservationPath', input.observationPath, '-DeadlineUnixMs', String(input.deadlineUnixMs)], { shell: false, windowsHide: true, env: input.env });
    if (result.code !== 0 || result.signal !== null || result.stdout !== '' || result.stderr !== '') fail('launcher_failed');
  };
  return Object.freeze({ verifyStaticContract, readMvid, launch });
}
