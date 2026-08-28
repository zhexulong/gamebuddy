import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNavigationMultiSourceCharacterizationAdapter } from './stardew-navigation-multisource-characterization-adapter.mjs';

const sha = 'a'.repeat(64);
const key = 'b'.repeat(64);
const mvid = '01234567-89ab-cdef-0123-456789abcdef';

function child({ code = 0, stdout = '', stderr = '', signal = null } = {}) {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) result.stdout.emit('data', Buffer.from(stdout));
    if (stderr) result.stderr.emit('data', Buffer.from(stderr));
    result.emit('close', code, signal);
  });
  return result;
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'multisource-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gameRoot = join(root, 'game');
  const contractExecutable = join(root, 'NavigationTopologyCharacterization.Contract.exe');
  const launcherPs1 = join(root, 'launcher.ps1');
  const productionRoot = join(root, 'production');
  const probeRoot = join(root, 'probe');
  const transactionPath = join(root, 'tx');
  const profileRoot = join(transactionPath, 'Mods');
  await Promise.all([mkdir(gameRoot), mkdir(productionRoot), mkdir(probeRoot), mkdir(profileRoot, { recursive: true })]);
  await Promise.all([
    writeFile(contractExecutable, 'contract'), writeFile(launcherPs1, 'launcher'),
    writeFile(join(gameRoot, 'StardewModdingAPI.exe'), 'smapi'),
    writeFile(join(productionRoot, 'GameBuddy.Stardew.dll'), 'production'),
    writeFile(join(probeRoot, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'), 'probe'),
  ]);
  return { root, gameRoot, contractExecutable, launcherPs1, productionRoot, probeRoot, transactionPath, profileRoot };
}
function staticDescriptor(fixture) {
  return { productionDllPath: join(fixture.productionRoot, 'GameBuddy.Stardew.dll'), probeDllPath: join(fixture.probeRoot, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'), productionSha256: sha };
}
function launchDescriptor(fixture, overrides = {}) {
  return {
    executable: join(fixture.gameRoot, 'StardewModdingAPI.exe'), args: ['--mods-path', fixture.profileRoot], profileRoot: fixture.profileRoot,
    env: { APPDATA: 'C:\\AppData', PATH: 'C:\\Windows', GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY: key, GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY: key },
    observedSaveSlot: 'GameBuddyFixture_1', observationPath: join(fixture.transactionPath, 'observation.json'), deadlineUnixMs: Date.now() + 60_000, transactionPath: fixture.transactionPath,
    ...overrides,
  };
}

test('factory admits fixed regular paths and performs no spawn', async (t) => {
  const fixture = await setup(t);
  let calls = 0;
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, { spawn: () => { calls += 1; return child(); } });
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(seams), true);
  assert.deepEqual(Object.keys(seams).sort(), ['launch', 'readMvid', 'verifyStaticContract']);
});

test('static verifier and metadata reader spawn only fixed contract argument vectors', async (t) => {
  const fixture = await setup(t);
  const calls = [];
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, {
    spawn: (executable, args, options) => {
      calls.push({ executable, args, options });
      return child(args[0] === '--print-production-mvid' ? { stdout: `${mvid}\n` } : { stderr: 'NavigationTopologyCharacterization.Contract passed.\r\n' });
    },
  });
  assert.equal(await seams.verifyStaticContract(staticDescriptor(fixture)), true);
  assert.equal(await seams.readMvid(join(fixture.productionRoot, 'GameBuddy.Stardew.dll')), mvid);
  assert.deepEqual(calls[0].args, ['--production-sha256', sha, '--production-dll', join(fixture.productionRoot, 'GameBuddy.Stardew.dll'), '--probe-dll', join(fixture.probeRoot, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll')]);
  assert.deepEqual(calls[1].args, ['--print-production-mvid', '--production-dll', join(fixture.productionRoot, 'GameBuddy.Stardew.dll')]);
  assert.equal(calls.every((call) => call.executable === fixture.contractExecutable && call.options.shell === false), true);
});

test('static verifier accepts only the exact success sentence with one platform newline', async (t) => {
  const fixture = await setup(t);
  let contractResult;
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, {
    spawn: () => child(contractResult),
  });

  for (const stderr of ['NavigationTopologyCharacterization.Contract passed.\n', 'NavigationTopologyCharacterization.Contract passed.\r\n']) {
    contractResult = { stderr };
    assert.equal(await seams.verifyStaticContract(staticDescriptor(fixture)), true);
  }

  for (const [name, result] of [
    ['no newline', { stderr: 'NavigationTopologyCharacterization.Contract passed.' }],
    ['duplicate line', { stderr: 'NavigationTopologyCharacterization.Contract passed.\nNavigationTopologyCharacterization.Contract passed.\n' }],
    ['extra prefix', { stderr: 'unexpected NavigationTopologyCharacterization.Contract passed.\n' }],
    ['extra suffix', { stderr: 'NavigationTopologyCharacterization.Contract passed.\nextra' }],
    ['stdout content', { stdout: 'unexpected\n', stderr: 'NavigationTopologyCharacterization.Contract passed.\n' }],
    ['failure exit', { code: 1, stderr: 'NavigationTopologyCharacterization.Contract passed.\n' }],
  ]) {
    contractResult = result;
    await assert.rejects(seams.verifyStaticContract(staticDescriptor(fixture)), /multisource_adapter_static_contract_failed/, name);
  }
});

test('launch maps the exact runner descriptor to fixed PowerShell arguments and preserves only supplied env', async (t) => {
  const fixture = await setup(t);
  const calls = [];
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, { spawn: (executable, args, options) => { calls.push({ executable, args, options }); return child(); } });
  const descriptor = launchDescriptor(fixture);
  await seams.launch(descriptor);
  assert.deepEqual(calls[0].args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.launcherPs1, '-GamePath', fixture.gameRoot, '-ProfilePath', fixture.profileRoot, '-ObservedSaveSlot', 'GameBuddyFixture_1', '-ObservationPath', join(fixture.transactionPath, 'observation.json'), '-DeadlineUnixMs', String(descriptor.deadlineUnixMs)]);
  assert.equal(calls[0].executable, 'powershell.exe');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env, descriptor.env);
  assert.equal('HOME' in calls[0].options.env, false);
});

