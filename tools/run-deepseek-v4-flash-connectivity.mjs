#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const apiKey = process.env.CPA_OAI_API_KEY;
if (!apiKey) throw new Error("CPA_OAI_API_KEY_required");
const baseUrl = "http://127.0.0.1:8317/v1";
const model = "deepseek-v4-flash";
const root = await mkdtemp(join(tmpdir(), "gamebuddy-deepseek-connectivity-"));
const requestPath = join(root, "request.json");
try {
  const catalogResponse = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  const catalog = await catalogResponse.json().catch(() => null);
  const catalogModels = Array.isArray(catalog?.data)
    ? catalog.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
    : [];
  if (!catalogResponse.ok || !catalogModels.includes(model)) throw new Error("deepseek_v4_flash_not_advertised_by_cpa");

  const body = {
    model,
    stream: false,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    max_tokens: 128,
    messages: [
      { role: "system", content: "You are a GameBuddy provider connectivity probe. Reply with exactly: ready" },
      { role: "user", content: "Confirm provider connectivity." },
    ],
  };
  await writeFile(
    requestPath,
    JSON.stringify({ model, thinkingEnabled: true, reasoningEffort: "high", maxTokens: 128 }),
    "utf8",
  );
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  const message = payload?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const passed = response.ok && content.length > 0;
  console.log(
    JSON.stringify({
      provider: "cpa-oai",
      model,
      catalogAdvertised: catalogModels.includes(model),
      request: { thinkingEnabled: true, reasoningEffort: "high", maxTokens: 128 },
      response: {
        ok: response.ok,
        status: response.status,
        hasContent: content.length > 0,
        hasReasoning: typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0,
      },
      passed,
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
