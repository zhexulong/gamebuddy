import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeSourceClosure } from './lib/stardew-native-source-closure.mjs';

const hash = (letter) => letter.repeat(64);
function certificate({ state = 'partial_with_unknown_blocking', edge = {} } = {}) {
  return {
    schemaVersion: 1,
    artifactKind: 'native_source_closure',
    attestation: {
      targetAssemblySha256: hash('a'),
      sourceManifestSha256: hash('b'),
      contentManifestSha256: hash('c'),
      boundaryModelSha256: hash('d'),
    },
    closureState: state,
    mechanisms: [{
      mechanismId: 'mechanism:input-router',
      terminal: state === 'bounded_source_closure_complete' ? 'native_transition' : 'unknown_blocking',
      edges: [{
        edgeId: 'edge:dynamic-receiver',
        disposition: state === 'bounded_source_closure_complete' ? 'runtime_modeled' : 'unknown_blocking',
        sourceAnchor: 'StardewValley/Game1.cs#100-120',
        ...(state === 'bounded_source_closure_complete' ? { runtimeModelSha256: hash('e') } : {}),
        ...edge,
      }],
    }],
  };
}

test('retains unknown dynamic provenance as a closure-blocking edge', () => {
  const result = validateNativeSourceClosure(certificate());
  assert.equal(result.closureState, 'partial_with_unknown_blocking');
  assert.deepEqual(result.unknownBlockingEdgeIds, ['edge:dynamic-receiver']);
});

test('accepts a bounded complete certificate only after every edge has an approved disposition', () => {
  const result = validateNativeSourceClosure(certificate({ state: 'bounded_source_closure_complete' }));
  assert.equal(result.unknownBlockingEdgeIds.length, 0);
});

test('schema-v2 requires exact structured source anchors', () => {
  const v2 = certificate();
  v2.schemaVersion = 2;
  v2.mechanisms[0].edges[0].sourceAnchor = { relativePath: 'Game.cs', startByte: 0, endByte: 0, sliceSha256: 'a'.repeat(64), sourceFileSha256: 'b'.repeat(64) };
  assert.throws(() => validateNativeSourceClosure(v2), { code: 'source_closure_anchor_invalid' });
});
test('fails closed for unknown completion, unmodeled runtime edges, and post-source vocabulary', () => {
  const unknownComplete = certificate();
  unknownComplete.closureState = 'bounded_source_closure_complete';
  assert.throws(() => validateNativeSourceClosure(unknownComplete), /unknown blocking edges/);
  assert.throws(
    () => validateNativeSourceClosure(certificate({ edge: { disposition: 'runtime_modeled' } })),
    /runtimeModelSha256/,
  );
  const invalid = certificate();
  invalid.mechanisms[0].primitiveId = 'bad';
  assert.throws(() => validateNativeSourceClosure(invalid), /forbidden/);
});
