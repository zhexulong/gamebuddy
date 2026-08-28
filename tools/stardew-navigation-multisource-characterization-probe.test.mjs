import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./stardew-navigation-multisource-characterization/ModEntry.cs', import.meta.url);

function phaseBlock(source) {
  const start = source.indexOf('private enum ProbePhase');
  const end = source.indexOf('private static bool ProductionIdentityMatches', start);
  assert.ok(start >= 0, 'ProbePhase must be declared');
  assert.ok(end > start, 'ProbePhase logging code must precede production identity inspection');
  return source.slice(start, end);
}

test('probe private diagnosis trace is a closed fixed-code Trace-only seam outside authenticated evidence', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const phaseSource = phaseBlock(source);
  const expectedPhases = [
    'ArmAccepted',
    'ArmRejected',
    'SubscriptionsInstalled',
    'SubscriptionsFailed',
    'StableWorldReady',
    'ObservationAttempt',
    'TerminalPassed',
    'TerminalBlocked',
    'ObservationWriteSucceeded',
    'ObservationWriteFailed',
  ];

  const enumMatch = /private enum ProbePhase\s*\{([\s\S]*?)\}/.exec(phaseSource);
  assert.ok(enumMatch, 'ProbePhase must be a closed enum');
  const actualPhases = enumMatch[1]
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);
  assert.deepEqual(actualPhases, expectedPhases, 'ProbePhase must expose exactly the fixed diagnosis allowlist');
  assert.equal((source.match(/this\.Monitor\.Log\(/g) ?? []).length, 1, 'TracePhase must be the probe-wide only logging seam');
  assert.match(phaseSource, /this\.Monitor\.Log\(phase switch\s*\{[\s\S]*?_ => throw new ArgumentOutOfRangeException\(nameof\(phase\)\),?\s*\}, LogLevel\.Trace\)/);
  for (const code of [
    'arm_accepted',
    'arm_rejected',
    'subscriptions_installed',
    'subscriptions_failed',
    'stable_world_ready',
    'observation_attempt',
    'terminal_passed',
    'terminal_blocked',
    'observation_write_succeeded',
    'observation_write_failed',
  ]) assert.equal((phaseSource.match(new RegExp(`=> "GBMS_PHASE:${code}"`, 'g')) ?? []).length, 1, `phase code ${code} must have exactly one fixed mapping`);
  assert.equal((phaseSource.match(/GBMS_PHASE:/g) ?? []).length, 10, 'no other phase code may be logged');
  assert.doesNotMatch(source, /Monitor\.Log\(\s*\$"|Monitor\.Log\([^)]*\+/, 'probe-wide logging must not interpolate or concatenate values');
  assert.doesNotMatch(source, /LogLevel\.(?!Trace)/, 'probe-wide phase logs must use Trace only');
  const fileStreamCalls = source.match(/new FileStream\([\s\S]*?\)/g) ?? [];
  assert.equal(fileStreamCalls.length, 1, 'the probe must retain exactly one observation write stream');
  assert.match(fileStreamCalls[0], /FileMode\.CreateNew, FileAccess\.Write, FileShare\.None/, 'the sole observation write must remain exclusive CreateNew');

  assert.match(source, /if \(this\.arm is null\)\s*\{\s*this\.TracePhase\(ProbePhase\.ArmRejected\);\s*return;/);
  assert.match(source, /this\.TracePhase\(ProbePhase\.ArmAccepted\);/);
  assert.match(source, /this\.TracePhase\(ProbePhase\.SubscriptionsInstalled\);/);
  assert.match(source, /catch\s*\{\s*this\.TracePhase\(ProbePhase\.SubscriptionsFailed\);\s*this\.Detach\(\);/);
  assert.match(source, /this\.TracePhase\(ProbePhase\.StableWorldReady\);\s*this\.Observe\(player, location\);/);
  assert.match(source, /this\.TracePhase\(ProbePhase\.ObservationAttempt\);/);
  assert.match(source, /this\.TracePhase\(observation\.TerminalStatus == "passed" \? ProbePhase\.TerminalPassed : ProbePhase\.TerminalBlocked\);/);
  assert.match(source, /private const long TerminalWriteReserveMilliseconds = 30_000;/, 'the probe must reserve a bounded write window before arm expiry');
  assert.match(source, /private bool ShouldBeginTerminalWrite\(\)\s*\{\s*if \(this\.arm is null\)\s*return false;\s*long remainingMs = this\.arm\.DeadlineUnixMs - DateTimeOffset\.UtcNow\.ToUnixTimeMilliseconds\(\);\s*return remainingMs > 0 && remainingMs <= TerminalWriteReserveMilliseconds;\s*\}/, 'the reserve predicate must accept only the positive, bounded pre-deadline write window');
  assert.match(source, /if \(this\.ShouldBeginTerminalWrite\(\)\)\s*\{\s*this\.EmitWorldNotReady\(\);\s*return;\s*}\s*if \(DateTimeOffset\.UtcNow\.ToUnixTimeMilliseconds\(\) >= this\.arm\.DeadlineUnixMs\)\s*\{\s*this\.Detach\(\);\s*return;/, 'world-not-ready must terminalize only in the reserved pre-deadline write window, never at or after expiry');
  assert.match(source, /if \(!this\.emitted && this\.ShouldBeginTerminalWrite\(\)\)\s*this\.EmitWorldNotReady\(\);\s*else\s*this\.Detach\(\);/, 'title return must use the same bounded terminal-write rule');
  assert.match(source, /writer\.Flush\(\);\s*stream\.Flush\(true\);\s*this\.TracePhase\(ProbePhase\.ObservationWriteSucceeded\);\s*this\.emitted = true;/, 'write success must follow durable stream flush before the launcher may observe the file');
  assert.match(source, /catch\s*\{\s*this\.TracePhase\(ProbePhase\.ObservationWriteFailed\);\s*\/\/ A probe may never overwrite/);

  const rawStart = source.indexOf('string raw = JsonSerializer.Serialize');
  const rawEnd = source.indexOf('using var stream = new FileStream', rawStart);
  assert.ok(rawStart >= 0 && rawEnd > rawStart, 'existing authenticated raw observation serialization must remain present');
  assert.doesNotMatch(source.slice(rawStart, rawEnd), /GBMS_PHASE|TracePhase|Monitor\.Log/, 'diagnostic phase codes must not enter the authenticated raw observation');
});
