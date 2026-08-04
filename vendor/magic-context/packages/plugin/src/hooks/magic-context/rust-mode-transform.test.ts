/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    type AuthorityStatus,
    getAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { getChannel2NudgeState, setChannel2NudgeState } from "../../features/magic-context/storage";
import { initializeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import {
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import {
    scheduleOpenCodeTransformDecisionWrite,
    __test as transformDecisionTest,
} from "../../features/magic-context/transform-decision-log";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { getSlot } from "./lkg-slot";
import { MODULE_PAGE_MAX_BYTES } from "./module-wire";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    __rustModeTransformTest,
    createRustModeTransform as createRustModeTransformImpl,
    type RustModeModuleClient,
} from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import { createTransform } from "./transform";
import type { MessageLike } from "./transform-operations";

const createRustModeTransform = (
    deps: TransformDeps,
    options: Parameters<typeof createRustModeTransformImpl>[1],
) =>
    createRustModeTransformImpl(deps, {
        ...options,
        allowAuthorityProtocolBypassForTests: true,
    });

const sessions: string[] = [];
const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
const availabilityDataHomes: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

type LegacySnapshotField = string | number | boolean | symbol;

function legacyMessageContentFields(
    value: unknown,
    fields: LegacySnapshotField[] = [],
): LegacySnapshotField[] {
    const tags = __rustModeTransformTest.snapshotTags;
    if (value === null) fields.push(tags.null);
    else if (typeof value === "string") fields.push(tags.string, value);
    else if (typeof value === "number") fields.push(tags.number, value);
    else if (typeof value === "boolean") fields.push(tags.boolean, value);
    else if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        fields.push(tags.undefined);
    } else if (Array.isArray(value)) {
        fields.push(tags.array, value.length);
        for (const item of value) legacyMessageContentFields(item, fields);
    } else if (typeof value === "object") {
        const entries = Object.entries(value).filter(
            ([, child]) =>
                child !== undefined && typeof child !== "function" && typeof child !== "symbol",
        );
        fields.push(tags.object, entries.length);
        for (const [key, child] of entries) {
            fields.push(tags.key, key);
            legacyMessageContentFields(child, fields);
        }
    } else fields.push(tags.undefined);
    return fields;
}

function sameSnapshotFields(
    left: readonly LegacySnapshotField[],
    right: readonly LegacySnapshotField[],
): boolean {
    return (
        left.length === right.length && left.every((field, index) => Object.is(field, right[index]))
    );
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function randomText(random: () => number, length: number): string {
    let text = "";
    for (let index = 0; index < length; index += 1) {
        text += String.fromCharCode(97 + Math.floor(random() * 26));
    }
    return text;
}

afterEach(() => {
    closeReadOnlySessionDb();
    transformDecisionTest.reset();
    resetEmergencyRecoveryRegistryForTest();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const dataHome of availabilityDataHomes.splice(0)) {
        rmSync(dataHome, { recursive: true, force: true });
    }
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function makeDb(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function makeFileDb(): ContextDatabase {
    const directory = mkdtempSync(join(tmpdir(), "rust-mode-context-"));
    availabilityDataHomes.push(directory);
    const db = openDatabase(join(directory, "context.db")) as ContextDatabase | null;
    if (!db) throw new Error("file-backed test database did not open");
    databases.push(db);
    return db;
}

function installRawProvider(sessionId: string): void {
    const row = {
        id: "m1",
        timeCreated: 1,
        contributesOrdinal: true,
        hasValidInfo: true,
    };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) =>
                !after || row.timeCreated > after.timeCreated || row.id > after.id
                    ? [row].slice(0, limit)
                    : [],
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "hello" }],
                createdAt: 1,
            }),
        }),
    );
}

function makeMessages(sessionId: string): MessageLike[] {
    return [
        {
            info: { id: "m1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "hello" }],
        },
    ];
}

function makeDeps(db: ContextDatabase, moduleClient: RustModeModuleClient): TransformDeps {
    return {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTags: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map(),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        rustModeAllowAuthorityProtocolBypassForTests: true,
    };
}

function makeMeta(
    db: ContextDatabase,
    sessionId: string,
): ReturnType<typeof getOrCreateSessionMeta> {
    return getOrCreateSessionMeta(db, sessionId);
}

function installAvailabilityDb(sessionId: string, firstUserTools?: Record<string, unknown>): void {
    const dataHome = mkdtempSync(join(tmpdir(), "rust-mode-availability-"));
    availabilityDataHomes.push(dataHome);
    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const opencodeDb = new Database(dbPath);
    opencodeDb.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    if (firstUserTools !== undefined) {
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
                "availability-user",
                sessionId,
                1,
                1,
                JSON.stringify({ id: "availability-user", role: "user", tools: firstUserTools }),
            );
    }
    closeQuietly(opencodeDb);
    process.env.XDG_DATA_HOME = dataHome;
}

function authoritySeqMismatch(durableSeq: number): Error & {
    code: string;
} {
    const error = new Error(
        JSON.stringify({
            code: "authority_seq_mismatch",
            durable_authority_seq: durableSeq,
        }),
    ) as Error & { code: string };
    error.code = "authority_seq_mismatch";
    return error;
}

