import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GroqWhisperAsrProvider } from "../vendor/pi-koe/dist/groq.js";

// Load local secrets if present
for (const envPath of [".env.local", "../.env.local"]) {
  try {
    process.loadEnvFile?.(envPath);
    break;
  } catch {
    // optional
  }
}

const key = process.env.GROQ_API_KEY;
if (typeof key !== "string" || key.trim().length < 16) {
  console.error("GROQ_API_KEY required in .env.local or process environment.");
  process.exit(1);
}

const audioPath = resolve(process.argv[2] ?? "ref/external/Fun-ASR/runtime/llama.cpp/tests/sample.wav");
const locale = process.argv[3] ?? "zh";
const wavBytes = await readFile(audioPath);

// Strip standard 44-byte WAV header to get pure PCM16 for AsrProvider
const pcm16 = new Uint8Array(wavBytes.buffer, wavBytes.byteOffset + 44, wavBytes.byteLength - 44);

console.log(`Audio loaded: ${audioPath}`);
console.log(`PCM16 bytes: ${pcm16.byteLength} (${(pcm16.byteLength / (16000 * 2)).toFixed(2)}s @ 16kHz mono)`);
console.log(`Target locale: "${locale}"`);
console.log("Invoking Groq Whisper API (whisper-large-v3-turbo)...");

const provider = new GroqWhisperAsrProvider({ apiKey: key.trim() });
const startTime = Date.now();
try {
  const transcript = await provider.transcribe(pcm16, locale, new AbortController().signal);
  const elapsedMs = Date.now() - startTime;
  console.log("--- Groq Whisper Result ---");
  console.log(`Transcript : "${transcript}"`);
  console.log(`Latency    : ${elapsedMs}ms`);
  console.log(`Provider   : ${provider.providerId} (${provider.modelRevision})`);
  console.log("---------------------------");
} catch (err) {
  console.error("Transcribe failed:", err);
  process.exitCode = 1;
}
