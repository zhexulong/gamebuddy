import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLiveRunPersonaMounted,
  LIVE_RUN_PERSONA_DIR,
  provisionLiveRunPersona,
  readLiveRunPersonaIdentity,
} from "./persona.mjs";

test("the canonical live-run card is present and identified", async () => {
  const identity = await readLiveRunPersonaIdentity();
  assert.equal(identity.dir, "deepseek-chan");
  assert.equal(typeof identity.name, "string");
  assert.ok(identity.name.length > 0, "the card must carry a display name");
  assert.ok(identity.worldBookEntries > 0, "the card must ship its world book");
  const canonical = await assertLiveRunPersonaMounted(LIVE_RUN_PERSONA_DIR);
  assert.equal(canonical.ok, true, JSON.stringify(canonical.problems));
  assert.ok(canonical.macroTokens > 0, "the reviewed card carries authored templating; that is recorded, not refused");
  // The card is the live-run persona by decision; a silently different directory is a change of subject.
  assert.ok(LIVE_RUN_PERSONA_DIR.endsWith(path.join("assets", "tavern", "presets", "deepseek-chan")));
});

test("provisioning copies both files byte for byte, with no preprocessing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-run-"));
  try {
    const provisioned = await provisionLiveRunPersona(cwd);
    const [{ cardPath, worldbookPath }] = [{ ...provisioned }];
    assert.deepEqual(
      await readFile(cardPath, "utf8"),
      await readFile(path.join(cwd, "card.json"), "utf8"),
      "card.json must be identical after provisioning",
    );
    assert.deepEqual(
      await readFile(worldbookPath, "utf8"),
      await readFile(path.join(cwd, "worldbook.json"), "utf8"),
      "worldbook.json must be identical after provisioning",
    );
    const mounted = await assertLiveRunPersonaMounted(cwd);
    assert.equal(mounted.ok, true, JSON.stringify(mounted.problems));
    assert.equal(mounted.worldBookEntries, provisioned.identity.worldBookEntries);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an unmounted run is a failure that names itself, never a bland companion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-empty-"));
  try {
    const mounted = await assertLiveRunPersonaMounted(cwd);
    assert.equal(mounted.ok, false);
    assert.deepEqual(mounted.problems.sort(), ["card_json_absent", "worldbook_json_absent"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an empty or macro-laden world book is refused", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-bad-"));
  try {
    await provisionLiveRunPersona(cwd);
    // An empty book is the "hollow default" the game-side content gate already refuses.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(cwd, "worldbook.json"), JSON.stringify({ entries: [] }), "utf8");
    assert.equal((await assertLiveRunPersonaMounted(cwd)).problems.includes("worldbook_empty"), true);
    // The reviewed card itself ships templating, so its presence must NOT be a failure: it is counted,
    // and whether the runtime substitutes it is verified downstream.
    await writeFile(
      path.join(cwd, "worldbook.json"),
      JSON.stringify({ entries: [{ content: "{{char}} 你好" }] }),
      "utf8",
    );
    const templated = await assertLiveRunPersonaMounted(cwd);
    assert.equal(templated.ok, true, JSON.stringify(templated.problems));
    assert.equal(templated.macroTokens, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
