import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CARD_SCORE_THRESHOLD,
  assertReleasePersonaHygiene,
  cardScore,
  readDeclaredArtifactFiles,
  scanReleasePersonaHygiene,
} from "./check-release-persona-hygiene.mjs";

/**
 * The release persona-hygiene gate.
 *
 * What each test catches, and why the fixture is that shape:
 *
 * 1. `a packaged generation with no character content passes` - a gate that
 *    fails everything would be removed within a week, so the clean case is a
 *    first-class assertion. The fixture is deliberately artifact-shaped
 *    (`index.html`, hashed browser assets, a multi-megabyte binary) because the
 *    real generation contains exactly those.
 * 2. `the committed development seed is outside the artifact and stays legal` -
 *    this is the honest boundary: `assets/tavern/presets/default-companion` IS a
 *    character card in the repository, and it must not make the gate fail. The
 *    test proves the seed exists (so the clean pass is not vacuous) and that a
 *    generation root does not contain it.
 * 3. `a planted card file fails the build by path` - copying `card.json` into a
 *    generation is the plainest way third-party content ships.
 * 4. `a card payload inlined in an admitted asset fails` - the artifact
 *    allowlist admits any reachable `.js`; only a byte-level gate sees a card
 *    that was renamed or embedded. This is the case that a name-based check
 *    would miss, so it is the reason the gate reads bytes. The fixture is a card
 *    with its own name and authored prose, because that is what a card is; a
 *    bare spec marker is not (see 9).
 * 5. `an embedded card PNG fails` - the ST ecosystem's other carrier is a PNG
 *    with a `chara` text chunk.
 * 6. `an untyped v1 card under an arbitrary name fails` - a card without a
 *    `spec` member is still a card; the CCv2 core fields identify it.
 * 7. `the failure names the nested asset path` - a bounded message is only
 *    actionable if it says WHICH asset would ship.
 * 8. `a missing artifact root is refused` - the gate never silently passes for
 *    want of a root.
 * 9. `the product's own import-box placeholder is not a card payload` - the
 *    regression this gate shipped with. The bytes below are the ones Vite
 *    bundles out of `CharacterCardImport.tsx`; the marker-only rule refused
 *    every generation built after it landed over this string, so a test keeps
 *    the help text and the gate compatible.
 * 10. `a dependency manifest with a long description is not a card` - the same
 *    class again, one rule later: `name` + a 69-character `description` is
 *    exactly `CARD_SCORE_THRESHOLD`, so the score-only rule refused
 *    `node_modules/@aws/lambda-invoke-store/package.json` and the generation
 *    could not be built at all. The fixture is that file's own manifest.
 * 11. `a spec-stripped reviewed card is still a card` - the case the untyped
 *    rule exists for, run against the repository's OWN reviewed card with its
 *    `spec` member deleted, so the card-only-field requirement cannot be
 *    traded for a gate that only reads typed cards.
 * 12. `a planted reviewed card that keeps its spec still fails` - the typed
 *     half, at a file name that is not card-shaped, so the pass in 10 is not
 *     bought by weakening the payload rule.
 * 13. `the same dependency bytes behind a link get the same verdict as real
 *     files` - the determinism property. `readdir` reports a junction or symlink
 *     as neither a file nor a directory, so the old walk sent a linked dependency
 *     into `inspectFile`, whose link guard threw
 *     `release_persona_hygiene_non_regular_entry`: identical bytes, two answers,
 *     decided by the checkout's link representation. The fixture materializes the
 *     same two files - the manifest of 10 and a card payload inlined beside it -
 *     as real copies, as hardlinks, and behind every link kind the platform can
 *     construct, and requires one verdict for all of them.
 * 14. `a card inside the dependency closure is in scope` - dependency bytes ship,
 *     so they are read, and a card dropped among them fails the build.
 * 15. `a directory reached twice is read once and still fails once` - two declared
 *     paths that resolve to one directory are one set of bytes: one finding, never
 *     a skipped byte.
 * 16. `the scan reports the surface it covered` - the census IS the surface
 *     statement: the same read that decides the verdict says how many declared
 *     files it read, how many it only name-checked, and how many links it
 *     resolved. `declaredFiles` is the declared set itself.
 * 17. `a file the generation does not declare is not part of the surface` and
 * 18. `a card the generation declares is inspected` - the recorded owner ruling,
 *     both halves. The surface is the packaged generation artifact taken from the
 *     generation's OWN inventory, so a card in a sibling generation, or inside the
 *     generation but not declared, is not read and cannot change the verdict -
 *     while the same bytes declared by the inventory are read and refuse the
 *     generation. Together they assert that the inspected set equals the declared
 *     set: widening the surface back to "whatever is reachable" fails 17, and
 *     reading something narrower than the declaration fails 18.
 * 19. `a directory that is not a generation is refused, never walked` - the old
 *     whole-output-root default. A directory holding a pointer and generations
 *     declares no inventory, so it is refused with a bounded code, and so are a
 *     missing, unparseable, and path-escaping inventory.
 * 20. `a declared path that ships nothing, or is not a file, is refused` - the
 *     declaration is a claim the tree has to satisfy, and a claim it does not
 *     satisfy refuses the generation rather than being silently skipped.
 * 21. `a dangling declared link fails the gate rather than being dropped` - the
 *     link property, now reached through a declared path: a touched link that
 *     resolves to nothing refuses the generation.
 * 22. `the CLI refuses an output root and reads a generation` - the CLI end to
 *     end: a generation is scanned and censused, an output root and the
 *     no-argument default are refused with `inventory_required`.
 *
 * Fixtures declare their file set the way the builder does - from what the tree
 * ships - because the gate now reads the generation's own `production-inventory.json`
 * and nothing else.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
const INVENTORY = "production-inventory.json";
const GATE_SCRIPT = fileURLToPath(new URL("./check-release-persona-hygiene.mjs", import.meta.url));
const runNode = promisify(execFile);

async function readFileUtf8(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

/** The generation's own declaration: the inventory the builder writes for it. */
async function declareArtifactFiles(root, paths) {
  const entries = [...paths]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((path) => ({ path, type: "file", mode: "644", sha256: "0".repeat(64), origin: { kind: "typescript_emit" } }));
  await writeFile(
    path.join(root, INVENTORY),
    `${JSON.stringify(
      {
        schema: "gamebuddy-host-production-inventory/v4",
        entries,
        externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["fixture"] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Declares what the tree ships, exactly as `createInventory` does for a build. */
async function declareArtifactFromDisk(root) {
  const paths = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const child = path.join(directory, entry.name);
      const item = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (item === INVENTORY) continue;
      const state = await lstat(child);
      const resolved = state.isSymbolicLink() ? await stat(child) : state;
      if (resolved.isDirectory()) {
        await visit(child, item);
        continue;
      }
      paths.push(item);
    }
  };
  await visit(root, "");
  await declareArtifactFiles(root, paths);
}

async function scanGeneration(root) {
  await declareArtifactFromDisk(root);
  return scanReleasePersonaHygiene({ artifactRoot: root });
}

async function assertGeneration(root) {
  await declareArtifactFromDisk(root);
  return assertReleasePersonaHygiene({ artifactRoot: root });
}

async function generationRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "release-hygiene-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "browser", "tavern", "v1", "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><div id=app></div>\n", "utf8");
  await writeFile(path.join(root, "assets", "app-0123abcd.js"), "export const boot = 1;\n", "utf8");
  // A stand-in for the bundled runtime / native helpers: larger than the scan
  // ceiling, and legitimate.
  await writeFile(path.join(root, "assets", "large-binary-9999beef.js"), Buffer.alloc(9 * 1024 * 1024, 0x41));
  return root;
}

/** A directory link kind this platform can construct without elevation. */
const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

/** The dependency manifest of the reported false positive, verbatim. */
const DEPENDENCY_MANIFEST = `${JSON.stringify(
  {
    name: "@aws/lambda-invoke-store",
    version: "0.3.0",
    description: "Invoke scoped data storage for AWS Lambda Node.js Runtime Environment",
    main: "./dist-cjs/invoke-store.js",
    license: "Apache-2.0",
  },
  null,
  2,
)}\n`;
/** A card payload inlined in an admitted asset, as in test 4. */
const INLINED_CARD = `export const bundled = ${JSON.stringify({
  spec: "chara_card_v2",
  data: {
    name: "Kohaku",
    description:
      "A rival farmhand from another valley who talks about the weather and never about herself, and who is not the companion this product reviewed.",
    personality: "warm, guarded",
  },
})};\n`;

/**
 * A generation whose dependency entry holds the same bytes in one of four forms:
 * real copies, hardlinks, one directory link, or two file links. The store lives
 * OUTSIDE the generation, as pnpm's does, so a link is the only route to the
 * bytes. Returns `link` (the kind constructed, or null for real bytes) and
 * `unavailable` when this platform cannot build that link.
 */
async function dependencyClosureRoot(t, kind) {
  const scratch = await mkdtemp(path.join(tmpdir(), `release-hygiene-${kind}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "generation");
  const store = path.join(scratch, "store", "@aws+lambda-invoke-store@0.3.0", "node_modules", "@aws", "lambda-invoke-store");
  await mkdir(path.join(store, "assets"), { recursive: true });
  await writeFile(path.join(store, "package.json"), DEPENDENCY_MANIFEST, "utf8");
  await writeFile(path.join(store, "assets", "preset-abcdef12.js"), INLINED_CARD, "utf8");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html>\n", "utf8");
  const visible = path.join(root, "node_modules", "@aws", "lambda-invoke-store");
  await mkdir(path.join(root, "node_modules", "@aws"), { recursive: true });
  if (kind === "real-files") {
    await mkdir(path.join(visible, "assets"), { recursive: true });
    await writeFile(path.join(visible, "package.json"), DEPENDENCY_MANIFEST, "utf8");
    await writeFile(path.join(visible, "assets", "preset-abcdef12.js"), INLINED_CARD, "utf8");
    return { root, link: null };
  }
  if (kind === "hardlinks") {
    await mkdir(path.join(visible, "assets"), { recursive: true });
    await link(path.join(store, "package.json"), path.join(visible, "package.json"));
    await link(path.join(store, "assets", "preset-abcdef12.js"), path.join(visible, "assets", "preset-abcdef12.js"));
    return { root, link: null };
  }
  try {
    if (kind === "directory-link") {
      await symlink(store, visible, DIRECTORY_LINK_TYPE);
    } else {
      await mkdir(path.join(visible, "assets"), { recursive: true });
      await symlink(path.join(store, "package.json"), path.join(visible, "package.json"), "file");
      await symlink(path.join(store, "assets", "preset-abcdef12.js"), path.join(visible, "assets", "preset-abcdef12.js"), "file");
    }
  } catch (error) {
    return { root, link: null, unavailable: `${error.code ?? error.message}` };
  }
  return { root, link: kind };
}

