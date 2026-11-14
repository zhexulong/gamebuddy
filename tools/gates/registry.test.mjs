/**
 * The registry's falsifiers: every rule it refuses by is driven red on a tree built for it, and the real tree is read
 * whole.
 *
 * Each case is a synthetic repository that differs from a GOOD one by exactly one defect, so the finding the registry
 * prints is the defect rather than a consequence of a broken fixture. The last case reads this repository, because a
 * registry that is green only over synthetic trees has not measured the population it exists for - and it asserts the
 * one property that makes the count honest: `examined = declared + undeclared`, with no file falling between them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { GATE_DOMAINS, GATE_DIRECTORIES, directoryDomain, gateFiles, readDeclarations } from "./registry.mjs";

const REGISTRY = resolve(fileURLToPath(import.meta.url), "../registry.mjs");

/** A declaration with the four fields, written the way a gate writes one. */
const declaration = ({ id, domain = "meta", tier = "l0", kind = "contract" }) =>
  `export const gateDeclaration = { id: "${id}", domain: "${domain}", tier: "${tier}", kind: "${kind}" };\n`;

/** A repository whose `tools/` holds exactly the gate files named, each with the body given. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "gate-registry-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  return root;
}

/** Every gate file in a tree, named the way a gate is named. */
const gate = (slug, body) => [`tools/${slug}.mjs`, body];

/**
 * Build the tree, run the reading over it, and remove it - AWAITING the reading first.
 *
 * The `await` is the whole of this helper: `readDeclarations` yields to the event loop between files, so a `finally`
 * that fires on the returned promise deletes the tree under the reader and every case reads as "unreadable".
 */
