import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORY_ORDER = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const;
const LAYOUT_FONT =
    process.env.PALACE_LAYOUT_FONT === "jetbrains-mono-10" ? "jetbrains-mono-10" : "spleen-5x8";
const CELL_WIDTH = LAYOUT_FONT === "jetbrains-mono-10" ? 6 : 5;
const CELL_HEIGHT = LAYOUT_FONT === "jetbrains-mono-10" ? 11 : 8;
const COLUMN_COUNT = LAYOUT_FONT === "jetbrains-mono-10" ? 2 : 3;
const COLUMN_GAP = 1;
const PAGE_WIDTH_PIXELS = 1_092;
const PAGE_HEIGHT_PIXELS = 1_092;
const ROOM_WIDTH = Math.floor(
    (Math.floor(PAGE_WIDTH_PIXELS / CELL_WIDTH) - (COLUMN_COUNT - 1) * COLUMN_GAP) / COLUMN_COUNT,
);
const BANNER_HEIGHT_PIXELS = CELL_HEIGHT;
const BODY_LINE_PITCH = CELL_HEIGHT + 1;
const PAGE_WIDTH_CHARS = COLUMN_COUNT * ROOM_WIDTH;
const MAX_LINE_CHARS = PAGE_WIDTH_CHARS + (COLUMN_COUNT - 1) * COLUMN_GAP;
const PAGE_HEIGHT_CELLS = Math.floor(PAGE_HEIGHT_PIXELS / BODY_LINE_PITCH);
const PAGE_LINE_CAPACITY = COLUMN_COUNT * PAGE_HEIGHT_CELLS;
const MAX_PALACE_CHARS = 27_000;
export const ROOM_HEADER_MARKER = "▰";
const SOURCE_PATH = "/tmp/visual-memory/trimmed-memories-source.txt";
const HERE = dirname(fileURLToPath(import.meta.url));
const ALTERNATE_LAYOUT = LAYOUT_FONT === "jetbrains-mono-10";
const PALACE_OUTPUT = ALTERNATE_LAYOUT
    ? "/tmp/visual-memory/palace-jb-layout.txt"
    : join(HERE, "palace.txt");
const COVERAGE_OUTPUT = ALTERNATE_LAYOUT
    ? "/tmp/visual-memory/coverage-jb-layout.json"
    : join(HERE, "coverage.json");

export type Category = (typeof CATEGORY_ORDER)[number];
export type SpecEntry = {
    id: number;
    category: Category;
    room: string;
    cue?: string | string[];
    mergeInto?: number;
    importance: number;
};
export type SourceMemory = {
    id: number;
    category: Category;
    importance: number;
};
type Placement = {
    category: Category;
    room: string;
    palaceLine: number;
    palaceColumn: number;
    page: number;
    pageLine: number;
    mergedInto?: number;
};
type RoomSummary = {
    category: Category;
    name: string;
    entryCount: number;
    mergeCount: number;
    memoryCount: number;
    peakImportance: number;
    border: "single" | "double";
    column: number;
    startLine: number;
    endLine: number;
    heightCells: number;
    sharedPairCount: number;
    continuation: boolean;
    segment: number;
    page: number;
    pageLine: number;
    pageTopPixels: number;
    heightPixels: number;
};
type LayoutItem = {
    kind: "category" | "room";
    category: Category;
    categories?: Category[];
    room?: string;
    continuation?: boolean;
    segment?: number;
    column: number;
    startLine: number;
    endLine: number;
    page: number;
    pageLine: number;
    pageTopPixels: number;
    heightPixels: number;
};

type RoomPlan = {
    category: Category;
    name: string;
    lines: string[];
    entryBodyLines: Map<number, number>;
    relativeLines: Map<number, number>;
    entries: SpecEntry[];
    merges: SpecEntry[];
    peakImportance: number;
    sharedPairCount: number;
};

type StreamSlot = { column: number; row: number };

function codepoints(value: string): number {
    return [...value].length;
}