test("a packaged generation with no character content passes", async (t) => {
  const root = await generationRoot(t);
  assert.deepEqual(await scanGeneration(root), []);
  const result = await assertGeneration(root);
  assert.deepEqual(result.findings, []);
});

test("the committed development seed is outside the artifact and stays legal", async (t) => {
  const root = await generationRoot(t);
  // The seed really is a card on disk: the boundary being asserted is location,
  // not content. A gate that also refused the repository seed would forbid the
  // reviewed live-run card the product ships its own persona from.
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  assert.equal(existsSync(seed), true, "the reviewed dev seed must exist for this boundary to mean anything");
  const seedBytes = await readFileUtf8(seed);
  assert.match(seedBytes, /"spec"\s*:\s*"chara_card_v2"/u, "the dev seed IS a card, by bytes");
  assert.deepEqual(await scanGeneration(root), []);
});

test("a planted card file fails the build by path", async (t) => {
  const root = await generationRoot(t);
  await writeFile(path.join(root, "card.json"), JSON.stringify({ spec: "chara_card_v2", data: { name: "x" } }), "utf8");
  await assert.rejects(assertGeneration(root), /release_persona_hygiene_violation:card\.json/);
  assert.deepEqual(await scanGeneration(root), [
    { path: "card.json", kind: "companion_card_file" },
  ]);
});

