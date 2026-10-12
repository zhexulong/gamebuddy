import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CARD_SCORE_THRESHOLD,
  assertReleasePersonaHygiene,
  cardScore,
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
 *    half, at a file name that is not card-shaped, so the pass in 10 is not
 *    bought by weakening the payload rule.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");

async function readFileUtf8(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

async function generationRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "release-hygiene-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "browser", "tavern", "v1", "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><div id=app></div>\n", "utf8");
  await writeFile(path.join(root, "assets", "app-0123abcd.js"), "export const boot = 1;\n", "utf8");
  await writeFile(
    path.join(root, "production-inventory.json"),
    JSON.stringify({ schemaVersion: 1, generation: "g-fixture", entries: [] }),
    "utf8",
  );
  // A stand-in for the bundled runtime / native helpers: larger than the scan
  // ceiling, and legitimate.
  await writeFile(path.join(root, "assets", "large-binary-9999beef.js"), Buffer.alloc(9 * 1024 * 1024, 0x41));
  return root;
}

test("a packaged generation with no character content passes", async (t) => {
  const root = await generationRoot(t);
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
  const result = await assertReleasePersonaHygiene({ artifactRoot: root });
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
});

test("a planted card file fails the build by path", async (t) => {
  const root = await generationRoot(t);
  await writeFile(path.join(root, "card.json"), JSON.stringify({ spec: "chara_card_v2", data: { name: "x" } }), "utf8");
  await assert.rejects(assertReleasePersonaHygiene({ artifactRoot: root }), /release_persona_hygiene_violation:card\.json/);
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
    { path: "card.json", kind: "companion_card_file" },
  ]);
});

test("a card payload inlined in an admitted asset fails", async (t) => {
  const root = await generationRoot(t);
  // Exactly the shape the artifact allowlist admits: a reachable `.js` module.
  // The payload is a card - a name of its own and authored prose in a card's
  // prose field - not a marker on its own.
  await writeFile(
    path.join(root, "browser", "tavern", "v1", "assets", "preset-abcdef12.js"),
    `export const bundled = ${JSON.stringify({
      spec: "chara_card_v2",
      data: {
        name: "Kohaku",
        description:
          "A rival farmhand from another valley who talks about the weather and never about herself, and who is not the companion this product reviewed.",
        personality: "warm, guarded",
      },
    })};\n`,
    "utf8",
  );
  await assert.rejects(
    assertReleasePersonaHygiene({ artifactRoot: root }),
    /release_persona_hygiene_violation:browser\/tavern\/v1\/assets\/preset-abcdef12\.js:card_payload/,
  );
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
  const result = await assertReleasePersonaHygiene({ artifactRoot: root });
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
    assertReleasePersonaHygiene({ artifactRoot: root }),
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
});

test("a spec-stripped reviewed card is still a card", async (t) => {
  const root = await generationRoot(t);
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  const stripped = JSON.parse(await readFileUtf8(seed));
  delete stripped.spec;
  assert.equal(stripped.spec, undefined);
  await writeFile(path.join(root, "companion-backup.json"), `${JSON.stringify(stripped)}\n`, "utf8");
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
    { path: "companion-backup.json", kind: "untyped_card_payload" },
  ]);
});

test("a planted reviewed card that keeps its spec still fails", async (t) => {
  const root = await generationRoot(t);
  const seed = path.join(REPOSITORY_ROOT, "assets", "tavern", "presets", "default-companion", "card.json");
  await writeFile(path.join(root, "companion-backup.json"), await readFileUtf8(seed), "utf8");
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), [
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
  assert.deepEqual(await scanReleasePersonaHygiene({ artifactRoot: root }), []);
});
