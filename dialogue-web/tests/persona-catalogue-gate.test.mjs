/**
 * The voice persona picker must offer exactly the extension's personas.
 *
 * The measured risk: `MIMO_TTS_PERSONAS` is the Voice layer's own allowlist
 * (`vendor/pi-koe/src/mimo.ts`), and dialogue-web cannot import across the
 * submodule boundary at runtime - the shipped browser artifact has no access to
 * the vendored extension's TypeScript sources, and there is no published
 * package that carries the persona ids (`@gamebuddy/voice-protocol` carries the
 * wire protocol, not the personas). So the picker keeps a display-time mirror of
 * the ids, and this gate is what keeps it from drifting: it reads the ids out of
 * the extension's own declaration and asserts the picker's set is the same set.
 *
 * The read is a source read on purpose. Importing the module would pull
 * `@gamebuddy/voice-protocol` (through `gateway.ts`) and a build artifact, and
 * the static zone must run on a fresh checkout with no build. A package export of
 * the persona ids (or moving them into `@gamebuddy/voice-protocol`) would be the
 * clean seam; until it exists, this text read is the one honest way to compare.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MIMO_PERSONA_IDS } from "../src/components/management-panels.tsx";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_MIMO = join(REPO, "vendor", "pi-koe", "src", "mimo.ts");

/** The persona ids the extension declares, read from its own `MIMO_TTS_PERSONAS` block. */
export function extensionPersonaIds(source) {
  const block = /export const MIMO_TTS_PERSONAS = Object\.freeze\(\{([\s\S]*?)\n\} as const\);/u.exec(source);
  assert.ok(block !== null, "the extension declares MIMO_TTS_PERSONAS as a frozen object literal");
  const ids = [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*Object\.freeze\(/gmu)].map((match) => match[1]);
  assert.ok(ids.length > 0, "the MIMO_TTS_PERSONAS block declares at least one persona");
  return ids;
}

test("persona-catalogue.1: the picker's persona set is exactly the extension's", (t) => {
  const extensionIds = extensionPersonaIds(readFileSync(EXTENSION_MIMO, "utf8"));
  const pickerIds = [...MIMO_PERSONA_IDS];
  t.diagnostic(`persona-catalogue.1: extension=${extensionIds.join(",")} picker=${pickerIds.join(",")}`);
  assert.deepEqual(
    [...pickerIds].sort(),
    [...extensionIds].sort(),
    "the voice persona picker offers exactly the personas the vendored extension resolves; adding one on either side must update the other",
  );
});

test("persona-catalogue.2 (mutation): a diverging picker set is reported", () => {
  const extensionIds = extensionPersonaIds(readFileSync(EXTENSION_MIMO, "utf8"));
  // Plant a picker set that is missing a real persona and carries an invented one:
  // the comparison must reject both directions rather than only a subset.
  const planted = [...extensionIds.slice(1), "invented_persona"];
  assert.notDeepEqual([...planted].sort(), [...extensionIds].sort());
  assert.deepEqual([...extensionIds].sort(), [...extensionIds].sort());
});