test("a card payload inlined in an admitted asset fails", async (t) => {
  const root = await generationRoot(t);
  // Exactly the shape the artifact allowlist admits: a reachable `.js` module.
  // The payload is a card - a name of its own and authored prose in a card's
  // prose field - not a marker on its own.
  await writeFile(path.join(root, "browser", "tavern", "v1", "assets", "preset-abcdef12.js"), INLINED_CARD, "utf8");
  await assert.rejects(
    assertGeneration(root),
    /release_persona_hygiene_violation:browser\/tavern\/v1\/assets\/preset-abcdef12\.js:card_payload/,
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "browser/tavern/v1/assets/preset-abcdef12.js", kind: "card_payload" },
  ]);
});

test("an embedded card PNG fails", async (t) => {
  const root = await generationRoot(t);
  await writeFile(
    path.join(root, "assets", "portrait-1111aaaa.png"),
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk("tEXt", Buffer.from("chara\0eyJzcGVjIjoiY2hhcmFfY2FyZF92MiJ9", "utf8")),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "assets/portrait-1111aaaa.png", kind: "embedded_card_png" },
  ]);
});

test("an untyped v1 card under an arbitrary name fails", async (t) => {
  const root = await generationRoot(t);
  await writeFile(
    path.join(root, "kohaku-backup.json"),
    JSON.stringify({
      name: "Kohaku",
      description: "d",
      personality: "p",
      scenario: "s",
      first_mes: "hi",
      mes_example: "e",
    }),
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "kohaku-backup.json", kind: "untyped_card_payload" },
  ]);
});