export function parseSource(source: string, importanceById: ReadonlyMap<number, number>): SourceMemory[] {
    const memories: SourceMemory[] = [];
    let category: Category | undefined;
    for (const line of source.split("\n")) {
        const open = line.match(/^<([A-Z_]+)>$/)?.[1];
        if (open) {
            if (!CATEGORY_ORDER.includes(open as Category))
                throw new Error(`unknown category ${open}`);
            category = open as Category;
            continue;
        }
        if (/^<\//.test(line)) {
            category = undefined;
            continue;
        }
        const id = line.match(/^#(\d+):/)?.[1];
        if (id) {
            if (!category) throw new Error(`memory ${id} is outside a category`);
            const numericId = Number(id);
            const importance = importanceById.get(numericId);
            if (importance === undefined || !Number.isFinite(importance))
                throw new Error(`source importance missing for ${id}`);
            memories.push({ id: numericId, category, importance });
        }
    }
    return memories;
}

export function readSpecs(directory = HERE): SpecEntry[] {
    const files = readdirSync(directory)
        .filter((file) => file.startsWith("spec-") && file.endsWith(".json"))
        .sort();
    return files.flatMap(
            (file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as SpecEntry[],
    );
}

export function isExactToken(value: string): boolean {
    const token = value.replace(/^[('"`]+|[)'"`,;]+$/g, "");
    if (!token) return false;
    return (
        /[\\/_$%<>=|@]/.test(token) ||
        /:\S/.test(token) ||
        /(?:[A-Za-z0-9]\.[A-Za-z0-9]|^\.[A-Za-z0-9])/.test(token) ||
        /[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/.test(token) ||
        /\d/.test(token) ||
        /[a-z][A-Z]/.test(token) ||
        /\b[A-Z_]{2,}\b/.test(token)
    );
}

function compactCue(raw: string, room: string): string {
    const hubWords = room
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length >= 2)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let value = raw;
    if (hubWords.length > 0) {
        value = value.replace(
            new RegExp(`(?<![\\w/._-])(?:${hubWords.join("|")})(?![\\w/._-])`, "gi"),
            "",
        );
    }
    const protectedValues: string[] = [];
    value = value.replace(/`[^`]+`|[^\s()`]+/g, (match) => {
        if (!match.startsWith("`") && !isExactToken(match)) return match;
        const marker = `QZ${protectedValues.length}ZQ`;
        protectedValues.push(match);
        return marker;
    });
    const replacements: Array<[RegExp, string]> = [
        [/\bconfigurations?\b/gi, "cfg"],
        [/\bbackground\b/gi, "bg"],
        [/\benvironment\b/gi, "env"],
        [/\bparameters?\b/gi, "params"],
        [/\bbefore\b/gi, "≺"],
        [/\bafter\b/gi, "≻"],
        [/\bbecause\b/gi, "∵"],
        [/\breturns?\b/gi, "→"],
        [/\bwrites?\b/gi, "→"],
        [/\breads?\b/gi, "←"],
        [/\brequires?\b/gi, "→"],
        [/\bevery\b/gi, "∀"],
        [/\ball\b/gi, "∀"],
        [/\bnone\b/gi, "∅"],
        [/\bzero\b/gi, "0"],
        [/\bthe\b/gi, ""],
        [/\ban?\b/gi, ""],
        [/\s*;\s*/g, "; "],
        [/\s*→\s*/g, "→"],
        [/\s*←\s*/g, "←"],
        [/\s*≺\s*/g, "≺"],
        [/\s*≻\s*/g, "≻"],
        [/\s*∵\s*/g, "∵"],
        [/\s{2,}/g, " "],
    ];
    for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
    value = protectedValues.reduce(
        (result, item, index) => result.replace(`QZ${index}ZQ`, () => item),
        value,
    );
    return value.trim().replace(/^[-:;,]+|[-:;,]+$/g, "");
}

// Per-entry budget check for the authoring retry loop: the harness rejects and
// re-prompts a category whose cues exceed the budget, so size enforcement is
// mechanical rather than prose guidance in the prompt.
export function cueBudgetViolations(
    entries: SpecEntry[],
    importanceById: Map<number, number>,
): { id: number; length: number; budget: number }[] {
    const violations: { id: number; length: number; budget: number }[] = [];
    for (const entry of entries) {
        if (entry.cue === undefined) continue;
        const rendered = displayCue(entry);
        const importance = importanceById.get(entry.id) ?? entry.importance;
        const budget = importance >= 70 ? 90 : 50;
        const length = codepoints(rendered);
        if (length > budget) violations.push({ id: entry.id, length, budget });
    }
    return violations;
}

function displayCue(entry: SpecEntry): string {
    const raw = Array.isArray(entry.cue) ? entry.cue.join("; ") : (entry.cue ?? "");
    return compactCue(raw, entry.room);
}

function cueOutsideCode(value: string): string {
    // Mask inline code so incomplete call fragments cannot affect the parenthesized
    // explanations required after ⊘ markers; the original cue still preserves code verbatim.
    return value.replace(/`[^`]*`/g, (anchor) => " ".repeat(anchor.length));
}

/**
 * Cue length is an authoring diagnostic rather than a reason to reject a
 * selected memory. Keep reporting it so trial reports can compare compression
 * quality, but allow the renderer to apply the page's importance policy.
 */
function reportCueWarning(message: string, warnings: string[]): void {
    warnings.push(message);
    console.warn(`[palace] cue warning: ${message}`);
}

export function validate(source: SourceMemory[], specs: SpecEntry[]): string[] {
    if (source.length === 0) throw new Error("source contains no memories");
    if (new Set(source.map((memory) => memory.id)).size !== source.length)
        throw new Error("source contains duplicate memory ids");
    for (const memory of source) {
        if (!Number.isFinite(memory.importance))
            throw new Error(`source importance missing for ${memory.id}`);
    }
    const defects: string[] = [];
    const sourceById = new Map(source.map((memory) => [memory.id, memory]));
    const specById = new Map<number, SpecEntry>();
    for (const spec of specs) {
        if (specById.has(spec.id)) {
            throw new Error(`duplicate spec id ${spec.id}`);
        }
        specById.set(spec.id, spec);
        const memory = sourceById.get(spec.id);
        if (!memory) throw new Error(`spec id ${spec.id} absent from source`);
        if (memory.category !== spec.category) throw new Error(`category mismatch for ${spec.id}`);
        if (!Number.isFinite(spec.importance)) throw new Error(`importance missing for ${spec.id}`);
        if (spec.mergeInto === undefined && spec.cue === undefined)
            throw new Error(`cue missing for ${spec.id}`);
        if (spec.mergeInto !== undefined && spec.cue !== undefined)
            throw new Error(`merged ${spec.id} also has cue`);
        const cue = Array.isArray(spec.cue) ? spec.cue.join(" ") : spec.cue;
        if (cue && /#\d+/.test(cue)) throw new Error(`memory id leaked into cue ${spec.id}`);
        if (cue) {
            const renderedCue = displayCue(spec);
            const cueBudget = memory.importance >= 70 ? 90 : 50;
            const renderedCueLength = codepoints(renderedCue);
            if (renderedCueLength > cueBudget) {
                reportCueWarning(
                    `cue over budget for ${spec.id}: ${renderedCueLength} chars (max ${cueBudget})`,
                    defects,
                );
            }
            for (const hubWord of spec.room
                .split(/[^A-Za-z0-9]+/)
                .filter((word) => word.length >= 2)) {
                if (new RegExp(`(?<![\\w/._-])${hubWord}(?![\\w/._-])`, "i").test(renderedCue)) {
                    throw new Error(`hub noun repeated in cue ${spec.id}: ${renderedCue}`);
                }
            }
            const mechanismCue = cueOutsideCode(renderedCue);
            const negativeRule = /\b(?:must not|never|without|instead of|excludes?)\b/i.test(
                mechanismCue,
            );
            if (negativeRule && !mechanismCue.includes("⊘")) {
                throw new Error(`negative rule missing polarity marker in cue ${spec.id}: ${renderedCue}`);
            }
            const polarityCount = mechanismCue.split("⊘").length - 1;
            const mechanismCount = mechanismCue.match(/\([^()]+\)/g)?.length ?? 0;
            if (polarityCount > mechanismCount) {
                throw new Error(`polarity mechanism missing from rendered cue ${spec.id}: ${renderedCue}`);
            }
            let marker = mechanismCue.indexOf("⊘");
            while (marker >= 0) {
                const nextMarker = mechanismCue.indexOf("⊘", marker + 1);
                const mechanism = mechanismCue.indexOf("(", marker + 1);
                if (mechanism < 0 || (nextMarker >= 0 && mechanism > nextMarker)) {
                    throw new Error(`polarity mechanism must follow marker ${spec.id}: ${renderedCue}`);
                    break;
                }
                let depth = 0;
                let close = -1;
                for (let index = mechanism; index < mechanismCue.length; index++) {
                    if (mechanismCue[index] === "(") depth++;
                    if (mechanismCue[index] === ")") depth--;
                    if (depth === 0) {
                        close = index;
                        break;
                    }
                }
                if (close < mechanism) {
                    throw new Error(`polarity mechanism is unclosed ${spec.id}: ${renderedCue}`);
                }
                marker = mechanismCue.indexOf("⊘", close + 1);
            }
            const unclosed = [...mechanismCue].reduce(
                (depth, character) => depth + (character === "(" ? 1 : character === ")" ? -1 : 0),
                0,
            );
            if (unclosed !== 0)
                throw new Error(`unbalanced mechanism in rendered cue ${spec.id}: ${renderedCue}`);
            const exactAnchors = (cue.match(/`[^`]+`|[^\s()`]+/g) ?? []).filter(
                (anchor) => anchor.startsWith("`") || isExactToken(anchor),
            );
            const hubAnchors = new Set(
                spec.room
                    .split(/[^A-Za-z0-9]+/)
                    .filter(Boolean)
                    .map((word) => word.toLowerCase()),
            );
            for (const rawAnchor of exactAnchors) {
                const anchor = rawAnchor.replace(/^[,;]+|[,;]+$/g, "");
                if (hubAnchors.has(anchor.replace(/[^A-Za-z0-9]+/g, "").toLowerCase())) continue;
                let anchorWithoutHub = anchor;
                for (const hubWord of hubAnchors) {
                    anchorWithoutHub = anchorWithoutHub.replace(
                        new RegExp(`(?<![\\w/._-])${hubWord}(?![\\w/._-])`, "gi"),
                        "",
                    );
                }
                if (anchorWithoutHub !== anchor && renderedCue.includes(anchorWithoutHub)) continue;
                if (["AND", "APIs", "NEVER", "OR", "RAM", "SAME"].includes(anchor)) continue;
                if (anchor && !renderedCue.includes(anchor)) {
                    throw new Error(
                        `exact anchor ${anchor} missing from rendered cue ${spec.id}: ${renderedCue}`,
                    );
                }
            }
        }
    }
    for (const spec of specs) {
        if (spec.mergeInto === undefined) continue;
        const target = specById.get(spec.mergeInto);
        if (!target || target.mergeInto !== undefined)
            throw new Error(`invalid merge target ${spec.mergeInto}`);
        if (target.category !== spec.category || target.room !== spec.room) {
            throw new Error(`merge ${spec.id} crosses room/category`);
        }
    }
    return defects;
}

function longestToken(entries: SpecEntry[]): number {
    return Math.max(
        ...entries.flatMap((entry) => displayCue(entry).split(/\s+/).map(codepoints)),
        0,
    );
}

function appendEntry(body: string[], cue: string, width: number): number {
    const words = cue.split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new Error("empty palace cue");
    const placement = body.length;
    let line = "•";
    for (const word of words) {
        const separator = line === "•" || line === " " ? "" : " ";
        const candidate = `${line}${separator}${word}`;
        if (codepoints(candidate) <= width) {
            line = candidate;
            continue;
        }
        body.push(line);
        line = ` ${word}`;
        if (codepoints(line) > width) throw new Error(`anchor exceeds room width: ${word}`);
    }
    body.push(line);
    return placement;
}

function buildRoomPlan(category: Category, name: string, allEntries: SpecEntry[]): RoomPlan {
    // Manifest order is the author's importance ranking; never sort entries by id.
    const entries = allEntries.filter((entry) => entry.mergeInto === undefined);
    const merges = allEntries.filter((entry) => entry.mergeInto !== undefined);
    const requiredTokenWidth = longestToken(entries);
    if (requiredTokenWidth > ROOM_WIDTH) {
        throw new Error(`room ${name} has ${requiredTokenWidth}-char anchor (max ${ROOM_WIDTH})`);
    }
    const header = `${ROOM_HEADER_MARKER} — ${name} —`;
    if (codepoints(header) > ROOM_WIDTH) {
        throw new Error(`room header ${name} exceeds ${ROOM_WIDTH} cells`);
    }

    const bodyLines: string[] = [];
    const entryBodyLines = new Map<number, number>();
    const shortEntryLimit = Math.floor((ROOM_WIDTH - 4) / 2);
    let sharedPairCount = 0;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const cue = displayCue(entry);
        const next = entries[index + 1];
        const nextCue = next ? displayCue(next) : "";
        const shared = `•${cue} • ${nextCue}`;
        if (
            next &&
            !cue.includes("⊘") &&
            !nextCue.includes("⊘") &&
            codepoints(cue) <= shortEntryLimit &&
            codepoints(nextCue) <= shortEntryLimit &&
            codepoints(shared) <= ROOM_WIDTH
        ) {
            const bodyLine = bodyLines.length;
            bodyLines.push(shared);
            entryBodyLines.set(entry.id, bodyLine);
            entryBodyLines.set(next.id, bodyLine);
            sharedPairCount++;
            index++;
            continue;
        }
        const bodyLine = appendEntry(bodyLines, cue, ROOM_WIDTH);
        entryBodyLines.set(entry.id, bodyLine);
    }
    const peakImportance = Math.max(...allEntries.map((entry) => entry.importance));
    const relativeLines = new Map<number, number>();
    for (const entry of entries) {
        const bodyLine = entryBodyLines.get(entry.id);
        if (bodyLine === undefined) throw new Error(`body line missing for ${entry.id}`);
        // The room header occupies line zero; palace lines are one-based.
        relativeLines.set(entry.id, bodyLine + 1);
    }
    for (const merge of merges) {
        const targetLine =
            merge.mergeInto === undefined ? undefined : relativeLines.get(merge.mergeInto);
        if (targetLine === undefined) throw new Error(`merge target line missing for ${merge.id}`);
        relativeLines.set(merge.id, targetLine);
    }
    return {
        category,
        name,
        lines: [header, ...bodyLines],
        entryBodyLines,
        relativeLines,
        entries,
        merges,
        peakImportance,
        sharedPairCount,
    };
}

export function renderPalace(specs: SpecEntry[]): {
    palace: string;
    placements: Map<number, Placement>;
    rooms: RoomSummary[];
    layoutItems: LayoutItem[];
    pages: Array<{
        page: number;
        startLine: number;
        endLine: number;
        heightCells: number;
        heightPixels: number;
    }>;
    leveling: { gapRowsBefore: number; gapRowsAfter: number; splitCount: number };
    droppedByTrimIds: number[];
    droppedBySkipIds: number[];
} {
    type RoomInput = {
        category: Category;
        name: string;
        entries: SpecEntry[];
        categoryIndex: number;
        manifestOrder: number;
    };
    type Allocation = { banner?: StreamSlot; gap?: StreamSlot; room: StreamSlot[]; end: StreamSlot };
    const grouped = new Map<string, RoomInput>();
    const MAX_RENDER_ITERATIONS = 1_000_000;
    const MAX_SHARE_ITERATIONS = 1_000;
    let iterations = 0;
    const guard = (context: string): void => {
        if (++iterations > MAX_RENDER_ITERATIONS) {
            throw new Error(
                `single-page placement exceeded ${MAX_RENDER_ITERATIONS} iterations while ${context}`,
            );
        }
    };

    const mergeTargetsArePresent = (entries: SpecEntry[]): boolean => {
        const ids = new Set(entries.map((entry) => entry.id));
        return entries.every((entry) => entry.mergeInto === undefined || ids.has(entry.mergeInto));
    };

    const nextManifestOrder = new Map<Category, number>();
    for (const spec of specs) {
        guard("grouping manifest entries");
        const key = `${spec.category}\u0000${spec.room}`;
        const categoryOrder = nextManifestOrder.get(spec.category) ?? 0;
        const room =
            grouped.get(key) ??
            {
                category: spec.category,
                name: spec.room,
                entries: [],
                categoryIndex: CATEGORY_ORDER.indexOf(spec.category),
                manifestOrder: categoryOrder,
            };
        if (!grouped.has(key)) nextManifestOrder.set(spec.category, categoryOrder + 1);
        room.entries.push(spec);
        grouped.set(key, room);
    }

    // The category order is the page's spatial order. Within a category, the best
    // room leads while manifest order remains the tie-breaker and entry order.
    const roomsByCategory = new Map<Category, RoomInput[]>();
    for (const category of CATEGORY_ORDER) roomsByCategory.set(category, []);
    for (const room of grouped.values()) roomsByCategory.get(room.category)?.push(room);
    for (const category of CATEGORY_ORDER) {
        const categoryRooms = roomsByCategory.get(category) ?? [];
        categoryRooms.sort((left, right) => {
            const leftPeak = Math.max(...left.entries.map((entry) => entry.importance));
            const rightPeak = Math.max(...right.entries.map((entry) => entry.importance));
            return rightPeak - leftPeak || left.manifestOrder - right.manifestOrder;
        });
    }

    const plans = new Map<RoomInput, RoomPlan>();
    const categoryDemand = new Map<Category, number>();
    for (const category of CATEGORY_ORDER) {
        const categoryRooms = roomsByCategory.get(category) ?? [];
        let demand = categoryRooms.length > 0 ? 1 : 0;
        for (const room of categoryRooms) {
            guard(`measuring ${category}/${room.name} demand`);
            if (!mergeTargetsArePresent(room.entries)) {
                throw new Error(`room ${room.name} has a merge target outside its manifest order`);
            }
            const plan = buildRoomPlan(room.category, room.name, room.entries);
            plans.set(room, plan);
            // One blank line separates adjacent rooms unless the next room starts
            // at a new column; that boundary exception is handled during placement.
            demand += plan.lines.length;
        }
        if (categoryRooms.length > 1) demand += categoryRooms.length - 1;
        categoryDemand.set(category, demand);
    }

    const initialShare = Math.floor(PAGE_LINE_CAPACITY / CATEGORY_ORDER.length);
    const categoryBudgets = new Map<Category, number>();
    let unassignedLines = PAGE_LINE_CAPACITY - initialShare * CATEGORY_ORDER.length;
    for (const category of CATEGORY_ORDER) {
        const demand = categoryDemand.get(category) ?? 0;
        if (demand < initialShare) {
            categoryBudgets.set(category, demand);
            unassignedLines += initialShare - demand;
        } else {
            categoryBudgets.set(category, initialShare);
        }
    }

    // Redistribute short categories' unused share proportionally to categories
    // that still have unmet demand. Repeating after each integer allocation lets
    // small residual demands receive a line without starving larger categories.
    for (let shareIteration = 0; unassignedLines > 0; shareIteration++) {
        if (shareIteration >= MAX_SHARE_ITERATIONS) {
            throw new Error(`category share redistribution exceeded ${MAX_SHARE_ITERATIONS} iterations`);
        }
        const unmet = CATEGORY_ORDER.map((category) => {
            const budget = categoryBudgets.get(category) ?? 0;
            const demand = categoryDemand.get(category) ?? 0;
            return { category, budget, remaining: Math.max(0, demand - budget) };
        }).filter((item) => item.remaining > 0);
        if (unmet.length === 0) break;
        const totalRemaining = unmet.reduce((total, item) => total + item.remaining, 0);
        const pool = unassignedLines;
        const allocations = unmet.map((item) => {
            const exact = (pool * item.remaining) / totalRemaining;
            return {
                ...item,
                extra: Math.min(item.remaining, Math.floor(exact)),
                fraction: exact - Math.floor(exact),
            };
        });
        let assigned = allocations.reduce((total, item) => total + item.extra, 0);
        allocations.sort(
            (left, right) =>
                right.fraction - left.fraction ||
                CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category),
        );
        for (const allocation of allocations) {
            if (assigned >= pool) break;
            if (allocation.extra >= allocation.remaining) continue;
            allocation.extra++;
            assigned++;
        }
        for (const allocation of allocations) {
            if (allocation.extra > 0) {
                categoryBudgets.set(allocation.category, allocation.budget + allocation.extra);
            }
        }
        if (assigned === 0) {
            throw new Error("category share redistribution made no progress");
        }
        unassignedLines -= assigned;
    }

    const columns = Array.from({ length: COLUMN_COUNT }, () => Array<string>(PAGE_HEIGHT_CELLS).fill(""));
    const placements = new Map<number, Placement>();
    const roomSummaries: RoomSummary[] = [];
    const layoutItems: LayoutItem[] = [];
    const droppedByTrimIds: number[] = [];
    const droppedBySkipIds: number[] = [];
    const droppedTrimSet = new Set<number>();
    const droppedSkipSet = new Set<number>();
    let cursor: StreamSlot = { column: 0, row: 0 };
    let spilloverLines = 0;

    const categoryBanner = (category: Category): string => {
        const label = ` <${category}> `;
        const remaining = ROOM_WIDTH - codepoints(label);
        if (remaining < 0) throw new Error(`category banner exceeds column width: ${category}`);
        return `${"─".repeat(Math.floor(remaining / 2))}${label}${"─".repeat(Math.ceil(remaining / 2))}`;
    };
    const addDropped = (id: number, kind: "trim" | "skip"): void => {
        const set = kind === "trim" ? droppedTrimSet : droppedSkipSet;
        const output = kind === "trim" ? droppedByTrimIds : droppedBySkipIds;
        if (placements.has(id) || set.has(id)) return;
        set.add(id);
        output.push(id);
    };
    const isEnd = (slot: StreamSlot): boolean => slot.column >= COLUMN_COUNT;
    const advance = (slot: StreamSlot): StreamSlot => {
        const nextRow = slot.row + 1;
        if (nextRow < PAGE_HEIGHT_CELLS) return { column: slot.column, row: nextRow };
        return { column: slot.column + 1, row: 0 };
    };
    const segmentHeight = (lineCount: number, continuation: boolean): number => {
        if (lineCount <= 0) return 0;
        return continuation
            ? lineCount * BODY_LINE_PITCH
            : CELL_HEIGHT + Math.max(0, lineCount - 1) * BODY_LINE_PITCH;
    };
    const simulate = (
        category: Category,
        plan: RoomPlan,
        includeBanner: boolean,
        includeGap: boolean,
        lineBudget: number,
    ): Allocation | undefined => {
        let next = { ...cursor };
        let banner: StreamSlot | undefined;
        if (includeBanner) {
            if (isEnd(next)) return undefined;
            banner = next;
            next = advance(next);
        }

        let gap: StreamSlot | undefined;
        let needsGap = includeGap && next.row > 0;
        // Keep a blank/header unit together at the bottom of a column. If the
        // header would cross the boundary, the room begins at the next column and
        // therefore needs no leading blank.
        if (needsGap && next.row >= PAGE_HEIGHT_CELLS - 2) {
            next = advance(next);
            needsGap = false;
        }
        if (!needsGap && next.row === PAGE_HEIGHT_CELLS - 1) next = advance(next);
        if (isEnd(next)) return undefined;
        if (needsGap) {
            gap = next;
            next = advance(next);
        }
        if (isEnd(next)) return undefined;
        if (next.row === PAGE_HEIGHT_CELLS - 1) next = advance(next);
        if (isEnd(next)) return undefined;

        const fixedLines = (banner ? 1 : 0) + (gap ? 1 : 0);
        if (fixedLines + plan.lines.length > lineBudget) return undefined;
        const roomSlots: StreamSlot[] = [];
        for (const line of plan.lines) {
            guard(`simulating ${category}/${plan.name} flow`);
            if (codepoints(line) > ROOM_WIDTH) {
                throw new Error(`line in ${category}/${plan.name} exceeds ${ROOM_WIDTH} cells`);
            }
            roomSlots.push(next);
            next = advance(next);
            if (isEnd(next) && roomSlots.length < plan.lines.length) return undefined;
        }
        if (roomSlots.length < 2) return undefined;
        return { ...(banner ? { banner } : {}), ...(gap ? { gap } : {}), room: roomSlots, end: next };
    };
    const writeSlot = (slot: StreamSlot, line: string, context: string): void => {
        guard(`writing ${context}`);
        const column = columns[slot.column];
        if (!column) throw new Error(`missing column ${slot.column} while writing ${context}`);
        if (slot.row < 0 || slot.row >= column.length) {
            throw new Error(`line ${slot.row} is outside column ${slot.column} while writing ${context}`);
        }
        if (codepoints(line) > ROOM_WIDTH) throw new Error(`${context} exceeds ${ROOM_WIDTH} cells`);
        column[slot.row] = line;
    };
    const recordCategory = (category: Category, slot: StreamSlot): void => {
        writeSlot(slot, categoryBanner(category), `${category} banner`);
        const line = slot.row + 1;
        layoutItems.push({
            kind: "category",
            category,
            categories: [category],
            column: slot.column,
            startLine: line,
            endLine: line,
            page: 1,
            pageLine: line,
            pageTopPixels: slot.row * BODY_LINE_PITCH,
            heightPixels: CELL_HEIGHT,
        });
    };
    const recordRoom = (room: RoomInput, plan: RoomPlan, allocation: Allocation): void => {
        const segmentSlots = new Map<number, StreamSlot[]>();
        for (const slot of allocation.room) {
            const segment = segmentSlots.get(slot.column) ?? [];
            segment.push(slot);
            segmentSlots.set(slot.column, segment);
        }
        const segmentColumns = [...segmentSlots.keys()];
        for (const [segmentIndex, column] of segmentColumns.entries()) {
            guard(`recording ${room.category}/${room.name} segment`);
            const slots = segmentSlots.get(column);
            if (!slots || slots.length === 0) throw new Error(`empty segment for ${room.name}`);
            const startLine = (slots[0]?.row ?? 0) + 1;
            const endLine = (slots.at(-1)?.row ?? 0) + 1;
            const continuation = segmentIndex > 0;
            const segmentEntries = [...plan.entries, ...plan.merges].filter((entry) => {
                const relativeLine = plan.relativeLines.get(entry.id);
                const slot = relativeLine === undefined ? undefined : allocation.room[relativeLine];
                return slot?.column === column;
            });
            const entryCount = segmentEntries.filter((entry) => entry.mergeInto === undefined).length;
            const mergeCount = segmentEntries.length - entryCount;
            const heightPixels = segmentHeight(slots.length, continuation);
            const layoutItem: LayoutItem = {
                kind: "room",
                category: room.category,
                room: room.name,
                continuation,
                segment: segmentIndex,
                column,
                startLine,
                endLine,
                page: 1,
                pageLine: startLine,
                pageTopPixels: (slots[0]?.row ?? 0) * BODY_LINE_PITCH,
                heightPixels,
            };
            layoutItems.push(layoutItem);
            roomSummaries.push({
                category: room.category,
                name: room.name,
                entryCount,
                mergeCount,
                memoryCount: entryCount + mergeCount,
                peakImportance: plan.peakImportance,
                // Retained for sidecar compatibility; border characters are no longer emitted.
                border: plan.peakImportance >= 70 ? "double" : "single",
                column,
                startLine,
                endLine,
                heightCells: slots.length,
                sharedPairCount: segmentIndex === 0 ? plan.sharedPairCount : 0,
                continuation,
                segment: segmentIndex,
                page: 1,
                pageLine: startLine,
                pageTopPixels: (slots[0]?.row ?? 0) * BODY_LINE_PITCH,
                heightPixels,
            });
        }
        for (const entry of [...plan.entries, ...plan.merges]) {
            guard(`recording ${room.category}/${room.name} entries`);
            const relativeLine = plan.relativeLines.get(entry.id);
            if (relativeLine === undefined) throw new Error(`placement missing for ${entry.id}`);
            const slot = allocation.room[relativeLine];
            if (!slot) throw new Error(`room line ${relativeLine} missing for ${entry.id}`);
            placements.set(entry.id, {
                category: room.category,
                room: room.name,
                palaceLine: slot.row + 1,
                palaceColumn: slot.column * (ROOM_WIDTH + COLUMN_GAP) + 1,
                page: 1,
                pageLine: slot.row + 1,
                ...(entry.mergeInto === undefined ? {} : { mergedInto: entry.mergeInto }),
            });
        }
    };

    for (const category of CATEGORY_ORDER) {
        const categoryRooms = roomsByCategory.get(category) ?? [];
        if (categoryRooms.length === 0) continue;
        let remainingBudget = (categoryBudgets.get(category) ?? 0) + spilloverLines;
        spilloverLines = 0;
        let categoryRendered = false;
        for (const room of categoryRooms) {
            guard(`selecting ${room.category}/${room.name}`);
            const includeBanner = !categoryRendered;
            const includeGap = categoryRendered;
            const fullPlan = plans.get(room);
            if (!fullPlan) throw new Error(`room plan missing for ${room.category}/${room.name}`);
            const select = (entries: SpecEntry[]): { plan: RoomPlan; allocation: Allocation } | undefined => {
                if (!mergeTargetsArePresent(entries)) return undefined;
                const plan = entries === room.entries ? fullPlan : buildRoomPlan(room.category, room.name, entries);
                const allocation = simulate(
                    room.category,
                    plan,
                    includeBanner,
                    includeGap,
                    remainingBudget,
                );
                return allocation ? { plan, allocation } : undefined;
            };
            let selected = select(room.entries);
            if (!selected) {
                for (let keep = room.entries.length - 1; keep >= 1; keep--) {
                    guard(`trimming ${room.category}/${room.name}`);
                    selected = select(room.entries.slice(0, keep));
                    if (selected) {
                        for (const entry of room.entries.slice(keep)) addDropped(entry.id, "trim");
                        break;
                    }
                }
            }
            if (!selected) {
                for (const entry of room.entries) {
                    guard(`dropping skipped ${room.category}/${room.name}`);
                    addDropped(entry.id, "skip");
                }
                continue;
            }
            if (selected.allocation.banner) recordCategory(category, selected.allocation.banner);
            categoryRendered = true;
            for (let index = 0; index < selected.plan.lines.length; index++) {
                const slot = selected.allocation.room[index];
                const line = selected.plan.lines[index];
                if (!slot || line === undefined) throw new Error(`room line ${index} missing for ${room.name}`);
                writeSlot(slot, line, `${room.category}/${room.name} room line`);
            }
            recordRoom(room, selected.plan, selected.allocation);
            const consumed =
                (selected.allocation.banner ? 1 : 0) +
                (selected.allocation.gap ? 1 : 0) +
                selected.plan.lines.length;
            if (consumed > remainingBudget) {
                throw new Error(`category ${category} exceeded its line share`);
            }
            remainingBudget -= consumed;
            cursor = selected.allocation.end;
        }
        // A category that cannot use its final partial room returns those lines
        // as spill for the next category rather than leaving a silent hole.
        spilloverLines += remainingBudget;
    }

    const palaceLines = columns[0]?.map((_, row) =>
        columns
            .map((column) => (column[row] ?? "").padEnd(ROOM_WIDTH))
            .join(" ".repeat(COLUMN_GAP)),
    ) ?? [];
    for (let row = 0; row < palaceLines.length; row++) {
        guard("padding the fixed page canvas");
        if (codepoints(palaceLines[row] ?? "") > MAX_LINE_CHARS) {
            throw new Error(`line ${row + 1} exceeds ${MAX_LINE_CHARS} cells`);
        }
    }
    const palace = `${palaceLines.join("\n")}\n`;
    const longLines = palaceLines
        .map((line, index) => ({ line: index + 1, chars: codepoints(line) }))
        .filter((item) => item.chars > MAX_LINE_CHARS);
    if (longLines.length > 0) {
        throw new Error(`lines exceed ${MAX_LINE_CHARS}: ${JSON.stringify(longLines)}`);
    }
    if (palace.length > MAX_PALACE_CHARS) {
        throw new Error(`palace has ${palace.length} chars (max ${MAX_PALACE_CHARS})`);
    }
    if (/#\d+/.test(palace)) {
        const message = "memory id leaked into palace.txt";
        if (!process.env.PALACE_RENDER_DESPITE_VALIDATOR) throw new Error(message);
        console.warn(`[palace] ${message}; rendering review manifest anyway`);
    }
    return {
        palace,
        placements,
        rooms: roomSummaries,
        layoutItems,
        pages: [
            {
                page: 1,
                startLine: 1,
                endLine: PAGE_HEIGHT_CELLS,
                heightCells: PAGE_HEIGHT_CELLS,
                heightPixels: PAGE_HEIGHT_PIXELS,
            },
        ],
        leveling: {
            gapRowsBefore: 0,
            gapRowsAfter: 0,
            splitCount: roomSummaries.filter((room) => room.continuation).length,
        },
        droppedByTrimIds,
        droppedBySkipIds,
    };
}

