import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const endpoint = "https://api.xiaomimimo.com/v1/chat/completions";
const apiKey = process.env.MIMO_API_KEY;
const output = resolve(process.cwd(), "fixtures/voice/mimo-v2.5-tts-sse-redacted.json");
if (typeof apiKey !== "string" || apiKey.length < 16)
  throw new Error(
    "MIMO_API_KEY must be supplied through the process environment; it is never read from or written to a fixture.",
  );

// Deliberately tiny, non-user content. Do not record this text, the API key,
// any auth header, base64 audio, or raw provider response in the artifact.
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "api-key": apiKey, "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({
    model: "mimo-v2.5-tts",
    messages: [{ role: "assistant", content: "你好。" }],
    audio: { format: "pcm16", voice: "Chloe" },
    stream: true,
  }),
});

const fixture = {
  fixtureVersion: 1,
  capturedAt: new Date().toISOString(),
  provider: "xiaomi-mimo",
  endpoint: new URL(endpoint).origin + new URL(endpoint).pathname,
  request: {
    method: "POST",
    model: "mimo-v2.5-tts",
    stream: true,
    audioFormat: "pcm16",
    messageRoles: ["assistant"],
    authentication: "api-key: <redacted>",
  },
  response: {
    httpStatus: response.status,
    contentType: response.headers.get("content-type")?.split(";")[0] ?? null,
    terminal: "not_observed",
    chunksWithAudio: 0,
    eventFields: [],
  },
};

if (response.ok && response.body !== null) {
  const decoder = new TextDecoder();
  let buffered = "";
  const fields = new Set();
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        fixture.response.terminal = "done";
        continue;
      }
      try {
        const payload = JSON.parse(data);
        const delta = payload?.choices?.[0]?.delta;
        if (delta && typeof delta === "object") {
          for (const key of Object.keys(delta).sort()) fields.add(`choices[].delta.${key}`);
          if (typeof delta.audio?.data === "string") fixture.response.chunksWithAudio++;
        }
      } catch {
        fixture.response.terminal = "malformed_sse";
      }
    }
  }
  fixture.response.eventFields = [...fields];
} else {
  fixture.response.terminal = "http_error";
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
if (!response.ok)
  throw new Error(
    `MiMo contract capture returned HTTP ${response.status}; redacted fixture recorded only status/category.`,
  );
console.log(
  `Captured redacted MiMo TTS contract fixture (${fixture.response.chunksWithAudio} audio chunks; ${fixture.response.terminal}).`,
);