describe("Rust mode authority adapter", () => {
    it("uses the resolved session directory instead of the plugin launch directory for authority routes", async () => {
        const sessionId = "ses-directory-root";
        installRawProvider(sessionId);
        const db = makeDb();
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'seed me', 'seed-hash', 0, 0, 0, 0)",
            ).run("git:identity");
        });
        const authorityRoots: string[] = [];
        const statuses = new Map<string, AuthorityStatus>();
        const module: RustModeModuleClient = {
            call: async () => {
                throw new Error("stop after authority preparation");
            },
            authorityStatus: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return { authority: statuses.get(args.domain) ?? null };
            },
            authorityPrepare: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                const domain = String(args.domain) as "memories" | "notes";
                const phase = String(args.phase);
                const base = {
                    context_store_uuid: String(args.context_store_uuid),
                    project: String(args.project),
                    domain,
                    generation: 1,
                };
                if (phase === "begin") {
                    const authority = { ...base, state: "PREPARING" as const };
                    statuses.set(domain, authority);
                    return { authority };
                }
                if (phase === "complete") {
                    const checksum = String(args.checksum_expected);
                    const authority = {
                        ...base,
                        state: "PREPARING" as const,
                        checksum_expected: checksum,
                        checksum_actual: checksum,
                        checksum_ok: true,
                    };
                    statuses.set(domain, authority);
                    return { authority };
                }
                if (phase === "ack") {
                    const authority = { ...base, state: "MODULE" as const };
                    statuses.set(domain, authority);
                    return { authority };
                }
                const authority = { ...base, state: "TS" as const };
                statuses.set(domain, authority);
                return { authority };
            },
            authoritySeed: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                const rows = Array.isArray(args.rows) ? args.rows : [];
                return { seeded: rows.length, module_row_ids: rows.map((_, index) => index + 1) };
            },
            mirrorPull: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: args.cursor,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };
        const deps = makeDeps(db, module);
        deps.directory = "/launch/root-a";
        deps.projectPath = "git:identity";
        deps.sessionDirectoryBySession?.set(sessionId, "/session/root-b");
        const runner = createRustModeTransformImpl(deps, { moduleClient: module });
        const messages = makeMessages(sessionId);

        await runner.run(sessionId, messages, { messages: [...messages] }, makeMeta(db, sessionId));

        expect(authorityRoots.length).toBeGreaterThan(0);
        expect(authorityRoots.every((root) => root === "/session/root-b")).toBe(true);
    });

    it("copies the resolved history budget onto the authority wire", () => {
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "budget-wire",
            input: [],
            nativeMessages: [],
            passInputs: { history_budget_tokens: 42_000 },
            usage: {},
            modelKey: null,
            providerId: null,
            midTurn: false,
        });
        expect(body.history_budget_tokens).toBe(42_000);
    });

    it("copies caveman settings onto the authority wire", () => {
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "caveman-wire",
            input: [],
            nativeMessages: [],
            passInputs: { caveman_enabled: true, caveman_min_chars: 240 },
            usage: {},
            modelKey: null,
            providerId: null,
            midTurn: false,
        });
        expect(body.caveman_enabled).toBe(true);
        expect(body.caveman_min_chars).toBe(240);
    });

    it("keeps the rust pass line grep-compatible", () => {
        expect(
            __rustModeTransformTest.formatRustPassLog({
                decision: "HARD",
                reason: "first_render",
                servedFrom: "transform",
                inputCount: 4,
                outputCount: 3,
                applied: true,
                elapsedMs: 12.345,
                moduleElapsedMs: 8.765,
            }),
        ).toBe(
            "rust pass: decision=HARD reason=first_render served_from=transform in=4 out=3 applied=true elapsed=12.3 ms module=8.8 ms stages=prefix_guard:0.0 ordinal_resolve:0.0 state_sync:0.0 clone:0.0 wire_build:0.0 wire_messages:0 transport:0.0 transport_pages:0 transport_bytes:0 apply:0.0 lkg_snapshot:0.0 other:12.3",
        );
    });

    it("walks an armed low-usage Rust recovery through a forced fold and durable disarm", async () => {
        const sessionId = `rust-overflow-recovery-${Date.now()}`;
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Record<string, unknown>[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(body);
                return transformBodies.length === 1
                    ? { native_messages: makeMessages(sessionId), decision: "PASSTHROUGH" }
                    : {
                          native_messages: makeMessages(sessionId),
                          decision: "HARD",
                          materialize_reason: "overflow_recovery_fold",
                      };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 30_000, percentage: 30 },
            updatedAt: Date.now(),
        });
        const runner = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        await runner.run(sessionId, messages, { messages }, makeMeta(db, sessionId));

        recordOverflowDetected(db, sessionId, 100_000, "test/model");
        const recoveryMessages = makeMessages(sessionId);
        await runner.run(
            sessionId,
            recoveryMessages,
            { messages: recoveryMessages },
            makeMeta(db, sessionId),
        );

        expect(transformBodies).toHaveLength(2);
        expect(transformBodies[1]?.emergency_recovery_armed).toBe(true);
        expect(transformBodies[1]?.tail_delta).toBeUndefined();
        expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(false);
    });

    it("binds every served Rust pass class to the provider assistant decision row", async () => {
        const db = makeFileDb();
        const bindProviderAssistant = async (sessionId: string, messageId: string) => {
            expect(
                scheduleOpenCodeTransformDecisionWrite({
                    db,
                    sessionId,
                    messageId,
                    inputTokens: 123,
                }),
            ).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 5));
        };

        const classifierSession = `rust-decisions-${Date.now()}`;
        sessions.push(classifierSession);
        installRawProvider(classifierSession);
        const responses = [
            { decision: "HARD", materialize_reason: "first_render" },
            { decision: "SOFT", materialize_reason: "m1_delta" },
            { decision: "SOFT+" },
            { decision: "PASSTHROUGH" },
        ];
        const classifierClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? { ...responses.shift(), native_messages: [] }
                    : { ok: true },
        };
        const classifierDeps = makeDeps(db, classifierClient);
        classifierDeps.contextUsageMap.set(classifierSession, {
            usage: { inputTokens: 123, percentage: 1 },
            updatedAt: Date.now(),
        });
        const classifierTransform = createRustModeTransform(classifierDeps, {
            moduleClient: classifierClient,
        });
        for (let index = 0; index < 4; index += 1) {
            const messages = makeMessages(classifierSession);
            await classifierTransform.run(
                classifierSession,
                messages,
                { messages },
                makeMeta(db, classifierSession),
            );
            await bindProviderAssistant(classifierSession, `classifier-response-${index}`);
        }

        const failureSession = `rust-decision-errors-${Date.now()}`;
        sessions.push(failureSession);
        installRawProvider(failureSession);
        const failureClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("daemon unavailable");
                return { ok: true };
            },
        };
        const failureTransform = createRustModeTransform(makeDeps(db, failureClient), {
            moduleClient: failureClient,
        });
        for (let index = 0; index < 3; index += 1) {
            const messages = makeMessages(failureSession);
            await failureTransform.run(
                failureSession,
                messages,
                { messages },
                makeMeta(db, failureSession),
            );
            await bindProviderAssistant(failureSession, `error-response-${index}`);
        }
        const parkedMessages = makeMessages(failureSession);
        await failureTransform.run(
            failureSession,
            parkedMessages,
            { messages: parkedMessages },
            makeMeta(db, failureSession),
        );
        await bindProviderAssistant(failureSession, "parked-response");

        const fullSyncSession = `rust-decision-full-sync-${Date.now()}`;
        sessions.push(fullSyncSession);
        installRawProvider(fullSyncSession);
        const fullSyncClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform" ? { status: "need_full_sync" } : { ok: true },
        };
        const fullSyncTransform = createRustModeTransform(makeDeps(db, fullSyncClient), {
            moduleClient: fullSyncClient,
        });
        const fullSyncMessages = makeMessages(fullSyncSession);
        await fullSyncTransform.run(
            fullSyncSession,
            fullSyncMessages,
            { messages: fullSyncMessages },
            makeMeta(db, fullSyncSession),
        );
        await bindProviderAssistant(fullSyncSession, "full-sync-response");

        expect(
            db
                .prepare(
                    "SELECT message_id, decision, materialized, materialize_reason FROM transform_decisions ORDER BY rowid",
                )
                .all(),
        ).toEqual([
            {
                message_id: "classifier-response-0",
                decision: "execute",
                materialized: 1,
                materialize_reason: "first_render",
            },
            {
                message_id: "classifier-response-1",
                decision: "execute",
                materialized: 0,
                materialize_reason: "m1_delta",
            },
            {
                message_id: "classifier-response-2",
                decision: "defer",
                materialized: 0,
                materialize_reason: null,
            },
            {
                message_id: "classifier-response-3",
                decision: "passthrough",
                materialized: 0,
                materialize_reason: null,
            },
            ...Array.from({ length: 3 }, (_, index) => ({
                message_id: `error-response-${index}`,
                decision: "error",
                materialized: 0,
                materialize_reason: null,
            })),
            {
                message_id: "parked-response",
                decision: "parked",
                materialized: 0,
                materialize_reason: null,
            },
            {
                message_id: "full-sync-response",
                decision: "need_full_sync",
                materialized: 0,
                materialize_reason: null,
            },
        ]);
    });

    it("adopts a durable sequence from a fresh process and retries the sync", async () => {
        const sessionId = `rust-adopt-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const native = [{ role: "assistant", parts: [{ type: "text", text: "module output" }] }];
        const methods: string[] = [];
        let firstSync = true;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                methods.push(method);
                if (method === "state_sync" && firstSync) {
                    firstSync = false;
                    throw authoritySeqMismatch(5);
                }
                return method === "transform" ? { native_messages: native } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        expect(methods).toEqual(["state_sync", "state_sync", "transform"]);
        expect(transform.getState(sessionId).lastAckedSeq).toBe(6);
        expect(transform.getState(sessionId).lastAckedWatermarks).not.toBeNull();
        expect(output.messages).toEqual(native);
    });

    it("re-sends a full seed after historian busy while still applying the transform", async () => {
        const sessionId = `rust-seed-busy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const stateSyncBodies: Array<Record<string, unknown>> = [];
        let rejectSeed = true;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "state_sync") {
                    stateSyncBodies.push(body as Record<string, unknown>);
                    if (rejectSeed) {
                        rejectSeed = false;
                        throw Object.assign(new Error("historian owns compartment snapshot"), {
                            code: "historian_compartment_sync_busy",
                        });
                    }
                    return { ok: true };
                }
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: makeMessages(sessionId) }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const firstInput = makeMessages(sessionId);

        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        expect(transform.getState(sessionId).initialized).toBe(false);
        expect(transform.getState(sessionId).seedPassPending).toBe(true);

        const secondInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            secondInput,
            { messages: [...secondInput] },
            makeMeta(db, sessionId),
        );

        expect(stateSyncBodies).toHaveLength(2);
        expect(stateSyncBodies.every((body) => "seed_id" in body)).toBe(true);
        expect(transform.getState(sessionId).initialized).toBe(true);
        expect(transform.getState(sessionId).seedPassPending).toBe(false);
    });

    it("fails after the second authority mismatch in one transform pass", async () => {
        const sessionId = `rust-adopt-once-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        const methods: string[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                methods.push(method);
                if (method === "state_sync") throw authoritySeqMismatch(4);
                return { native_messages: [] };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        expect(methods).toEqual(["state_sync", "state_sync"]);
        expect(transform.getState(sessionId).lastAckedSeq).toBe(4);
        expect(transform.getState(sessionId).lastAckedWatermarks).toBeNull();
        expect(output.messages).toBe(messages);
    });

    it("gates the transform before any TypeScript mutation", async () => {
        const sessionId = `rust-gate-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const native = [{ role: "user", parts: [{ type: "text", text: "unchanged" }] }];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform" ? { native_messages: native } : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createTransform(deps);
        const output = { messages: input as unknown[] };
        await transform({}, output);
        expect(output.messages).toEqual(native);
        expect(input).toEqual(native);
    });

    it("applies module output through the OpenCode hook array reference", async () => {
        const sessionId = `rust-hook-array-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const native = [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "<project-docs>m0</project-docs>", synthetic: true }],
            },
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "tail" }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          action: "CACHE_HIT",
                          served_from: "transform",
                          boundary_id: "m1#0",
                          native_messages: native,
                      }
                    : { ok: true },
        };
        const transform = createTransform(makeDeps(db, moduleClient));
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": transform as never,
            },
        });
        const output = { messages: input as unknown[] };
        const callerHeldMessages = output.messages;

        const returned = await handler({}, output as never);

        expect(returned).toEqual(native);
        expect(output.messages).toEqual(native);
        expect(callerHeldMessages).toEqual(native);
        expect(output.messages).toBe(callerHeldMessages);
    });

    it("fails the pass when a present boundary lacks a synthetic session-scoped m0", async () => {
        const sessionId = `rust-wire-invariant-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          action: "CACHE_HIT",
                          served_from: "transform",
                          boundary_id: "m1#0",
                          native_messages: [
                              {
                                  info: { role: "user", sessionID: sessionId },
                                  parts: [{ type: "text", text: "not marked synthetic" }],
                              },
                          ],
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: input as unknown[] };

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toBe(input);
        expect(output.messages[0]).toEqual(input[0]);
        expect(transform.getState(sessionId).failureCount).toBe(1);
    });

    it("seeds before the first transform and applies native output verbatim", async () => {
        const sessionId = `rust-seed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const native = [{ role: "user", parts: [{ type: "text", text: "module output" }] }];
        const methods: string[] = [];
        let transformRequest: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                methods.push(method);
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform" ? { native_messages: native } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
        expect(methods).toEqual(["state_sync", "transform"]);
        expect(transformRequest?.serve_native).toBe(true);
        expect(transformRequest?.tool_present).toBe(true);
        expect(transformRequest?.native_messages).toBe(messages);
        expect(Array.isArray(transformRequest?.messages)).toBe(true);
        expect(output.messages).toEqual(native);

        methods.length = 0;
        const secondInput = makeMessages(sessionId);
        const secondOutput = { messages: secondInput as unknown[] };
        await transform.run(sessionId, secondInput, secondOutput, makeMeta(db, sessionId));
        expect(methods).toEqual(["transform"]);
        expect(transformRequest?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: 1,
            native_replace_from: 1,
        });
        expect((transformRequest?.messages as unknown[]).length).toBe(0);
        expect((transformRequest?.native_messages as unknown[]).length).toBe(0);
        expect(secondOutput.messages).toEqual(native);
    });

    it("preserves the receiver for a class-backed compartment mirror client", async () => {
        const sessionId = `rust-class-compartments-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);

        class ClassBackedModuleClient {
            private readonly title = "receiver-bound compartment";

            async call({ method }: Parameters<RustModeModuleClient["call"]>[0]) {
                return method === "transform" ? { native_messages: [] } : { ok: true };
            }

            async getCompartmentsAfter(_sessionId: string, _afterSequence: number) {
                if (this.title !== "receiver-bound compartment") {
                    throw new Error("class receiver was detached");
                }
                return {
                    max_sequence: 1,
                    compartments: [
                        {
                            sequence: 1,
                            start_message: 0,
                            end_message: 0,
                            start_message_id: "m1",
                            end_message_id: "m1",
                            title: this.title,
                            content: "summary",
                        },
                    ],
                };
            }
        }

        const moduleClient: RustModeModuleClient = new ClassBackedModuleClient();
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );

        expect(
            db.prepare("SELECT title FROM compartments WHERE session_id = ?").get(sessionId),
        ).toEqual({ title: "receiver-bound compartment" });
    });

    it("sends tool_present false while availability remains provisional", async () => {
        const sessionId = `rust-availability-provisional-${Date.now()}`;
        sessions.push(sessionId);
        installAvailabilityDb(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform" ? { native_messages: [] } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages: MessageLike[] = [
            {
                info: { id: "m1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "assistant" }],
            },
        ];

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(requestBodies).toHaveLength(1);
        expect(requestBodies[0]?.tool_present).toBe(false);
    });

    it("defers a repeated module directive until the terminal boundary", async () => {
        const sessionId = `rust-channel2-refire-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const native = [{ role: "assistant", parts: [] }];
        const promptAsync = mock(async () => ({}));
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          native_messages: native,
                          host_directives: {
                              channel2_nudge: { text: "drop spent tool output" },
                          },
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            hostClient: {
                session: {
                    messages: async () => ({ data: [] }),
                    promptAsync,
                },
            },
        });

        const firstInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            firstInput,
            { messages: firstInput },
            makeMeta(db, sessionId),
        );

        const syntheticInput = [
            ...makeMessages(sessionId),
            {
                info: { id: "channel2-nudge-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "drop spent tool output", synthetic: true }],
            },
        ];
        await transform.run(
            sessionId,
            syntheticInput,
            { messages: syntheticInput },
            makeMeta(db, sessionId),
        );

        expect(getChannel2NudgeState(db, sessionId)).toBe("");
        expect(promptAsync).not.toHaveBeenCalled();
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(1);
    });

    it("breaks a synthetic-turn cascade after three turns", async () => {
        const sessionId = `rust-loop-breaker-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const promptAsync = mock(async () => ({}));
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          native_messages: [{ role: "assistant", parts: [] }],
                          host_directives: {
                              channel2_nudge: { text: "drop spent tool output" },
                          },
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            hostClient: {
                session: {
                    messages: async () => ({ data: [] }),
                    promptAsync,
                },
            },
        });

        for (let turn = 1; turn <= 4; turn += 1) {
            setChannel2NudgeState(db, sessionId, "pending");
            const input = [
                ...makeMessages(sessionId),
                {
                    info: { id: `synthetic-${turn}`, role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "synthetic turn", synthetic: true }],
                },
            ];
            await transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId));
        }

        expect(promptAsync).toHaveBeenCalledTimes(0);
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(4);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");

        setChannel2NudgeState(db, sessionId, "pending");
        const realInput = makeMessages(sessionId);
        await transform.run(sessionId, realInput, { messages: realInput }, makeMeta(db, sessionId));
        expect(promptAsync).toHaveBeenCalledTimes(0);
        expect(getChannel2NudgeState(db, sessionId)).toBe("pending");
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(0);
    });

    it("re-pages every transform payload after need_full_sync", async () => {
        const sessionId = `rust-repage-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
        const native = [{ role: "assistant", parts: [] }];
        const transformBodies: Array<Record<string, unknown>> = [];
        let retryStarted = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformBodies.push(page);
                if (!retryStarted && page.transform_page_complete === true) {
                    retryStarted = true;
                    return { status: "need_full_sync" };
                }
                return { native_messages: native };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: messages as unknown[] };
        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        const pageIds = new Set(transformBodies.map((body) => body.transform_page_id));
        expect(pageIds.size).toBe(2);
        expect(transformBodies.length).toBeGreaterThan(2);
        expect(
            transformBodies.every((body) =>
                [
                    "transform_page_id",
                    "transform_generation",
                    "transform_page_index",
                    "transform_page_total",
                    "transform_page_complete",
                    "transform_page_digest",
                ].every((field) => field in body),
            ),
        ).toBe(true);
        expect(transformBodies.at(-1)?.tool_present).toBe(true);
        expect(output.messages).toEqual(native);
    });

    it("re-primes all ordinal memo state after a durable message removal", async () => {
        const sessionId = `rust-removal-reprime-${Date.now()}`;
        sessions.push(sessionId);
        const rows = [
            { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true },
            { id: "m2", timeCreated: 2, contributesOrdinal: true, hasValidInfo: true },
        ];
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") transformCalls += 1;
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: [] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = () =>
            rows.map((row) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: row.id }],
            }));
        const initial = messages();
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );

        rows.splice(1, 1);
        const afterRemoval = messages();
        await transform.run(
            sessionId,
            afterRemoval,
            { messages: [...afterRemoval] },
            makeMeta(db, sessionId),
        );

        expect(transformCalls).toBe(2);
        expect(transform.getState(sessionId).ordinalMemoStoredCount).toBe(1);
        expect(transform.getState(sessionId).ordinalMemoCanonicalCount).toBe(1);
        expect(transform.getState(sessionId).idOrdinalMemo).toEqual(new Map([["m1", 1]]));
    });

    it("clears Rust state, wire caches, and the transport route for a deleted session", async () => {
        const sessionId = `rust-clear-session-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        const closeSession = mock(() => {});
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformBodies.push(body as Record<string, unknown>);
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: [] }
                    : { ok: true };
            },
            closeSession,
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        for (let pass = 0; pass < 2; pass += 1) {
            const input = makeMessages(sessionId);
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
        }
        expect(transformBodies[1]?.tail_delta).toBeDefined();

        transform.clearSession(sessionId);
        expect(closeSession).toHaveBeenCalledWith(sessionId);
        const afterClear = makeMessages(sessionId);
        await transform.run(
            sessionId,
            afterClear,
            { messages: [...afterClear] },
            makeMeta(db, sessionId),
        );

        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[2]?.messages).toHaveLength(1);
        expect(transform.getState(sessionId).passCount).toBe(1);
    });

    it("keeps a 1,000-message steady-state pass under the adapter budget", async () => {
        const sessionId = `rust-wire-delta-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 1_000 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform" ? { native_messages: [] } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = rows.map((row) => ({
            info: { id: row.id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: `message ${row.id}` }],
        }));
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        const steadyStartedAt = performance.now();
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        const steadyElapsed = performance.now() - steadyStartedAt;

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[0]?.messages).toHaveLength(1_000);
        expect(requestBodies[1]?.messages).toHaveLength(0);
        expect(requestBodies[1]?.native_messages).toHaveLength(0);
        expect(requestBodies[1]?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: 1_000,
            native_replace_from: 1_000,
        });
        expect(Buffer.byteLength(JSON.stringify(requestBodies[1]))).toBeLessThan(
            MODULE_PAGE_MAX_BYTES,
        );
        expect(steadyElapsed).toBeLessThan(100);
    });

    it("keeps a multi-frame tail delta paged instead of rebuilding the full wire", async () => {
        const sessionId = `rust-wire-paged-delta-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 3 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                requestBodies.push(body as Record<string, unknown>);
                return { decision: "PASSTHROUGH", native_messages: [] };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = () =>
            rows.map((row, index) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text:
                            index === rows.length - 1 && rows.length === 4
                                ? `large delta ${"x".repeat(350 * 1024)}`
                                : `message ${row.id}`,
                    },
                ],
            }));

        const initial = buildMessages();
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );
        rows.push({
            id: "m-4",
            timeCreated: 4,
            contributesOrdinal: true,
            hasValidInfo: true,
        });
        const appended = buildMessages();
        await transform.run(
            sessionId,
            appended,
            { messages: [...appended] },
            makeMeta(db, sessionId),
        );

        const deltaPages = requestBodies.filter((body) => "transform_page_id" in body);
        expect(deltaPages.length).toBeGreaterThan(1);
        expect(
            deltaPages.every(
                (page) => Buffer.byteLength(JSON.stringify(page)) <= MODULE_PAGE_MAX_BYTES,
            ),
        ).toBe(true);
        const finalPage = deltaPages.at(-1)!;
        expect(finalPage.tail_delta).toEqual({
            after: requestBodies[0]?.full_array_fingerprint,
            replace_from: 2,
            native_replace_from: 2,
        });
        const pagedWire = JSON.stringify(deltaPages);
        expect(pagedWire).not.toContain("message m-1");
        expect(pagedWire).not.toContain("message m-2");
        expect(pagedWire).toContain("message m-3");
        expect(pagedWire).toContain("large delta");
    });

    it("serves raw instead of stale LKG after a stable-id content mutation", async () => {
        const sessionId = `rust-lkg-content-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "captured stale content" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeDefined();

        (input[0]?.parts[0] as { text: string }).text = "same id, current content";
        failTransform = true;
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toEqual(input);
        expect((output.messages[0] as MessageLike).parts[0]).toEqual({
            type: "text",
            text: "same id, current content",
        });
        expect(getSlot(sessionId)).toBeUndefined();
    });

    it("drops the prior LKG slot when a successful cache-bust refresh is over budget", async () => {
        const sessionId = `rust-lkg-refresh-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                return {
                    decision: "HARD",
                    native_messages: [
                        {
                            role: "assistant",
                            parts: [
                                {
                                    type: "text",
                                    text:
                                        pass === 1
                                            ? "small capture"
                                            : "x".repeat(12 * 1024 * 1024 + 1_000),
                                },
                            ],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const firstInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        expect(getSlot(sessionId)).toBeDefined();

        const secondInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            secondInput,
            { messages: [...secondInput] },
            makeMeta(db, sessionId),
        );

        expect(getSlot(sessionId)).toBeUndefined();
    });

    it("passes through raw input, parks after three failures, then probes on the fifth pass", async () => {
        const sessionId = `rust-failure-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let shouldFail = true;
        let transformCalls = 0;
        let toastCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") transformCalls += 1;
                if (shouldFail) throw new Error("daemon unavailable");
                return method === "transform"
                    ? { native_messages: [{ role: "assistant", parts: [] }] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            notifyParked: () => {
                toastCalls += 1;
            },
        });
        for (let pass = 1; pass <= 3; pass += 1) {
            const input = makeMessages(sessionId);
            const output = { messages: input as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(output.messages).toBe(input);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(toastCalls).toBe(1);
        shouldFail = false;
        for (let pass = 0; pass < 2; pass += 1) {
            const input = makeMessages(sessionId);
            const output = { messages: input as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            if (pass === 0) expect(output.messages).toBe(input);
            else expect(output.messages).toEqual([{ role: "assistant", parts: [] }]);
        }
        expect(transform.getState(sessionId).parked).toBe(false);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
        expect(transform.getState(sessionId).warningSent).toBe(false);
        expect(transformCalls).toBe(1);
    });

    it("retries the module on every parked pass at emergency pressure", async () => {
        const sessionId = `rust-park-pressure-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") {
                    transformCalls += 1;
                    throw new Error("daemon unavailable");
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 90_000, percentage: 90 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });

        for (let pass = 0; pass < 3; pass += 1) {
            const input = makeMessages(sessionId);
            await transform.run(
                sessionId,
                input,
                { messages: input as unknown[] },
                makeMeta(db, sessionId),
            );
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(transformCalls).toBe(3);

        const input = makeMessages(sessionId);
        await transform.run(
            sessionId,
            input,
            { messages: input as unknown[] },
            makeMeta(db, sessionId),
        );
        expect(transformCalls).toBe(4);
        expect(transform.getState(sessionId).parked).toBe(true);
    });

    it("fails closed on failures one through three above 95% of a provider-proven limit", async () => {
        const sessionId = `rust-park-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const modelKey = "test-provider/test-model";
        recordDetectedContextLimit(db, sessionId, 100_000, modelKey);
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") {
                    transformCalls += 1;
                    throw new Error("daemon unavailable");
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 96_000, percentage: 96 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ] as MessageLike[];

        for (let pass = 1; pass <= 3; pass += 1) {
            const output = { messages: [...input] as unknown[] };
            await expect(
                transform.run(sessionId, input, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toEqual(input);
            expect(transformCalls).toBe(pass);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
    });

    it("keeps below-95 failures on the existing fallback ladder", async () => {
        const sessionId = `rust-below-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 100_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("daemon unavailable");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 94_000, percentage: 94 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ] as MessageLike[];
        const output = { messages: [...input] as unknown[] };

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toEqual(input);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("aborts an overflow-armed failure instead of falling through refused LKG to raw", async () => {
        const sessionId = `rust-overflow-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    native_messages: [
                        { role: "assistant", parts: [{ type: "text", text: "lkg" }] },
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 30_000, percentage: 30 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "current raw" }],
            },
        ] as MessageLike[];
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeDefined();
        recordOverflowDetected(db, sessionId, 100_000, "test-provider/test-model");
        failTransform = true;
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(output.messages).toEqual(input);
    });

    it("aborts after a fresh repeated provider overflow when the provider reports no limit", async () => {
        const sessionId = `rust-overflow-unknown-repeat-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, undefined);
        resetEmergencyRecoveryRegistryForTest();
        expect(getOverflowState(db, sessionId)).toMatchObject({
            detectedContextLimit: 0,
            needsEmergencyRecovery: true,
            emergencyRecoveryOrigin: "provider_overflow",
        });
        // The second observation models a provider overflow event arriving while recovery
        // from the first rejection is still durably armed.
        recordOverflowDetected(db, sessionId, undefined);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("adapter validation failed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 95_000, percentage: 95 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(output.messages).toEqual(input);
    });

    it("does not treat the first unknown-limit overflow arm as repeated provider proof", async () => {
        const sessionId = `rust-overflow-unknown-first-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, undefined);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("adapter validation failed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 95_000, percentage: 95 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toEqual(input);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("refuses an LKG prefix plus pristine tail that exceeds the current limit", async () => {
        const sessionId = `rust-lkg-limit-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "cached compact prefix" }],
                        },
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 100, percentage: 10 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const firstInput = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "current prefix" }],
            },
        ] as MessageLike[];
        const firstMeta = makeMeta(db, sessionId);
        firstMeta.systemPromptTokens = 100;
        await transform.run(sessionId, firstInput, { messages: [...firstInput] }, firstMeta);
        expect(getSlot(sessionId)).toBeDefined();

        const appended = [
            ...firstInput,
            {
                info: { id: "m2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: randomText(seededRandom(42), 20_000) }],
            },
        ] as MessageLike[];
        failTransform = true;
        const output = { messages: [...appended] as unknown[] };
        const failureMeta = makeMeta(db, sessionId);
        failureMeta.systemPromptTokens = 100;
        await transform.run(sessionId, appended, output, failureMeta);

        expect(output.messages).toEqual(appended);
        expect((output.messages[0] as MessageLike).parts[0]).toEqual({
            type: "text",
            text: "current prefix",
        });
    });
});