test('readMvid accepts exactly one canonical lowercase D-GUID with one platform newline', async (t) => {
  const fixture = await setup(t);
  let result;
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, {
    spawn: () => child(result),
  });

  for (const stdout of [`${mvid}\n`, `${mvid}\r\n`]) {
    result = { stdout };
    assert.equal(await seams.readMvid(join(fixture.productionRoot, 'GameBuddy.Stardew.dll')), mvid);
  }
});

test('readMvid rejects noncanonical output and unsuccessful contract processes', async (t) => {
  const fixture = await setup(t);
  let result;
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, {
    spawn: () => child(result),
  });
  const productionDll = join(fixture.productionRoot, 'GameBuddy.Stardew.dll');

  for (const [name, rejectedResult] of [
    ['no newline', { stdout: mvid }],
    ['uppercase', { stdout: `${mvid.toUpperCase()}\n` }],
    ['leading space', { stdout: ` ${mvid}\n` }],
    ['trailing space', { stdout: `${mvid} \n` }],
    ['double newline', { stdout: `${mvid}\n\n` }],
    ['other prefix', { stdout: `unexpected${mvid}\n` }],
    ['other suffix', { stdout: `${mvid}unexpected\n` }],
    ['stderr output', { stdout: `${mvid}\n`, stderr: 'unexpected\n' }],
    ['nonzero exit', { code: 1, stdout: `${mvid}\n` }],
    ['signal exit', { stdout: `${mvid}\n`, signal: 'SIGTERM' }],
  ]) {
    result = rejectedResult;
    await assert.rejects(seams.readMvid(productionDll), /multisource_adapter_production_mvid_read_failed/, name);
  }
});

