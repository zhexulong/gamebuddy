import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMultiSourceHmac,
  runNavigationMultiSourceCharacterization,
  validateMultiSourceArm,
  validateMultiSourceRawObservation,
} from './run-stardew-navigation-multisource-characterization.mjs';

const key = 'multisource-test-key';
const now = 1_800_000_000_000;
const transactionPath = 'C:\\multisource-transaction';
const observationPath = 'C:\\multisource-transaction\\observation.json';
const productionSha256 = 'a'.repeat(64);
const productionMvid = '01234567-89ab-cdef-0123-456789abcdef';
const nonce = 'b'.repeat(48);

function makeArm(overrides = {}) {
  const arm = {
    schemaVersion: 1,
    nonce,
    transactionPath,
    observationPath,
    deadlineUnixMs: now + 60_000,
    productionSha256,
    productionMvid,
    ...overrides,
  };
  arm.integrityMac = createMultiSourceHmac(
    key,
    `arm|${arm.nonce}|${arm.transactionPath}|${arm.observationPath}|${arm.deadlineUnixMs}|${arm.productionSha256}|${arm.productionMvid}`,
  );
  return arm;
}

function expectations(overrides = {}) {
  return {
    now,
    expectedTransactionPath: transactionPath,
    expectedObservationPath: observationPath,
    expectedProductionSha256: productionSha256,
    expectedProductionMvid: productionMvid,
    ...overrides,
  };
}

function rawObservation(overrides = {}) {
  return {
    schemaVersion: 1,
    terminalStatus: 'passed',
    targetBuild: '1.6.15',
    observationScope: 'navigation.multisource',
    predicateCode: 'NAV_MULTI_SOURCE',
    productionSha256,
    productionMvid,
    productionExtractorInvoked: true,
    productionExtractorInvocationCount: 1,
    gameThreadObserved: true,
    worldReadyObserved: true,
    multiSourceObserved: true,
    ordinaryWarpFamilyObserved: true,
    correlationApiShapeVerified: true,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    ...overrides,
  };
}

function makeEnvelope(arm, observation = rawObservation(), overrides = {}) {
  const observationText = typeof observation === 'string' ? observation : JSON.stringify(observation);
  const envelope = { nonce: arm.nonce, observation: observationText, ...overrides };
  envelope.integrityMac = createMultiSourceHmac(
    key,
    `observation|${envelope.nonce}|${arm.transactionPath}|${arm.observationPath}|${envelope.observation}`,
  );
  return envelope;
}

function mustReject(callback, expression = /multisource_/) {
  assert.throws(callback, expression);
}

test('validates and freezes an arm and pass-shaped raw observation', () => {
  const validatedArm = validateMultiSourceArm(makeArm(), key, expectations());
  assert.deepEqual(validatedArm, {
    schemaVersion: 1,
    nonce,
    transactionPath,
    observationPath,
    deadlineUnixMs: now + 60_000,
    productionSha256,
    productionMvid,
  });
  assert.equal(Object.isFrozen(validatedArm), true);
  assert.equal('integrityMac' in validatedArm, false);

  const validatedRaw = validateMultiSourceRawObservation(
    makeEnvelope(validatedArm),
    key,
    validatedArm,
    { now },
  );
  assert.equal(validatedRaw.terminalStatus, 'passed');
  assert.equal(Object.isFrozen(validatedRaw), true);
});

test('arm rejects missing, extra, schema, MAC, nonce, path, deadline, and identity failures', () => {
  const missing = makeArm();
  delete missing.nonce;
  mustReject(() => validateMultiSourceArm(missing, key, expectations()));
  mustReject(() => validateMultiSourceArm({ ...makeArm(), extra: true }, key, expectations()));
  mustReject(() => validateMultiSourceArm(makeArm({ schemaVersion: 2 }), key, expectations()));
  mustReject(() => validateMultiSourceArm({ ...makeArm(), integrityMac: '0'.repeat(64) }, key, expectations()));
  mustReject(() => validateMultiSourceArm(makeArm({ nonce: 'B'.repeat(48) }), key, expectations()));
  mustReject(() => validateMultiSourceArm(makeArm({ observationPath: 'C:\\other\\observation.json' }), key, expectations()));
  const traversalPath = `${transactionPath}\\child\\..\\observation.json`;
  mustReject(() => validateMultiSourceArm(makeArm({ observationPath: traversalPath }), key, expectations({ expectedObservationPath: traversalPath })));
  mustReject(() => validateMultiSourceArm(makeArm({ deadlineUnixMs: now }), key, expectations()));
  mustReject(() => validateMultiSourceArm(makeArm({ productionSha256: 'c'.repeat(64) }), key, expectations()));
  mustReject(() => validateMultiSourceArm(makeArm({ productionMvid: '01234567-89ab-cdef-0123-456789abcdee' }), key, expectations()));
});

