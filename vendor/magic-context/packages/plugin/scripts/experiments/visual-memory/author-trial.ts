#!/usr/bin/env bun
/**
 * Single-shot OpenRouter trial for memory-palace cue authoring. It deliberately
 * reuses author-palace.ts validation instead of applying model output to files.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractCompleteManifestBody } from "../../../src/features/magic-context/dreamer/manifest-parser.ts";

import { isExactToken, validate } from "./author-palace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = "/tmp/visual-memory/trimmed-memories-source.txt";
const OUTPUT_DIR = "/tmp/visual-memory";
const REPORT_PATH = join(HERE, "TRIAL-REPORT.md");
const SYSTEM_PROMPT_PATH = join(HERE, "author-trial-system-prompt.md");
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const MAX_OUTPUT_TOKENS = 16_384;
const ANCHOR_FIDELITY_FLOOR = 85;
const MIN_ROOMS_PER_CATEGORY = 4;
const MAX_ROOMS_PER_CATEGORY = 8;

const CATEGORY_ORDER = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const;
const TRIAL_CATEGORIES = ["PROJECT_RULES", "ARCHITECTURE"] as const;

type Category = (typeof CATEGORY_ORDER)[number];
type TrialCategory = (typeof TRIAL_CATEGORIES)[number];
type SpecEntry = {
    id: number;
    category: Category;
    room: string;
    cue?: string | string[];
    mergeInto?: number;
    importance: number;
};
type SourceMemory = {
    id: number;
    category: Category;
    text: string;
    importance: number;
};
type FailureKind =
    | "missing polarity mechanism"
    | "hub noun repetition"
    | "memory ID leakage"
    | "broken exact anchors"
    | "unbalanced parentheses"
    | "other validator failures";
type ValidationFailure = { id?: number; message: string };
type Assessment = {
    coverage: { covered: number; total: number; uncovered: number[] };
    manifestValidationError?: string;
    failures: Record<FailureKind, ValidationFailure[]>;
    anchorFidelity: { matched: number; total: number; percent: number };
    importance: { matched: number; total: number; mismatches: number[] };
    rooms: {
        generated: string[];
        frontier: string[];
        generatedEntryCounts: Array<{ name: string; count: number }>;
    };
    samples: Array<{ id: number; frontierCue: string; generatedCue: string }>;
};
type TokenUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};
type OpenRouterPricing = {
    prompt?: number;
    completion?: number;
};
type OpenRouterModel = {
    id: string;
    name?: string;
    pricing?: OpenRouterPricing;
};
type ModelPlan = {
    label: string;
    requestedModel: string;
    fallbackModels: string[];
};
type ModelRun = {
    plan: ModelPlan;
    model: string;
    substitution?: string;
    pricing?: OpenRouterPricing;
    pricingNote?: string;
    results: TrialResult[];
};
type TrialResult = {
    label: string;
    model: string;
    category: TrialCategory;
    rawPath: string;
    attempts: number;
    retry: { attempted: boolean; recovered?: boolean; initialParseError?: string };
    requestError?: string;
    parseError?: string;
    usage: TokenUsage[];
    assessment?: Assessment;
};

type ChatMessage = { role: "system" | "user"; content: string };
type OpenRouterCompletion = { content: string; usage?: TokenUsage };

const FRONTIER_ROOM_TARGETS: Record<TrialCategory, number> = {
    PROJECT_RULES: 7,
    ARCHITECTURE: 16,
};

const MODEL_MATRIX: ModelPlan[] = [
    {
        label: "DeepSeek V4 Flash",
        requestedModel: "deepseek/deepseek-v4-flash",
        fallbackModels: ["deepseek/deepseek-v3.2"],
    },
    {
        label: "DeepSeek V4 Pro",
        requestedModel: "deepseek/deepseek-v4-pro",
        fallbackModels: ["deepseek/deepseek-v3.2"],
    },
    {
        label: "Kimi K2",
        requestedModel: "moonshotai/kimi-k2",
        fallbackModels: ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5"],
    },
    {
        label: "Gemini 3.5 Flash",
        requestedModel: "google/gemini-3.5-flash",
        fallbackModels: ["google/gemini-3-flash-preview", "google/gemini-2.5-flash"],
    },
];

const FAILURE_KINDS: FailureKind[] = [
    "missing polarity mechanism",
    "hub noun repetition",
    "memory ID leakage",
    "broken exact anchors",
    "unbalanced parentheses",
    "other validator failures",
];

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseSourceMemories(source: string, importanceById: Map<number, number>): SourceMemory[] {
    const memories: SourceMemory[] = [];
    let category: Category | undefined;
    let current: { id: number; category: Category; lines: string[] } | undefined;

    const flush = (): void => {
        if (!current) return;
        const importance = importanceById.get(current.id);
        if (importance === undefined) {
            throw new Error(`frontier spec has no importance for source memory ${current.id}`);
        }
        memories.push({
            id: current.id,
            category: current.category,
            text: current.lines.join("\n").trim(),
            importance,
        });
        current = undefined;
    };

    for (const line of source.split("\n")) {
        const open = line.match(/^<([A-Z_]+)>$/)?.[1];
        if (open) {
            flush();
            if (!CATEGORY_ORDER.includes(open as Category)) {
                throw new Error(`unknown source category ${open}`);
            }
            category = open as Category;
            continue;
        }
        if (/^<\/[A-Z_]+>$/.test(line)) {
            flush();
            category = undefined;
            continue;
        }
        const memory = line.match(/^#(\d+):\s?(.*)$/);
        if (memory) {
            flush();
            if (!category) throw new Error(`memory ${memory[1]} is outside a category`);
            current = {
                id: Number(memory[1]),
                category,
                lines: [memory[2] ?? ""],
            };
            continue;
        }
        if (current) current.lines.push(line);
    }
    flush();
    return memories;
}

function readFrontierSpecs(): SpecEntry[] {
    return readdirSync(HERE)
        .filter((file) => file.startsWith("spec-") && file.endsWith(".json"))
        .sort()
        .flatMap((file) => JSON.parse(readFileSync(join(HERE, file), "utf8")) as SpecEntry[]);
}

function renderCategoryPrompt(category: TrialCategory, memories: SourceMemory[]): string {
    const pool = memories
        .map(
            (memory) =>
                `#${memory.id} [importance=${memory.importance}]\n${memory.text}`,
        )
        .join("\n\n");
    return `# Palace cue authoring task\n\nAuthor the complete ${category} manifest below. The header ID and importance are required output fields; copy importance exactly. The source text is the only factual input.\n\n<${category}>\n${pool}\n</${category}>`;
}

function decodeXml(value: string, context: string): string {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) {
        throw new Error(`${context} contains an unescaped or unknown XML entity`);
    }
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match, entity: string) => {
        switch (entity) {
            case "amp":
                return "&";
            case "lt":
                return "<";
            case "gt":
                return ">";
            case "quot":
                return '"';
            case "apos":
                return "'";
            default: {
                const codePoint = Number.parseInt(
                    entity.startsWith("#x") ? entity.slice(2) : entity.slice(1),
                    entity.startsWith("#x") ? 16 : 10,
                );
                if (
                    !Number.isSafeInteger(codePoint) ||
                    codePoint <= 0 ||
                    codePoint > 0x10ffff ||
                    (codePoint >= 0xd800 && codePoint <= 0xdfff)
                ) {
                    throw new Error(`${context} contains an invalid XML numeric entity`);
                }
                return String.fromCodePoint(codePoint);
            }
        }
    });
}

function parseXmlAttributes(raw: string, context: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const attributePattern = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let cursor = 0;
    for (const match of raw.matchAll(attributePattern)) {
        const start = match.index ?? 0;
        if (raw.slice(cursor, start).trim()) throw new Error(`${context} has malformed attributes`);
        const name = match[1];
        const rawValue = match[2];
        if (!name || rawValue === undefined) throw new Error(`${context} has malformed attributes`);
        if (attributes.has(name)) throw new Error(`${context} repeats attribute ${name}`);
        attributes.set(name, decodeXml(rawValue, `${context} attribute ${name}`));
        cursor = start + match[0].length;
    }
    if (raw.slice(cursor).trim()) throw new Error(`${context} has malformed attributes`);
    return attributes;
}

function requireAttribute(attributes: Map<string, string>, name: string, context: string): string {
    const value = attributes.get(name);
    if (value === undefined || value.length === 0) throw new Error(`${context} missing ${name} attribute`);
    return value;
}

function allowOnlyAttributes(
    attributes: Map<string, string>,
    allowed: readonly string[],
    context: string,
): void {
    for (const name of attributes.keys()) {
        if (!allowed.includes(name)) throw new Error(`${context} has unsupported attribute ${name}`);
    }
}

function parseManifestInteger(value: string, context: string): number {
    if (!/^\d+$/.test(value)) throw new Error(`${context} must be a numeric integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${context} must be a safe integer`);
    return parsed;
}

function parsePalaceManifest(
    raw: string,
    expectedCategory: TrialCategory,
    importanceById: Map<number, number>,
): SpecEntry[] {
    const text = raw.trim();
    if (!text.startsWith("<palace")) {
        throw new Error("palace manifest must begin with <palace");
    }
    if (!text.endsWith("</palace>")) {
        try {
            extractCompleteManifestBody(text, "palace");
        } catch (error) {
            throw new Error(errorMessage(error));
        }
        throw new Error("palace manifest must end with </palace>");
    }

    const rootMatch = /^<palace\b([^>]*)>([\s\S]*)<\/palace>$/.exec(text);
    if (!rootMatch) throw new Error("palace manifest must contain one complete <palace> root");
    const body = extractCompleteManifestBody(text, "palace");
    if (body !== rootMatch[2]) {
        throw new Error("palace manifest must contain exactly one root element");
    }

    const rootAttributes = parseXmlAttributes(rootMatch[1] ?? "", "palace root");
    allowOnlyAttributes(rootAttributes, ["category"], "palace root");
    const category = requireAttribute(rootAttributes, "category", "palace root");
    if (!CATEGORY_ORDER.includes(category as Category)) {
        throw new Error(`palace root has unknown category ${category}`);
    }
    if (category !== expectedCategory) {
        throw new Error(`palace root category ${category} does not match ${expectedCategory}`);
    }

    const specs: SpecEntry[] = [];
    const roomPattern = /<room\b([^>]*)>([\s\S]*?)<\/room>/g;
    let roomCursor = 0;
    for (const roomMatch of body.matchAll(roomPattern)) {
        const roomStart = roomMatch.index ?? 0;
        if (body.slice(roomCursor, roomStart).trim()) {
            throw new Error("palace manifest contains content outside a room");
        }
        const roomAttributes = parseXmlAttributes(roomMatch[1] ?? "", "room");
        allowOnlyAttributes(roomAttributes, ["name"], "room");
        const room = requireAttribute(roomAttributes, "name", "room");
        const roomBody = roomMatch[2] ?? "";
        const childPattern = /<entry\b([^>]*)>([\s\S]*?)<\/entry>|<merge\b([^>]*)\/>/g;
        let childCursor = 0;
        let childCount = 0;
        for (const childMatch of roomBody.matchAll(childPattern)) {
            const childStart = childMatch.index ?? 0;
            if (roomBody.slice(childCursor, childStart).trim()) {
                throw new Error(`room ${room} contains an unknown XML element or text`);
            }
            if (childMatch[1] !== undefined) {
                const entryAttributes = parseXmlAttributes(childMatch[1], `entry in room ${room}`);
                allowOnlyAttributes(entryAttributes, ["id", "importance"], `entry in room ${room}`);
                const id = parseManifestInteger(
                    requireAttribute(entryAttributes, "id", `entry in room ${room}`),
                    `entry id in room ${room}`,
                );
                const importance = parseManifestInteger(
                    requireAttribute(entryAttributes, "importance", `entry ${id}`),
                    `entry ${id} importance`,
                );
                const rawCue = childMatch[2] ?? "";
                if (rawCue.includes("<")) {
                    throw new Error(`entry ${id} must XML-escape literal < characters in its cue`);
                }
                const cue = decodeXml(rawCue.trim(), `entry ${id} cue`);
                if (!cue) throw new Error(`entry ${id} has an empty cue`);
                specs.push({ id, category: category as Category, room, cue, importance });
            } else {
                const mergeAttributes = parseXmlAttributes(childMatch[3] ?? "", `merge in room ${room}`);
                allowOnlyAttributes(mergeAttributes, ["id", "into", "importance"], `merge in room ${room}`);
                const id = parseManifestInteger(
                    requireAttribute(mergeAttributes, "id", `merge in room ${room}`),
                    `merge id in room ${room}`,
                );
                const mergeInto = parseManifestInteger(
                    requireAttribute(mergeAttributes, "into", `merge ${id}`),
                    `merge ${id} target`,
                );
                const reportedImportance = mergeAttributes.get("importance");
                const importance =
                    reportedImportance === undefined
                        ? (importanceById.get(id) ?? Number.NaN)
                        : parseManifestInteger(reportedImportance, `merge ${id} importance`);
                specs.push({ id, category: category as Category, room, mergeInto, importance });
            }
            childCount++;
            childCursor = childStart + childMatch[0].length;
        }
        if (roomBody.slice(childCursor).trim()) {
            throw new Error(`room ${room} contains an unknown XML element or text`);
        }
        if (childCount === 0) throw new Error(`room ${room} has no entries`);
        roomCursor = roomStart + roomMatch[0].length;
    }
    if (body.slice(roomCursor).trim()) throw new Error("palace manifest contains content outside a room");
    if (specs.length === 0) throw new Error("palace manifest contains no entries");
    return specs;
}

function parseSpecXml(
    raw: string,
    expectedCategory: TrialCategory,
    importanceById: Map<number, number>,
): { specs?: SpecEntry[]; error?: string } {
    try {
        return { specs: parsePalaceManifest(raw, expectedCategory, importanceById) };
    } catch (error) {
        return { error: `XML parse failed: ${errorMessage(error)}` };
    }
}

function responseContent(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return undefined;
    const first = choices[0];
    if (typeof first !== "object" || first === null) return undefined;
    const message = (first as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) return undefined;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
        const value = content as { text?: unknown; content?: unknown; value?: unknown };
        for (const candidate of [value.text, value.content, value.value]) {
            if (typeof candidate === "string") return candidate;
        }
        return undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const parts = content.flatMap((part) => {
        if (typeof part !== "object" || part === null) return [];
        const value = part as { text?: unknown; content?: unknown; value?: unknown };
        const text = typeof value.text === "string" ? value.text : value.content ?? value.value;
        return typeof text === "string" ? [text] : [];
    });
    return parts.length > 0 ? parts.join("") : undefined;
}

function responseUsage(payload: unknown): TokenUsage | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const usage = (payload as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
    const value = usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
    };
    const prompt = value.prompt_tokens ?? value.input_tokens;
    const completion = value.completion_tokens ?? value.output_tokens;
    if (typeof prompt !== "number" || typeof completion !== "number") return undefined;
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
    const total = value.total_tokens;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens:
            typeof total === "number" && Number.isFinite(total) ? total : prompt + completion,
    };
}

function responseShape(payload: unknown): string {
    if (typeof payload !== "object" || payload === null) return "non-object payload";
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return `top-level keys: ${Object.keys(payload).join(", ")}`;
    const first = choices[0];
    if (typeof first !== "object" || first === null) return `choices=${choices.length}`;
    const message = (first as { message?: unknown }).message;
    const finishReason = (first as { finish_reason?: unknown }).finish_reason;
    if (typeof message !== "object" || message === null) {
        return `choices=${choices.length}; finish_reason=${String(finishReason)}; no message object`;
    }
    const content = (message as { content?: unknown }).content;
    const contentShape =
        typeof content === "object" && content !== null && !Array.isArray(content)
            ? `object keys: ${Object.keys(content).join(", ")}`
            : Array.isArray(content)
              ? "array"
              : typeof content;
    return `choices=${choices.length}; finish_reason=${String(finishReason)}; message keys: ${Object.keys(message).join(", ")}; content type: ${contentShape}`;
}

async function callOpenRouter(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
): Promise<OpenRouterCompletion> {
    const response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.1,
            max_tokens: MAX_OUTPUT_TOKENS,
            // Gemini 3.5 Flash rejects explicitly disabled reasoning, so OpenRouter must choose its required mode.
            ...(model === "google/gemini-3.5-flash" ? {} : { reasoning: { enabled: false } }),
        }),
        signal: AbortSignal.timeout(10 * 60 * 1_000),
    });
    const responseText = await response.text();
    if (!response.ok) {
        const summary = responseText.replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`OpenRouter ${response.status}: ${summary}`);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`OpenRouter returned non-JSON: ${errorMessage(error)}`);
    }
    const content = responseContent(payload);
    if (!content) throw new Error(`OpenRouter response has no assistant text (${responseShape(payload)})`);
    return { content, usage: responseUsage(payload) };
}

function rawOutputPath(label: string, category: TrialCategory): string {
    return join(OUTPUT_DIR, `trial-${label}-${category}.xml`);
}

async function runTrial(args: {
    apiKey: string;
    label: string;
    model: string;
    category: TrialCategory;
    source: SourceMemory[];
    allSource: SourceMemory[];
    frontier: SpecEntry[];
    systemPrompt: string;
}): Promise<TrialResult> {
    const categorySource = args.source.filter((memory) => memory.category === args.category);
    const importanceById = new Map(args.allSource.map((memory) => [memory.id, memory.importance]));
    const prompt = renderCategoryPrompt(args.category, categorySource);
    const rawPath = rawOutputPath(args.label, args.category);
    const baseMessages: ChatMessage[] = [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: prompt },
    ];
    const usage: TokenUsage[] = [];
    let raw: string;
    try {
        const completion = await callOpenRouter(args.apiKey, args.model, baseMessages);
        raw = completion.content;
        if (completion.usage) usage.push(completion.usage);
    } catch (error) {
        return {
            label: args.label,
            model: args.model,
            category: args.category,
            rawPath,
            attempts: 1,
            retry: { attempted: false },
            requestError: errorMessage(error),
            usage,
        };
    }

    let parsed = parseSpecXml(raw, args.category, importanceById);
    let attempts = 1;
    const retry: TrialResult["retry"] = { attempted: false };
    if (!parsed.specs) {
        retry.attempted = true;
        retry.initialParseError = parsed.error;
        writeFileSync(rawPath.replace(/\.xml$/, ".attempt-1.xml"), raw);
        attempts++;
        try {
            const completion = await callOpenRouter(args.apiKey, args.model, [
                ...baseMessages,
                {
                    role: "user",
                    content: `The previous response was rejected before validation: ${parsed.error ?? "invalid XML"}. Return a fresh, complete XML palace manifest only. It must begin with <palace and end with </palace>.`,
                },
            ]);
            raw = completion.content;
            if (completion.usage) usage.push(completion.usage);
        } catch (error) {
            return {
                label: args.label,
                model: args.model,
                category: args.category,
                rawPath,
                attempts,
                retry,
                requestError: errorMessage(error),
                usage,
            };
        }
        parsed = parseSpecXml(raw, args.category, importanceById);
        retry.recovered = Boolean(parsed.specs);
    }

    writeFileSync(rawPath, raw);
    if (!parsed.specs) {
        return {
            label: args.label,
            model: args.model,
            category: args.category,
            rawPath,
            attempts,
            retry,
            parseError: parsed.error,
            usage,
        };
    }

    return {
        label: args.label,
        model: args.model,
        category: args.category,
        rawPath,
        attempts,
        retry,
        usage,
        assessment: assessCandidate({
            category: args.category,
            source: categorySource,
            allSource: args.allSource,
            frontier: args.frontier,
            generated: parsed.specs,
        }),
    };
}

function emptyFailures(): Record<FailureKind, ValidationFailure[]> {
    const failures = {} as Record<FailureKind, ValidationFailure[]>;
    for (const kind of FAILURE_KINDS) failures[kind] = [];
    return failures;
}

function classifyValidatorError(message: string): FailureKind {
    if (
        /negative rule missing polarity marker|polarity mechanism missing|polarity mechanism must follow marker/i.test(
            message,
        )
    ) {
        return "missing polarity mechanism";
    }
    if (/hub noun repeated in cue/i.test(message)) return "hub noun repetition";
    if (/memory id leaked into cue/i.test(message)) return "memory ID leakage";
    if (/exact anchor .* missing from rendered cue/i.test(message)) return "broken exact anchors";
    if (/polarity mechanism is unclosed|unbalanced mechanism/i.test(message)) {
        return "unbalanced parentheses";
    }
    return "other validator failures";
}

function validatorErrorId(message: string): number | undefined {
    const match = message.match(/\b(?:cue|spec id|merge)\s+(\d+)\b/i);
    return match ? Number(match[1]) : undefined;
}

function addFailure(
    failures: Record<FailureKind, ValidationFailure[]>,
    seen: Set<string>,
    message: string,
    id?: number,
): void {
    const kind = classifyValidatorError(message);
    const key = `${kind}\u0000${id ?? ""}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures[kind].push({ ...(id === undefined ? {} : { id }), message });
}

function exactTokens(value: string): string[] {
    return [
        ...new Set(
            (value.match(/`[^`]+`|[^\s()`]+/g) ?? [])
                .filter((token) => token.startsWith("`") || isExactToken(token))
                .map((token) => token.replace(/^[,;]+|[,;]+$/g, ""))
                .filter(Boolean),
        ),
    ];
}

function cueText(entry: SpecEntry | undefined): string {
    if (!entry) return "";
    if (typeof entry.cue === "string") return entry.cue;
    if (Array.isArray(entry.cue)) return entry.cue.join("; ");
    return "";
}

function effectiveCue(id: number, entriesById: Map<number, SpecEntry>): string {
    const visited = new Set<number>();
    let entry = entriesById.get(id);
    while (entry) {
        if (visited.has(entry.id)) return "";
        visited.add(entry.id);
        if (entry.mergeInto === undefined) return cueText(entry);
        entry = entriesById.get(entry.mergeInto);
    }
    return "";
}

function cueField(entry: SpecEntry | undefined): string {
    if (!entry) return "MISSING";
    if (entry.mergeInto !== undefined) return JSON.stringify({ mergeInto: entry.mergeInto });
    return JSON.stringify(entry.cue);
}

function evenlySpaced<T>(values: T[], count: number): T[] {
    if (values.length <= count) return values;
    return Array.from({ length: count }, (_, index) => {
        const offset = Math.round((index * (values.length - 1)) / (count - 1));
        return values[offset] as T;
    });
}

function assessCandidate(args: {
    category: TrialCategory;
    source: SourceMemory[];
    allSource: SourceMemory[];
    frontier: SpecEntry[];
    generated: SpecEntry[];
}): Assessment {
    const failures = emptyFailures();
    const failureKeys = new Set<string>();
    const generatedIds = new Set<unknown>(args.generated.map((entry) => entry.id));
    const uncovered = args.source.filter((memory) => !generatedIds.has(memory.id)).map((memory) => memory.id);
    const generatedById = new Map<number, SpecEntry>();
    const occurrences = new Map<number, number>();

    for (const entry of args.generated) {
        if (typeof entry.id !== "number") {
            addFailure(failures, failureKeys, `spec id is not numeric: ${String(entry.id)}`);
            continue;
        }
        generatedById.set(entry.id, entry);
        occurrences.set(entry.id, (occurrences.get(entry.id) ?? 0) + 1);
    }
    for (const [id, count] of occurrences) {
        if (count > 1) {
            addFailure(failures, failureKeys, `duplicate spec id ${id} (${count} entries)`, id);
        }
    }

    const sourceById = new Map(args.allSource.map((memory) => [memory.id, memory]));
    for (const entry of args.generated) {
        if (typeof entry.id !== "number") continue;
        const sourceMemory = sourceById.get(entry.id);
        if (!sourceMemory) {
            addFailure(failures, failureKeys, `spec id ${entry.id} absent from source`, entry.id);
            continue;
        }
        const replacements = new Map<number, SpecEntry>([[entry.id, entry]]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const candidate of args.generated) {
                if (
                    typeof candidate.id === "number" &&
                    candidate.mergeInto !== undefined &&
                    replacements.has(candidate.mergeInto) &&
                    !replacements.has(candidate.id)
                ) {
                    replacements.set(candidate.id, candidate);
                    changed = true;
                }
            }
            for (const frontierEntry of args.frontier) {
                if (
                    frontierEntry.mergeInto !== undefined &&
                    replacements.has(frontierEntry.mergeInto) &&
                    !replacements.has(frontierEntry.id)
                ) {
                    const generatedReplacement = generatedById.get(frontierEntry.id);
                    if (generatedReplacement) {
                        replacements.set(generatedReplacement.id, generatedReplacement);
                        changed = true;
                    }
                }
            }
            for (const candidate of [...replacements.values()]) {
                if (candidate.mergeInto === undefined || replacements.has(candidate.mergeInto)) continue;
                const target = generatedById.get(candidate.mergeInto);
                if (target) {
                    replacements.set(target.id, target);
                    changed = true;
                }
            }
        }
        const overlay = args.frontier.map(
            (frontierEntry) => replacements.get(frontierEntry.id) ?? frontierEntry,
        );
        try {
            validate(args.allSource, overlay);
        } catch (error) {
            const message = errorMessage(error);
            addFailure(failures, failureKeys, message, validatorErrorId(message) ?? entry.id);
        }
    }

    let manifestValidationError: string | undefined;
    try {
        validate(
            args.allSource,
            [
                ...args.frontier.filter((entry) => entry.category !== args.category),
                ...args.generated,
            ],
        );
    } catch (error) {
        manifestValidationError = errorMessage(error);
        addFailure(failures, failureKeys, manifestValidationError, validatorErrorId(manifestValidationError));
    }

    let matchedAnchors = 0;
    let totalAnchors = 0;
    for (const memory of args.source) {
        const sourceTokens = exactTokens(memory.text);
        const cue = effectiveCue(memory.id, generatedById);
        totalAnchors += sourceTokens.length;
        matchedAnchors += sourceTokens.filter((token) => cue.includes(token)).length;
    }

    const importanceMismatches: number[] = [];
    for (const memory of args.source) {
        const entry = generatedById.get(memory.id);
        if (entry && entry.importance !== memory.importance) importanceMismatches.push(memory.id);
    }

    const frontierById = new Map(args.frontier.map((entry) => [entry.id, entry]));
    const samples = evenlySpaced(args.source, 4).map((memory) => ({
        id: memory.id,
        frontierCue: cueField(frontierById.get(memory.id)),
        generatedCue: cueField(generatedById.get(memory.id)),
    }));
    const generatedRooms = [
        ...new Set(
            args.generated
                .filter((entry) => typeof entry.room === "string")
                .map((entry) => entry.room)
                .sort((a, b) => a.localeCompare(b)),
        ),
    ];
    const frontierRooms = [
        ...new Set(
            args.frontier
                .filter((entry) => entry.category === args.category)
                .map((entry) => entry.room)
                .sort((a, b) => a.localeCompare(b)),
        ),
    ];
    const generatedEntryCounts = generatedRooms.map((name) => ({
        name,
        count: args.generated.filter((entry) => entry.room === name).length,
    }));

    return {
        coverage: {
            covered: args.source.length - uncovered.length,
            total: args.source.length,
            uncovered,
        },
        ...(manifestValidationError ? { manifestValidationError } : {}),
        failures,
        anchorFidelity: {
            matched: matchedAnchors,
            total: totalAnchors,
            percent: totalAnchors === 0 ? 100 : Number(((matchedAnchors / totalAnchors) * 100).toFixed(1)),
        },
        importance: {
            matched: args.source.length - importanceMismatches.length,
            total: args.source.length,
            mismatches: importanceMismatches,
        },
        rooms: {
            generated: generatedRooms,
            frontier: frontierRooms,
            generatedEntryCounts,
        },
        samples,
    };
}

function inline(value: string): string {
    return value.replace(/`/g, "\\`").replace(/\n/g, " ");
}

function renderFailures(failures: Record<FailureKind, ValidationFailure[]>): string[] {
    const lines: string[] = [];
    for (const kind of FAILURE_KINDS) {
        const entries = failures[kind];
        lines.push(`- **${kind}:** ${entries.length}`);
        for (const entry of entries.slice(0, 3)) {
            lines.push(
                `  - ${entry.id === undefined ? "manifest" : `#${entry.id}`}: ${inline(entry.message)}`,
            );
        }
    }
    return lines;
}

function renderAssessment(result: TrialResult): string[] {
    const lines = [
        `### ${result.label}: ${result.category}`,
        "",
        `- Model: \`${result.model}\``,
        `- Raw completion: \`${result.rawPath}\``,
        `- Calls: ${result.attempts}; parse retry: ${
            result.retry.attempted
                ? result.retry.recovered
                    ? "recovered"
                    : "attempted but did not recover"
                : "not needed"
        }`,
    ];
    if (result.retry.initialParseError) {
        lines.push(`- First parse rejection: ${inline(result.retry.initialParseError)}`);
    }
    if (result.requestError) {
        lines.push(
            `- Request failure: ${inline(result.requestError)}`,
            "- Coverage, validator failures, anchor fidelity, room quality, and side-by-side cues: not measured because no completion was available.",
            "",
        );
        return lines;
    }
    if (result.parseError) {
        lines.push(
            `- Fail-closed parse rejection: ${inline(result.parseError)}`,
            "- Coverage: not measured because the complete XML root was rejected.",
            "- Hard validator failures: not measured because validation never receives a partial manifest.",
            "- Anchor fidelity: not measured because validation never receives a partial manifest.",
            "- Room quality and side-by-side cues: not measured because validation never receives a partial manifest.",
            "",
        );
        return lines;
    }

    const assessment = result.assessment;
    if (!assessment) return [...lines, "- No assessment was produced.", ""];
    lines.push(
        `- Coverage: **${assessment.coverage.covered}/${assessment.coverage.total}**; uncovered: ${
            assessment.coverage.uncovered.length > 0 ? assessment.coverage.uncovered.join(", ") : "none"
        }`,
        `- Anchor fidelity: **${assessment.anchorFidelity.percent}%** (${assessment.anchorFidelity.matched}/${assessment.anchorFidelity.total} source exact tokens retained in the effective cue)`,
        `- Importance passthrough: **${assessment.importance.matched}/${assessment.importance.total}**; mismatches: ${
            assessment.importance.mismatches.length > 0 ? assessment.importance.mismatches.join(", ") : "none"
        }`,
        `- Full-manifest validator: ${
            assessment.manifestValidationError ? `failed — ${inline(assessment.manifestValidationError)}` : "passed"
        }`,
        "",
        "#### Hard validator failures",
        "",
        ...renderFailures(assessment.failures),
        "",
        "#### Room quality",
        "",
        `- ${result.label} rooms (${assessment.rooms.generated.length}): ${assessment.rooms.generatedEntryCounts.map((room) => `${room.name} (${room.count})`).join(", ") || "none"}`,
        `- Frontier spec rooms (${assessment.rooms.frontier.length}; Round-2 comparison target ${FRONTIER_ROOM_TARGETS[result.category]}): ${assessment.rooms.frontier.join(", ") || "none"}`,
        "",
        "#### Four evenly spaced cue comparisons",
        "",
    );
    for (const sample of assessment.samples) {
        lines.push(
            `#### #${sample.id}`,
            "",
            "Frontier cue:",
            "```json",
            sample.frontierCue,
            "```",
            "",
            `${result.label} cue:`,
            "```json",
            sample.generatedCue,
            "```",
            "",
        );
    }
    return lines;
}

function roomBudgetGaps(assessment: Assessment): string[] {
    // The prompt exempts genuinely tiny categories; neither trial category is tiny.
    if (assessment.coverage.total < MIN_ROOMS_PER_CATEGORY * 3) return [];
    const gaps: string[] = [];
    const roomCount = assessment.rooms.generated.length;
    if (roomCount < MIN_ROOMS_PER_CATEGORY || roomCount > MAX_ROOMS_PER_CATEGORY) {
        gaps.push(`room count ${roomCount} outside ${MIN_ROOMS_PER_CATEGORY}-${MAX_ROOMS_PER_CATEGORY}`);
    }
    const undersized = assessment.rooms.generatedEntryCounts.filter((room) => room.count < 3);
    if (undersized.length > 0) {
        gaps.push(
            `rooms below 3 entries (${undersized.map((room) => `${room.name}=${room.count}`).join(", ")})`,
        );
    }
    return gaps;
}

function hardQualityGaps(result: TrialResult): string[] {
    if (result.requestError) return ["request failure"];
    if (result.parseError) return ["fail-closed parse rejection"];
    const assessment = result.assessment;
    if (!assessment) return ["missing assessment"];
    const gaps: string[] = [];
    gaps.push(
        ...FAILURE_KINDS.filter(
            (kind) => kind !== "cue over budget" && assessment.failures[kind].length > 0,
        ),
    );
    if (assessment.importance.mismatches.length > 0) gaps.push("importance passthrough mismatches");
    return [...new Set(gaps)];
}

function softQualityGaps(result: TrialResult): string[] {
    const assessment = result.assessment;
    if (!assessment) return [];
    const gaps = roomBudgetGaps(assessment);
    if (assessment.anchorFidelity.percent < ANCHOR_FIDELITY_FLOOR) {
        gaps.push(`anchor fidelity ${assessment.anchorFidelity.percent}% < ${ANCHOR_FIDELITY_FLOOR}%`);
    }
    return gaps;
}

function modelVerdict(run: ModelRun): {
    verdict: "VIABLE" | "VIABLE-WITH-CAVEATS" | "NOT-VIABLE";
    reasons: string[];
} {
    const hardGaps = run.results.flatMap((result) =>
        hardQualityGaps(result).map((gap) => `${result.category}: ${gap}`),
    );
    if (hardGaps.length > 0) return { verdict: "NOT-VIABLE", reasons: hardGaps };

    const caveats = run.results.flatMap((result) =>
        softQualityGaps(result).map((gap) => `${result.category}: ${gap}`),
    );
    if (caveats.length > 0) return { verdict: "VIABLE-WITH-CAVEATS", reasons: caveats };
    return {
        verdict: "VIABLE",
        reasons: [
            `all selected categories passed fail-closed XML, coverage, validator, importance, anchor, and room-budget gates`,
        ],
    };
}

function parseOutcome(result: TrialResult): string {
    if (result.requestError || result.parseError) return "fail";
    return result.retry.recovered ? "retry-recovered" : "pass";
}

function compactFailureCounts(assessment: Assessment | undefined): string {
    if (!assessment) return "—";
    return FAILURE_KINDS.map((kind) => `${kind.replace(/ /g, "-")}=${assessment.failures[kind].length}`).join(", ");
}

function tableCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMatrix(runs: ModelRun[]): string[] {
    return [
        "## Matrix",
        "",
        "Parse is `pass`, `retry-recovered`, or `fail`; failure counts are ordered as the named validator classes.",
        "",
        "| Model | Category | Parse | Coverage | Validator failure classes (counts) | Anchor fidelity | Rooms (frontier target) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...runs.flatMap((run) =>
            run.results.map((result) => {
                const assessment = result.assessment;
                return `| ${tableCell(`${run.plan.label} (${run.model})`)} | ${result.category} | ${parseOutcome(result)} | ${assessment ? `${assessment.coverage.covered}/${assessment.coverage.total}` : "—"} | ${tableCell(compactFailureCounts(assessment))} | ${assessment ? `${assessment.anchorFidelity.percent}%` : "—"} | ${assessment ? `${assessment.rooms.generated.length}/${FRONTIER_ROOM_TARGETS[result.category]}` : "—"} |`;
            }),
        ),
        "",
    ];
}

function parseOpenRouterPrice(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOpenRouterPricing(value: unknown): OpenRouterPricing | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const pricing = value as { prompt?: unknown; completion?: unknown };
    const prompt = parseOpenRouterPrice(pricing.prompt);
    const completion = parseOpenRouterPrice(pricing.completion);
    return prompt === undefined && completion === undefined ? undefined : { prompt, completion };
}

async function fetchOpenRouterModels(apiKey: string): Promise<OpenRouterModel[]> {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`OpenRouter model catalog ${response.status}: ${responseText.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`OpenRouter model catalog returned non-JSON: ${errorMessage(error)}`);
    }
    const data = typeof payload === "object" && payload !== null ? (payload as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) throw new Error("OpenRouter model catalog has no data array");
    return data.flatMap((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const model = item as { id?: unknown; name?: unknown; pricing?: unknown };
        if (typeof model.id !== "string") return [];
        const pricing = parseOpenRouterPricing(model.pricing);
        return [
            {
                id: model.id,
                ...(typeof model.name === "string" ? { name: model.name } : {}),
                ...(pricing ? { pricing } : {}),
            },
        ];
    });
}

function closestFallback(plan: ModelPlan, models: OpenRouterModel[]): string | undefined {
    const available = new Set(models.map((model) => model.id));
    for (const fallback of plan.fallbackModels) {
        if (models.length === 0 || available.has(fallback)) return fallback;
    }
    const provider = plan.requestedModel.split("/")[0];
    const requestedTerms = plan.requestedModel
        .split(/[/._-]+/)
        .filter((term) => term.length > 1 && term !== provider);
    return models
        .filter((model) => model.id.startsWith(`${provider}/`) && model.id !== plan.requestedModel)
        .sort((a, b) => {
            const score = (id: string): number =>
                requestedTerms.reduce((total, term) => total + (id.includes(term) ? 1 : 0), 0);
            return score(b.id) - score(a.id) || a.id.localeCompare(b.id);
        })[0]?.id;
}

function isMissingModelResult(result: TrialResult): boolean {
    return Boolean(
        result.requestError &&
            (/OpenRouter 404\b/i.test(result.requestError) ||
                /OpenRouter 400:.*model .*not found/i.test(result.requestError)),
    );
}

async function runModelPlan(args: {
    apiKey: string;
    plan: ModelPlan;
    categories: TrialCategory[];
    source: SourceMemory[];
    frontier: SpecEntry[];
    systemPrompt: string;
    availableModels: OpenRouterModel[];
    catalogError?: string;
}): Promise<ModelRun> {
    let model = args.plan.requestedModel;
    let substitution: string | undefined;
    const results: TrialResult[] = [];
    for (const category of args.categories) {
        let result = await runTrial({
            apiKey: args.apiKey,
            label: args.plan.label,
            model,
            category,
            source: args.source,
            allSource: args.source,
            frontier: args.frontier,
            systemPrompt: args.systemPrompt,
        });
        if (model === args.plan.requestedModel && isMissingModelResult(result)) {
            const fallback = closestFallback(args.plan, args.availableModels);
            if (fallback) {
                model = fallback;
                substitution = `Requested ${args.plan.requestedModel} returned model-not-found; substituted ${fallback}.`;
                result = await runTrial({
                    apiKey: args.apiKey,
                    label: args.plan.label,
                    model,
                    category,
                    source: args.source,
                    allSource: args.source,
                    frontier: args.frontier,
                    systemPrompt: args.systemPrompt,
                });
            }
        }
        results.push(result);
    }

    const modelInfo = args.availableModels.find((candidate) => candidate.id === model);
    return {
        plan: args.plan,
        model,
        ...(substitution ? { substitution } : {}),
        ...(modelInfo?.pricing ? { pricing: modelInfo.pricing } : {}),
        pricingNote: modelInfo?.pricing
            ? "OpenRouter model-catalog input/output prices retrieved at run time."
            : args.catalogError
              ? `OpenRouter pricing unavailable: ${args.catalogError}`
              : `OpenRouter model catalog did not provide input/output pricing for ${model}.`,
        results,
    };
}

function summarizeUsage(run: ModelRun): TokenUsage & { calls: number } {
    const usage = run.results.flatMap((result) => result.usage);
    return usage.reduce<TokenUsage & { calls: number }>(
        (total, entry) => ({
            calls: total.calls + 1,
            promptTokens: total.promptTokens + entry.promptTokens,
            completionTokens: total.completionTokens + entry.completionTokens,
            totalTokens: total.totalTokens + entry.totalTokens,
        }),
        { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
}

function estimatedRunCost(run: ModelRun): number | undefined {
    if (run.pricing?.prompt === undefined || run.pricing.completion === undefined) return undefined;
    const usage = summarizeUsage(run);
    if (usage.calls === 0) return undefined;
    return usage.promptTokens * run.pricing.prompt + usage.completionTokens * run.pricing.completion;
}

function formatPerMillion(price: number | undefined): string {
    if (price === undefined) return "unavailable";
    const perMillion = price * 1_000_000;
    return `$${perMillion.toFixed(perMillion < 1 ? 3 : 2)}/M`;
}

function formatCost(cost: number | undefined): string {
    if (cost === undefined) return "unavailable";
    return `$${cost.toFixed(cost < 0.01 ? 5 : 3)}`;
}

function renderCostTable(runs: ModelRun[]): string[] {
    return [
        "## Cost per model run",
        "",
        "Estimates use the OpenRouter model-catalog input/output price at run time and the API-reported tokens for all completed calls, including parse retries. Cache, tool, and provider-specific surcharges are not included.",
        "",
        "| Model | Input / output price | Reported usage | Estimated run cost | Pricing note |",
        "| --- | --- | --- | --- | --- |",
        ...runs.map((run) => {
            const usage = summarizeUsage(run);
            const usageText =
                usage.calls === 0
                    ? "no reported usage"
                    : `${usage.calls} response(s); ${usage.promptTokens} input + ${usage.completionTokens} output`;
            return `| ${tableCell(`${run.plan.label} (${run.model})`)} | ${formatPerMillion(run.pricing?.prompt)} / ${formatPerMillion(run.pricing?.completion)} | ${usageText} | ${formatCost(estimatedRunCost(run))} | ${tableCell(run.pricingNote ?? "pricing unavailable")} |`;
        }),
        "",
    ];
}

function renderRoundTwoReport(runs: ModelRun[]): string {
    const verdicts = runs.map((run) => ({ run, ...modelVerdict(run) }));
    return [
        "# Round 2",
        "",
        `Run: ${new Date().toISOString()}`,
        "",
        "This round is a non-agentic, single-call-per-category authoring trial across the requested OpenRouter model matrix. XML parsing is fail-closed: the reply must be one complete `<palace>` root beginning with `<palace` and ending with `</palace>`; the harness never strips fences, extracts a substring, or applies a partial manifest. A parse rejection receives one error-fed retry. Parsed XML entries are converted to the existing `SpecEntry` shape and checked by the unchanged `author-palace.ts` validator. The strict safety gate requires complete XML, 100% coverage, no validator-class failures, and exact importance passthrough; cue quality also targets at least 85% anchor fidelity and the 4–8-room, three-entries-per-room budget.",
        "",
        ...renderMatrix(runs),
        ...renderCostTable(runs),
        "## Per-model verdicts",
        "",
        ...verdicts.flatMap(({ run, verdict, reasons }) => [
            `- **${run.plan.label}: ${verdict}.** ${reasons.join("; ")}${run.substitution ? ` ${run.substitution}` : ""}`,
        ]),
        "",
        "## Cell details",
        "",
        ...runs.flatMap((run) => run.results.flatMap(renderAssessment)),
    ].join("\n");
}

function requestedCategories(): TrialCategory[] {
    const args = process.argv.slice(2);
    if (args.length === 0) return [...TRIAL_CATEGORIES];
    const categories = args.map((arg) => arg.toUpperCase());
    const invalid = categories.filter(
        (category) => !TRIAL_CATEGORIES.includes(category as TrialCategory),
    );
    if (invalid.length > 0) {
        throw new Error(`use only PROJECT_RULES or ARCHITECTURE; received ${invalid.join(", ")}`);
    }
    return categories as TrialCategory[];
}

async function main(): Promise<void> {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const apiKey = readFileSync(join(homedir(), ".config", "openrouter.key"), "utf8").trim();
    if (!apiKey) throw new Error("~/.config/openrouter.key is empty");
    const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
    const frontier = readFrontierSpecs();
    const importanceById = new Map(frontier.map((entry) => [entry.id, entry.importance]));
    const source = parseSourceMemories(readFileSync(SOURCE_PATH, "utf8"), importanceById);
    const categories = requestedCategories();

    let availableModels: OpenRouterModel[] = [];
    let catalogError: string | undefined;
    try {
        availableModels = await fetchOpenRouterModels(apiKey);
    } catch (error) {
        catalogError = errorMessage(error);
    }

    const runs: ModelRun[] = [];
    for (const plan of MODEL_MATRIX) {
        runs.push(
            await runModelPlan({
                apiKey,
                plan,
                categories,
                source,
                frontier,
                systemPrompt,
                availableModels,
                ...(catalogError ? { catalogError } : {}),
            }),
        );
    }

    const priorReport = readFileSync(REPORT_PATH, "utf8");
    const roundTwoIndex = priorReport.search(/^# Round 2\b/m);
    const preservedReport = (roundTwoIndex >= 0 ? priorReport.slice(0, roundTwoIndex) : priorReport).trimEnd();
    writeFileSync(REPORT_PATH, `${preservedReport}\n\n${renderRoundTwoReport(runs).trimEnd()}\n`);
    console.log(`report=${REPORT_PATH}`);
    for (const run of runs) {
        for (const result of run.results) {
            const coverage = result.assessment?.coverage;
            console.log(
                `${run.plan.label}/${result.category}: ${
                    result.requestError ?? result.parseError ?? `${coverage?.covered}/${coverage?.total} covered`
                }`,
            );
        }
    }
}

void main().catch((error) => {
    console.error(`author-trial failed: ${errorMessage(error)}`);
    process.exitCode = 1;
});