async function withTree(files, run) {
  const root = tree(Object.fromEntries(files));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const findingFor = (reading, code) => reading.findings.filter((finding) => finding.code === code);

// -------------------------------------------------------------------------------------------------------------
// The good tree: a declaration present, in the closed sets, with the id the file's own name gives it.
// -------------------------------------------------------------------------------------------------------------
test("a gate that declares itself is declared, and its fields are the ones it wrote", async () => {
  await withTree(
    [
      gate("check-a", `${declaration({ id: "check-a", domain: "stardew", tier: "l2", kind: "ratchet" })}`),
      gate("audit-b", `${declaration({ id: "audit-b", domain: "data", tier: "l1", kind: "totality" })}`),
    ],
    async (root) => {
      const reading = await readDeclarations({ root });
      assert.deepEqual(reading.findings, []);
      assert.deepEqual(reading.undeclared, []);
      assert.deepEqual(
        reading.declared.map((entry) => [entry.path, entry.id, entry.domain, entry.tier, entry.kind]),
        [
          ["tools/audit-b.mjs", "audit-b", "data", "l1", "totality"],
          ["tools/check-a.mjs", "check-a", "stardew", "l2", "ratchet"],
        ],
      );
    },
  );
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 1: a gate file that declares nothing.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a gate file that declares nothing is named, not counted", async () => {
  await withTree(
    [gate("check-declared", declaration({ id: "check-declared" })), gate("check-silent", "// nothing here\n")],
    async (root) => {
      const reading = await readDeclarations({ root });
      assert.equal(reading.examined, 2);
      assert.equal(reading.declared.length, 1);
      assert.deepEqual(reading.undeclared, ["tools/check-silent.mjs"]);
      assert.deepEqual(
        findingFor(reading, "gate_without_a_declaration").map((finding) => finding.id),
        ["tools/check-silent.mjs"],
      );
    },
  );
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 2: two gates claiming one identity.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER two gate files declaring one id are a collision naming both paths", async () => {
  // The id is the file's slug, so a collision is two paths that share one base name - what a directory move into an
  // undeclared second location produces. Declaring both locations is what makes the second file part of the population.
  await withTree(
    [
      gate("check-same", declaration({ id: "check-same" })),
      ["tools/gates/arch/check-same.mjs", declaration({ id: "check-same", domain: "arch" })],
    ],
    async (root) => {
      const reading = await readDeclarations({
        root,
        files: ["tools/check-same.mjs", "tools/gates/arch/check-same.mjs"],
      });
      const collisions = findingFor(reading, "gate_id_collision");
      assert.equal(reading.declared.length, 1, "the second claim is not published as a declaration");
      assert.equal(collisions.length, 1);
      assert.equal(collisions[0].id, "check-same:tools/check-same.mjs:tools/gates/arch/check-same.mjs");
    },
  );
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 4: a gate filed in a domain directory its declaration contradicts.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a gate filed under one domain and declaring another is invalid, naming both", async () => {
  // The layout is only an authority if the two words about a gate agree. Without this rule `tools/gates/meta/` is a
  // folder, and a stardew gate filed in it declares a domain no reader can trust.
  await withTree(
    [
      ["tools/gates/meta/check-filed.mjs", declaration({ id: "check-filed", domain: "product" })],
      ["tools/gates/meta/check-agreed.mjs", declaration({ id: "check-agreed", domain: "meta" })],
    ],
    async (root) => {
      const reading = await readDeclarations({ root });
      assert.equal(reading.examined, 2, "both files are in the population, so the finding is not a scan gap");
      assert.deepEqual(
        findingFor(reading, "gate_declaration_invalid").map((finding) => finding.id),
        ["tools/gates/meta/check-filed.mjs:domain"],
      );
      assert.match(
        findingFor(reading, "gate_declaration_invalid")[0].detail,
        /`product` is declared, but the file is filed under `meta`/u,
      );
      assert.deepEqual(reading.undeclared, ["tools/gates/meta/check-filed.mjs"]);
      assert.deepEqual(
        reading.declared.map((entry) => entry.path),
        ["tools/gates/meta/check-agreed.mjs"],
      );
    },
  );
});

test("a gate directly in tools/ declares its domain freely, because no directory files it", async () => {
  await withTree([gate("check-unsorted", declaration({ id: "check-unsorted", domain: "stardew" }))], async (root) => {
    const reading = await readDeclarations({ root });
    assert.deepEqual(reading.findings, []);
    assert.equal(directoryDomain("tools/check-unsorted.mjs"), null);
    assert.equal(directoryDomain("tools/gates/meta/check-unsorted.mjs"), "meta");
  });
});

// -------------------------------------------------------------------------------------------------------------
// Falsifier 3: a value outside its closed set.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER a domain outside the closed set is invalid, and names the field", async () => {
  await withTree([gate("check-a", declaration({ id: "check-a", domain: "gameplay" }))], async (root) => {
    const reading = await readDeclarations({ root });
    assert.deepEqual(
      findingFor(reading, "gate_declaration_invalid").map((finding) => finding.id),
      ["tools/check-a.mjs:domain"],
    );
    assert.match(
      findingFor(reading, "gate_declaration_invalid")[0].detail,
      /gameplay.*not one of product \| data \| arch \| stardew \| meta/u,
    );
    assert.deepEqual(reading.undeclared, ["tools/check-a.mjs"]);
  });
});

test("FALSIFIER a tier and a kind outside their closed sets are invalid, each naming its field", async () => {
  await withTree([gate("check-a", declaration({ id: "check-a", tier: "l3", kind: "spot-check" }))], async (root) => {
    const reading = await readDeclarations({ root });
    assert.deepEqual(
      findingFor(reading, "gate_declaration_invalid")
        .map((finding) => finding.id)
        .sort(),
      ["tools/check-a.mjs:kind", "tools/check-a.mjs:tier"],
    );
  });
});

test("FALSIFIER an id that is not the file's own slug is invalid, so a rename cannot leave it behind", async () => {
  await withTree([gate("check-renamed", declaration({ id: "check-original" }))], async (root) => {
    const reading = await readDeclarations({ root });
    assert.deepEqual(
      findingFor(reading, "gate_declaration_invalid").map((finding) => finding.id),
      ["tools/check-renamed.mjs:id"],
    );
    assert.match(findingFor(reading, "gate_declaration_invalid")[0].detail, /check-renamed.*check-original/u);
  });
});