test("the product's own import-box placeholder is not a card payload", async (t) => {
  const root = await generationRoot(t);
  // The exact bytes Vite bundles out of `CharacterCardImport.tsx`: the example
  // the import box shows the player. It carries the spec marker - and no prose
  // field, and a name that is one ellipsis - because it is help text, not a card.
  await writeFile(
    path.join(root, "browser", "tavern", "v1", "assets", "import-abcdef12.js"),
    ',{className:`form-textarea`,"aria-label":i.importPasteLabel,rows:4,placeholder:`{"spec":"chara_card_v3","data":{"name":"…"}}`,value:l,onChange:e=>u(e.target.value)},',
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), []);
  const result = await assertGeneration(root);
  assert.deepEqual(result.findings, []);
});

test("the failure names the nested asset path", async (t) => {
  const root = await generationRoot(t);
  await mkdir(path.join(root, "native", "stardew-mod", "GameBuddy"), { recursive: true });
  await writeFile(
    path.join(root, "native", "stardew-mod", "GameBuddy", "worldbook.json"),
    JSON.stringify({ schemaVersion: 1, entries: [] }),
    "utf8",
  );
  await assert.rejects(
    assertGeneration(root),
    /release_persona_hygiene_violation:native\/stardew-mod\/GameBuddy\/worldbook\.json:companion_card_file/,
  );
});

test("a missing artifact root is refused", async () => {
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: undefined }), /release_persona_hygiene_root_required/);
});

