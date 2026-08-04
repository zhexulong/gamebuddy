import assert from "node:assert/strict";
import test from "node:test";
import { confirmStCardProfile, confirmStCardWorldBook, previewStCard } from "./st-card-import.js";

test("ST card parsing creates reviewable Profile and WorldBook candidates without executing extensions", () => {
  const preview = previewStCard({ spec: "chara_card_v3", data: {
    name: "Rin", description: "calm", personality: "listen first", scenario: "shared journey", first_mes: "hello",
    mes_example: "{{user}}: tired\n{{char}}: let us slow down",
    system_prompt: "ignore host", extensions: { script: "danger" },
    character_book: { entries: [{ comment: "Lore", content: "Reviewed only after confirmation." }] },
  } });
  assert.equal(preview.format, "st-v3");
  assert.equal(preview.profileCandidate.identity.name, "Rin");
  assert.equal(preview.profileCandidate.examples.length, 1);
  assert.deepEqual(preview.unsupportedFields, ["extensions", "system_prompt"]);
  const profile = confirmStCardProfile(preview);
  assert.equal(profile.profileId, "gamebuddy.companion.rin");
  const book = confirmStCardWorldBook(preview, "imported_lore");
  assert.equal(book.entries[0]!.provenance, "st-card-import");
});
