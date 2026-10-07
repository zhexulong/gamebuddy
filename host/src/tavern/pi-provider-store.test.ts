import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { environmentProviderEntry, mergeModelProviderEntry, modelProviderEntry } from "./pi-provider-store.js";
import {
  connectionDocumentPath,
  TavernConnectionStore,
} from "./connection-store.js";
import { TAVERN_ESCAPE_HATCH_PROVIDER_ID } from "./provider-catalog.js";

/**
 * The zero-configuration equivalence boundary.
 *
 * Every root that has no player connection must produce exactly the
 * `models.json` document this Host wrote before player connections existed. The
 * frozen expectation below is a literal copy of the pre-change serializer
 * output, so a regression in the merge cannot pass by being compared against
 * the code it is meant to replace.
 */
const ZERO_CONFIG_DEEPSEEK = `{
  "providers": {
    "cpa-oai": {
      "name": "CPA OpenAI-compatible Agent",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "api": "openai-completions",
      "apiKey": "$CPA_OAI_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true
      },
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "deepseek-v4-flash",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": "low",
            "low": "low",
            "medium": "high",
            "high": "high",
            "xhigh": "high",
            "max": "max"
          },
          "input": [
            "text"
          ],
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "cost": {
            "input": 0.14,
            "output": 0.28,
            "cacheRead": 0.0028,
            "cacheWrite": 0.14
          },
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true,
            "maxTokensField": "max_tokens",
            "supportsStrictMode": true,
            "thinkingFormat": "deepseek",
            "requiresReasoningContentOnAssistantMessages": true
          }
        }
      ]
    }
  }
}`;

let canonicalTemporaryRoot: string;

