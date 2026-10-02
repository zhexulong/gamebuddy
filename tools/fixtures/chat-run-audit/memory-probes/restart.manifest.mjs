// Fixture sidecar for the P-RESTART probe (design 3.4, distance `session`).
//
// What this proves is the PERSISTENCE PARTITION, not an in-process cache: the fact
// is written by one Host process and asked about in a DIFFERENT one, and the only
// reason the two halves can meet is that both open the same continuity's storage.
//
// The memory loop's shape already IS this scenario - phase 1 seeds through a
// management child, that child's teardown commits, and phase 2 mounts as its
// terminal successor on the same runtime root. So the distance here is declared
// `session` and the runner supplies the restart evidence it actually has (the
// successor mount succeeded; see the runner's session-distance branch). If the
// predecessor teardown had NOT committed the product would refuse the mount and the
// run would report a gap, never a pass.
//
// AUTHORING RULE (enforced by embodied-probes.test.mjs): the forbidden set is the
// plausible WRONG answers, never tokens a correct reply would have to deny. Here the
// distractor is a different cat belonging to someone else in the same world, so a
// correct reply has no reason to name it.
//
// Synthetic SFW material authored for this design; ordinary pet vocabulary.
import { createHash } from "node:crypto";

const probe = {
  probeId: "p-restart",
  distance: "session",
  dimension: "retention",
  seedClass: "explicit",
  steps: [
    {
      kind: "seed",
      role: "player",
      text: "I have a calico cat called Sesame who adores grilled saury. She is mine, she lives at my place.",
      persistVia: "conversation",
    },
    { kind: "filler", role: "player", text: "The innkeeper's ginger cat keeps sleeping on the porch.", persistVia: "conversation" },
    { kind: "filler", role: "player", text: "The river is running high after the storm.", persistVia: "conversation" },
    {
      kind: "probe",
      role: "player",
      text: "By the way - do you remember the cat I keep at home?",
      // The pet's own name, which only the stored fact carries.
      requiredKeywords: ["sesame"],
      // The other cat in the world. Naming it is the wrong-owner failure.
      forbiddenKeywords: ["ginger", "innkeeper"],
      minHitRate: 1,
    },
  ],
};

const manifest = {
  schema: "chat_memory_probe_manifest/v1",
  manifestId: "man-restart-01",
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