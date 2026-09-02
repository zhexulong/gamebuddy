import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { buildCompanionSystemPrompt, validateIdentityProfile } from "./identity-profile.js";
import { candidateToIdentityProfile, decodeStCard, previewStCard } from "./st-card-import.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./tavern/compatibility-manifest.v1.js";
import fc from "fast-check";

function pngWithChara(json: string, keyword = "chara"): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Uint8Array) => {
    const output = new Uint8Array(data.length + 12);
    new DataView(output.buffer).setUint32(0, data.length);
    output.set(Buffer.from(type, "ascii"), 4);
    output.set(data, 8);
    return output;
  };
  const payload = Buffer.from(`${keyword}\0${Buffer.from(json).toString("base64")}`, "utf8");
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(signature),
      Buffer.from(chunk("tEXt", payload)),
      Buffer.from(chunk("IEND", new Uint8Array())),
    ]),
  );
}

function pngWithZtxt(json: string, keyword = "chara"): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Uint8Array) => {
    const output = new Uint8Array(data.length + 12);
    new DataView(output.buffer).setUint32(0, data.length);
    output.set(Buffer.from(type, "ascii"), 4);
    output.set(data, 8);
    return output;
  };
  const base64Data = Buffer.from(json).toString("base64");
  const compressed = deflateSync(Buffer.from(base64Data, "utf8"));
  const header = Buffer.from(`${keyword}\0\0`, "utf8"); // keyword + null + compression_method(0)
  const payload = Buffer.concat([header, compressed]);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(signature),
      Buffer.from(chunk("zTXt", payload)),
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

