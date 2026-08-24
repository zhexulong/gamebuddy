import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  combineLocaleSnapshots,
  LOCALES,
  P4A_DIGEST,
  runCoordinator,
} from "./run-stardew-navigation-p4-corpus-producer.mjs";

const sha = "a".repeat(64);
const snapshot = (locale, entries = ["opaque-a", "opaque-b"]) => ({
  artifactKind: "stardew_navigation_p4c_private_locale_snapshot",
  schemaVersion: 1,
  targetVersion: "1.6.15.24356",
  locale,
  p4aInputDigest: P4A_DIGEST,
  producerInputDigest: sha,
  producerInputManifest: [],
  entries: entries.map((key) => ({
    key,
    rawDisplayToken: `${locale}-${key}`,
    displayTokenKind: "raw_display_token_not_runtime_parsed",
  })),
});
test("combines only equal locale keysets and preserves the three raw tokens privately", () => {
  const combined = combineLocaleSnapshots(LOCALES.map((locale) => snapshot(locale)));
  assert.equal(combined.entries.length, 2);
  assert.deepEqual(Object.keys(combined.entries[0].rawDisplayTokens), LOCALES);
  assert.match(combined.canonicalDigest, /^[a-f0-9]{64}$/);
});
test("rejects a locale that omits a source display token key", () => {
  const snapshots = LOCALES.map((locale) => snapshot(locale));
  snapshots[1].entries.shift();
  assert.throws(() => combineLocaleSnapshots(snapshots), /locale_keysets_mismatch/);
});
test("rejects locale keyset drift", () =>
  assert.throws(
    () => combineLocaleSnapshots([snapshot("en-US"), snapshot("zh-CN"), snapshot("ja-JP", ["opaque-a"])]),
    /locale_keysets_mismatch/,
  ));
test("coordinator accepts only strict redacted extractor reports and atomically combines private snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4c-test-"));
  const outputParent = join(root, "private");
  await mkdir(outputParent);
  try {
    const report = await runCoordinator({
      gameRoot: root,
      privateOutput: join(outputParent, "out.json"),
      invokeExtractor: async ({ locale, output }) => {
        await (await import("node:fs/promises")).writeFile(output, JSON.stringify(snapshot(locale)));
        return {
          out: JSON.stringify({
            kind: "stardew_navigation_p4c_locale_extract",
            schemaVersion: 1,
            targetVersion: "1.6.15.24356",
            locale,
            p4aInputDigest: P4A_DIGEST,
            producerInputDigest: sha,
            recordCount: 2,
            mutationCount: 0,
            gameLaunched: false,
            nonClaim: "private only",
          }),
          err: "",
        };
      },
    });
    assert.equal(report.gameLaunched, false);
    const combined = JSON.parse(await readFile(join(outputParent, "out.json"), "utf8"));
    assert.equal(combined.entries.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects extractor stdout that contains forbidden text-shaped field names", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4c-test-"));
  const parent = join(root, "private");
  await mkdir(parent);
  try {
    await assert.rejects(
      runCoordinator({
        gameRoot: root,
        privateOutput: join(parent, "out.json"),
        invokeExtractor: async () => ({
          out: JSON.stringify({
            kind: "stardew_navigation_p4c_locale_extract",
            schemaVersion: 1,
            targetVersion: "1.6.15.24356",
            locale: "en-US",
            p4aInputDigest: P4A_DIGEST,
            producerInputDigest: sha,
            recordCount: 1,
            mutationCount: 0,
            gameLaunched: false,
            nonClaim: "x",
            sourcePath: "forbidden",
          }),
          err: "",
        }),
      }),
      /extractor_stdout_schema_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("removes a private temporary snapshot when atomic rename fails", async () => {
  const parent = await mkdtemp(join(tmpdir(), "p4c-atomic-"));
  const output = join(parent, "snapshot.json");
  try {
    await assert.rejects(
      atomicJson(
        output,
        { private: "value" },
        {
          move: async () => {
            throw new Error("rename_failed");
          },
        },
      ),
      /rename_failed/,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("CLI executes from a native Windows-style absolute script path", () => {
  const script = fileURLToPath(new URL("./run-stardew-navigation-p4-corpus-producer.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: --game-root/);
});