test('raw observation rejects malformed envelope, JSON, authentication, expiry, identity, and topology fields', () => {
  const arm = validateMultiSourceArm(makeArm(), key, expectations());
  const validEnvelope = makeEnvelope(arm);

  const missing = { ...validEnvelope };
  delete missing.observation;
  mustReject(() => validateMultiSourceRawObservation(missing, key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation({ ...validEnvelope, extra: true }, key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, '{'), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation({ ...validEnvelope, integrityMac: '0'.repeat(64) }, key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation(), { nonce: 'c'.repeat(48) }), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(validEnvelope, key, { ...arm, deadlineUnixMs: now }, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation({ productionSha256: 'd'.repeat(64) })), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, { ...rawObservation(), fixtureCleanup: true }), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, { ...rawObservation(), route: 'Farm' }), key, arm, { now }));
});

test('raw observation rejects invalid count and nonconforming raw fields', () => {
  const arm = validateMultiSourceArm(makeArm(), key, expectations());
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation({ gameplayMutationCount: -1 })), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation({ playerWarpEventCount: 1.5 })), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation({ gameThreadObserved: 'true' })), key, arm, { now }));
  mustReject(() => validateMultiSourceRawObservation(makeEnvelope(arm, rawObservation({ terminalStatus: 'failed' })), key, arm, { now }));
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function setupRunnerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'multisource-runner-test-'));
  const appData = join(root, 'appdata'), saveRoot = join(appData, 'StardewValley', 'Saves');
  const fixtureRoot = join(root, 'fixture'), slot = 'GameBuddyFixture';
  const loader = join(root, 'loader'), probe = join(root, 'probe'), production = join(root, 'production');
  await Promise.all([mkdir(saveRoot, { recursive: true }), mkdir(join(fixtureRoot, slot), { recursive: true }), mkdir(loader), mkdir(probe), mkdir(production)]);
  const fixtureFiles = [['SaveGameInfo', 'save-info'], ['GameBuddyFixture', 'save-body']];
  for (const [name, content] of fixtureFiles) await writeFile(join(fixtureRoot, slot, name), content);
  await writeFile(join(fixtureRoot, 'fixture-manifest.json'), JSON.stringify({ saveDirectoryName: slot, files: fixtureFiles.map(([name, content]) => ({ path: `${slot}/${name}`, sha256: sha256(content) })) }));
  await writeFile(join(loader, 'manifest.json'), JSON.stringify({ UniqueID: 'zhexulong.GameBuddy.NavigationP4Loader' }));
  await writeFile(join(loader, 'StardewNavigationP4Loader.dll'), 'loader');
  await writeFile(join(probe, 'manifest.json'), JSON.stringify({ UniqueID: 'zhexulong.GameBuddy.NavigationTopologyCharacterization' }));
  await writeFile(join(probe, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'), 'probe');
  for (const name of ['GameBuddy.Stardew.dll', 'GameBuddy.Stardew.Core.dll', 'Raffinert.FuzzySharp.dll']) {
    await writeFile(join(probe, name), `shared-${name}`);
    await writeFile(join(production, name), `shared-${name}`);
  }
  return { root, appData, saveRoot, fixtureRoot, loader, probe, production, slot, env: {
    APPDATA: appData,
    PATH: 'allowed-path',
    GAMEBUDDY_CONTROL_PIPE: 'must-not-reach-launch',
    GAMEBUDDY_CONTROL_TOKEN: 'must-not-reach-launch',
    GAMEBUDDY_ARBITRARY_SECRET: 'must-not-reach-launch',
    GAMEBUDDY_STARDEW_GAME_PATH: join(root, 'game'),
    GAMEBUDDY_NAVIGATION_MULTISOURCE_PRODUCTION_BUILD_PATH: production,
    GAMEBUDDY_NAVIGATION_MULTISOURCE_PROBE_BUILD_PATH: probe,
    GAMEBUDDY_NAVIGATION_MULTISOURCE_LOADER_BUILD_PATH: loader,
    GAMEBUDDY_NAVIGATION_MULTISOURCE_FIXTURE_ROOT: fixtureRoot,
    GAMEBUDDY_NAVIGATION_MULTISOURCE_SAVE_ROOT: saveRoot,
    GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH: join(root, 'artifact.json'),
  }, productionSha256: sha256('shared-GameBuddy.Stardew.dll') };
}

function baseRunnerOptions(fixture, overrides = {}) {
  return {
    env: fixture.env,
    tempRoot: fixture.root,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    productionSha256: fixture.productionSha256,
    verifyStaticContract: async () => true,
    listProcesses: async () => [],
    readMvid: async () => productionMvid,
    ...overrides,
  };
}

async function writePassingObservation(profileRoot, launchEnv, overrides = {}) {
  const arm = JSON.parse(await readFile(join(profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'arm.json'), 'utf8'));
  const observation = JSON.stringify({ ...rawObservation({ targetBuild: '1.6.15.24356', observationScope: 'multi_hop_ordinary_warp', predicateCode: 'successful_multisource_characterization', productionSha256: arm.productionSha256, productionMvid: arm.productionMvid }), ...overrides });
  const envelope = { nonce: arm.nonce, observation };
  envelope.integrityMac = createMultiSourceHmac(launchEnv.GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY, `observation|${arm.nonce}|${arm.transactionPath}|${arm.observationPath}|${observation}`);
  await writeFile(arm.observationPath, JSON.stringify(envelope), { flag: 'wx' });
}

async function assertAbsent(path) {
  await assert.rejects(readFile(path));
}

test('runner stages the exact profile, accepts one authenticated injected observation, and removes private state', async (t) => {
  const fixture = await setupRunnerFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let launchCount = 0, staticCalls = 0;
  const result = await runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, {
    verifyStaticContract: async (descriptor) => {
      staticCalls += 1;
      assert.equal(Object.isFrozen(descriptor), true);
      assert.deepEqual(descriptor, {
        productionDllPath: join(fixture.production, 'GameBuddy.Stardew.dll'),
        probeDllPath: join(fixture.probe, 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'),
        productionSha256: fixture.productionSha256,
      });
      return true;
    },
    launch: async (descriptor) => {
      const { executable, args, profileRoot, env, observedSaveSlot, observationPath, deadlineUnixMs, transactionPath } = descriptor;
      launchCount += 1;
      assert.equal(Object.isFrozen(descriptor), true);
      assert.deepEqual(Object.keys(descriptor).sort(), ['args', 'deadlineUnixMs', 'env', 'executable', 'observationPath', 'observedSaveSlot', 'profileRoot', 'transactionPath']);
      assert.equal(executable, join(fixture.env.GAMEBUDDY_STARDEW_GAME_PATH, 'StardewModdingAPI.exe'));
      assert.deepEqual(args, ['--mods-path', profileRoot]);
      assert.equal(Object.isFrozen(args), true);
      assert.equal(observedSaveSlot, fixture.slot);
      assert.equal(observationPath, join(transactionPath, 'observation.json'));
      assert.equal(deadlineUnixMs, now + 300_000);
      assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY', 'GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY', 'PATH']);
      assert.equal(env.APPDATA, fixture.appData);
      assert.equal('GAMEBUDDY_CONTROL_PIPE' in env, false);
      assert.equal('GAMEBUDDY_CONTROL_TOKEN' in env, false);
      assert.equal('GAMEBUDDY_NAVIGATION_MULTISOURCE_TRANSACTION_KEY' in env, false);
      assert.equal(env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY, env.GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY);
      assert.match(env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY, /^[a-f0-9]{64}$/);
      assert.match(env.GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY, /^[a-f0-9]{64}$/);
      const arm = JSON.parse(await readFile(join(profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'arm.json'), 'utf8'));
      assert.match(arm.nonce, /^[a-f0-9]{48}$/);
      assert.deepEqual((await readFile(join(profileRoot, 'GameBuddy.NavigationP4Loader', 'fixture-load.json'), 'utf8')).length > 0, true);
      await writePassingObservation(profileRoot, env);
    },
  }));
  assert.equal(staticCalls, 1);
  assert.equal(launchCount, 1);
  assert.equal(result.validation.valid, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal('productionSha256' in result.artifact, false);
  assert.equal('productionMvid' in result.artifact, false);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH, 'utf8')), result.artifact);
  assert.deepEqual(await readFile(join(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_FIXTURE_ROOT, 'GameBuddyFixture', 'SaveGameInfo'), 'utf8'), 'save-info');
  assert.equal((await (async () => { try { await readFile(join(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_SAVE_ROOT, 'GameBuddyFixture', 'SaveGameInfo')); return true; } catch { return false; } })()), false);
});

