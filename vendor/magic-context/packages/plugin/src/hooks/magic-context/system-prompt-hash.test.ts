/// <reference types="bun-types" />

/**
 * Regression suite for `createSystemPromptHashHandler`'s drain semantics.
 *
 * Oracle review 2026-04-26 Finding A1 caught a real bug: the handler's
 * unconditional drain of `systemPromptRefreshSessions` at the end of the
 * handler was silently dropping the flag added by hash-change detection
 * earlier in the same handler call. That meant a real prompt-content
 * change set the flag, then immediately discarded it before any future
 * pass could observe it — adjuncts (project docs, user profile, key
 * files) stayed stale forever.
 *
 * The fix made the drain conditional on the value of `isCacheBusting`
 * captured at the top of the handler. These tests lock that contract in.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHiddenAgentRegistrations } from "../../agents/hidden-agent-registrations";
import { CLASSIFY_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/classify-prompt";
import { MAP_MEMORIES_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/map-memories-prompt";
import {
    CURATE_SYSTEM_PROMPT,
    DREAMER_SYSTEM_PROMPT,
    MAINTAIN_DOCS_SYSTEM_PROMPT,
    PRIMER_INVESTIGATOR_SYSTEM_PROMPT,
    REVIEW_USER_MEMORIES_SYSTEM_PROMPT,
} from "../../features/magic-context/dreamer/task-prompts";
import { VERIFY_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/verify-prompt";
import { MIGRATION_SYSTEM_PROMPT } from "../../features/magic-context/memory/memory-migration";
import { SIDEKICK_SYSTEM_PROMPT } from "../../features/magic-context/sidekick/agent";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "../../features/magic-context/smart-notes/compiler-prompt";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./compartment-prompt";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { createSystemPromptHashHandler, isMagicContextInternalAgent } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function buildHandler(opts?: {
    historyRefreshSessions?: Set<string>;
    systemPromptRefreshSessions?: Set<string>;
    pendingMaterializationSessions?: Set<string>;
    injectionEnabled?: boolean;
    injectionSkipSignatures?: string[];
    dreamerEnabled?: boolean;
    experimentalUserMemories?: boolean;
    internalChildSessions?: Set<string>;
    experimentalCavemanTextCompression?: boolean;
    language?: string;
}): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        protectedTags: 1,
        language: opts?.language,
        dreamerEnabled: opts?.dreamerEnabled ?? false,
        historyRefreshSessions: opts?.historyRefreshSessions ?? new Set<string>(),
        systemPromptRefreshSessions: opts?.systemPromptRefreshSessions ?? new Set<string>(),
        pendingMaterializationSessions: opts?.pendingMaterializationSessions ?? new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        injectionEnabled: opts?.injectionEnabled,
        injectionSkipSignatures: opts?.injectionSkipSignatures,
        experimentalUserMemories: opts?.experimentalUserMemories,
        internalChildSessions: opts?.internalChildSessions,
        experimentalCavemanTextCompression: opts?.experimentalCavemanTextCompression,
    });
}

describe("system-prompt-hash drain semantics (Oracle review 2026-04-26 Finding A1)", () => {
    it("drains pre-existing systemPromptRefresh flag set by /ctx-flush", async () => {
        useTempDataHome("sph-drain-existing-");
        const sessionId = "ses-existing-flag";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Seed a prior hash so this looks like an existing session, no
        // hash change on this pass.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "deadbeef",
            systemPromptTokens: 100,
        });

        await handler({ sessionID: sessionId }, { system: ["You are a helpful agent."] });

        // Flag was set on entry → handler consumed it → drain.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });

    it("does NOT drain just-added flag from hash-change detection (the bug Oracle caught)", async () => {
        useTempDataHome("sph-drain-just-added-");
        const sessionId = "ses-hash-change";
        const systemPromptRefreshSessions = new Set<string>(); // empty on entry
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        // Seed a prior hash that will mismatch the prompt below.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        await handler(
            { sessionID: sessionId },
            { system: ["You are a helpful agent.", "New system content here"] },
        );

        // Hash detection added all three signals.
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        // CRITICAL: systemPromptRefreshSessions was added by hash-change
        // detection AFTER `isCacheBusting` was captured at the top of
        // the handler. The drain at the end is conditional on that
        // captured value (false in this case), so the just-added flag
        // must SURVIVE for the next pass to consume.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("does NOT drain if handler short-circuits before the drain (early return)", async () => {
        useTempDataHome("sph-drain-early-return-");
        const sessionId = "ses-empty-prompt";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Empty system prompt triggers early return at line 375.
        await handler({ sessionID: sessionId }, { system: [] });

        // The handler returned early before reaching the drain. With the
        // OLD unconditional drain, the flag would have been dropped
        // anyway because the early return is BEFORE the drain. With the
        // current code structure, the drain still only fires after Step
        // 3 — so this test documents that early returns preserve the
        // flag for a future valid pass to consume.
        //
        // Note: this is a low-severity Oracle finding D — the main fix
        // was for Finding A1, but the conditional drain also makes
        // early-return paths safer by default.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("on subsequent pass after hash-change pass, drains the surviving flag", async () => {
        useTempDataHome("sph-drain-followup-");
        const sessionId = "ses-followup";
        const systemPromptRefreshSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        // Pass 1: hash mismatch → flag added but survives.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);

        // Pass 2: same prompt content (hash now matches stored value
        // from Pass 1). Flag was set on entry → handler reads adjuncts
        // with isCacheBusting=true → drain.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });
});

describe("system-prompt-hash token estimation (council audit bg_51106601 #2)", () => {
    it("does not refresh systemPromptTokens when the system prompt hash is unchanged", async () => {
        useTempDataHome("sph-unchanged-token-skip-");
        const sessionId = "ses-unchanged-token-skip";
        const { handler } = buildHandler();
        const db = openDatabase();

        const firstPassSystem = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system: firstPassSystem });

        const initializedMeta = getOrCreateSessionMeta(db, sessionId);
        expect(initializedMeta.systemPromptHash).toBe(
            createHash("md5").update(firstPassSystem.join("\n")).digest("hex"),
        );
        expect(initializedMeta.systemPromptTokens).toBeGreaterThan(50);

        updateSessionMeta(db, sessionId, { systemPromptTokens: 1 });

        const secondPassSystem = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system: secondPassSystem });

        const unchangedMeta = getOrCreateSessionMeta(db, sessionId);
        expect(unchangedMeta.systemPromptHash).toBe(initializedMeta.systemPromptHash);
        expect(unchangedMeta.systemPromptTokens).toBe(1);
    });
});

describe("system-prompt-hash fail-open (per-turn handler must never throw)", () => {
    it("resolves and preserves the mutated prompt when the meta write fails", async () => {
        useTempDataHome("sph-fail-open-");
        const sessionId = "ses-fail-open";
        const { handler } = buildHandler();
        const db = openDatabase();

        // Pass 1 primes session_meta (hash + tokens) cleanly.
        await handler({ sessionID: sessionId }, { system: ["You are a helpful agent."] });

        // Now sabotage the persistence layer so the hash-change branch's
        // updateSessionMeta throws on pass 2. Dropping the table makes any write
        // raise — simulating a busy/failing DB. The handler must NOT propagate it.
        db.exec("DROP TABLE session_meta");

        const system = ["You are a helpful agent.", "DIFFERENT content forces a hash change"];
        // Must not throw — a throw here would fail the LLM call instead of just
        // losing a telemetry write.
        await handler({ sessionID: sessionId }, { system });

        // The prompt was still mutated/injected (guidance present) — failing open
        // means we keep what we did, not crash.
        expect(system.join("\n")).toContain("## Magic Context");
    });
});

describe("system-prompt-hash v2 system prompt contents", () => {
    it("keeps project docs, user profile, and key files out of the system prompt", async () => {
        useTempDataHome("sph-v2-adjuncts-out-");
        const directory = mkdtempSync(join(tmpdir(), "sph-docs-project-"));
        tempDirs.push(directory);
        writeFileSync(join(directory, "ARCHITECTURE.md"), "Alpha <closing-tag> & beta", "utf-8");
        const sessionId = "ses-v2-adjuncts-out";
        const { handler } = buildHandler({
            dreamerEnabled: true,
            experimentalUserMemories: true,
        });

        const system = ["You are a helpful coding assistant. Today's date: 2026-05-28"];
        await handler({ sessionID: sessionId }, { system });
        const joined = system.join("\n");

        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("Today's date: 2026-05-28");
        expect(joined).not.toContain("<project-docs>");
        expect(joined).not.toContain("<user-profile>");
        expect(joined).not.toContain("<key-files>");
        expect(joined).not.toContain("Alpha &lt;closing-tag&gt;");
    });

    it("injects language guidance and stabilizes after the config changes once", async () => {
        useTempDataHome("sph-language-fold-once-");
        const sessionId = "ses-language-fold";
        const systemPromptRefreshSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const db = openDatabase();

        const withoutLanguage = buildHandler({
            systemPromptRefreshSessions,
            historyRefreshSessions,
            pendingMaterializationSessions,
        });
        await withoutLanguage.handler({ sessionID: sessionId }, { system: ["You are helpful."] });
        historyRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        systemPromptRefreshSessions.clear();

        const withLanguage = buildHandler({
            systemPromptRefreshSessions,
            historyRefreshSessions,
            pendingMaterializationSessions,
            language: "tr",
        });
        const changed = ["You are helpful."];
        await withLanguage.handler({ sessionID: sessionId }, { system: changed });
        expect(changed.join("\n")).toContain(
            "Use Turkish (Türkçe) for your natural-language replies",
        );
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        historyRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        systemPromptRefreshSessions.clear();
        const stable = ["You are helpful."];
        await withLanguage.handler({ sessionID: sessionId }, { system: stable });
        expect(stable.join("\n")).toContain(
            "Use Turkish (Türkçe) for your natural-language replies",
        );
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).not.toBe("");
    });
});

/**
 * Issue #52 regression: Magic Context guidance was being injected into the
 * system prompt for OpenCode's three native hidden agents (title, summary,
 * compaction). These agents run on small/cheap models with a fixed single-
 * shot job — they don't benefit from any of our injection (no tools, no
 * `ctx_reduce`, no nudges) and pay for the extra prompt content in cost.
 */