describe("prepareRustMemoryAuthority mixed restore", () => {
    it("resumes a schema-57 DRAINING restart through the real prepare path", async () => {
        const db = makeDb();
        const projectPath = "git:schema-57-restart";
        const projectRoot = "/worktrees/schema-57-restart";
        db.exec(`
            DROP TABLE mirror_live_staging;
            DROP TABLE mirror_resnapshot_state;
            DROP TABLE mirror_live_memory_rows;
            DELETE FROM schema_migrations WHERE version >= 58;
        `);
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, ?, 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
            ).run(projectPath);
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/legacy', 100, 9395)",
            ).run();
            db.prepare(
                "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
            ).run();
        });
        runMigrations(db);
        db.prepare(
            "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
        ).run();
        db.prepare(
            "INSERT INTO mirror_live_staging VALUES ('abandoned', '/stale', 1, 'CONSTRAINTS', 'stale', NULL)",
        ).run();

        const calls: Array<{ liveOnly?: boolean; cursor: number }> = [];
        const statuses = new Map<string, AuthorityStatus | null>([
            [
                "memories",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "memories",
                    state: "DRAINING",
                    generation: 3,
                    captured_upper_bound: 21,
                    coordinator_token: "restart-token",
                },
            ],
            [
                "notes",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "notes",
                    state: "TS",
                    generation: 1,
                },
            ],
        ]);
        const memoryRow = (id: number, sourceProject: string) => ({
            id,
            project_path: sourceProject,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => ({ authority: statuses.get(args.domain) ?? null }),
            authorityPrepare: async () => {
                throw new Error("prepare should not run during DRAINING recovery");
            },
            authoritySeed: async () => ({ seeded: 0 }),
            authorityDrain: async (args) => {
                if (args.action === "finish") {
                    statuses.set("memories", {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "TS",
                        generation: 4,
                    });
                }
                return {
                    authority: {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: args.action === "finish" ? "TS" : "DRAINING",
                        generation: args.action === "finish" ? 4 : 3,
                        captured_upper_bound: 21,
                        coordinator_token: "restart-token",
                    },
                };
            },
            mirrorPull: async (args) => {
                calls.push({ liveOnly: args.live_only, cursor: args.cursor });
                return args.live_only
                    ? {
                          page: {
                              domain: "memories",
                              cursor: 0,
                              next_cursor: 200,
                              has_more: false,
                              rows: [
                                  {
                                      feed_seq: 0,
                                      domain: "memories",
                                      op: "insert",
                                      module_row_id: 200,
                                      full_row_snapshot: memoryRow(200, projectPath),
                                      content_hash: "same-hash",
                                  },
                              ],
                          },
                      }
                    : {
                          page: {
                              domain: "memories",
                              cursor: args.cursor,
                              next_cursor: 21,
                              has_more: false,
                              rows: [
                                  {
                                      feed_seq: 21,
                                      domain: "memories",
                                      op: "tombstone",
                                      module_row_id: 100,
                                      full_row_snapshot: memoryRow(100, "/legacy"),
                                      content_hash: "same-hash",
                                  },
                              ],
                          },
                      };
            },
        };
        const state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            memoryAuthorityProject: null as string | null,
            memoryAuthorityRoot: null as string | null,
            memoryAuthorityReady: false,
        };

        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot,
            state,
        });

        expect(calls.map((call) => call.liveOnly)).toEqual([true, undefined]);
        expect(
            db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({
            cursor: 21,
        });
        expect(db.prepare("SELECT id FROM memories WHERE id = 9395").get()).toEqual({ id: 9395 });
        expect(db.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
            status: "complete",
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get()).toEqual({
            count: 0,
        });
        expect(state.memoryAuthorityReady).toBe(true);
    });

    it("reconciles remaining MODULE domains after a DRAINING resume before tools open", async () => {
        const db = makeDb();
        const projectPath = "git:mixed-restore";
        const projectRoot = "/worktrees/mixed-restore";
        const authorityRoots: string[] = [];
        const statuses = new Map<string, AuthorityStatus | null>([
            [
                "memories",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "memories",
                    state: "DRAINING",
                    generation: 3,
                    coordinator_token: "tok-a",
                    captured_upper_bound: 0,
                },
            ],
            [
                "notes",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "notes",
                    state: "MODULE",
                    generation: 2,
                },
            ],
        ]);
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return { authority: statuses.get(args.domain) ?? null };
            },
            authorityPrepare: async () => {
                throw new Error("prepare should not run on mixed DRAINING resume");
            },
            authoritySeed: async () => ({ seeded: 0 }),
            authorityDrain: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                if (args.action === "begin") {
                    return {
                        authority: {
                            context_store_uuid: "store",
                            project: projectPath,
                            domain: "memories",
                            state: "DRAINING",
                            generation: 3,
                            coordinator_token: "tok-a",
                            captured_upper_bound: 0,
                        },
                    };
                }
                if (args.action === "finish") {
                    statuses.set("memories", {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "TS",
                        generation: 4,
                    });
                    return {
                        authority: {
                            context_store_uuid: "store",
                            project: projectPath,
                            domain: "memories",
                            state: "TS",
                            generation: 4,
                            coordinator_token: "tok-a",
                        },
                    };
                }
                return {
                    authority: {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "DRAINING",
                        generation: 3,
                        coordinator_token: "tok-a",
                    },
                };
            },
            mirrorPull: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: args.cursor,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };
        const state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            memoryAuthorityProject: null as string | null,
            memoryAuthorityRoot: null as string | null,
            memoryAuthorityReady: false,
        };
        const preparedProjects: string[] = [];
        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot,
            state,
            onProjectPrepared: (prepared) => preparedProjects.push(prepared),
        });
        expect(state.memoryAuthorityReady).toBe(true);
        // Hosts hang per-project services (the smart-note evaluator bridge) off this
        // callback, so it must fire with the RESOLVED project — a session that resolves
        // a project other than the plugin's launch directory still gets its bridge.
        expect(preparedProjects).toEqual([projectPath]);
        expect(authorityRoots.length).toBeGreaterThan(0);
        expect(authorityRoots.every((root) => root === projectRoot)).toBe(true);
        expect(getAuthorityManagedMarker(db, projectPath)).not.toBeNull();
        statuses.set("memories", {
            context_store_uuid: "store",
            project: projectPath,
            domain: "memories",
            state: "MODULE",
            generation: 4,
        });
        const secondRoot = "/worktrees/mixed-restore-two";
        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot: secondRoot,
            state,
        });
        expect(authorityRoots).toContain(secondRoot);
        expect(state.memoryAuthorityRoot).toBe(secondRoot);

        expect(() =>
            db
                .prepare(
                    "INSERT INTO notes(type, status, content, project_path, session_id, created_at, updated_at) VALUES ('plain', 'active', 'blocked', ?, 's', 0, 0)",
                )
                .run(projectPath),
        ).toThrow("managed by the Rust module");
    });
});

