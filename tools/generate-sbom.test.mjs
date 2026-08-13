import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSbom,
  generateSbom,
  normalizeLicenseInventory,
  publishWithoutOverwrite,
  verifySbom,
} from "./generate-sbom.mjs";

const lockBytes = Buffer.from("fixture lockfile\n");
const lockHash = createHash("sha256").update(lockBytes).digest("hex");
const policy = {
  schemaVersion: 1,
  descriptor: { name: "gamebuddy-node-sbom", version: "1" },
  bom: {
    format: "CycloneDX",
    specVersion: "1.5",
    component: { type: "application", name: "gamebuddy", version: "0.0.0" },
  },
  inventory: {
    scope: "node-dependencies-only",
    acceptedClaimEcosystems: ["node", "node.js", "nodejs", "npm", "pnpm"],
    input: { command: "pnpm licenses list --json", lockfile: "pnpm-lock.yaml" },
  },
};
const inventory = {
  MIT: [
    { name: "zeta", versions: ["2.0.0", "1.0.0"], homepage: "https://example.test/zeta" },
    { name: "alpha", versions: ["1.0.0"], homepage: null },
  ],
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gamebuddy-sbom-"));
  await writeFile(path.join(root, "pnpm-lock.yaml"), lockBytes);
  await mkdir(path.join(root, "third_party"));
  await writeFile(path.join(root, "third_party", "sbom-node-policy.json"), JSON.stringify(policy));
  return root;
}

test("normalizes inventory deterministically and embeds descriptor identity", async () => {
  const root = await fixture();
  try {
    const run = async ({ cwd, command }) => {
      assert.equal(cwd, root);
      assert.deepEqual(command, ["licenses", "list", "--json"]);
      return JSON.stringify(inventory);
    };
    const first = await generateSbom({ root, output: path.join(root, "one.json"), run });
    const second = await generateSbom({ root, output: path.join(root, "two.json"), run });
    assert.deepEqual(first, second);
    const values = Object.fromEntries(first.metadata.properties.map(({ name, value }) => [name, value]));
    assert.deepEqual(first.metadata.component, policy.bom.component);
    assert.equal(first.bomFormat, policy.bom.format);
    assert.equal(first.specVersion, policy.bom.specVersion);
    assert.equal(values["gamebuddy:sbom-policy-schema-version"], String(policy.schemaVersion));
    assert.equal(values["gamebuddy:sbom-descriptor-name"], policy.descriptor.name);
    assert.equal(values["gamebuddy:sbom-descriptor-version"], policy.descriptor.version);
    assert.equal(values["gamebuddy:inventory-scope"], policy.inventory.scope);
    assert.equal(values["gamebuddy:accepted-claim-ecosystems"], policy.inventory.acceptedClaimEcosystems.join(","));
    assert.equal(values["gamebuddy:generator-input-command"], policy.inventory.input.command);
    assert.equal(values["gamebuddy:generator-input-lockfile"], policy.inventory.input.lockfile);
    assert.equal(values["gamebuddy:generator-input-lockfile-sha256"], lockHash);
    assert.deepEqual(
      first.components.map(({ name }) => name),
      ["alpha", "zeta"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects claims outside descriptor scope", () => {
  assert.throws(
    () => normalizeLicenseInventory({ MIT: [{ name: "bad", versions: ["1"], ecosystem: "python" }] }),
    /Unsupported ecosystem claim/,
  );
});
test("rejects an existing destination without residue", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    await writeFile(output, "original\n");
    await assert.rejects(
      publishWithoutOverwrite(output, JSON.stringify(buildSbom({ packages: [], lockfileSha256: lockHash, policy }))),
      (error) => error.code === "EEXIST",
    );
    assert.equal(await readFile(output, "utf8"), "original\n");
    assert.deepEqual((await readdir(root)).sort(), ["pnpm-lock.yaml", "sbom.json", "third_party"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fails closed on invalid runner output", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      generateSbom({ root, output: path.join(root, "sbom.json"), run: async () => "not json" }),
      /not valid JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("verify detects descriptor schema, identity, and input-scope drift", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    const run = async () => JSON.stringify(inventory);
    await generateSbom({ root, output, run });
    const descriptor = path.join(root, "third_party", "sbom-node-policy.json");
    for (const [mutate, expected] of [
      [
        (p) => {
          p.schemaVersion = 2;
        },
        /schema version/,
      ],
      [
        (p) => {
          p.descriptor.name = "wrong";
        },
        /identity/,
      ],
      [
        (p) => {
          p.bom.component.name = "other";
        },
        /BOM schema/,
      ],
      [
        (p) => {
          p.inventory.scope = "all";
        },
        /input scope/,
      ],
      [
        (p) => {
          p.inventory.input.command = "other command";
        },
        /input scope/,
      ],
      [
        (p) => {
          p.inventory.input.lockfile = "other-lock.yaml";
        },
        /input scope/,
      ],
    ]) {
      const invalid = structuredClone(policy);
      mutate(invalid);
      await writeFile(descriptor, JSON.stringify(invalid));
      await assert.rejects(
        verifySbom({ root, output, generate: ({ root: r, output: o }) => generateSbom({ root: r, output: o, run }) }),
        expected,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("verify fails on valid descriptor version drift and cleans temporary output", async () => {
  const root = await fixture();
  try {
    const output = path.join(root, "sbom.json");
    const run = async () => JSON.stringify(inventory);
    await generateSbom({ root, output, run });
    const changed = structuredClone(policy);
    changed.descriptor.version = "2";
    await writeFile(path.join(root, "third_party", "sbom-node-policy.json"), JSON.stringify(changed));
    await assert.rejects(
      verifySbom({ root, output, generate: ({ root: r, output: o }) => generateSbom({ root: r, output: o, run }) }),
      /identity/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
