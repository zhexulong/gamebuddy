import assert from "node:assert/strict";
import test from "node:test";
import {
  advancedPiSettingsText,
  applyAdvancedPiSettingsEdit,
  parseAdvancedPiSettings,
  serializeAdvancedPiSettings,
  validateAdvancedPiSettingsDocument,
} from "../src/pi-settings-model.ts";

/**
 * The advanced (Pi JSON) settings path. Each assertion is written against the
 * concrete failure it catches, because this path stands between a player's typed
 * JSON and Pi's own `models.json`:
 *
 * - an envelope we invented instead of Pi's would silently stop Pi from reading
 *   the player's endpoint;
 * - a partial accept would let a rejected edit reach the file anyway;
 * - a normalized provider entry would rename Pi's fields behind the player.
 */

const piDocument = {
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "qwen2.5-coder:7b" }],
    },
  },
};

test("a valid edit parses to exactly Pi's models.json envelope", () => {
  const parsed = parseAdvancedPiSettings(JSON.stringify(piDocument));
  assert.equal(parsed.ok, true, "Pi's own document must parse");
  assert.deepEqual(parsed.document, piDocument, "the parsed document must be Pi's document, byte-for-byte in shape");
  assert.deepEqual(Object.keys(parsed.document), ["providers"], "Pi's models.json has exactly one top-level key");
});

test("a provider entry is passed through verbatim, never normalized", () => {
  const parsed = parseAdvancedPiSettings(
    JSON.stringify({
      providers: {
        gateway: {
          name: "My gateway",
          baseUrl: "https://example.test/v1",
          api: "openai-responses",
          headers: { "x-tenant": "$TENANT" },
          models: [{ id: "m1", reasoning: true, contextWindow: 200000 }],
          modelOverrides: { m1: { promptCache: { short: 300 } } },
        },
      },
    }),
  );
  assert.equal(parsed.ok, true);
  const entry = parsed.document.providers.gateway;
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["api", "baseUrl", "headers", "modelOverrides", "models", "name"],
    "every field the player wrote must survive exactly: Pi owns these names",
  );
});

test("text that is not JSON is rejected as invalid_json with a real message", () => {
  for (const text of ["{ not json", "", "{\"providers\": }", "providers: {}"]) {
    const parsed = parseAdvancedPiSettings(text);
    assert.deepEqual(parsed, { ok: false, problem: "invalid_json" }, `"${text}" is not JSON`);
  }
  const text = advancedPiSettingsText("en").invalidJson;
  assert.ok(text.length > 0 && !text.includes("invalid_json"), "the player reads a sentence, not the closed code");
});

test("JSON that is not Pi's models.json is rejected whole as invalid_shape", () => {
  const wrongShapes = [
    "[]",
    "3",
    "null",
    "{}",
    JSON.stringify({ providers: 3 }),
    JSON.stringify({ providers: [] }),
    JSON.stringify({ providers: { ollama: 3 } }),
    JSON.stringify({ providers: {}, extra: 1 }),
    JSON.stringify({ providers: {}, defaultModel: "x" }),
  ];
  for (const text of wrongShapes) {
    assert.deepEqual(
      parseAdvancedPiSettings(text),
      { ok: false, problem: "invalid_shape" },
      `${text} is not Pi's document and must be refused whole`,
    );
  }
  assert.ok(advancedPiSettingsText("en").invalidShape.length > 0);
  assert.ok(advancedPiSettingsText("zh-CN").invalidShape.length > 0);
});

test("an invalid edit is rejected with a real message and never reaches the writer", async () => {
  const written = [];
  const write = async (document) => {
    written.push(document);
  };
  const invalid = await applyAdvancedPiSettingsEdit("{ oops", write);
  assert.deepEqual(invalid, { ok: false, problem: "invalid_json" });
  assert.equal(written.length, 0, "a rejected edit must not write Pi's file");
  const wrongShape = await applyAdvancedPiSettingsEdit(JSON.stringify({ providers: { ollama: 7 } }), write);
  assert.deepEqual(wrongShape, { ok: false, problem: "invalid_shape" });
  assert.equal(written.length, 0, "a wrong-shape edit must not write Pi's file");
});

test("a valid edit writes exactly Pi's shape, once", async () => {
  const written = [];
  const result = await applyAdvancedPiSettingsEdit(JSON.stringify(piDocument), async (document) => {
    written.push(document);
  });
  assert.equal(result.ok, true);
  assert.equal(written.length, 1, "one accepted edit is one write");
  assert.deepEqual(written[0], piDocument, "the written document is exactly what Pi reads");
  assert.deepEqual(Object.keys(written[0]), ["providers"], "no wrapper key is invented for the file");
});

test("the editor's seeding text round-trips without losing a field", () => {
  const parsed = parseAdvancedPiSettings(serializeAdvancedPiSettings(piDocument));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document, piDocument, "serialize then parse must be lossless");
});

test("a Host read-back is validated, not trusted", () => {
  assert.deepEqual(validateAdvancedPiSettingsDocument(piDocument), piDocument);
  assert.equal(validateAdvancedPiSettingsDocument({ providers: { ollama: "no" } }), null);
  assert.equal(validateAdvancedPiSettingsDocument(null), null);
});
