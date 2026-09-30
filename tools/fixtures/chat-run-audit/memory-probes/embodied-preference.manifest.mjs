// Fixture sidecar for the EMBODIED PREFERENCE probe (design 10.5, class 1:
// "preferences and production covenants").
//
// A trivia question ("what did I do before I retired?") tests string recall. This
// probe tests a directive that has to change what the companion DOES: keep the
// greenhouse strawberries for wine instead of clearing them into the shipping bin.
// The needle is a standing instruction, so a companion that forgot it will describe
// the wrong action - which is what the keyword split below detects.
//
// AUTHORING RULE, learned the hard way (see the distractor analysis in
// design/reviews/probe-distractor-verdict-analysis.md): a forbidden keyword must be
// one a CORRECT reply has no reason to name, and the probe question must ask for the
// RIGHT action rather than about the wrong option. The first version of the
// turn-distance probe asked a question that invited denying a rumour, so a correct
// denial ("not the mine-road driver") contained the forbidden words and scored as
// `distractor.confused`. The question here asks what to DO with the strawberries, so
// a correct reply names wine and never names the bin. The same rule is enforced
// mechanically by embodied-probes.test.mjs.
//
// All content is synthetic SFW material authored for this design; the game terms
// (greenhouse, shipping bin) are ordinary vocabulary, not copied text.
import { createHash } from "node:crypto";

const probe = {
  probeId: "p-embodied-preference",
  distance: "turn",
  dimension: "retention",
  // Explicit: the covenant arrives as a player directive, not as a passing remark
  // the product may or may not sediment.
  seedClass: "explicit",
  steps: [
    {
      kind: "seed",
      role: "player",
      text: "Standing rule for rainy days: leave the greenhouse strawberries alone. I press those into wine, so they never go in the shipping bin.",
      persistVia: "conversation",
    },
    { kind: "filler", role: "player", text: "The greenhouse stays warm even when the fog rolls in.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "I finally saved up for the second row of casks.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "Rain like this makes the whole farm smell like wet grass.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "The cat refused to leave the porch all afternoon.", persistVia: "conversation" },
    {
      kind: "probe",
      role: "player",
      // The question must NOT echo a required token, or any reply that merely
      // mentions the thing asked about scores a hit (audit 2026-10: the original
      // ended with "...the greenhouse strawberries", and "strawberr" is required,
      // so a zero-memory reply could still hit). The directive itself is the only
      // place the tokens exist; a reply that recalls the rule must supply them.
      text: "It is going to rain tomorrow. What should happen with the crop in the greenhouse?",
      requiredKeywords: ["strawberr", "wine"],
      forbiddenKeywords: ["bin", "sell"],
      minHitRate: 0.5,
    },
  ],
};

const manifest = {
  schema: "chat_memory_probe_manifest/v1",
  manifestId: "man-embodied-preference-01",
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
