#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildMagicContextSection } from "../src/agents/magic-context-prompt";
import { parseRangeString } from "../src/features/magic-context/range-parser";

const ARTIFACT_DIR = resolve(
    import.meta.dir,
    "../../..",
    "docs/specs/prompt-surface/light-validation",
);
const MODELS = [
    { label: "DeepSeek V4 Flash", route: "ollama-cloud/deepseek-v4-flash", model: "deepseek-v4-flash" },
    { label: "Gemma 4 31B", route: "ollama-cloud/gemma4:31b", model: "gemma4:31b" },
] as const;
const PRESETS = ["full", "light"] as const;
const PROBE = `§101§ User instruction: preserve the requested migration order.
§102§ Assistant: I extracted the relevant code paths.
§103§ Tool output: a large file read already analyzed and acted on.
§104§ Tool output: an unresolved compiler error that still needs diagnosis.
§105§ Tool output: repeated passing status already recorded elsewhere.

You have finished with §103§ and §105§, but §104§ is unresolved. Silently call ctx_reduce once with both eligible IDs in the documented drop grammar. Emit no prose or placeholder markers.`;
const EXPECTED_DROP_IDS = [103, 105];
const TEMPERATURE = 0;
const SEED = 268;
const MAX_OUTPUT_TOKENS = 128;
const TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 2;

interface OllamaToolCall {
    function?: {
        name?: string;
        arguments?: Record<string, unknown>;
    };
}

interface OllamaResponse {
    message?: {
        content?: string;
        tool_calls?: OllamaToolCall[];
    };
    prompt_eval_count?: number;
    eval_count?: number;
}

interface RunRecord {
    model: string;
    requestedModel: string;
    preset: (typeof PRESETS)[number];
    content: string;
    toolCalls: OllamaToolCall[];
    drop: string | null;
    checks: {
        oneRealCtxReduceCall: boolean;
        correctDropShape: boolean;
        noTagImitation: boolean;
        noFabricatedDroppedMarker: boolean;
    };
    passed: boolean;
    usage: { promptTokens: number; completionTokens: number };
}

function resolveOllamaCloudKey(): string {
    const candidates = [
        join(homedir(), ".local", "share", "opencode", "auth.json"),
        join(homedir(), ".config", "opencode", "auth.json"),
    ];
    const path = candidates.find(existsSync);
    if (!path) throw new Error(`opencode auth.json not found (looked in ${candidates.join(", ")})`);
    const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: string }>;
    const key = auth["ollama-cloud"]?.key?.trim();
    if (!key) throw new Error(`ollama-cloud key not found in ${path}`);
    return key;
}

async function callModel(model: string, system: string): Promise<OllamaResponse> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch("https://ollama.com/api/chat", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${resolveOllamaCloudKey()}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: PROBE },
                    ],
                    tools: [
                        {
                            type: "function",
                            function: {
                                name: "ctx_reduce",
                                description: "Mark spent tagged outputs discardable.",
                                parameters: {
                                    type: "object",
                                    properties: { drop: { type: "string" } },
                                    required: ["drop"],
                                    additionalProperties: false,
                                },
                            },
                        },
                    ],
                    think: false,
                    stream: false,
                    options: {
                        temperature: TEMPERATURE,
                        seed: SEED,
                        num_predict: MAX_OUTPUT_TOKENS,
                    },
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`ollama-cloud ${response.status}: ${text.slice(0, 500)}`);
            return JSON.parse(text) as OllamaResponse;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_ATTEMPTS) await Bun.sleep(1_000);
        }
    }
    throw lastError ?? new Error("ollama-cloud request failed without an error");
}