test('launcher validates exact argv and (PID, CreationDate), then observes before verified stop and wait', async () => {
  const script = await readFile(new URL('./start-stardew-navigation-multisource-characterization.ps1', import.meta.url), 'utf8');
  assert.match(script, /\[DllImport\("shell32\.dll", SetLastError = true, CharSet = CharSet\.Unicode\)\]/);
  assert.match(script, /CommandLineToArgvW\(\$CommandLine, \[ref\]\$argv\)/);
  assert.match(script, /function Test-FullyQualifiedWindowsPath/);
  assert.match(script, /\^\(\?:\[A-Za-z\]:\\\\\|\\\\\\\\/);
  assert.match(script, /\$GamePath -cne \$gameRoot/);
  assert.doesNotMatch(script, /IsPathRooted|IsPathFullyQualified/);
  assert.match(script, /\$argv -ne 3/);
  assert.match(script, /\[Runtime\.InteropServices\.Marshal\]::PtrToStringUni\(/);
  assert.match(script, /return \$actual\[0\] -ceq \$ExpectedSmapi -and \$actual\[1\] -ceq \$expectedArgs\[0\] -and \$actual\[2\] -ceq \$expectedArgs\[1\]/);
  assert.match(script, /function Get-VerifiedLaunchedSmapiProcess/);
  assert.match(script, /\[Int64\]\$ExpectedCreationUnixMs/);
  assert.match(script, /\$processCreationUnixMs = \(\[DateTimeOffset\]\$actual\.CreationDate\)\.ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /\(\[DateTimeOffset\]\$actual\.CreationDate\)\.ToUnixTimeMilliseconds\(\) -ne \$ExpectedCreationUnixMs/);
  assert.doesNotMatch(script, /ExpectedCreationDate|\$actual\.CreationDate -cne/);
  assert.match(script, /function Stop-VerifiedLaunchedSmapiProcess/);
  assert.match(script, /Get-VerifiedLaunchedSmapiProcess -ProcessId \$Process\.Id -ExpectedCreationUnixMs \$ExpectedCreationUnixMs -ExactSmapi \$ExactSmapi -ExactProfile \$ExactProfile/);
  assert.match(script, /Stop-VerifiedLaunchedSmapiProcess -Process \$process -ExpectedCreationUnixMs \$processCreationUnixMs -ExactSmapi \$ExactSmapi -ExactProfile \$ExactProfile/);
  const start = script.indexOf('$startedProcess = Start-Process');
  const ownershipAssignment = script.indexOf('$process = $startedProcess', start);
  const initialVerification = script.indexOf('Get-VerifiedLaunchedSmapiProcess -ProcessId $startedProcess.Id', ownershipAssignment);
  assert.ok(start >= 0 && ownershipAssignment > start && initialVerification > ownershipAssignment);
  const observed = script.indexOf('if (Test-RegularNonLink $ExactObservationPath $false) {');
  const verifiedStop = script.indexOf('Stop-VerifiedLaunchedSmapiProcess -Process $process', observed);
  const finalValidation = script.indexOf("if (!(Test-RegularNonLink $ExactObservationPath $false)) { throw 'multisource_launcher_observation_not_regular' }", verifiedStop);
  assert.ok(observed >= 0 && verifiedStop > observed && finalValidation > verifiedStop);
  assert.match(script, /if \(!\$observationObserved\) \{ throw 'multisource_launcher_deadline_or_early_observation' \}/);
});

test('adapter rejects bad fixed paths, contract output, descriptor traversal, and environment widening before launch', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: join(fixture.root, 'missing.exe'), launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }), /multisource_adapter_contract_executable_not_regular/);
  let calls = 0;
  const seams = await createNavigationMultiSourceCharacterizationAdapter({ contractExecutable: fixture.contractExecutable, launcherPs1: fixture.launcherPs1, gameRoot: fixture.gameRoot }, { spawn: () => { calls += 1; return child({ stderr: 'wrong\n' }); } });
  await assert.rejects(seams.verifyStaticContract(staticDescriptor(fixture)), /multisource_adapter_static_contract_failed/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(seams.launch(launchDescriptor(fixture, { observationPath: `${fixture.transactionPath}/nested/../observation.json` })), /multisource_adapter_observation_path_must_be_canonical_absolute|multisource_adapter_observation_path_not_direct_child/);
  await assert.rejects(seams.launch(launchDescriptor(fixture, { env: { ...launchDescriptor(fixture).env, HOME: 'forbidden' } })), /multisource_adapter_launch_env_unexpected_key/);
  await assert.rejects(seams.launch({ ...launchDescriptor(fixture), extra: true }), /multisource_adapter_launch_descriptor_keys_invalid/);
  assert.equal(calls, 0);
});