test('static contract admission precedes every filesystem, process, and transaction side effect', async (t) => {
  const fixture = await setupRunnerFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let effects = 0;
  const io = new Proxy({}, { get: () => async () => { effects += 1; throw new Error('unexpected_side_effect'); } });
  const listProcesses = async () => { effects += 1; return []; };
  await assert.rejects(() => runNavigationMultiSourceCharacterization({ env: fixture.env, productionSha256: fixture.productionSha256, io, listProcesses }), /multisource_static_contract_verifier_not_admitted/);
  assert.equal(effects, 0);
  let verifierCalls = 0;
  await assert.rejects(() => runNavigationMultiSourceCharacterization({
    env: fixture.env, productionSha256: fixture.productionSha256, io, listProcesses,
    verifyStaticContract: async () => { verifierCalls += 1; return false; },
  }), /multisource_static_contract_invalid/);
  assert.equal(verifierCalls, 1);
  assert.equal(effects, 0);
  await assertAbsent(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
});

test('source extras are ignored while required source members remain mandatory', async (t) => {
  const fixture = await setupRunnerFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.probe, 'ignored-extra.pdb'), 'not staged');
  await runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, {
    launch: async ({ profileRoot, env }) => {
      await assertAbsent(join(profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'ignored-extra.pdb'));
      await writePassingObservation(profileRoot, env);
    },
  }));
  await rm(join(fixture.probe, 'GameBuddy.Stardew.Core.dll'));
  await rm(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, { launch: async () => {} })), /multisource_probe_source_member_not_regular/);
  await mkdir(join(fixture.probe, 'GameBuddy.Stardew.Core.dll'));
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, { launch: async () => {} })), /multisource_probe_source_member_not_regular/);
  await assertAbsent(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
});