export function authorPalace(args: {
    source: SourceMemory[];
    specs: SpecEntry[];
    sourceLabel?: string;
    palaceOutput?: string;
    coverageOutput?: string;
}) {
    const palaceOutput = args.palaceOutput ?? PALACE_OUTPUT;
    const coverageOutput = args.coverageOutput ?? COVERAGE_OUTPUT;
    const reviewRender = Boolean(process.env.PALACE_RENDER_DESPITE_VALIDATOR);
    if (reviewRender) {
        // Review renders soft-break oversized unbreakable anchors before validation
        // and measurement, so every downstream consumer sees the same widths.
        const maxToken = ROOM_WIDTH - 6;
        for (const entry of args.specs) {
            if (entry.cue === undefined) continue;
            const parts = Array.isArray(entry.cue) ? entry.cue : [entry.cue];
            const softened = parts.map((part) =>
                part
                    .split(" ")
                    .map((token) =>
                        codepoints(token) > maxToken
                            ? Array.from(token)
                                  .reduce<string[]>((acc, ch) => {
                                      const last = acc[acc.length - 1];
                                      if (last === undefined || codepoints(last) >= maxToken - 1)
                                          acc.push(ch);
                                      else acc[acc.length - 1] = last + ch;
                                      return acc;
                                  }, [])
                                  .join("- ")
                            : token,
                    )
                    .join(" "),
            );
            entry.cue = Array.isArray(entry.cue) ? softened : softened[0];
        }
    }
    let renderSpecs = args.specs;
    try {
        validate(args.source, args.specs);
    } catch (error) {
        if (!reviewRender) throw error;
        console.warn(
            `[palace] validator rejected review manifest: ${error instanceof Error ? error.message : String(error)}; rendering anyway`,
        );
        const seenIds = new Set<number>();
        renderSpecs = args.specs.filter((entry) => {
            if (seenIds.has(entry.id)) return false;
            seenIds.add(entry.id);
            return true;
        });
    }
    const { palace, placements, rooms, layoutItems, pages, leveling, droppedByTrimIds, droppedBySkipIds: renderedSkipIds } =
        renderPalace(renderSpecs);

    const droppedBySkipIds = [...renderedSkipIds];
    const droppedSkipSet = new Set(droppedBySkipIds);
    const droppedTrimSet = new Set(droppedByTrimIds);
    const renderedIds = [...placements.keys()];
    const renderedSet = new Set(renderedIds);
    for (const memory of args.source) {
        if (
            !renderedSet.has(memory.id) &&
            !droppedTrimSet.has(memory.id) &&
            !droppedSkipSet.has(memory.id)
        ) {
            droppedSkipSet.add(memory.id);
            droppedBySkipIds.push(memory.id);
        }
    }
    const renderedEntries = renderSpecs.filter(
        (entry) => entry.mergeInto === undefined && placements.has(entry.id),
    );
    const renderedMerges = renderSpecs.filter(
        (entry) => entry.mergeInto !== undefined && placements.has(entry.id),
    );
    const cueLengths = renderedEntries.map((entry) => codepoints(displayCue(entry))).sort((a, b) => a - b);
    const percentile = (value: number): number =>
        cueLengths[Math.round((cueLengths.length - 1) * value)] ?? 0;
    const renderedMemoryCount = renderedIds.length;
    const droppedMemoryCount = droppedByTrimIds.length + droppedBySkipIds.length;
    const palaceLines = palace.endsWith("\n") ? palace.slice(0, -1).split("\n") : palace.split("\n");
    const coverage = {
        source: args.sourceLabel ?? SOURCE_PATH,
        sourceMemoryCount: args.source.length,
        renderedIds,
        droppedByTrimIds,
        droppedBySkipIds,
        renderedMemoryCount,
        droppedMemoryCount,
        entryCount: renderedEntries.length,
        mergeCount: renderedMerges.length,
        representedMemoryCount: renderedMemoryCount,
        palaceChars: palace.length,
        maxLineChars: Math.max(...palaceLines.map(codepoints)),
        layout: {
            font: LAYOUT_FONT,
            cellWidth: CELL_WIDTH,
            cellHeight: CELL_HEIGHT,
            columns: COLUMN_COUNT,
            roomWidthChars: ROOM_WIDTH,
            pageWidthChars: PAGE_WIDTH_CHARS,
            columnGapChars: COLUMN_GAP,
            canvasHeightCells: PAGE_HEIGHT_CELLS,
            pageHeightPixels: PAGE_HEIGHT_PIXELS,
            bodyLinePitch: BODY_LINE_PITCH,
            pages,
            cueLengthDistribution: {
                min: cueLengths[0] ?? 0,
                p25: percentile(0.25),
                median: percentile(0.5),
                p75: percentile(0.75),
                p90: percentile(0.9),
                max: cueLengths.at(-1) ?? 0,
            },
            sharedPairCount: rooms.reduce((total, room) => total + room.sharedPairCount, 0),
            bandGapRowsBefore: leveling.gapRowsBefore,
            bandGapRowsAfter: leveling.gapRowsAfter,
            roomSplitCount: leveling.splitCount,
            items: layoutItems,
        },
        rooms,
        memories: Object.fromEntries(
            [...placements.entries()]
                .sort(([a], [b]) => a - b)
                .map(([id, placement]) => [String(id), placement]),
        ),
    };
    writeFileSync(palaceOutput, palace);
    writeFileSync(coverageOutput, `${JSON.stringify(coverage, null, 4)}\n`);
    return { palace, coverage };
}

function main(): void {
    const specs = readSpecs();
    const source = parseSource(
        readFileSync(SOURCE_PATH, "utf8"),
        new Map(specs.map((spec) => [spec.id, spec.importance])),
    );
    const { palace, coverage } = authorPalace({ source, specs });
    console.log(
        JSON.stringify({
            palace: basename(PALACE_OUTPUT),
            font: LAYOUT_FONT,
            chars: palace.length,
            lines: palace.trimEnd().split("\n").length,
            entries: coverage.entryCount,
            merges: coverage.mergeCount,
            memories: coverage.representedMemoryCount,
            rooms: coverage.rooms.length,
            pages: coverage.layout.pages.map((page) => page.heightCells),
            cueLengths: coverage.layout.cueLengthDistribution,
            sharedPairs: coverage.layout.sharedPairCount,
            bandGaps: {
                before: coverage.layout.bandGapRowsBefore,
                after: coverage.layout.bandGapRowsAfter,
            },
            roomSplits: coverage.layout.roomSplitCount,
        }),
    );
}

if (import.meta.main) main();
