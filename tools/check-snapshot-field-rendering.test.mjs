import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditSnapshotRendering, RENDERING_EXEMPTIONS } from "./check-snapshot-field-rendering.mjs";

// red-proof: inject  deleting `formatCarriedCanWater`'s call and its body from a copy of `host/src/fact-brief.ts` ->
//            `snapshot_field_never_rendered:wateringCanFacts` (see "a field the prose stops rendering is named" below).
//
// Also injected, each seen red once (this file): a field added to `SNAPSHOT_KEYS` with no renderer (the Mod grows a
// family and nobody notices), an exemption for a field the prose renders now (`stale_rendering_exemption`), an
// exemption for a field the wire no longer publishes (the same code, the other direction), an exemption with nobody's
// name on it, a mention of the field inside a COMMENT (not a rendering), and a wire list with no keys at all (blocked,
// exit 2 - never green).
//
// PROVENANCE - 2026-11-11, the run this gate exists for: `wateringCanFacts` was published in every observation
// (`water 40, 40, 38, 36, 36` of `40`), validated, coverage-listed and labelled, and `<world-state>` printed the can
// only as `1 份 喷壶` in the pack list. She shook it and narrated a gauge instead: `壶底见底了`, `壶空了正好`.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-snapshot-field-rendering.mjs");
const SOURCES = {
  protocol: "host/src/protocol.ts",
  factBrief: "host/src/fact-brief.ts",
  vocabulary: "host/src/game-world-vocabulary.ts",
  hud: "host/src/snapshot-hud.ts",
};

const readReal = (relative) => readFileSync(join(REPOSITORY_ROOT, ...relative.split("/")), "utf8");

/** A throwaway tree at the real relative paths, so the gate reads the product's own file names. */
async function withFixtureRoot(specs, run) {
  const root = mkdtempSync(join(tmpdir(), "snapshot-field-rendering-"));
  try {
    for (const [relativePath, contents] of Object.entries(specs)) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The sources this gate reads, each optionally rewritten, as one fixture tree. */
function tree({ protocol, factBrief, vocabulary, hud } = {}) {
  return {
    [SOURCES.protocol]: protocol ?? readReal(SOURCES.protocol),
    [SOURCES.factBrief]: factBrief ?? readReal(SOURCES.factBrief),
    [SOURCES.vocabulary]: vocabulary ?? readReal(SOURCES.vocabulary),
    [SOURCES.hud]: hud ?? readReal(SOURCES.hud),
  };
}

/** The HUD without one of its lines: the rendering the two exemptions credit it with, gone. */
function withoutHudLine(source, lineName) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.includes(`name: "${lineName}"`));
  assert.ok(at >= 0, `the HUD declares a line named ${lineName}`);
  if (lines[at].trim().startsWith("{") && lines[at].trim().endsWith("},")) {
    lines.splice(at, 1);
    return lines.join("\n");
  }
  let start = at;
  while (start >= 0 && !lines[start].trimEnd().endsWith("{")) start -= 1;
  let end = at;
  while (end < lines.length && lines[end].trim() !== "},") end += 1;
  assert.ok(start >= 0 && end < lines.length, `the line named ${lineName} is one object literal`);
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

/** The prose as it read before the water line existed: the call, and the function that produced it, gone. */
function withoutWaterLine(source) {
  return source
    .replace(
      / {2}const canWater = formatCarriedCanWater\(world\);\n {2}if \(canWater !== ""\) parts\.push\(canWater\);\n/u,
      "",
    )
    .replace(/function formatCarriedCanWater\(world: Snapshot\): string \{[\s\S]*?\n\}\n/u, "");
}

const codes = (violations) => violations.map((violation) => violation.code);
const dispositionOf = (reading, field) => reading.dispositions.find((entry) => entry.field === field);

test("every wire field reaches the prose or carries an owner, and the reading states its population", () => {
  const reading = auditSnapshotRendering({ root: REPOSITORY_ROOT });
  assert.deepEqual(codes(reading.violations), [], "the tree's own fields are all accounted for");
  assert.ok(reading.examined >= 100, `examined ${String(reading.examined)} fields, too few to be the wire's own list`);
  assert.equal(
    reading.rendered + reading.exempt,
    reading.examined,
    "each field is exactly one of rendered and exempt, so the three numbers describe one population",
  );
  // The figure that would have prevented the run: the can's own water, rendered by the prose composer.
  assert.equal(
    dispositionOf(reading, "wateringCanFacts")?.renderedBy,
    SOURCES.factBrief,
    "wateringCanFacts is rendered by the composer she reads",
  );
  // Every exemption names its owner and its reason, which is what makes it a debt rather than a silence.
  for (const field of Object.keys(RENDERING_EXEMPTIONS)) {
    const entry = RENDERING_EXEMPTIONS[field];
    assert.ok(typeof entry.owedBy === "string" && entry.owedBy.trim() !== "", `${field}: an exemption needs an owner`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim() !== "", `${field}: an exemption needs a reason`);
  }
  // The second surface is asked the same question, and the two exemptions that credit it name it per renderer: the
  // claim `snapshot-hud.ts` prints them is read from that module's source, not believed because a reason said so.
  for (const field of ["health", "harvestWhereabouts"]) {
    const disposition = dispositionOf(reading, field);
    assert.equal(disposition?.renderedBy, null, `${field} is exempt, so <world-state> does not render it`);
    assert.equal(
      disposition?.printedBy,
      SOURCES.hud,
      `${field} is printed by the HUD, and the report says which module`,
    );
  }
  assert.ok(
    reading.printedOutsideWorldState >= 2,
    `printed outside <world-state> ${String(reading.printedOutsideWorldState)}, too few to include the two exempted fields`,
  );
  process.stdout.write(
    `snapshot_field_rendering examined ${String(reading.examined)} · rendered ${String(reading.rendered)} · ` +
      `exempt ${String(reading.exempt)} · printed outside <world-state> ${String(reading.printedOutsideWorldState)}\n`,
  );
});

test("a field the prose stops rendering is named, so a published fact cannot go quiet again", async () => {
  const reading = await withFixtureRoot(tree({ factBrief: withoutWaterLine(readReal(SOURCES.factBrief)) }), (root) =>
    auditSnapshotRendering({ root }),
  );
  assert.deepEqual(
    codes(reading.violations),
    ["snapshot_field_never_rendered:wateringCanFacts"],
    "exactly the field the prose stopped rendering, named",
  );
  assert.equal(reading.status, "failed");
});

test("a field only the HUD printed is named when the HUD stops printing it", async () => {
  const reading = await withFixtureRoot(tree({ hud: withoutHudLine(readReal(SOURCES.hud), "health") }), (root) =>
    auditSnapshotRendering({ root }),
  );
  assert.deepEqual(
    codes(reading.violations),
    [`field_rendered_by_an_unchecked_renderer:health:${SOURCES.hud}`],
    "the rendering the exemption rested on, named, and the exemption does not survive it",
  );
  assert.equal(reading.status, "failed");
});

test("an exemption that credits a renderer this gate does not read is named", async () => {
  const reading = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: {
        ...RENDERING_EXEMPTIONS,
        health: { ...RENDERING_EXEMPTIONS.health, printedBy: "host/src/somebody-elses-hud.ts" },
      },
    }),
  );
  assert.deepEqual(codes(reading.violations), [
    "field_rendered_by_an_unchecked_renderer:health:host/src/somebody-elses-hud.ts",
  ]);
});

