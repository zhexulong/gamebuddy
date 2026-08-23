import assert from "node:assert/strict";
import test from "node:test";
import {
  characterizeHistoricalProjection,
  PINNED_COMMIT,
  PINNED_PATH,
  PINNED_SHA256,
} from "./stardew-p1t-historical-projection-characterization.mjs";

const source = `private static IReadOnlyList<string> CreateCapabilities(IReadOnlySet<string>? enabledActions)
    {
        List<string> result = new() { "inspect_self", "cancel_active_execution" };
        if (enabledActions?.Contains("tree_first_hit") == true)
            result.Insert(0, "tree_first_hit");
        return result;
    }`;

const expectedPinnedRecord = {
  artifactKind: "stardew_p1t_historical_projection_characterization/v1",
  source: { commit: PINNED_COMMIT, path: PINNED_PATH, sha256: PINNED_SHA256 },
  verification: { expectedDriftVerified: true, projectedActionCount: 28 },
  authority: "none",
  liveClosure: "none",
};

function gitFor(sourceText, overrides = {}) {
  return async (args) => {
    const key = args.join(" ");
    if (key === `cat-file -t ${PINNED_COMMIT}`) return overrides.commitType ?? "commit\n";
    if (key === `rev-parse ${PINNED_COMMIT}^{commit}`) return overrides.resolvedCommit ?? `${PINNED_COMMIT}\n`;
    if (key === `cat-file -t ${PINNED_COMMIT}:${PINNED_PATH}`) return overrides.blobType ?? "blob\n";
    if (key === `show ${PINNED_COMMIT}:${PINNED_PATH}`) return sourceText;
    throw new Error(`unexpected git request: ${key}`);
  };
}

test("P1T pinned Git characterization records only historical membership facts and explicit non-authority metadata", async () => {
  const result = await characterizeHistoricalProjection();
  assert.deepEqual(result, expectedPinnedRecord);
  assert.doesNotMatch(
    JSON.stringify(result),
    /tree_first_hit|place_crab_pot|bait_crab_pot|chop_tree_source|capabilit(?:y|ies)|runtime|policy|publish/i,
  );
});

test("P1T fails closed when pinned Git object identity or blob hash differs", async () => {
  await assert.rejects(
    characterizeHistoricalProjection({ gitRunner: gitFor(source, { commitType: "blob\n" }) }),
    /commit_object_drift/,
  );
  await assert.rejects(
    characterizeHistoricalProjection({ gitRunner: gitFor(source, { resolvedCommit: "a".repeat(40) }) }),
    /commit_resolution_drift/,
  );
  await assert.rejects(
    characterizeHistoricalProjection({ gitRunner: gitFor(source, { blobType: "tree\n" }) }),
    /blob_object_drift/,
  );
  await assert.rejects(
    characterizeHistoricalProjection({ gitRunner: gitFor(`${source}\n// changed`) }),
    /blob_hash_drift/,
  );
});

test("P1T constrained characterization fails closed before parsing altered CreateCapabilities form or membership", async () => {
  await assert.rejects(
    characterizeHistoricalProjection({ gitRunner: gitFor(source.replace("private static", "public static")) }),
    /blob_hash_drift/,
  );
  await assert.rejects(
    characterizeHistoricalProjection({
      gitRunner: gitFor(source.replace('result.Insert(0, "tree_first_hit")', 'result.Insert(0, "other_action")')),
    }),
    /blob_hash_drift/,
  );
  await assert.rejects(
    characterizeHistoricalProjection({
      gitRunner: gitFor(source.replace("        return result;", "        return new List<string>();")),
    }),
    /blob_hash_drift/,
  );
});