test("the weighted card score puts the reviewed card far above the placeholder", async () => {
  // The threshold's own anchor: the reviewed card's score is stated as a fact,
  // not as prose. 3 (spec) + 14 (all six core fields) + 3 (its 1658-char
  // description) = 20; the import-box placeholder is 3 (spec) + 2 (a name that
  // is one ellipsis) = 5.
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  const reviewed = JSON.parse(await readFileUtf8(seed));
  assert.equal(cardScore(reviewed), 20, "the reviewed card scores 20");
  assert.equal(cardScore({ spec: "chara_card_v3", data: { name: "…" } }), 5, "the placeholder scores 5");
  assert.ok(cardScore(reviewed) > CARD_SCORE_THRESHOLD, "the reviewed card clears the threshold comfortably");
  assert.ok(CARD_SCORE_THRESHOLD > cardScore({ spec: "chara_card_v3", data: { name: "…" } }), "the placeholder stays below it");
});

test("an untyped card that omits mes_example is still a card", async (t) => {
  // The former rule demanded all six CCv2 core fields, so a real card without
  // `mes_example` passed. Five fields score 12, well past the threshold.
  const root = await generationRoot(t);
  await writeFile(
    path.join(root, "kohaku-no-example.json"),
    JSON.stringify({ name: "Kohaku", description: "d", personality: "p", scenario: "s", first_mes: "hi" }),
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "kohaku-no-example.json", kind: "untyped_card_payload" },
  ]);
});

test("a dependency manifest with a long description is not a card", async (t) => {
  const root = await generationRoot(t);
  // The real bytes that stopped the build: a `description` of 69 characters
  // beside a `name` scores 2 + 3 + 3 = 8, which IS the threshold.
  const manifest = {
    name: "@aws/lambda-invoke-store",
    version: "0.3.0",
    description: "Invoke scoped data storage for AWS Lambda Node.js Runtime Environment",
    main: "./dist-cjs/invoke-store.js",
    license: "Apache-2.0",
  };
  assert.equal(cardScore(manifest), CARD_SCORE_THRESHOLD, "the manifest scores exactly the threshold");
  await mkdir(path.join(root, "node_modules", "@aws", "lambda-invoke-store"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "@aws", "lambda-invoke-store", "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), []);
});

test("a spec-stripped reviewed card is still a card", async (t) => {
  const root = await generationRoot(t);
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  const stripped = JSON.parse(await readFileUtf8(seed));
  delete stripped.spec;
  assert.equal(stripped.spec, undefined);
  await writeFile(path.join(root, "companion-backup.json"), `${JSON.stringify(stripped)}\n`, "utf8");
  assert.deepEqual(await scanGeneration(root), [
    { path: "companion-backup.json", kind: "untyped_card_payload" },
  ]);
});

test("a planted reviewed card that keeps its spec still fails", async (t) => {
  const root = await generationRoot(t);
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  await writeFile(path.join(root, "companion-backup.json"), await readFileUtf8(seed), "utf8");
  assert.deepEqual(await scanGeneration(root), [
    { path: "companion-backup.json", kind: "card_payload" },
  ]);
});

test("a card wrapped in a top-level array fails", async (t) => {
  const root = await generationRoot(t);
  await writeFile(
    path.join(root, "kohaku-export.json"),
    JSON.stringify([
      { name: "Kohaku", description: "d", personality: "p", scenario: "s", first_mes: "hi", mes_example: "e" },
    ]),
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "kohaku-export.json", kind: "untyped_card_payload" },
  ]);
});

test("a base64-encoded card in an admitted asset fails", async (t) => {
  const root = await generationRoot(t);
  const card = JSON.stringify({
    spec: "chara_card_v2",
    data: {
      name: "Kohaku",
      description:
        "A rival farmhand from another valley who talks about the weather and never about herself, and who is not the companion this product reviewed.",
      personality: "warm, guarded",
    },
  });
  const encoded = Buffer.from(card, "utf8").toString("base64");
  await writeFile(
    path.join(root, "browser", "tavern", "v1", "assets", "preset-abcdef12.js"),
    `export const bundled = "${encoded}";\n`,
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "browser/tavern/v1/assets/preset-abcdef12.js", kind: "encoded_card_payload" },
  ]);
});

