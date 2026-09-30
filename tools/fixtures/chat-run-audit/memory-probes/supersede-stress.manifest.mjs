// Fixture sidecar for the SUPERSEDE STRESS probe (design 10.6 item 1, the
// bidirectional-overwrite adversarial scenario).
//
// The point is not that the companion recalls a fact; it is that a fact can be
// deliberately REPLACED and the old one must be fully retired. The design's pass
// criteria are three-way and none of them may be softened:
//
//   1. the OLD fact is gone        (forbiddenKeywords hit 0)
//   2. the NEW fact is present     (requiredKeywords by the distance threshold)
//   3. no both-answers fudge       ("you like parsnips and amethyst" must NOT pass)
//
// Criterion 3 is why `forbiddenKeywords` carries the SUPERSEDED tokens: a reply that
// names both cannot score as a pass. This directly exercises the vendor's
// `superseded_by_memory_id` chain: if the physical supersession did not take effect
// in the dynamically assembled prompt, the old token comes back and the probe fails
// - which is exactly the regression it exists to catch.
//
// The two-step seed is deliberate: the overwrite must be a SECOND directive, so the
// first one is genuinely superseded rather than never stated.
//
// Synthetic SFW material authored for this design.
import { createHash } from "node:crypto";

const probe = {
  probeId: "p-supersede-stress",
  distance: "turn",
  dimension: "supersession",
  seedClass: "explicit",
  steps: [
    {
      kind: "seed",
      role: "player",
      text: "For the record, my favourite thing to grow is parsnips - I never get tired of them.",
      persistVia: "conversation",
    },
    { kind: "filler", role: "player", text: "The first harvest always feels like a small victory.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "I keep meaning to expand the eastern field.", persistVia: "conversation" },
    {
      kind: "seed",
      role: "player",
      text: "Actually, scratch that - I am tired of parsnips. These days amethyst is my favourite thing, hands down.",
      persistVia: "conversation",
    },
    { kind: "filler", role: "player", text: "The creek runs high after a storm like that one.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "I moved the scarecrow closer to the fence line.", persistVia: "conversation" },
    {
      kind: "probe",
      role: "player",
      text: "Remind me - what is my favourite thing these days?",
      // Criterion 2: the new fact must be stated.
      requiredKeywords: ["amethyst"],
      // Criteria 1 and 3: naming the superseded token means the old fact survived; it
      // is also exactly what a "both answers" reply would contain.
      forbiddenKeywords: ["parsnip"],
      minHitRate: 1,
    },
  ],
};

const manifest = {
  schema: "chat_memory_probe_manifest/v1",
  manifestId: "man-supersede-stress-01",
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