test("candidateToIdentityProfile creates valid IdentityProfile for 100% prefix caching", () => {
  const preview = previewStCard({
    spec: "chara_card_v3",
    data: {
      name: "Abigail",
      description: "Loves amethyst and gaming.",
      personality: "Adventurous and spirited.",
      scenario: "Living in Pelican Town.",
      mes_example: "{{user}}: Want to play Journey of the Prairie King?\n{{char}}: Always! Let's beat level 1 together.",
    },
  });

  const profile = candidateToIdentityProfile(preview, 1);
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.identity.name, "Abigail");
  assert.equal(profile.persona?.core, "Loves amethyst and gaming.");
  assert.equal(profile.persona?.interactionStyle, "Adventurous and spirited.");
  assert.equal(profile.examples?.length, 1);

  // Verifies that the IdentityProfile conforms to runtime contracts
  const validated = validateIdentityProfile(profile);
  assert.equal(validated.profileId, "gamebuddy.companion.abigail");

  // Verifies system prompt rendering for prefix caching (m[0])
  const prompt = buildCompanionSystemPrompt(profile);
  assert.ok(prompt.includes("gamebuddy_companion_identity"));
  assert.ok(prompt.includes("Abigail"));
  assert.ok(prompt.includes("Loves amethyst and gaming."));
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

test("safe decoder preserves multiline formatting in description, personality, scenario, greeting, and character book", () => {
  const multilineCard = {
    spec: "chara_card_v3",
    data: {
      name: "Abigail",
      description: "Line 1: A gamer.\r\nLine 2: Loves amethyst.\nLine 3: Adventurous.",
      personality: "Paragraph 1: Bold.\n\nParagraph 2: Mysterious.",
      scenario: "Setting:\n- Pelican Town\n- Pierre's General Store",
      first_mes: "Hey there!\nWhat are you up to today?",
      character_book: {
        entries: [
          {
            comment: "Lore Entry",
            content: "First line of lore.\r\nSecond line of lore with\ttabs.",
          },
        ],
      },
    },
  };

  const preview = previewStCard(multilineCard);
  assert.equal(
    preview.profileCandidate.persona?.core,
    "Line 1: A gamer.\r\nLine 2: Loves amethyst.\nLine 3: Adventurous.",
  );
  assert.equal(preview.profileCandidate.persona?.interactionStyle, "Paragraph 1: Bold.\n\nParagraph 2: Mysterious.");
  assert.equal(preview.profileCandidate.identity.continuity, "Setting:\n- Pelican Town\n- Pierre's General Store");
  assert.equal(preview.profileCandidate.firstGreeting, "Hey there!\nWhat are you up to today?");
  assert.equal(preview.worldBookCandidates[0]?.content, "First line of lore.\r\nSecond line of lore with\ttabs.");
});

test("safe decoder parses zTXt compressed PNG chunks and ccv3 keyword", () => {
  const cardData = {
    spec: "chara_card_v3",
    data: {
      name: "Compressed Rin",
      description: "Parsed from zTXt chunk with multiline\ndescription.",
    },
  };

  // Test zTXt with 'chara' keyword
  const ztxtReport = decodeStCard(pngWithZtxt(JSON.stringify(cardData), "chara"));
  assert.equal(ztxtReport.source, "png");
  assert.equal(ztxtReport.candidate?.profileCandidate.identity.name, "Compressed Rin");
  assert.equal(
    ztxtReport.candidate?.profileCandidate.persona?.core,
    "Parsed from zTXt chunk with multiline\ndescription.",
  );

  // Test tEXt with 'ccv3' keyword
  const ccv3Report = decodeStCard(pngWithChara(JSON.stringify(cardData), "ccv3"));
  assert.equal(ccv3Report.source, "png");
  assert.equal(ccv3Report.candidate?.profileCandidate.identity.name, "Compressed Rin");

  // Test zTXt with 'ccv3' keyword
  const ztxtCcv3Report = decodeStCard(pngWithZtxt(JSON.stringify(cardData), "ccv3"));
  assert.equal(ztxtCcv3Report.source, "png");
  assert.equal(ztxtCcv3Report.candidate?.profileCandidate.identity.name, "Compressed Rin");
});

test("previewStCard and decodeStCard recognize spec ccv3 as st-v3 format", () => {
  const cardWithTopLevelSpec = {
    spec: "ccv3",
    data: {
      name: "CCV3 Companion",
      description: "A companion defined with spec ccv3",
      character_book: { entries: [{ comment: "CCV3 Lore", content: "Lore content" }] },
    },
  };
  const preview1 = previewStCard(cardWithTopLevelSpec);
  assert.equal(preview1.format, "st-v3");
  assert.equal(preview1.worldBookCandidates[0]?.entryId, "st-st-v3-1");

  const cardWithDataSpec = {
    data: {
      spec: "ccv3",
      name: "Data CCV3 Companion",
      description: "A companion with spec inside data",
    },
  };
  const preview2 = previewStCard(cardWithDataSpec);
  assert.equal(preview2.format, "st-v3");

  const report = decodeStCard(JSON.stringify(cardWithTopLevelSpec));
  assert.equal(report.format, "st-v3");
  assert.equal(report.candidate?.worldBookCandidates[0]?.entryId, "st-st-v3-1");
});

// =========================================================================
// Property-Based Tests (PBT via fast-check)
// =========================================================================

test("PBT Property 1: Fuzzing arbitrary JSON strings never crashes decodeStCard", () => {
  fc.assert(
    fc.property(fc.json(), (jsonStr) => {
      // Must never throw an unhandled error
      const report = decodeStCard(jsonStr);
      assert.ok(report);
      assert.equal(typeof report.source, "string");
      assert.ok(Array.isArray(report.dispositions));

      for (const d of report.dispositions) {
        assert.ok(
          ["accepted_typed", "preserved_opaque", "dropped_unsupported", "rejected_invalid"].includes(d.classification),
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("PBT Property 2: Multiline formatting and newline preservation under fuzzing", () => {
  const multilineAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n\r.,!?-_";
  const multilineArb = fc.string({
    unit: fc.constantFrom(...multilineAlphabet),
    minLength: 1,
    maxLength: 80,
  });

  assert.ok(multilineAlphabet.includes("\t"));
  assert.ok(multilineAlphabet.includes("\n"));
  assert.ok(multilineAlphabet.includes("\r"));
  fc.assert(
    fc.property(multilineArb, (text) => {
      assert.ok([...text].every((character) => multilineAlphabet.includes(character)));
    }),
    { numRuns: 100 },
  );

  fc.assert(
    fc.property(multilineArb, multilineArb, (desc, greeting) => {
      const card = {
        spec: "chara_card_v3",
        data: {
          name: "TestCompanion",
          description: desc,
          first_mes: greeting,
        },
      };

      const preview = previewStCard(card);
      // Description must either be exactly preserved or undefined if it contains invalid control chars
      if (preview.profileCandidate.persona?.core) {
        assert.equal(preview.profileCandidate.persona.core, desc);
      }
      if (preview.profileCandidate.firstGreeting) {
        assert.equal(preview.profileCandidate.firstGreeting, greeting);
      }
    }),
    { numRuns: 100 },
  );
});

test("PBT Property 3: Arbitrary byte payload never crashes PNG decoder", () => {
  const bytesArb = fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 200 }).map(
    (arr) => new Uint8Array(arr),
  );

  fc.assert(
    fc.property(bytesArb, (bytes) => {
      const report = decodeStCard(bytes);
      assert.ok(report);
      assert.ok(Array.isArray(report.dispositions));
    }),
    { numRuns: 100 },
  );
});

test("PBT Property 4: Generated Card Preview maps to valid IdentityProfile with Prefix Caching", () => {
  const multilineAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n\r.,!?-_";
  const cardArb = fc.record({
    name: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 30 }),
    description: fc.string({
      unit: fc.constantFrom(...multilineAlphabet),
      minLength: 1,
      maxLength: 100,
    }),
    personality: fc.string({
      unit: fc.constantFrom(...multilineAlphabet),
      minLength: 1,
      maxLength: 100,
    }),
    scenario: fc.string({
      unit: fc.constantFrom(...multilineAlphabet),
      minLength: 1,
      maxLength: 100,
    }),
  });

  fc.assert(
    fc.property(fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 30 }), (name) => {
      assert.match(name, /^[\x20-\x7e]+$/);
    }),
    { numRuns: 100 },
  );

  fc.assert(
    fc.property(cardArb, (cardData) => {
      const card = {
        spec: "chara_card_v3",
        data: cardData,
      };
      const preview = previewStCard(card);
      const profile = candidateToIdentityProfile(preview, 1);

      // Invariant: candidateToIdentityProfile produces a structurally valid IdentityProfile
      assert.equal(profile.schemaVersion, 1);
      assert.equal(profile.revision, 1);
      assert.ok(profile.profileId.startsWith("gamebuddy.companion."));
      assert.equal(profile.identity.name, preview.profileCandidate.identity.name);

      // Invariant: Prompt rendering succeeds for m[0] prefix caching
      const prompt = buildCompanionSystemPrompt(profile);
      assert.ok(prompt.includes(profile.identity.name));
    }),
    { numRuns: 100 },
  );
});
