// Fixture sidecar for the EMBODIED PROVENANCE probe (design 10.5, class 2:
// "physical collaboration and item provenance").
//
// This is the strongest of the three classes because it binds memory to systems we
// already proved live: a container, a coordinate, and an item id. A companion that
// truly remembers can go to the right place; one that only pattern-matches a noun
// will send the player to the wrong container. So the forbidden keywords here are
// the OTHER containers - naming one of those is the wrong-route failure, and a
// correct reply has no reason to name them.
//
// AUTHORING RULE (same as embodied-preference.manifest.mjs): the question asks where
// to GO, so a correct answer names the right container and the right floor; the
// forbidden set is the plausible wrong answers, not words a correct reply would have
// to deny. Enforced mechanically by embodied-probes.test.mjs.
//
// Synthetic SFW material authored for this design; the item and container names are
// ordinary farm vocabulary, not copied text.
import { createHash } from "node:crypto";

const probe = {
  probeId: "p-embodied-provenance",
  distance: "turn",
  dimension: "retention",
  seedClass: "explicit",
  steps: [
    {
      kind: "seed",
      role: "player",
      text: "I put the obsidian blade I found on the deep mine levels into the blue chest upstairs in the farmhouse, on the left side. That is where it lives now.",
      persistVia: "conversation",
    },
    { kind: "filler", role: "player", text: "The deep levels get cold enough to see your breath.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "I sharpened the axe before the storm came in.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "The slimes down there leave a strange residue on the floor.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "I should sort the chest by the door one of these days.", persistVia: "conversation" },
    {
      kind: "probe",
      role: "player",
      text: "I need that obsidian blade. Where should I look for it?",
      // A correct reply routes to the blue chest in the farmhouse.
      requiredKeywords: ["blue", "farmhouse"],
      // These are the plausible wrong destinations. Remembering correctly means not
      // sending the player to them.
      forbiddenKeywords: ["barn", "shed", "cellar"],
      minHitRate: 0.5,
    },
  ],
};

const manifest = {
  schema: "chat_memory_probe_manifest/v1",
  manifestId: "man-embodied-provenance-01",
  manifestDigest: "",
  continuityTopology: "single",
  probes: [probe],
};

const canonical = JSON.stringify({
  schema: manifest.schema,
  manifestId: manifest.manifestId,
  continuityTopology: manifest.continuityTopology,
  probes: manifest.probes,
});
manifest.manifestDigest = createHash("sha256").update(canonical).digest("hex");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