test("a base64-encoded card PNG fails", async (t) => {
  const root = await generationRoot(t);
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("tEXt", Buffer.concat([Buffer.from("comment\0", "utf8"), Buffer.alloc(400, 0x20)])),
    pngChunk("tEXt", Buffer.from("chara\0eyJzcGVjIjoiY2hhcmFfY2FyZF92MiJ9", "utf8")),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const encoded = png.toString("base64");
  await writeFile(
    path.join(root, "browser", "tavern", "v1", "assets", "portrait-abcdef12.js"),
    `export const portrait = "${encoded}";\n`,
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "browser/tavern/v1/assets/portrait-abcdef12.js", kind: "embedded_card_png" },
  ]);
});

test("a base64 run that decodes to ordinary bytes is not a finding", async (t) => {
  const root = await generationRoot(t);
  const encoded = Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(20), "utf8").toString("base64");
  await writeFile(
    path.join(root, "browser", "tavern", "v1", "assets", "notes-abcdef12.js"),
    `export const notes = "${encoded}";\n`,
    "utf8",
  );
  assert.deepEqual(await scanGeneration(root), []);
});

test("the same dependency bytes behind a link get the same verdict as real files", async (t) => {
  // The determinism property, over the exact bytes that started this: the
  // dependency manifest, plus a card payload inlined beside it. Whatever the
  // filesystem says about how those bytes are reached, the gate must read them
  // and must report the card - and must never report the manifest.
  const expected = [
    { path: "node_modules/@aws/lambda-invoke-store/assets/preset-abcdef12.js", kind: "card_payload" },
  ];
  const linked = [];
  for (const kind of ["real-files", "hardlinks", "directory-link", "file-links"]) {
    const fixture = await dependencyClosureRoot(t, kind);
    if (fixture.unavailable !== undefined) continue;
    assert.deepEqual(
      await scanGeneration(fixture.root),
      expected,
      `${kind} must reach the same verdict as real files (${fixture.unavailable ?? "constructed"})`,
    );
    if (fixture.link !== null) linked.push(kind);
  }
  assert.ok(linked.length > 0, "at least one link kind must be constructible here, or this test proves nothing");
});

test("a card inside the dependency closure is in scope and fails the build", async (t) => {
  // Dependency bytes ship with the generation, the artifact inventory pins them
  // by digest but does not judge their content, and part of the closure is
  // vendored from this repository - so a card among them is third-party content
  // we would ship.
  const root = await generationRoot(t);
  const dependency = path.join(root, "node_modules", "@aws", "lambda-invoke-store");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "package.json"), DEPENDENCY_MANIFEST, "utf8");
  await writeFile(
    path.join(dependency, "card.json"),
    JSON.stringify({ spec: "chara_card_v2", data: { name: "Kohaku", description: "d" } }),
    "utf8",
  );
  await assert.rejects(
    assertGeneration(root),
    /release_persona_hygiene_violation:node_modules\/@aws\/lambda-invoke-store\/card\.json:companion_card_file/,
  );
  assert.deepEqual(await scanGeneration(root), [
    { path: "node_modules/@aws/lambda-invoke-store/card.json", kind: "companion_card_file" },
  ]);
});

