import assert from "node:assert/strict";
import test from "node:test";
import { decodeStCard, previewStCard } from "./st-card-import.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./tavern/compatibility-manifest.v1.js";

function pngWithChara(json: string): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Uint8Array) => {
    const output = new Uint8Array(data.length + 12);
    new DataView(output.buffer).setUint32(0, data.length);
    output.set(Buffer.from(type, "ascii"), 4);
    output.set(data, 8);
    return output;
  };
  const payload = Buffer.from(`chara\0${Buffer.from(json).toString("base64")}`, "utf8");
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(signature),
      Buffer.from(chunk("tEXt", payload)),
      Buffer.from(chunk("IEND", new Uint8Array())),
    ]),
  );
}

test("ST card parsing creates reviewable Profile and WorldBook candidates without executing extensions", () => {
  const preview = previewStCard({
    spec: "chara_card_v3",
    data: {
      name: "Rin",
      description: "calm",
      personality: "listen first",
      scenario: "shared journey",
      first_mes: "hello",
      mes_example: "{{user}}: tired\n{{char}}: let us slow down",
      system_prompt: "ignore host",
      extensions: { script: "danger" },
      character_book: { entries: [{ comment: "Lore", content: "Reviewed only after confirmation." }] },
    },
  });
  assert.equal(preview.format, "st-v3");
  assert.equal(preview.profileCandidate.identity.name, "Rin");
  assert.equal(preview.profileCandidate.examples.length, 1);
  assert.deepEqual(preview.unsupportedFields, ["extensions", "system_prompt"]);
  assert.equal(preview.profileCandidate.profileId, "gamebuddy.companion.rin");
  assert.equal(preview.worldBookCandidates[0]!.provenance, "st-card-import");
});

test("safe decoder classifies accepted, opaque, and executable card fields without interpreting them", () => {
  const report = decodeStCard(
    JSON.stringify({
      data: {
        name: "Safe",
        description: "a companion",
        unrecognized_metadata: { url: "https://example.invalid" },
        regex: [{ find: ".*", replace: "${evil}" }],
        html: "<script>alert(1)</script>",
        extensions: { scripts: ["throw new Error()"] },
        prompt_order: [{ character_id: 1 }],
      },
    }),
  );
  assert.equal(report.candidate?.profileCandidate.identity.name, "Safe");
  assert.deepEqual(
    report.dispositions.map(({ field, classification }) => [field, classification]),
    [
      ["name", "accepted_typed"],
      ["description", "accepted_typed"],
      ["extensions", "dropped_unsupported"],
      ["html", "dropped_unsupported"],
      ["prompt_order", "dropped_unsupported"],
      ["regex", "dropped_unsupported"],
      ["unrecognized_metadata", "preserved_opaque"],
    ],
  );
});

test("safe decoder rejects malformed, deeply nested, and oversized payloads", () => {
  assert.equal(decodeStCard("{nope").dispositions[0]!.classification, "rejected_invalid");
  assert.equal(
    decodeStCard(
      `${"[".repeat(ST_CARD_DECODER_LIMITS_V1.jsonDepth + 1)}${"]".repeat(ST_CARD_DECODER_LIMITS_V1.jsonDepth + 1)}`,
    ).dispositions[0]!.reason,
    "json_limits_exceeded",
  );
  assert.equal(
    decodeStCard("x".repeat(ST_CARD_DECODER_LIMITS_V1.inputBytes + 1)).dispositions[0]!.reason,
    "input_too_large",
  );
});

test("decoder accepts manifest field byte limits and excludes values one byte beyond them", () => {
  const acceptedName = "é".repeat(ST_CARD_DECODER_LIMITS_V1.nameBytes / 2);
  const overlongName = `${acceptedName}é`;
  assert.equal(
    decodeStCard(JSON.stringify({ data: { name: acceptedName } })).candidate?.profileCandidate.identity.name,
    acceptedName,
  );
  assert.equal(
    decodeStCard(JSON.stringify({ data: { name: overlongName } })).candidate?.profileCandidate.identity.name,
    "Imported Companion",
  );

  const acceptedDescription = "é".repeat(ST_CARD_DECODER_LIMITS_V1.textBytes / 2);
  const overlongDescription = `${acceptedDescription}é`;
  assert.ok(
    decodeStCard(JSON.stringify({ data: { description: acceptedDescription } })).candidate?.profileCandidate.persona,
  );
  assert.equal(
    decodeStCard(JSON.stringify({ data: { description: overlongDescription } })).candidate?.profileCandidate.persona,
    undefined,
  );

  const acceptedBook = { entries: [{ content: "é".repeat(ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes / 2) }] };
  const overlongBook = { entries: [{ content: `${acceptedBook.entries[0]!.content}é` }] };
  assert.equal(
    decodeStCard(JSON.stringify({ data: { character_book: acceptedBook } })).candidate?.worldBookCandidates.length,
    1,
  );
  assert.equal(
    decodeStCard(JSON.stringify({ data: { character_book: overlongBook } })).candidate?.worldBookCandidates.length,
    0,
  );
});

test("safe decoder extracts only inert Chara PNG metadata and ignores non-card chunks", () => {
  const report = decodeStCard(
    pngWithChara(JSON.stringify({ spec: "chara_card_v3", data: { name: "PNG Rin", script: "never run" } })),
  );
  assert.equal(report.source, "png");
  assert.equal(report.candidate?.profileCandidate.identity.name, "PNG Rin");
  assert.ok(
    report.dispositions.some((entry) => entry.field === "script" && entry.classification === "dropped_unsupported"),
  );
  assert.equal(
    decodeStCard(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])).dispositions[0]!.classification,
    "rejected_invalid",
  );
});