describe("delta prefix-mutation guard", () => {
    it("in-place mutation of an older message forces a full send instead of a delta", async () => {
        const sessionId = `rust-prefix-guard-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 4 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        let moduleNativeSnapshot: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const request = body as Record<string, unknown>;
                requestBodies.push(request);
                const suffix = request.native_messages as unknown[];
                const delta = request.tail_delta as { native_replace_from?: unknown } | undefined;
                if (delta && typeof delta.native_replace_from === "number") {
                    moduleNativeSnapshot = [
                        ...moduleNativeSnapshot.slice(0, delta.native_replace_from),
                        ...structuredClone(suffix),
                    ];
                } else {
                    moduleNativeSnapshot = structuredClone(suffix);
                }
                return { native_messages: structuredClone(moduleNativeSnapshot) };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = (count: number, mutatePrefix = false): MessageLike[] =>
            rows.slice(0, count).map((row, index) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: mutatePrefix && index === 0 ? "MESSAGE m-1" : `message ${row.id}`,
                    },
                ],
            }));

        const first = buildMessages(3);
        await transform.run(sessionId, first, { messages: [...first] }, makeMeta(db, sessionId));
        // Steady-state control: an appended tail rides a delta.
        const appended = buildMessages(4);
        await transform.run(
            sessionId,
            appended,
            { messages: [...appended] },
            makeMeta(db, sessionId),
        );
        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: expect.any(Number),
            native_replace_from: expect.any(Number),
        });
        // Mutate an OLD message in place (the ephemeral reminder-wrapper class): the
        // pass must abandon the delta and full-send, because the prefix the module
        // would reuse no longer matches what OpenCode holds.
        const mutated = buildMessages(4, true);
        expect(__rustModeTransformTest.messageContentSnapshot(mutated[0]).signature).not.toBe(
            __rustModeTransformTest.messageContentSnapshot(appended[0]).signature,
        );
        const mutatedOutput = { messages: [...mutated] as unknown[] };
        await transform.run(sessionId, mutated, mutatedOutput, makeMeta(db, sessionId));
        expect(requestBodies).toHaveLength(3);
        expect(requestBodies[2]?.tail_delta).toBeUndefined();
        expect(requestBodies[2]?.messages).toHaveLength(4);
        expect(requestBodies[2]?.native_messages).toEqual(mutated);
        expect(JSON.stringify(requestBodies[2]?.messages)).toContain("MESSAGE m-1");
        expect(mutatedOutput.messages).toEqual(mutated);

        const stableOutput = { messages: [...mutated] as unknown[] };
        await transform.run(sessionId, mutated, stableOutput, makeMeta(db, sessionId));
        expect(requestBodies).toHaveLength(4);
        expect(requestBodies[3]?.tail_delta).toEqual({
            after: requestBodies[2]?.full_array_fingerprint,
            replace_from: 4,
            native_replace_from: 4,
        });
        expect(requestBodies[3]?.messages).toEqual([]);
        expect(requestBodies[3]?.native_messages).toEqual([]);
        expect(stableOutput.messages).toEqual(mutatedOutput.messages);
    });

    it("detects equal-length mutations inside tool input arguments", async () => {
        const sessionId = `rust-tool-input-prefix-guard-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 3 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform" ? { native_messages: [] } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = (query: string): MessageLike[] =>
            rows.map((row, index) => ({
                info: { id: row.id, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool",
                        callID: `call-${index}`,
                        tool: "search",
                        state: { status: "completed", input: { query }, output: "ok" },
                    },
                ],
            }));

        const initial = buildMessages("alpha");
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );
        const mutated = buildMessages("bravo");
        expect(__rustModeTransformTest.messageContentSnapshot(mutated[0]).signature).not.toBe(
            __rustModeTransformTest.messageContentSnapshot(initial[0]).signature,
        );
        await transform.run(
            sessionId,
            mutated,
            { messages: [...mutated] },
            makeMeta(db, sessionId),
        );

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]?.tail_delta).toBeUndefined();
        expect(requestBodies[1]?.native_messages).toEqual(mutated);
        expect(JSON.stringify(requestBodies[1]?.messages)).toContain('"query":"bravo"');
    });

    it("matches the legacy snapshot comparator across 500 randomized deep mutations", () => {
        const random = seededRandom(0x5eed_c0de);
        for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
            const chainDepth = 2 + Math.floor(random() * 5);
            let payload: Record<string, unknown> = {
                alpha: randomText(random, 8),
                beta: randomText(random, 12),
                gamma: [null, undefined, randomText(random, 6), Math.floor(random() * 10_000)],
                delta: { enabled: random() > 0.5, count: Math.floor(random() * 100) },
            };
            for (let depth = 0; depth < chainDepth; depth += 1) {
                payload = {
                    alpha: payload,
                    beta: randomText(random, 10),
                    gamma: [depth, randomText(random, 7)],
                    delta: null,
                };
            }
            const original = {
                info: {
                    id: `random-message-${caseIndex}`,
                    role: caseIndex % 2 === 0 ? "assistant" : "user",
                },
                parts: [
                    { type: "text", text: randomText(random, 20) },
                    {
                        type: "tool",
                        callID: `call-${caseIndex}`,
                        state: {
                            status: "completed",
                            input: { query: randomText(random, 9), limit: caseIndex % 17 },
                            output: randomText(random, 24),
                        },
                    },
                ],
                payload,
            } as MessageLike & { payload: Record<string, unknown> };
            const snapshot = __rustModeTransformTest.messageContentSnapshot(original);
            const legacyOriginal = legacyMessageContentFields(original);
            expect(sameSnapshotFields(legacyOriginal, snapshot.fields)).toBe(true);
            expect(__rustModeTransformTest.messageMatchesContentSnapshot(original, snapshot)).toBe(
                true,
            );

            const mutated = structuredClone(original);
            const mutationDepth = Math.floor(random() * chainDepth);
            let parent: Record<string, unknown> = mutated;
            let parentKey = "payload";
            let target = mutated.payload;
            for (let depth = 0; depth < mutationDepth; depth += 1) {
                parent = target;
                parentKey = "alpha";
                target = target.alpha as Record<string, unknown>;
            }
            switch (caseIndex % 5) {
                case 0:
                    target[`added_${caseIndex}`] = randomText(random, 5);
                    break;
                case 1:
                    delete target.beta;
                    break;
                case 2:
                    target.beta = [target.beta, { retyped: true }];
                    break;
                case 3: {
                    const reordered = Object.fromEntries(Object.entries(target).reverse());
                    parent[parentKey] = reordered;
                    break;
                }
                default: {
                    const prior = String(target.beta);
                    target.beta = `${prior.slice(0, -1)}${prior.endsWith("z") ? "y" : "z"}`;
                    break;
                }
            }

            const legacyMutated = legacyMessageContentFields(mutated);
            const legacyVerdict = sameSnapshotFields(legacyMutated, snapshot.fields);
            const cursorVerdict = __rustModeTransformTest.messageMatchesContentSnapshot(
                mutated,
                snapshot,
            );
            expect(cursorVerdict).toBe(legacyVerdict);
            expect(cursorVerdict).toBe(false);
        }
    });

    it("checks a 1,400-message multi-megabyte prefix within the steady-pass budget", () => {
        const text = "x".repeat(2_048);
        const messages = Array.from({ length: 1_400 }, (_, index) => ({
            info: { id: `m-${index}`, role: "user" },
            parts: [{ type: "text", text }],
        })) as MessageLike[];
        const snapshots = __rustModeTransformTest.contentSnapshotsFor(messages);
        const samples: number[] = [];
        for (let sample = 0; sample < 7; sample += 1) {
            const startedAt = performance.now();
            expect(
                messages.every((message, index) =>
                    __rustModeTransformTest.messageMatchesContentSnapshot(
                        message,
                        snapshots[index],
                    ),
                ),
            ).toBe(true);
            samples.push(performance.now() - startedAt);
        }
        samples.sort((left, right) => left - right);
        expect(samples[3]).toBeLessThan(10);
    });

    it("recovers after a queued user message is mutated in place and the module rejects twice", async () => {
        const sessionId = `rust-tail-mutation-recovery-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const initial = makeMessages(sessionId);
        const mutated: MessageLike[] = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>queued user message was wrapped in place</system-reminder>",
                    },
                ],
            },
        ];
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                transformCalls += 1;
                if (transformCalls === 2 || transformCalls === 3) {
                    throw new Error("CK message block identity drift");
                }
                return {
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "module recovered" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });

        await transform.run(
            sessionId,
            initial,
            { messages: initial as unknown[] },
            makeMeta(db, sessionId),
        );
        for (let retry = 0; retry < 2; retry += 1) {
            const output = { messages: mutated as unknown[] };
            await transform.run(sessionId, mutated, output, makeMeta(db, sessionId));
            expect(output.messages).toBe(mutated);
        }
        expect(transform.getState(sessionId).consecutiveFailures).toBe(2);
        expect(transform.getState(sessionId).parked).toBe(false);

        const recoveredOutput = { messages: mutated as unknown[] };
        await transform.run(sessionId, mutated, recoveredOutput, makeMeta(db, sessionId));
        expect(transformCalls).toBe(4);
        expect(recoveredOutput.messages).toEqual([
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "module recovered" }],
            },
        ]);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
    });
});
