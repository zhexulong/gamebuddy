import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanLorebookText,
  importTavernLorebook,
  keysFromTitle,
} from "./tavern-lorebook-importer.js";
import { createWorldInfoManagementRepository, type WorldInfoManagementRepository } from "./world-info-management.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { rm } from "node:fs/promises";

test("keysFromTitle generates comprehensive retrieval keys from complex title", () => {
  const keys = keysFromTitle("望舒客栈 (Wangshu Inn)");
  assert.equal(keys[0], "望舒客栈 (Wangshu Inn)");
  assert.ok(keys.includes("望舒客栈"));
  assert.ok(keys.includes("Wangshu"));
  assert.ok(keys.includes("Inn"));
});

test("cleanLorebookText strips scripts, comments, and unwraps formatting tags while preserving clean newlines", () => {
  const raw = `
    <!-- Author note -->
    <script>alert("xss")</script>
    <b>Wangshu Inn</b> is located in the <span style="color:red">Bishui Plain</span>.
    \r\n\r\n
    It is built on a massive pillar.
  `;
  const cleaned = cleanLorebookText(raw);
  assert.ok(!cleaned.includes("<script>"));
  assert.ok(!cleaned.includes("<!--"));
  assert.ok(!cleaned.includes("<b>"));
  assert.ok(!cleaned.includes("<span"));
  assert.ok(cleaned.includes("Wangshu Inn is located in the Bishui Plain."));
  assert.ok(cleaned.includes("It is built on a massive pillar."));
  assert.ok(cleaned.includes("\n\n")); // Preserves multiline paragraphs
});