test("FALSIFIER a declaration that is not a literal object is invalid, so a computed one cannot pass", async () => {
  await withTree(
    [
      gate("check-computed", `export const gateDeclaration = make("check-computed");\n`),
      gate("check-reference", `const declared = make("check-reference");\nexport const gateDeclaration = declared;\n`),
      gate(
        "check-symbol-value",
        `const domain = "meta";\nexport const gateDeclaration = { id: "check-symbol-value", domain, tier: "l0", kind: "contract" };\n`,
      ),
      gate("check-missing-field", `export const gateDeclaration = { id: "check-missing-field", domain: "meta" };\n`),
    ],
    async (root) => {
      const reading = await readDeclarations({ root });
      assert.deepEqual(
        findingFor(reading, "gate_declaration_invalid")
          .map((finding) => finding.id)
          .sort(),
        [
          "tools/check-computed.mjs:shape",
          "tools/check-missing-field.mjs:kind",
          "tools/check-missing-field.mjs:tier",
          "tools/check-reference.mjs:shape",
          "tools/check-symbol-value.mjs:shape",
        ],
      );
    },
  );
});

test("FALSIFIER a declaration mentioned only in prose is not a declaration", async () => {
  const body = [
    '// The tree writes: export const gateDeclaration = { id: "check-a", domain: "meta", tier: "l0", kind: "contract" };',
    '/* export const gateDeclaration = { id: "check-a" }; */',
    "const declaration = 'export const gateDeclaration = { id: \"check-a\" };';",
    "export { declaration };",
    "",
  ].join("\n");
  await withTree([gate("check-a", body)], async (root) => {
    const reading = await readDeclarations({ root });
    assert.deepEqual(
      findingFor(reading, "gate_without_a_declaration").map((finding) => finding.id),
      ["tools/check-a.mjs"],
    );
  });
});

// -------------------------------------------------------------------------------------------------------------
// The population rule itself: the directory list and the name rule, not a glob each caller decides.
// -------------------------------------------------------------------------------------------------------------
test("the population is the declared directories and the name rule: a falsifier and a nested file are not gates", async () => {
  await withTree(
    [
      gate("check-a", declaration({ id: "check-a" })),
      gate("check-a.test", "// a falsifier\n"),
      gate("check-a.mutation", "// a mutation driver\n"),
      gate("not-a-gate", "// an ordinary module\n"),
      ["tools/gates/meta/check-sorted.mjs", declaration({ id: "check-sorted", domain: "meta" })],
      ["tools/gates/meta/check-sorted.test.mjs", "// a falsifier beside a sorted gate\n"],
      ["tools/scripts/check-nested.mjs", declaration({ id: "check-nested" })],
    ],
    (root) => {
      assert.deepEqual(gateFiles({ root }), ["tools/check-a.mjs", "tools/gates/meta/check-sorted.mjs"]);
    },
  );
});

test("the directories are derived from the domain list, so filing a domain is a move and no edit", () => {
  for (const domain of GATE_DOMAINS)
    assert.ok(
      GATE_DIRECTORIES.includes(`tools/gates/${domain}`),
      `\`${domain}\` has no directory: a gate declaring it cannot be filed anywhere but \`tools/\``,
    );
  assert.ok(GATE_DIRECTORIES.includes("tools"), "the unsorted half of the population still lives in tools/");
});

// -------------------------------------------------------------------------------------------------------------
// Zero population is blocked, never green: an empty scan agrees with itself.
// -------------------------------------------------------------------------------------------------------------
test("FALSIFIER an empty population is blocked with exit 2, not passed", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-registry-empty-"));
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    const run = spawnSync(process.execPath, [REGISTRY, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /gate_registry_no_population/u);
    assert.doesNotMatch(run.stdout, /gate_registry: passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------------------------
// This repository: the population it really has, and that no file falls between declared and undeclared.
// -------------------------------------------------------------------------------------------------------------
test("the real tree: every gate file is either declared or named, and the reading adds up", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = gateFiles({ root });
  assert.ok(files.length > 0, "the scan must find this repository's gates");
  const reading = await readDeclarations({ root, files });
  assert.equal(reading.examined, files.length);
  assert.equal(reading.declared.length + reading.undeclared.length, reading.examined);
  assert.deepEqual(reading.findings, [], `undeclared: ${reading.undeclared.join(", ")}`);
});