function evaluate(
    model: (typeof MODELS)[number],
    preset: (typeof PRESETS)[number],
    response: OllamaResponse,
): RunRecord {
    const content = response.message?.content?.trim() ?? "";
    const toolCalls = response.message?.tool_calls ?? [];
    const call = toolCalls[0]?.function;
    const drop = typeof call?.arguments?.drop === "string" ? call.arguments.drop : null;
    let parsedDrop: number[] = [];
    try {
        parsedDrop = drop ? [...new Set(parseRangeString(drop))].sort((a, b) => a - b) : [];
    } catch {
        parsedDrop = [];
    }
    const serializedOutput = JSON.stringify({ content, toolCalls });
    const checks = {
        oneRealCtxReduceCall: toolCalls.length === 1 && call?.name === "ctx_reduce",
        correctDropShape:
            parsedDrop.length === EXPECTED_DROP_IDS.length &&
            parsedDrop.every((id, index) => id === EXPECTED_DROP_IDS[index]),
        noTagImitation: !/§\d+§/.test(serializedOutput),
        noFabricatedDroppedMarker: !/\[dropped\s+§\d+§\]/i.test(serializedOutput),
    };
    return {
        model: model.route,
        requestedModel: model.model,
        preset,
        content,
        toolCalls,
        drop,
        checks,
        passed: Object.values(checks).every(Boolean),
        usage: {
            promptTokens: response.prompt_eval_count ?? 0,
            completionTokens: response.eval_count ?? 0,
        },
    };
}

function markdownFor(model: (typeof MODELS)[number], records: RunRecord[]): string {
    const lines = [
        `# ${model.label}: full vs light prompt behavior`,
        "",
        `Route: \`${model.route}\` (request model \`${model.model}\`)`,
        "",
        "Both presets received the same tagged transcript and real `ctx_reduce` tool schema. Passing requires one real tool call with IDs 103 and 105, no §N§ imitation, and no fabricated dropped marker.",
        "",
    ];
    for (const record of records) {
        lines.push(`## ${record.preset}`, "", `Result: **${record.passed ? "PASS" : "FAIL"}**`, "");
        lines.push("```json", JSON.stringify(record, null, 2), "```", "");
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    const records: RunRecord[] = [];
    for (const model of MODELS) {
        for (const preset of PRESETS) {
            const guidance = buildMagicContextSection(
                null,
                20,
                true,
                true,
                true,
                false,
                false,
                undefined,
                true,
                preset,
            );
            const response = await callModel(model.model, guidance);
            const record = evaluate(model, preset, response);
            records.push(record);
            console.log(`${model.route} ${preset}: ${record.passed ? "PASS" : "FAIL"}`);
        }
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    for (const model of MODELS) {
        const modelRecords = records.filter((record) => record.model === model.route);
        const name = model.route.replace(/[^A-Za-z0-9._-]+/g, "-");
        writeFileSync(join(ARTIFACT_DIR, `${name}.md`), markdownFor(model, modelRecords));
    }
    writeFileSync(
        join(ARTIFACT_DIR, "manifest.json"),
        `${JSON.stringify(
            {
                artifactId: "prompt-surface-light-weak-model-validation",
                revision: "s3-r1",
                timestamp: new Date().toISOString(),
                endpoint: "https://ollama.com/api/chat",
                models: MODELS,
                presets: PRESETS,
                settings: {
                    temperature: TEMPERATURE,
                    seed: SEED,
                    think: false,
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                    timeoutMs: TIMEOUT_MS,
                    maxAttempts: MAX_ATTEMPTS,
                    repetitions: 1,
                },
                probe: PROBE,
                expectedDropIds: EXPECTED_DROP_IDS,
                rubric: [
                    "one real ctx_reduce tool call",
                    "drop parses to exactly IDs 103 and 105",
                    "no §N§ imitation in assistant output or tool arguments",
                    "no fabricated [dropped §N§] marker",
                ],
                unavailableModelPolicy: "fail the harness; do not substitute a model silently",
                records,
                passed: records.length === MODELS.length * PRESETS.length && records.every((record) => record.passed),
            },
            null,
            2,
        )}\n`,
    );

    if (records.length !== MODELS.length * PRESETS.length || records.some((record) => !record.passed)) {
        process.exitCode = 1;
    }
}

await main();