test("importTavernLorebook converts SillyTavern object dictionary entries to valid CreateWorldInfoRequest", async () => {
  const root = await canonicalTestRoot("tavern-importer-test-");
  try {
    const repository: WorldInfoManagementRepository = createWorldInfoManagementRepository(root);
    const sampleTavernBook = {
      name: "Teyvat Geography",
      description: "Comprehensive geographical guide to Teyvat.",
      entries: {
        "0": {
          uid: 0,
          comment: "Wangshu Inn",
          content: "[ Wangshu Inn: located in Bishui Plain, south of Dihua Marsh. Front for Liyue Qixing. ]",
          key: ["Wangshu Inn", "Inn"],
          constant: false,
          selective: true,
        },
        "1": {
          uid: 1,
          comment: "Dihua Marsh",
          content: "<details><summary>Dihua Marsh</summary>Alluvial plain shaped by Bishui River.</details>",
          key: "Dihua Marsh,Marsh",
          constant: false,
          selective: true,
        },
        "2": {
          uid: 2,
          comment: "Wizard Tower",
          content: "A permanent landmark.",
          keys: ["Wizard Tower", "Tower"],
          constant: true,
          selective: false,
        },
      },
    };

    const request = importTavernLorebook(sampleTavernBook);
    assert.equal(request.publicTitle, "Teyvat Geography");
    assert.equal(request.entries.length, 3);
    assert.equal(request.entries[0]?.publicTitle, "Wangshu Inn");
    assert.ok(request.entries[0]?.summary.includes("Wangshu Inn: located in Bishui Plain"));
    assert.deepEqual(request.entries[0]?.keys, ["Wangshu Inn", "Inn"]);
    assert.equal(request.entries[0]?.constant, undefined);
    assert.equal(request.entries[1]?.publicTitle, "Dihua Marsh");
    assert.deepEqual(request.entries[1]?.keys, ["Dihua Marsh", "Marsh"]);
    assert.equal(request.entries[1]?.constant, undefined);
    assert.ok(!request.entries[1]?.summary.includes("<details>"));
    assert.ok(request.entries[1]?.summary.includes("Alluvial plain shaped by Bishui River."));
    assert.deepEqual(request.entries[2]?.keys, ["Wizard Tower", "Tower"]);
    assert.equal(request.entries[2]?.constant, true);

    // Verify it passes repository's strict validation
    repository.validateCreateRequest(request);

    // Verify it creates successfully in the repository
    const created = await repository.create(request);
    assert.equal(created.revision, 1);
    assert.equal(created.publicTitle, "Teyvat Geography");
    assert.equal(created.entries.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("importTavernLorebook handles array entries and character_book wrappers", async () => {
  const root = await canonicalTestRoot("tavern-importer-wrapper-test-");
  try {
    const repository: WorldInfoManagementRepository = createWorldInfoManagementRepository(root);
    const wrappedCard = {
      character_book: {
        name: "Pelican Valley",
        description: "A peaceful seaside town.",
        entries: [
          {
            name: "Town square",
            content: "The bustling center of Pelican Town with a general store and fountain.",
          },
        ],
      },
    };

    const request = importTavernLorebook(wrappedCard);
    assert.equal(request.publicTitle, "Pelican Valley");
    assert.equal(request.entries.length, 1);
    assert.equal(request.entries[0]?.publicTitle, "Town square");

    repository.validateCreateRequest(request);
    const created = await repository.create(request);
    assert.equal(created.publicTitle, "Pelican Valley");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("importTavernLorebook parses secondary_keys, keysecondary, and selectiveLogic accurately", async () => {
  const root = await canonicalTestRoot("tavern-importer-secondary-keys-test-");
  try {
    const repository: WorldInfoManagementRepository = createWorldInfoManagementRepository(root);
    const bookWithSecondary = {
      name: "Teyvat Tactics",
      description: "Tactics and elemental interactions in Teyvat.",
      entries: [
        {
          comment: "Vaporize Reaction",
          content: "Hydro meets Pyro to deal amplified damage.",
          key: ["Vaporize", "Reaction"],
          secondary_keys: ["Hydro", "Pyro"],
          selectiveLogic: 3,
        },
        {
          comment: "Swirl Reaction",
          content: "Anemo diffuses elements across foes.",
          keys: ["Swirl"],
          keysecondary: "Anemo,Elements",
          selectiveLogic: 0,
        },
        {
          comment: "Melt Exclusion",
          content: "Cryo and Pyro condition.",
          key: "Melt",
          secondary_keys: "Freeze,Superconduct",
          selectiveLogic: 2,
        },
        {
          comment: "Partial Reaction",
          content: "Not all conditions satisfied.",
          key: "Partial",
          secondary_keys: ["A", "B"],
          selectiveLogic: 1,
        },
        {
          comment: "Plain Entry",
          content: "No secondary keys.",
          key: "Plain",
        },
      ],
    };

    const request = importTavernLorebook(bookWithSecondary);
    assert.equal(request.publicTitle, "Teyvat Tactics");
    assert.equal(request.entries.length, 5);

    assert.deepEqual(request.entries[0]?.secondaryKeys, ["Hydro", "Pyro"]);
    assert.equal(request.entries[0]?.selectiveLogic, 3);

    assert.deepEqual(request.entries[1]?.secondaryKeys, ["Anemo", "Elements"]);
    assert.equal(request.entries[1]?.selectiveLogic, 0);

    assert.deepEqual(request.entries[2]?.secondaryKeys, ["Freeze", "Superconduct"]);
    assert.equal(request.entries[2]?.selectiveLogic, 2);

    assert.deepEqual(request.entries[3]?.secondaryKeys, ["A", "B"]);
    assert.equal(request.entries[3]?.selectiveLogic, 1);

    assert.equal(request.entries[4]?.secondaryKeys, undefined);
    assert.equal(request.entries[4]?.selectiveLogic, undefined);

    repository.validateCreateRequest(request);
    const created = await repository.create(request);
    assert.equal(created.entries[0]?.selectiveLogic, 3);
    assert.deepEqual(created.entries[0]?.secondaryKeys, ["Hydro", "Pyro"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanLorebookText removes C1 control characters in addition to ASCII control characters", () => {
  const withC1 = "Wangshu\u0080\u0085\u009f Inn";
  const cleaned = cleanLorebookText(withC1);
  assert.equal(cleaned, "Wangshu Inn");
});

test("importTavernLorebook accepts GameBuddy-authored entries carrying their own title field", () => {
  // GameBuddy managed worldbook entries use { entryId, title, content } rather
  // than the SillyTavern/Chub comment/name conventions; title must become the
  // public title instead of being skipped to the Overview fallback.
  const request = importTavernLorebook({
    schemaVersion: 1,
    worldBookId: "gamebuddy.worldbook.sample",
    revision: 1,
    alwaysOnPremise: "companion premise",
    entries: [
      {
        entryId: "sample-entry-1",
        title: "喜欢帅哥",
        content: "鲸鱼娘其实喜欢帅气男生——打死不承认。",
        scope: "companion",
        provenance: "authored",
        tokenBudget: 500,
      },
      {
        entryId: "sample-entry-2",
        title: "大肥鱼家族",
        content: "家族成员都是鲸鱼娘。",
        scope: "setting",
        provenance: "authored",
        tokenBudget: 500,
      },
    ],
  });
  assert.equal(request.publicTitle, "Tavern World Info");
  assert.equal(request.entries.length, 2, "every authored entry must import, not collapse to the Overview fallback");
  assert.equal(request.entries[0]?.publicTitle, "喜欢帅哥");
  assert.equal(request.entries[1]?.publicTitle, "大肥鱼家族");
  assert.equal(request.entries[0]?.scope, "companion");
  assert.equal(request.entries[1]?.scope, "setting");
});