// The provider store reads the selected connection through the durable store,
// which takes a path lock, so these tests need the same test-only reclaimer
// binding every other path-lock consumer's test uses.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  canonicalTemporaryRoot = await realpath(tmpdir());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function withRoot(run: (modelsPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-models-merge-"));
  try {
    await run(join(root, "models.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("zero configuration writes exactly the previous single-provider document", async () => {
  await withRoot(async (modelsPath) => {
    // The frozen entry the pre-change code built for the default model.
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    assert.equal(await readFile(modelsPath, "utf8"), ZERO_CONFIG_DEEPSEEK);

    // Re-running with the same entry is idempotent: a second runtime start for
    // the same model must not perturb the document.
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    assert.equal(await readFile(modelsPath, "utf8"), ZERO_CONFIG_DEEPSEEK);
  });
});

test("a second model keeps the frozen entry shape while the environment entry stays byte-identical", async () => {
  await withRoot(async (modelsPath) => {
    const entry = environmentProviderEntry("gpt-5.6-luna");
    await mergeModelProviderEntry(modelsPath, "cpa-oai", entry);
    const written = JSON.parse(await readFile(modelsPath, "utf8"));
    // Same keys in the same order as the frozen DeepSeek document; only the
    // thinking-level map and the model id differ, which the pre-change code
    // also varied per model.
    assert.deepEqual(Object.keys(written.providers["cpa-oai"]), [
      "name",
      "baseUrl",
      "api",
      "apiKey",
      "compat",
      "models",
    ]);
    assert.equal(written.providers["cpa-oai"].models[0].thinkingLevelMap.medium, "medium");
    assert.equal(written.providers["cpa-oai"].models[0].compat.thinkingFormat, undefined);
    assert.equal(written.providers["cpa-oai"].models[0].id, "gpt-5.6-luna");
  });
});

test("merging keeps an unrelated provider entry instead of deleting it", async () => {
  await withRoot(async (modelsPath) => {
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    await mergeModelProviderEntry(modelsPath, TAVERN_ESCAPE_HATCH_PROVIDER_ID, {
      name: "OpenAI-compatible endpoint",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      authHeader: true,
      models: [{ id: "qwen2.5-coder:7b", name: "qwen2.5-coder:7b" }],
    });
    const written = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.deepEqual(Object.keys(written.providers).sort(), ["cpa-oai", TAVERN_ESCAPE_HATCH_PROVIDER_ID].sort());
    assert.equal(written.providers[TAVERN_ESCAPE_HATCH_PROVIDER_ID].baseUrl, "http://127.0.0.1:11434/v1");

    // The previous behaviour replaced the whole document. Prove the frozen
    // entry survives a later start for a different selection.
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    const after = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(after.providers[TAVERN_ESCAPE_HATCH_PROVIDER_ID].models[0].id, "qwen2.5-coder:7b");
  });
});

test("a malformed document is replaced by the entry the runtime owns", async () => {
  await withRoot(async (modelsPath) => {
    await writeFile(modelsPath, "not json", "utf8");
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    assert.equal(await readFile(modelsPath, "utf8"), ZERO_CONFIG_DEEPSEEK);

    await writeFile(modelsPath, JSON.stringify({ providers: "invalid" }), "utf8");
    await mergeModelProviderEntry(modelsPath, "cpa-oai", environmentProviderEntry("deepseek-v4-flash"));
    assert.equal(await readFile(modelsPath, "utf8"), ZERO_CONFIG_DEEPSEEK);
  });
});

/**
 * The selection-to-entry path the runtime construction actually calls. The
 * endpoint of the one player-supplied entry is read from that player's own
 * durable record, and no other selection can reach an endpoint the catalog did
 * not authorize.
 */
test("the runtime provider entry follows the selected connection and its own endpoint", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-models-selection-"));
  try {
    // No player connection at all: the frozen environment entry is selected.
    const environment = await modelProviderEntry(root, {
      provider: "cpa-oai",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
    });
    assert.equal(environment?.providerId, "cpa-oai");
    assert.deepEqual(environment?.entry, environmentProviderEntry("deepseek-v4-flash"));

    // A catalog provider pins the Host-owned endpoint and adds no model list,
    // so the model metadata Pi ships for that provider is preserved.
    const catalog = await modelProviderEntry(root, {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "high",
    });
    assert.equal(catalog?.providerId, "openai");
    assert.deepEqual(catalog?.entry, {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
    });

    // The escape hatch has no Host-owned endpoint: without the player's own
    // record there is nothing to select, and the runtime must not invent one.
    const unrecorded = await modelProviderEntry(root, {
      provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      modelId: "qwen2.5-coder:7b",
      thinkingLevel: "high",
    });
    assert.equal(unrecorded, null);

    await new TavernConnectionStore(root).create({
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      apiKey: "sk-synthetic-hatch-key",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiShape: "openai-completions",
      modelId: "qwen2.5-coder:7b",
    });
    const hatch = await modelProviderEntry(root, {
      provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      modelId: "qwen2.5-coder:7b",
      thinkingLevel: "high",
    });
    assert.equal(hatch?.providerId, TAVERN_ESCAPE_HATCH_PROVIDER_ID);
    // The endpoint and the model id come from the player's record; the
    // credential never reaches `models.json`.
    assert.deepEqual(hatch?.entry, {
    name: "OpenAI-compatible endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    // No authHeader: the adapter installs `Authorization: Bearer` from the resolved key
    // itself, and pi's default for the flag is false.
    models: [{ id: "qwen2.5-coder:7b", name: "qwen2.5-coder:7b" }],
  });
  assert.doesNotMatch(JSON.stringify(hatch?.entry), /sk-synthetic-hatch-key/);

    // An unknown provider is not a provider entry.
    assert.equal(await modelProviderEntry(root, { provider: "invented", modelId: "x", thinkingLevel: "high" }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the emitted provider entry carries the escape hatch's own API shape", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-models-shape-"));
  try {
    // The document the connection store persists for two escape-hatch records:
    // one speaking Anthropic messages, one speaking Responses at an endpoint
    // whose route carries the required `?api-version=` query string.
    await writeFile(
      connectionDocumentPath(root),
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        activeConnectionId: null,
        connections: [
          hatchConnection("A".repeat(43), "https://anthropic-gateway.example.com", "anthropic-messages", "claude-3-5-sonnet"),
          hatchConnection(
            "B".repeat(43),
            "https://gateway.example.com/openai/deployments/coder?api-version=2024-02-01",
            "openai-responses",
            "gpt-5.5",
          ),
        ],
      }),
      "utf8",
    );

    const anthropic = await modelProviderEntry(root, {
      provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      modelId: "claude-3-5-sonnet",
      thinkingLevel: "high",
    });
    assert.deepEqual(anthropic?.entry, {
      name: "OpenAI-compatible endpoint",
      baseUrl: "https://anthropic-gateway.example.com",
      api: "anthropic-messages",
      // The decisive case for not writing authHeader: this shape authenticates with
      // `x-api-key`, so a generic `Authorization: Bearer` would be a second header in a
      // scheme the endpoint does not use.
      models: [{ id: "claude-3-5-sonnet", name: "claude-3-5-sonnet" }],
    });

    const responses = await modelProviderEntry(root, {
      provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      modelId: "gpt-5.5",
      thinkingLevel: "high",
    });
    assert.equal(responses?.entry.api, "openai-responses");
    assert.equal(
      responses?.entry.baseUrl,
      "https://gateway.example.com/openai/deployments/coder?api-version=2024-02-01",
    );
    // One record's shape never leaks into another's entry.
    assert.equal(anthropic?.entry.api, "anthropic-messages");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A record whose API shape is not one Pi speaks yields no provider entry at
 * all: the runtime fails closed instead of receiving an API id with no adapter.
 */
test("an escape-hatch record with an unspokable API shape yields no provider entry", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-models-shape-corrupt-"));
  try {
    for (const apiShape of ["invented-messages", null]) {
      await writeFile(
        connectionDocumentPath(root),
        JSON.stringify({
          schemaVersion: 1,
          revision: 2,
          activeConnectionId: null,
          connections: [
            { ...hatchConnection("A".repeat(43), "https://gateway.example.com/v1", "openai-responses", "gpt-5.5"), apiShape },
          ],
        }),
        "utf8",
      );
      assert.equal(
        await modelProviderEntry(root, {
          provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
          modelId: "gpt-5.5",
          thinkingLevel: "high",
        }),
        null,
        `expected ${JSON.stringify(apiShape)} to yield no provider entry`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** One persisted escape-hatch record, in the exact shape the store writes. */
function hatchConnection(connectionId: string, baseUrl: string, apiShape: string, modelId: string) {
  return {
    connectionId,
    providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    baseUrl,
    apiShape,
    modelId,
    thinkingLevel: "high",
    readiness: "configured",
    failure: null,
    lastCheckedAtMs: null,
  };
}

/**
 * The record a selection is read from is the same document the store writes; a
 * corrupted one must not be read as "no player endpoint" and silently fall back
 * to a different endpoint.
 */
test("an unreadable connection document yields no player endpoint", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-models-corrupt-"));
  try {
    await writeFile(connectionDocumentPath(root), "not json", "utf8");
    assert.equal(
      await modelProviderEntry(root, {
        provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
        modelId: "qwen2.5-coder:7b",
        thinkingLevel: "high",
      }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