test("a directory reached twice is read once and still fails once", async (t) => {
  // Two declared paths that resolve to one store directory are one file: the
  // finding is reported once, at the first path in read order, and no byte is
  // skipped.
  const scratch = await mkdtemp(path.join(tmpdir(), "release-hygiene-twice-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "generation");
  const store = path.join(scratch, "store", "@aws", "lambda-invoke-store");
  await mkdir(path.join(store, "assets"), { recursive: true });
  await writeFile(path.join(store, "assets", "card.json"), JSON.stringify({ spec: "chara_card_v2", data: { name: "Kohaku" } }), "utf8");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(store, path.join(root, "node_modules", "a-dependency"), DIRECTORY_LINK_TYPE);
  await symlink(store, path.join(root, "node_modules", "b-dependency"), DIRECTORY_LINK_TYPE);
  assert.deepEqual(await scanGeneration(root), [
    { path: "node_modules/a-dependency/assets/card.json", kind: "companion_card_file" },
  ]);
});

test("the scan reports the surface it covered", async (t) => {
  // The census is how the surface is stated rather than inferred: the same read
  // that decides the verdict says how many declared files it read, how many it
  // only name-checked, and how many links it resolved to read them. A linked
  // dependency adds to `filesInspected` exactly as a real one does.
  const scratch = await mkdtemp(path.join(tmpdir(), "release-hygiene-surface-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "generation");
  const store = path.join(scratch, "store", "lambda-invoke-store");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "package.json"), "{}\n", "utf8");
  await mkdir(path.join(root, "node_modules", "@aws"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html>\n", "utf8");
  await symlink(store, path.join(root, "node_modules", "@aws", "lambda-invoke-store"), DIRECTORY_LINK_TYPE);
  const result = await assertGeneration(root);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.surface, {
    declaredFiles: 2,
    filesInspected: 2,
    filesNameCheckedOnly: 0,
    linksResolved: 1,
    duplicateTargetsSkipped: 0,
  });
});

test("a file the generation does not declare is not part of the surface", async (t) => {
  // The recorded ruling: the surface is the packaged generation artifact, taken
  // from that generation's own declared file set, and nothing outside it. Two
  // cards sit outside it here - one beside the generation in the same output
  // root, one inside the generation that its inventory does not declare - and
  // neither is read, so neither can change this gate's verdict.
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-hygiene-declared-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const sibling = path.join(outputRoot, "generations", "g-sibling");
  const root = path.join(outputRoot, "generations", "g-selected");
  for (const generation of [sibling, root]) {
    await mkdir(path.join(generation, "assets"), { recursive: true });
    await writeFile(path.join(generation, "index.html"), "<!doctype html>\n", "utf8");
    await writeFile(path.join(generation, "assets", "app-0123abcd.js"), "export const boot = 1;\n", "utf8");
  }
  await writeFile(path.join(sibling, "assets", "preset-abcdef12.js"), INLINED_CARD, "utf8");
  await writeFile(path.join(root, "assets", "preset-abcdef12.js"), INLINED_CARD, "utf8");
  await declareArtifactFiles(root, ["assets/app-0123abcd.js", "index.html"]);
  const result = await assertReleasePersonaHygiene({ artifactRoot: root });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.declaredFiles, ["assets/app-0123abcd.js", "index.html"], "the inspected set is what the inventory declares");
  assert.equal(result.surface.filesInspected, 2, "only the two declared files were read");
});

test("a card the generation declares is inspected", async (t) => {
  // The other half of the surface assertion: the same inlined card bytes, this
  // time declared by the generation's own inventory, are read and refuse it.
  const root = await generationRoot(t);
  await mkdir(path.join(root, "unreviewed"), { recursive: true });
  await writeFile(path.join(root, "unreviewed", "preset-abcdef12.js"), INLINED_CARD, "utf8");
  await declareArtifactFromDisk(root);
  const declared = await readDeclaredArtifactFiles({ artifactRoot: root });
  assert.ok(declared.includes("unreviewed/preset-abcdef12.js"), "the declared set names the planted asset");
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
    { path: "unreviewed/preset-abcdef12.js", kind: "card_payload" },
  ]);
});

test("a directory that is not a generation is refused, never walked", async (t) => {
  // The output root is what the CLI used to walk: the pointer and every
  // generation at once. It declares no inventory, so it is refused instead - and
  // so is a generation whose inventory is missing, unparseable, or names a path
  // that escapes the generation.
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-hygiene-output-root-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const generation = path.join(outputRoot, "generations", "g-one");
  await mkdir(generation, { recursive: true });
  await writeFile(path.join(generation, "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(outputRoot, "current.json"), "{}\n", "utf8");
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: outputRoot }), /^Error: release_persona_hygiene_inventory_required$/u);
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: generation }), /release_persona_hygiene_inventory_required/u);
  await writeFile(path.join(generation, INVENTORY), "not json\n", "utf8");
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: generation }), /release_persona_hygiene_inventory_invalid/u);
  await writeFile(
    path.join(generation, INVENTORY),
    `${JSON.stringify({ schema: "gamebuddy-host-production-inventory/v4", entries: [{ path: "../escape.js" }] })}\n`,
    "utf8",
  );
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: generation }), /release_persona_hygiene_inventory_invalid:\.\.\/escape\.js/u);
});

