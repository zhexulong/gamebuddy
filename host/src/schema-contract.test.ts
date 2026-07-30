import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

type ReplayFixture = Readonly<{ messages: readonly unknown[] }>;

async function schemaValidator() {
  const schema = JSON.parse(await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8")) as object;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function fixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/bridge-v1/${name}`, import.meta.url)), "utf8")) as ReplayFixture;
}

test("language-neutral schema validates committed bridge replay payloads", async () => {
  const validate = await schemaValidator();
  for (const name of ["golden-sequence.json", "phase2-terminal-replay.json"]) {
    for (const message of (await fixture(name)).messages) {
      assert.equal(validate(message), true, `${name}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

test("language-neutral schema rejects a malformed typed payload", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  assert.equal(validate({ ...(message as Record<string, unknown>), type: "execution_receipt", payload: { executionId: "exec_01" } }), false);
});
