import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSbom, generateSbom, normalizeLicenseInventory, publishWithoutOverwrite, verifySbom } from "./generate-sbom.mjs";

const lockBytes = Buffer.from("fixture lockfile\n");
const lockHash = createHash("sha256").update(lockBytes).digest("hex");
const inventory = {
  MIT: [
    { name: "zeta", versions: ["2.0.0", "1.0.0"], homepage: "https://example.test/zeta" },
    { name: "alpha", versions: ["1.0.0"], homepage: null },
  ],
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gamebuddy-sbom-"));
  await writeFile(path.join(root, "pnpm-lock.yaml"), lockBytes);
  return root;
}

test("normalizes inventory deterministically and binds exact lockfile hash", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "third_party", "sbom-node.json");
    const run = async ({ cwd, command }) => {
      assert.equal(cwd, root);
      assert.deepEqual(command, ["licenses", "list", "--json"]);
      return JSON.stringify(inventory);
    };
    const first = await generateSbom({ root, output, run });
    const second = await generateSbom({ root, output: path.join(root, "other.json"), run });
    assert.deepEqual(first, second);
    assert.equal(first.metadata.properties.find((item) => item.name.endsWith("lockfile-sha256")).value, lockHash);
    assert.deepEqual(
      first.components.map(({ name }) => name),
      ["alpha", "zeta"],
    );
    assert.ok(!JSON.stringify(first).includes(root));
    assert.ok(!JSON.stringify(first).includes("secret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-Node/Bun/C# claims before publishing", () => {
  assert.throws(
    () => normalizeLicenseInventory({ MIT: [{ name: "bad", versions: ["1"], ecosystem: "python" }] }),
    /Unsupported ecosystem claim/,
  );
  assert.throws(
    () => normalizeLicenseInventory({ MIT: [{ name: "bad", versions: ["1"], language: "Rust" }] }),
    /Unsupported language claim/,
  );
});

test("rejects an existing destination and cleans temporary output", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    await writeFile(output, "original\n");
    await assert.rejects(
      publishWithoutOverwrite(output, JSON.stringify(buildSbom({ packages: [], lockfileSha256: lockHash }))),
      (error) => error.code === "EEXIST",
    );
    assert.equal(await readFile(output, "utf8"), "original\n");
    assert.deepEqual((await readdir(root)).sort(), ["pnpm-lock.yaml", "sbom.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed without publishing when runner output is invalid", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    await assert.rejects(generateSbom({ root, output, run: async () => "not json" }), /not valid JSON/);
    await assert.rejects(readFile(output), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies an existing SBOM through an isolated temporary output without residue", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    const run = async () => JSON.stringify(inventory);
    await generateSbom({ root, output, run });
    const result = await verifySbom({
      root,
      output,
      temporaryName: ".verification-output.json",
      generate: ({ root: nestedRoot, output: nestedOutput }) => generateSbom({ root: nestedRoot, output: nestedOutput, run }),
    });
    assert.equal(result.output, output);
    await assert.rejects(readFile(path.join(root, ".verification-output.json")), (error) => error.code === "ENOENT");
    assert.deepEqual((await readdir(root)).sort(), ["pnpm-lock.yaml", "sbom.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on SBOM drift and removes its verification output", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    await writeFile(output, "stale\n");
    await assert.rejects(
      verifySbom({
        root,
        output,
        temporaryName: ".verification-output.json",
        generate: ({ output: nestedOutput }) => writeFile(nestedOutput, "fresh\n"),
      }),
      /SBOM output drifted/,
    );
    await assert.rejects(readFile(path.join(root, ".verification-output.json")), (error) => error.code === "ENOENT");
    assert.equal(await readFile(output, "utf8"), "stale\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