test("a declared path that ships nothing, or is not a file, is refused", async (t) => {
  // The declaration is a claim the tree has to satisfy: a declared path that is
  // not there, or is a directory, refuses the generation instead of being
  // silently skipped.
  const root = await generationRoot(t);
  await declareArtifactFiles(root, ["assets/missing-0123abcd.js", "index.html"]);
  await assert.rejects(
    assertReleasePersonaHygiene({ artifactRoot: root }),
    /release_persona_hygiene_declared_file_missing:assets\/missing-0123abcd\.js/u,
  );
  await mkdir(path.join(root, "assets", "directory-not-file"), { recursive: true });
  await declareArtifactFiles(root, ["assets/directory-not-file", "index.html"]);
  await assert.rejects(
    assertReleasePersonaHygiene({ artifactRoot: root }),
    /release_persona_hygiene_non_regular_entry:assets\/directory-not-file/u,
  );
});

test("a dangling declared link fails the gate rather than being dropped", async (t) => {
  // The touched link is in the surface, so a link that resolves to nothing is a
  // refusal, not a silent skip: a path that is not read is a hole a card can sit
  // in. A file symlink is the shape where the link itself is the declared path.
  const root = await generationRoot(t);
  let fileLink = true;
  try {
    await symlink(path.join(root, "absent-portrait.png"), path.join(root, "portrait-0123abcd.png"), "file");
  } catch {
    fileLink = false;
  }
  if (fileLink) {
    await declareArtifactFiles(root, ["index.html", "portrait-0123abcd.png"]);
    await assert.rejects(
      assertReleasePersonaHygiene({ artifactRoot: root }),
      /release_persona_hygiene_unresolvable_link:portrait-0123abcd\.png/u,
    );
  }
  // The same property through a directory link, which every platform can build:
  // the target is removed after the declaration, and the declared path under it
  // stops resolving.
  const store = path.join(root, "store");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "package.json"), "{}\n", "utf8");
  await symlink(store, path.join(root, "linked-dependencies"), DIRECTORY_LINK_TYPE);
  await declareArtifactFiles(root, ["index.html", "linked-dependencies/package.json"]);
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
  await rm(store, { recursive: true, force: true });
  await assert.rejects(
    assertReleasePersonaHygiene({ artifactRoot: root }),
    /release_persona_hygiene_declared_file_missing:linked-dependencies\/package\.json/u,
  );
});

test("the CLI refuses an output root and reads a generation", async (t) => {
  const root = await generationRoot(t);
  await declareArtifactFromDisk(root);
  const accepted = await runNode(process.execPath, [GATE_SCRIPT, root]);
  assert.match(accepted.stdout, /^release_persona_hygiene_ok\t/u);
  assert.match(
    accepted.stdout,
    /declared=3\tfiles=2\t/u,
    "three declared files: two read, and the 9 MiB binary name-checked only",
  );
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-hygiene-cli-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await mkdir(path.join(outputRoot, "generations", "g-one"), { recursive: true });
  await writeFile(path.join(outputRoot, "generations", "g-one", "index.html"), "<!doctype html>\n", "utf8");
  await assert.rejects(runNode(process.execPath, [GATE_SCRIPT, outputRoot]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /release_persona_hygiene_inventory_required/u);
    return true;
  });
  // No argument is the default that used to walk `host/dist`: it names the fixed
  // output root, which declares no inventory, so it refuses with the same code.
  await assert.rejects(runNode(process.execPath, [GATE_SCRIPT]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /release_persona_hygiene_inventory_required/u);
    return true;
  });
});