test("a field the wire grows is named on the day it arrives, with no edit here", async () => {
  const protocol = readReal(SOURCES.protocol).replace(
    "export const SNAPSHOT_KEYS = [",
    'export const SNAPSHOT_KEYS = [\n  "brandNewFamily",',
  );
  const reading = await withFixtureRoot(tree({ protocol }), (root) => auditSnapshotRendering({ root }));
  assert.deepEqual(codes(reading.violations), ["snapshot_field_never_rendered:brandNewFamily"]);
});

test("an exemption expires both ways: rendered now, or no longer published", async () => {
  const rendered = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({ root, exemptions: { ...RENDERING_EXEMPTIONS, stamina: RENDERING_EXEMPTIONS.health } }),
  );
  assert.deepEqual(
    codes(rendered.violations),
    ["stale_rendering_exemption:stamina"],
    "a field the prose renders needs no exemption",
  );
  const gone = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: { ...RENDERING_EXEMPTIONS, retiredField: RENDERING_EXEMPTIONS.health },
    }),
  );
  assert.deepEqual(
    codes(gone.violations),
    ["stale_rendering_exemption:retiredField"],
    "an exemption for a field the wire dropped exempts nothing",
  );
});

test("an exemption with nobody's name on it is a fact quietly left out", async () => {
  const reading = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: { ...RENDERING_EXEMPTIONS, catalogRevision: { reason: "someone looked", owedBy: " " } },
    }),
  );
  assert.deepEqual(
    codes(reading.violations),
    ["exemption_without_owner:catalogRevision"],
    "the exemption is not accepted on a blank owner",
  );
});

test("a mention inside a comment is not a rendering", async () => {
  const commented = tree({
    factBrief: `${withoutWaterLine(readReal(SOURCES.factBrief))}\n// wateringCanFacts: the can's water is rendered elsewhere\n`,
  });
  const reading = await withFixtureRoot(commented, (root) => auditSnapshotRendering({ root }));
  assert.deepEqual(
    codes(reading.violations),
    ["snapshot_field_never_rendered:wateringCanFacts"],
    "the gate reads code, not its own documentation",
  );
});

test("a wire list with no keys is blocked, not green", async () => {
  const protocol = readReal(SOURCES.protocol).replace(
    /export const SNAPSHOT_KEYS = \[[\s\S]*?\] as const;/u,
    "export const SNAPSHOT_KEYS = [] as const;",
  );
  const reading = await withFixtureRoot(tree({ protocol }), (root) => auditSnapshotRendering({ root }));
  assert.equal(reading.status, "blocked", "an unreadable population cannot pass");
  assert.equal(reading.examined, 0);

  await withFixtureRoot(tree({ protocol }), (root) => {
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 2, `the CLI exits 2 on no population, printed: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /no snapshot field was examined/u);
    return null;
  });
});