describe("system-prompt-hash skips OpenCode internal hidden agents (issue #52)", () => {
    const TITLE_PROMPT_HEAD =
        "You are a title generator. You output ONLY a thread title. Nothing else.";
    const SUMMARY_PROMPT_HEAD =
        "Summarize what was done in this conversation. Write like a pull request description.";
    const COMPACTION_PROMPT_HEAD =
        "You are an anchored context summarization assistant for coding sessions.";

    it("skips ALL injection for the title agent (signature from title.txt)", async () => {
        useTempDataHome("sph-skip-title-");
        const sessionId = "ses-title";
        const { handler } = buildHandler();

        const system = [TITLE_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        // Nothing appended: no `## Magic Context`, no `<project-docs>`,
        // no `<user-profile>`, no `<key-files>`. The system array stays
        // exactly as OpenCode passed it in.
        expect(system).toHaveLength(1);
        expect(system[0]).toBe(TITLE_PROMPT_HEAD);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("skips ALL injection for the summary agent", async () => {
        useTempDataHome("sph-skip-summary-");
        const sessionId = "ses-summary";
        const { handler } = buildHandler();

        const system = [SUMMARY_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe(SUMMARY_PROMPT_HEAD);
    });

    it("skips ALL injection for the compaction agent", async () => {
        useTempDataHome("sph-skip-compaction-");
        const sessionId = "ses-compaction";
        const { handler } = buildHandler();

        const system = [COMPACTION_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe(COMPACTION_PROMPT_HEAD);
    });

    it("does NOT update systemPromptHash for internal-agent calls", async () => {
        // Title-gen runs once on the first user turn with a totally
        // different system prompt than the main agent. If we updated the
        // hash here, every subsequent main-agent turn would see a
        // "hash changed" flush and burn cache for nothing.
        useTempDataHome("sph-skip-no-hash-update-");
        const sessionId = "ses-no-hash-update";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash-abc123" });

        const { handler } = buildHandler();
        await handler({ sessionID: sessionId }, { system: [TITLE_PROMPT_HEAD] });

        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).toBe("main-agent-hash-abc123");
    });

    it("still injects guidance for normal agents whose prompts don't match signatures", async () => {
        useTempDataHome("sph-still-injects-");
        const sessionId = "ses-normal";
        const { handler } = buildHandler();

        const system = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        // The normal-agent path still appends the magic-context guidance.
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
    });
});

/**
 * Magic Context's OWN hidden children (historian/dreamer/sidekick/migration)
 * must not get the guidance block — wasted spend + a contradictory second
 * identity frame. Detected by prompt signature (pass-1, timing-independent)
 * AND the title-prefix `internalChildSessions` flag.
 */
describe("system-prompt-hash skips Magic Context internal child agents", () => {
    const HISTORIAN_HEAD =
        "You are Historian — the hippocampus of a long-running coding agent. You and the primary agent are one mind.";
    const SIDEKICK_HEAD =
        "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.";
    // Every dreamer task prompt shares "for the magic-context system"; each opener
    // below must be detected so the guidance block is never injected into a dreamer
    // child even in the title-flag race window.
    const DREAMER_BASE_HEAD =
        "You are a background maintenance agent for the magic-context system,";
    const CURATE_HEAD = "You are a memory-pool curator for the magic-context system.";
    const MAINTAIN_DOCS_HEAD = "You are a documentation maintainer for the magic-context system.";
    const REVIEW_USER_HEAD = "You are a user-profile reviewer for the magic-context system.";
    const PRIMER_HEAD = "You are a read-only code investigator for the magic-context system.";

    for (const [label, head] of [
        ["historian", HISTORIAN_HEAD],
        ["dreamer-base", DREAMER_BASE_HEAD],
        ["curate", CURATE_HEAD],
        ["maintain-docs", MAINTAIN_DOCS_HEAD],
        ["review-user-memories", REVIEW_USER_HEAD],
        ["primer-investigator", PRIMER_HEAD],
        ["sidekick", SIDEKICK_HEAD],
    ] as const) {
        it(`skips ALL injection for the ${label} agent (prompt signature)`, async () => {
            useTempDataHome(`sph-skip-mc-${label}-`);
            const { handler } = buildHandler();
            const system = [head];
            await handler({ sessionID: `ses-mc-${label}` }, { system });
            expect(system).toHaveLength(1);
            expect(system[0]).toBe(head);
            expect(system.join("\n")).not.toContain("## Magic Context");
        });
    }

    it("detects every registered hidden-agent prompt", () => {
        const registrations = buildHiddenAgentRegistrations({
            dreamerPrompt: DREAMER_SYSTEM_PROMPT,
            smartNoteCompilerPrompt: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
            historianPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
            historianRecompPrompt: COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
            historianEditorPrompt: HISTORIAN_EDITOR_SYSTEM_PROMPT,
            sidekickPrompt: SIDEKICK_SYSTEM_PROMPT,
            historianDisallowed: [],
        });

        for (const registration of registrations) {
            expect(registration.prompt, registration.id).toBeString();
            expect(
                isMagicContextInternalAgent(registration.prompt as string),
                registration.id,
            ).toBe(true);
        }
    });

    it("detects every dedicated Magic Context child prompt constant", () => {
        const prompts = [
            ["dreamer-base", DREAMER_SYSTEM_PROMPT],
            ["curate", CURATE_SYSTEM_PROMPT],
            ["maintain-docs", MAINTAIN_DOCS_SYSTEM_PROMPT],
            ["review-user-memories", REVIEW_USER_MEMORIES_SYSTEM_PROMPT],
            ["primer-investigator", PRIMER_INVESTIGATOR_SYSTEM_PROMPT],
            ["map-memories", MAP_MEMORIES_SYSTEM_PROMPT],
            ["verify", VERIFY_SYSTEM_PROMPT],
            ["classify", CLASSIFY_SYSTEM_PROMPT],
            ["smart-note-compiler", SMART_NOTE_COMPILER_SYSTEM_PROMPT],
            ["historian", COMPARTMENT_AGENT_SYSTEM_PROMPT],
            ["historian-recomp", COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT],
            ["historian-editor", HISTORIAN_EDITOR_SYSTEM_PROMPT],
            ["memory-migration", MIGRATION_SYSTEM_PROMPT],
            ["sidekick", SIDEKICK_SYSTEM_PROMPT],
        ] as const;

        for (const [label, prompt] of prompts) {
            expect(isMagicContextInternalAgent(prompt), label).toBe(true);
        }
    });

    it("skips injection via the internalChildSessions flag even when the prompt has no known signature", async () => {
        // Covers the title-prefix detection path: a child whose prompt opener
        // we don't signature-match (e.g. a future MC agent) is still exempt
        // because session.created flagged it by `magic-context-` title.
        useTempDataHome("sph-skip-mc-flag-");
        const sessionId = "ses-mc-flagged";
        const { handler } = buildHandler({
            internalChildSessions: new Set<string>([sessionId]),
        });
        const system = ["Some custom internal prompt with no known opener."];
        await handler({ sessionID: sessionId }, { system });
        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("does NOT update systemPromptHash for internal MC child calls", async () => {
        useTempDataHome("sph-skip-mc-no-hash-");
        const sessionId = "ses-mc-no-hash";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash-xyz" });
        const { handler } = buildHandler();
        await handler({ sessionID: sessionId }, { system: [HISTORIAN_HEAD] });
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe("main-agent-hash-xyz");
    });
});

/**
 * Unit B: subagent self-management. A subagent session (isSubagent=true) with
 * ctx_reduce enabled gets the MINIMAL §N§ + ctx_reduce block — not the full
 * primary block, not the no-reduce block. Internal MC children still skip
 * entirely (order invariant: the internal-child skip runs BEFORE the subagent
 * branch).
 */
describe("system-prompt-hash subagent self-management (Unit B)", () => {
    it("injects the MINIMAL block for a subagent with ctx_reduce enabled", async () => {
        useTempDataHome("sph-subagent-min-");
        const sessionId = "ses-subagent";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        const { handler } = buildHandler();
        const system = ["You are a general-purpose coding subagent."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        // Minimal block: marker + §N§ + ctx_reduce mechanics …
        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("§N§ identifiers");
        expect(joined).toContain("ctx_reduce");
        // … but NONE of the primary's role/guidance.
        expect(joined).not.toContain("long-term partner");
        expect(joined).not.toContain("### Reduction Triggers");
        expect(joined).not.toContain("ctx_memory");
        expect(joined).not.toContain("ctx_search");
    });

    it("injects NO block for a subagent without callable ctx_reduce (no primary-role leak)", async () => {
        useTempDataHome("sph-subagent-denied-");
        const sessionId = "ses-subagent-denied";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        // Tool allow-list denies ctx_reduce: the subagent has no §N§ and no tool
        // to act on, so it must get NO Magic Context block — not the no-reduce
        // PRIMARY block (which would leak the partner frame + memory/search/note
        // guidance).
        clearCtxReduceAvailability(sessionId);
        resolveCtxReduceAvailabilityFromMessages(sessionId, [
            { info: { role: "user", tools: { "*": false, read: true } } },
        ]);
        const { handler } = buildHandler();
        const system = ["You are a general-purpose coding subagent."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).not.toContain("## Magic Context");
        expect(joined).not.toContain("long-term partner");
        expect(joined).not.toContain("ctx_memory");
    });

    it("a PRIMARY (non-subagent) still gets the full long-term-partner block", async () => {
        useTempDataHome("sph-primary-full-");
        const sessionId = "ses-primary-full";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        // isSubagent defaults false.

        const { handler } = buildHandler();
        const system = ["You are the primary coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("long-term partner");
        expect(joined).toContain("ctx_memory");
    });

    it("warns primary sessions about caveman compression even when ctx_reduce is callable", async () => {
        useTempDataHome("sph-primary-caveman-reduce-");
        const sessionId = "ses-primary-caveman-reduce";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler({ experimentalCavemanTextCompression: true });
        const system = ["You are the primary coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).toContain("ctx_reduce");
        expect(joined).toContain("History compression is on");
        expect(joined).toContain("DO NOT mimic this style");
    });

    it("ORDER INVARIANT: an internal MC child that is ALSO marked subagent still skips entirely", async () => {
        useTempDataHome("sph-subagent-internal-");
        const sessionId = "ses-internal-and-subagent";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        const { handler } = buildHandler({
            internalChildSessions: new Set<string>([sessionId]),
        });
        const system = ["Some internal MC prompt."];
        await handler({ sessionID: sessionId }, { system });

        // Internal-child skip wins — no block at all, despite isSubagent=true.
        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });
});

/**
 * Issue #53 regression: users can opt specific agents out of system-prompt
 * injection so Magic Context's `## Magic Context` guidance doesn't tell the
 * LLM to use tools that the user has denied for that agent.
 */
describe("system-prompt-hash honors per-agent opt-out (issue #53)", () => {
    it("skips ALL injection when injectionEnabled=false (global escape hatch)", async () => {
        useTempDataHome("sph-issue53-disabled-");
        const sessionId = "ses-disabled";
        const { handler } = buildHandler({ injectionEnabled: false });

        const system = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe("You are a helpful coding assistant.");
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("skips injection when an agent prompt contains a custom skip signature", async () => {
        useTempDataHome("sph-issue53-skip-sig-");
        const sessionId = "ses-skipsig";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["<!-- magic-context: skip -->"],
        });

        const system = [
            "You are a read-only QA agent.\n<!-- magic-context: skip -->\nDeny all writes.",
        ];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("matches multiple skip signatures (any one match opts the agent out)", async () => {
        useTempDataHome("sph-issue53-multi-sig-");
        const sessionId = "ses-multisig";
        const { handler } = buildHandler({
            injectionSkipSignatures: [
                "<!-- magic-context: skip -->",
                "I AM A TINY SPECIALIZED AGENT",
            ],
        });

        const system = ["I AM A TINY SPECIALIZED AGENT — do nothing else."];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("does NOT skip when skip signatures don't match the prompt", async () => {
        useTempDataHome("sph-issue53-no-match-");
        const sessionId = "ses-nomatch";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["<!-- magic-context: skip -->"],
        });

        const system = ["You are a normal agent without any skip marker."];
        await handler({ sessionID: sessionId }, { system });

        // Injection still happened — guidance was appended.
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
    });

    it("ignores empty skip-signature strings (would otherwise match everything)", async () => {
        // Defensive: an empty string in skip_signatures would make
        // `prompt.includes("")` true for every prompt, silently disabling
        // injection globally. The handler explicitly filters out empty
        // signatures so a misconfiguration can't break injection silently.
        useTempDataHome("sph-issue53-empty-sig-");
        const sessionId = "ses-emptysig";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["", "<!-- magic-context: skip -->"],
        });

        const system = ["You are a normal agent — no skip marker here."];
        await handler({ sessionID: sessionId }, { system });

        // Empty signature ignored, real signature didn't match → guidance injected.
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
    });

    it("does NOT update systemPromptHash for opted-out calls", async () => {
        // Same reasoning as the issue #52 hash-update test: an opted-out
        // agent's system prompt is structurally different from the main
        // agent's, so updating the hash here would cause every later
        // main-agent turn to see a hash-change flush.
        useTempDataHome("sph-issue53-no-hash-update-");
        const sessionId = "ses-issue53-no-hash";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash" });

        const { handler } = buildHandler({ injectionEnabled: false });
        await handler({ sessionID: sessionId }, { system: ["Custom agent prompt"] });

        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).toBe("main-agent-hash");
    });
});

describe("provisional ctx_reduce availability (pre-first-user race)", () => {
    function createOpenCodeDbWithFirstUser(
        dataHome: string,
        sessionId: string,
        tools: Record<string, unknown>,
    ): void {
        const { Database } = require("../../shared/sqlite");
        const { mkdirSync } = require("node:fs");
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const oc = new Database(join(dataHome, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
        ).run("msg-first-user", sessionId, JSON.stringify({ role: "user", tools }));
        oc.close();
    }

    it("does not persist a hash while the availability verdict is provisional", async () => {
        // A system pass can run BEFORE the session's first user message is
        // persisted to opencode.db. The availability verdict is then a
        // provisional fail-open true; persisting a hash computed from the
        // reduce-enabled guidance variant would flip (hash change → flush →
        // HARD fold) as soon as the real first user message denies the tool.
        const dir = mkdtempSync(join(tmpdir(), "sph-provisional-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const { mkdirSync } = require("node:fs");
        const { Database } = require("../../shared/sqlite");
        mkdirSync(join(dir, "opencode"), { recursive: true });
        // opencode.db exists but has NO first-user row for this session yet.
        const oc = new Database(join(dir, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.close();

        const sessionId = "ses-provisional";
        clearCtxReduceAvailability(sessionId);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler();
        const system = ["Base agent prompt"];
        await handler({ sessionID: sessionId }, { system });

        // Guidance still renders (a prompt must go out)...
        expect(system.join("\n")).toContain("## Magic Context");
        // ...but no hash baseline is written from the provisional variant.
        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash === "" || meta.systemPromptHash === "0").toBe(true);
    });

    it("persists the hash from the frozen deny-verdict variant once the first user row exists", async () => {
        const dir = mkdtempSync(join(tmpdir(), "sph-frozen-deny-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;

        const sessionId = "ses-frozen-deny";
        clearCtxReduceAvailability(sessionId);
        createOpenCodeDbWithFirstUser(dir, sessionId, { "*": false, read: true });

        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler();
        const system = ["Base agent prompt"];
        await handler({ sessionID: sessionId }, { system });

        // Deny-list session: the no-reduce guidance variant renders...
        const joined = system.join("\n");
        expect(joined).toContain("## Magic Context");
        expect(joined).not.toContain("ctx_reduce");
        // ...and the hash IS persisted (frozen verdict owns the baseline).
        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).not.toBe("");
        expect(meta.systemPromptHash).not.toBe("0");
    });
});
