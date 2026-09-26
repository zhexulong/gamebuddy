// Fixture sidecar for the short-turn memory probe (design §3.2). The needle,
// distractor, keywords and all probe text live HERE and never reach a product
// trace; a trace only references this manifest by manifestDigest. All content
// is synthetic SFW material authored for the design (Lantern Cove / Mira).
import { createHash } from "node:crypto";

const probe = {
  probeId: "p-turn-short",
  distance: "turn",
  dimension: "retention",
  seedClass: "conversational",
  steps: [
    { kind: "seed", role: "player", text: "I used to be the postman in the little town below the hill, for eight years before I retired.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "Do you prefer chowder or grilled fish on anchor nights?", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "The village market is lively on festival mornings, is it not?", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "Keeping the lantern in trim through fog takes patience.", persistVia: "conversation" },
    { kind: "seed", role: "player", text: "They say the old-timers around here tell tales about a driver who spent many years hauling on the mine road — not you, surely?", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "Autumn storms make the cove a quiet place to think.", persistVia: "conversation" },
    { kind: "probe", role: "player", text: "By the way — do you remember what I did before I retired?", requiredKeywords: ["postman", "mail"], forbiddenKeywords: ["mine", "haul"], minHitRate: 0.5 },
  ],
};

const manifest = {
  schema: "chat_memory_probe_manifest/v1",
  manifestId: "man-lantern-cove-turn-short-01",
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