test('post-launch staged DLL tampering, missing observation, and duplicate observation fail without artifacts', async (t) => {
  const scenarios = [
    ['tampered', async ({ profileRoot }) => writeFile(join(profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'GameBuddy.Stardew.NavigationTopologyCharacterization.dll'), 'tampered')],
    ['missing', async () => {}],
    ['duplicate', async ({ profileRoot, env }) => { await writePassingObservation(profileRoot, env); const arm = JSON.parse(await readFile(join(profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'arm.json'))); await writeFile(join(arm.transactionPath, 'duplicate-observation.json'), 'duplicate', { flag: 'wx' }); }],
  ];
  for (const [name, launch] of scenarios) {
    await test(`runner rejects ${name} observation state`, async (t) => {
      const fixture = await setupRunnerFixture();
      t.after(() => rm(fixture.root, { recursive: true, force: true }));
      await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, { launch })), /multisource_/);
      await assertAbsent(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
      await assertAbsent(join(fixture.saveRoot, fixture.slot, 'SaveGameInfo'));
    });
  }
});

test('existing and residual game processes reject without artifacts', async (t) => {
  const existing = await setupRunnerFixture();
  t.after(() => rm(existing.root, { recursive: true, force: true }));
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(existing, { listProcesses: async () => ['1'], launch: async () => {} })), /multisource_existing_stardew_or_smapi_process/);
  await assertAbsent(existing.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);

  const residual = await setupRunnerFixture();
  t.after(() => rm(residual.root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(residual, {
    listProcesses: async () => (++calls === 1 ? [] : ['2']),
    launch: async ({ profileRoot, env }) => writePassingObservation(profileRoot, env),
  })), /multisource_cleanup_incomplete/);
  await assertAbsent(residual.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
});

test('preserves the transaction profile when target-process cleanup cannot prove files are unused', async (t) => {
  for (const processState of [async () => ['2'], async () => { throw new Error('process_table_unavailable'); }]) {
    const fixture = await setupRunnerFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    let calls = 0;
    let captured;
    await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, {
      listProcesses: async () => (++calls === 1 ? [] : processState()),
      launch: async ({ transactionPath, profileRoot }) => {
        captured = { transactionPath, profileRoot };
        throw new Error('launcher_identity_rejected_after_spawn');
      },
    })), /multisource_cleanup_incomplete/);
    assert.notEqual(captured, undefined);
    assert.deepEqual(await readFile(join(captured.profileRoot, 'GameBuddy.NavigationP4Loader', 'manifest.json'), 'utf8'), await readFile(join(fixture.loader, 'manifest.json'), 'utf8'));
    assert.deepEqual(await readFile(join(captured.profileRoot, 'GameBuddy.NavigationTopologyCharacterization', 'manifest.json'), 'utf8'), await readFile(join(fixture.probe, 'manifest.json'), 'utf8'));
    assert.deepEqual(await readFile(join(fixture.saveRoot, fixture.slot, 'SaveGameInfo'), 'utf8'), 'save-info');
    await assertAbsent(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
  }
});

test('fixture manifest and payload drift reject after observation, clean the owned working save, and never publish an artifact', async (t) => {
  const manifestDrift = await setupRunnerFixture();
  t.after(() => rm(manifestDrift.root, { recursive: true, force: true }));
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(manifestDrift, {
    launch: async ({ profileRoot, env }) => { await writePassingObservation(profileRoot, env); await writeFile(join(manifestDrift.fixtureRoot, 'fixture-manifest.json'), '{}'); },
  })), /multisource_|p4_runtime_fixture_manifest_invalid/);
  await assertAbsent(join(manifestDrift.saveRoot, manifestDrift.slot, 'SaveGameInfo'));
  await assertAbsent(manifestDrift.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);

  const payloadDrift = await setupRunnerFixture();
  t.after(() => rm(payloadDrift.root, { recursive: true, force: true }));
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(payloadDrift, {
    launch: async ({ profileRoot, env }) => {
      await writePassingObservation(profileRoot, env);
      await writeFile(join(payloadDrift.fixtureRoot, payloadDrift.slot, 'SaveGameInfo'), 'mutated-save-info');
    },
  })), /multisource_|p4_runtime_fixture_hash_mismatch/);
  await assertAbsent(join(payloadDrift.saveRoot, payloadDrift.slot, 'SaveGameInfo'));
  await assertAbsent(payloadDrift.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
});

test('owner cleanup failure and artifact collision never publish an artifact', async (t) => {
  const ownerFailure = await setupRunnerFixture();
  t.after(() => rm(ownerFailure.root, { recursive: true, force: true }));
  const realIo = await import('node:fs/promises');
  let failedOwnerDelete = false;
  const io = { ...realIo, rm: async (path, options) => {
    if (!failedOwnerDelete && path.endsWith('.owner')) { failedOwnerDelete = true; throw new Error('injected_owner_delete_failure'); }
    return realIo.rm(path, options);
  } };
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(ownerFailure, { io, launch: async () => {} })), /multisource_cleanup_incomplete/);
  await assertAbsent(join(ownerFailure.saveRoot, ownerFailure.slot, 'SaveGameInfo'));
  await assertAbsent(ownerFailure.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);

  const collision = await setupRunnerFixture();
  t.after(() => rm(collision.root, { recursive: true, force: true }));
  await writeFile(collision.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH, 'original');
  let staticCalls = 0, launchCount = 0, processListCalls = 0;
  await assert.rejects(() => runNavigationMultiSourceCharacterization(baseRunnerOptions(collision, {
    verifyStaticContract: async () => { staticCalls += 1; return true; },
    launch: async () => { launchCount += 1; },
    listProcesses: async () => { processListCalls += 1; return []; },
  })), /multisource_artifact_already_exists/);
  assert.equal(staticCalls, 1);
  assert.equal(launchCount, 0);
  assert.equal(processListCalls, 0);
  await assertAbsent(join(collision.saveRoot, collision.slot, 'SaveGameInfo'));
  assert.equal(await readFile(collision.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH, 'utf8'), 'original');
});

test('pre-existing staging save collision preserves the directory while removing the owned sidecar', async (t) => {
  const fixture = await setupRunnerFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const stageNonce = 'ab'.repeat(24);
  const stagingSavePath = join(fixture.saveRoot, `.${fixture.slot}.multisource-stage-${stageNonce}`);
  await mkdir(stagingSavePath);
  await writeFile(join(stagingSavePath, 'SaveGameInfo'), 'save-info');
  await writeFile(join(stagingSavePath, fixture.slot), 'save-body');

  await assert.rejects(
    () => runNavigationMultiSourceCharacterization(baseRunnerOptions(fixture, { launch: async () => {} })),
    (error) => error?.code === 'EEXIST',
  );

  assert.equal(await readFile(join(stagingSavePath, 'SaveGameInfo'), 'utf8'), 'save-info');
  assert.equal(await readFile(join(stagingSavePath, fixture.slot), 'utf8'), 'save-body');
  await assertAbsent(`${stagingSavePath}.owner`);
  await assertAbsent(join(fixture.saveRoot, fixture.slot, 'SaveGameInfo'));
  await assertAbsent(fixture.env.GAMEBUDDY_NAVIGATION_MULTISOURCE_ARTIFACT_PATH);
});
