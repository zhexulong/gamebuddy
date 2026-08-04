import { createHash } from "node:crypto";
import {
    type AuthorityDrainResponse,
    type AuthorityModuleClient,
    type AuthorityStatus,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    prepareAuthority,
    pullMemoryMirrorOnce,
    reconcileAuthorityProject,
} from "../../features/magic-context/context-authority";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoryVerifications } from "../../features/magic-context/memory/storage-memory-verifications";
import type { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearEmergencyRecovery,
    getChannel2NudgeState,
    getOverflowState,
    isEmergencyRecoveryArmed,
    isProviderOverflowReconfirmed,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage-meta-persisted";
import { writeRustTransformDecision } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import { resolveCtxReduceAvailability } from "./ctx-reduce-availability";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    resolveExecuteThreshold,
    resolveModelKey,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { replayLkg, resolveLkgModelKeys } from "./lkg-replay";
import {
    captureSlot,
    dropSlot,
    getSlot,
    type LkgEntryNote,
    lkgContentDigest,
    noteEntry,
} from "./lkg-slot";
import {
    type ModuleCompartmentMirrorResponse,
    type ModuleCompartmentReader,
    type ModuleStateSyncClient,
    type ModuleStateSyncState,
    mirrorModuleCompartments,
    syncModuleState,
} from "./module-state-sync";
import {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    resolveOrdinalsForModule,
} from "./module-wire";
import { RECOVERY_NO_HEAD_LIMIT } from "./protected-tail-boundary";
import { findLastAssistantModelFromOpenCodeDb, isMidTurn } from "./read-session-db";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import type { TransformDeps } from "./transform";
import { resolveHistoryBudgetTokens } from "./transform";
import { loadContextUsage } from "./transform-context-state";
import type { MessageLike } from "./transform-operations";
import { runRustModePostprocess } from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export class MemoryAuthorityUnavailableError extends Error {
    readonly code = "MEMORY_AUTHORITY_UNAVAILABLE";

    constructor(detail: string) {
        super(
            `rust memory authority unavailable; route ctx_memory through the Rust module: ${detail}`,
        );
        this.name = "MemoryAuthorityUnavailableError";
    }
}

const RUST_FAILURE_PARK_THRESHOLD = 3;
const RUST_PROBE_INTERVAL = 5;
const RUST_SEND_TIMEOUT_MS = 15_000;

export interface RustModeModuleClient extends ModuleStateSyncClient {
    authorityStatus?(args: {
        context_store_uuid: string;
        project: string;
        /** Bound route root for this authority query. */
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: AuthorityStatus | null }>;
    authorityPrepare?(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }>;
    authoritySeed?(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    mirrorPull?(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: import("../../features/magic-context/context-authority").ChangefeedPage }>;
    closeSession?(sessionId: string): void;
    getCompartmentsAfter?(
        sessionId: string,
        afterSequence: number,
    ): Promise<ModuleCompartmentMirrorResponse>;
}

type MessageContentField = string | number | boolean | symbol;

interface MessageContentSnapshot {
    signature: string;
    fields: MessageContentField[];
}

interface RustWireCache {
    rawCount: number;
    wireCount: number;
    rawLastId: string | null;
    rawLastSignature: string | null;
    rawLastVisible: boolean;
    /** Content-sensitive per-message snapshots for the whole raw array. Delta passes
     * re-verify every reused message so in-place edits cannot ride a stale prefix. */
    rawContentSnapshots: MessageContentSnapshot[];
    ckFingerprint: string;
    ckPrefixFingerprintBeforeLast: string;
    nativeFingerprint: string;
    nativePrefixFingerprintBeforeLast: string;
    fingerprint: string;
}

interface RustSessionState extends ModuleStateSyncState {
    initialized: boolean;
    consecutiveFailures: number;
    passCount: number;
    parked: boolean;
    passesSincePark: number;
    warningSent: boolean;
    /** Set when the module answered need_full_sync: the next pass must send the
     * full wire array (delta eligibility bypassed) until a pass applies. Wire-layer
     * only — never triggers a state re-seed. */
    forceFullWire: boolean;
    ordinalMemoAnchor: RawMessageOrdinalAnchor | null;
    ordinalMemoStoredCount: number | null;
    ordinalMemoCanonicalCount: number;
    failureCount: number;
    parkCount: number;
    syntheticTurnCount: number;
    lastObservedUserMessageId: string | null;
    syntheticLoopBreakerLogged: boolean;
    memoryAuthorityProject: string | null;
    memoryAuthorityRoot: string | null;
    memoryAuthorityReady: boolean;
    authorityMemorySyncSkipLogged?: boolean;
}

export interface RustModeTransformOptions {
    moduleClient: RustModeModuleClient;
    hostClient?: unknown;
    projectRoot?: string;
    notifyParked?: (sessionId: string, message: string) => void;
    moduleTimeoutMs?: number;
    memorySyncRequestedSessions?: Set<string>;
    /**
     * Invoked with each project that reaches rust-mode authority preparation, so the
     * host can lazily register per-project services (the smart-note evaluator bridge)
     * for projects other than the plugin's launch directory.
     */
    onProjectPrepared?: (projectPath: string) => void;
    /** Test-only escape hatch for transform-wire tests without an authority transport. */
    allowAuthorityProtocolBypassForTests?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

/**
 * OpenCode retains the original messages array when it serializes a transform result.
 * Mutate that array in place so the module response reaches the wire, while returning
 * the same array for callers that also consume the hook result.
 */
function replaceMessagesInPlace(output: { messages: unknown[] }, next: unknown[]): unknown[] {
    const target = output.messages;
    if (target !== next) target.splice(0, target.length, ...next);
    return target;
}

function messageInfo(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    return isRecord(value.info) ? value.info : value;
}

function messageIdOf(message: MessageLike): string | null {
    const id = messageInfo(message).id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

function updateFnv1a32(hash: number, value: string): number {
    let next = hash;
    for (let index = 0; index < value.length; index += 1) {
        next ^= value.charCodeAt(index);
        next = Math.imul(next, FNV1A_32_PRIME) >>> 0;
    }
    return next;
}

const SNAPSHOT_ARRAY = Symbol("array");
const SNAPSHOT_OBJECT = Symbol("object");
const SNAPSHOT_KEY = Symbol("key");
const SNAPSHOT_STRING = Symbol("string");
const SNAPSHOT_NUMBER = Symbol("number");
const SNAPSHOT_BOOLEAN = Symbol("boolean");
const SNAPSHOT_NULL = Symbol("null");
const SNAPSHOT_UNDEFINED = Symbol("undefined");

interface MessageContentFieldVisitor {
    field(value: MessageContentField): boolean;
    beginObject(): number | undefined;
    endObject(token: number, entryCount: number): boolean;
}

function isSnapshotObjectChild(value: unknown): boolean {
    return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

function visitMessageContentFields(value: unknown, visitor: MessageContentFieldVisitor): boolean {
    if (value === null) return visitor.field(SNAPSHOT_NULL);
    if (typeof value === "string") {
        return visitor.field(SNAPSHOT_STRING) && visitor.field(value);
    }
    if (typeof value === "number") {
        return visitor.field(SNAPSHOT_NUMBER) && visitor.field(value);
    }
    if (typeof value === "boolean") {
        return visitor.field(SNAPSHOT_BOOLEAN) && visitor.field(value);
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        return visitor.field(SNAPSHOT_UNDEFINED);
    }
    if (Array.isArray(value)) {
        if (!visitor.field(SNAPSHOT_ARRAY) || !visitor.field(value.length)) return false;
        for (const item of value) {
            if (!visitMessageContentFields(item, visitor)) return false;
        }
        return true;
    }
    if (typeof value === "object") {
        if (!visitor.field(SNAPSHOT_OBJECT)) return false;
        const objectToken = visitor.beginObject();
        if (objectToken === undefined) return false;
        let entryCount = 0;
        for (const key in value) {
            if (!Object.hasOwn(value, key)) continue;
            const child = (value as Record<string, unknown>)[key];
            if (!isSnapshotObjectChild(child)) continue;
            entryCount += 1;
            if (
                !visitor.field(SNAPSHOT_KEY) ||
                !visitor.field(key) ||
                !visitMessageContentFields(child, visitor)
            ) {
                return false;
            }
        }
        return visitor.endObject(objectToken, entryCount);
    }
    return visitor.field(SNAPSHOT_UNDEFINED);
}

function messageContentFields(message: MessageLike): MessageContentField[] {
    const fields: MessageContentField[] = [];
    const complete = visitMessageContentFields(message, {
        field(value) {
            fields.push(value);
            return true;
        },
        beginObject() {
            const countIndex = fields.length;
            fields.push(0);
            return countIndex;
        },
        endObject(countIndex, entryCount) {
            fields[countIndex] = entryCount;
            return true;
        },
    });
    if (!complete) throw new Error("message content snapshot traversal stopped unexpectedly");
    return fields;
}

function signatureForFields(fields: readonly MessageContentField[]): string {
    let hash = FNV1A_32_OFFSET;
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash = updateFnv1a32(hash, `${typeof field}:${value.length}:`);
        hash = updateFnv1a32(hash, value);
        hash = updateFnv1a32(hash, "\0");
    }
    return hash.toString(16).padStart(8, "0");
}

/** Capture an exact field snapshot plus its compact content-sensitive rolling hash. */
function messageContentSnapshot(message: MessageLike): MessageContentSnapshot {
    const fields = messageContentFields(message);
    return { signature: signatureForFields(fields), fields };
}

function contentSnapshotsFor(messages: readonly MessageLike[]): MessageContentSnapshot[] {
    return messages.map(messageContentSnapshot);
}

function messageMatchesContentSnapshot(
    message: MessageLike,
    snapshot: MessageContentSnapshot,
): boolean {
    let fieldIndex = 0;
    const matched = visitMessageContentFields(message, {
        field(value) {
            if (!Object.is(value, snapshot.fields[fieldIndex])) return false;
            fieldIndex += 1;
            return true;
        },
        beginObject() {
            const expectedCount = snapshot.fields[fieldIndex];
            if (typeof expectedCount !== "number") return undefined;
            fieldIndex += 1;
            return expectedCount;
        },
        endObject(expectedCount, entryCount) {
            return expectedCount === entryCount;
        },
    });
    return matched && fieldIndex === snapshot.fields.length;
}

function prefixContentSnapshotsMatch(
    messages: readonly MessageLike[],
    cache: RustWireCache,
    prefixLength: number,
): boolean {
    if (prefixLength > cache.rawContentSnapshots.length) return false;
    for (let index = 0; index < prefixLength; index += 1) {
        if (!messageMatchesContentSnapshot(messages[index], cache.rawContentSnapshots[index])) {
            return false;
        }
    }
    return true;
}

function messageCacheSignature(message: MessageLike): string {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const serializedParts = JSON.stringify(parts) ?? "null";
    const serializedMessage = JSON.stringify(message) ?? "null";
    return `${messageIdOf(message) ?? ""}:${parts.length}:${Buffer.byteLength(serializedParts)}:${createHash("sha256").update(serializedMessage).digest("hex")}`;
}

function advanceWireFingerprint(previous: string, encoded: unknown): string {
    return createHash("sha256")
        .update(previous)
        .update("\\0")
        .update(JSON.stringify(encoded) ?? "null")
        .digest("hex");
}

function buildWireFingerprint(encoded: unknown[]): {
    fingerprint: string;
    prefixFingerprintBeforeLast: string;
} {
    let fingerprint = "rust-wire-v1";
    let prefixFingerprintBeforeLast = fingerprint;
    for (let index = 0; index < encoded.length; index += 1) {
        if (index === encoded.length - 1) prefixFingerprintBeforeLast = fingerprint;
        fingerprint = advanceWireFingerprint(fingerprint, encoded[index]);
    }
    return { fingerprint, prefixFingerprintBeforeLast };
}

function newestUserMessage(messages: MessageLike[]): MessageLike | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messageInfo(messages[index]).role === "user") return messages[index];
    }
    return undefined;
}

interface RustPassTimings {
    prefixGuard: number;
    ordinalResolve: number;
    stateSync: number;
    clone: number;
    wireBuild: number;
    wireMessages: number;
    transport: number;
    transportPages: number;
    transportBytes: number;
    apply: number;
    lkgSnapshot: number;
}

function emptyRustPassTimings(): RustPassTimings {
    return {
        prefixGuard: 0,
        ordinalResolve: 0,
        stateSync: 0,
        clone: 0,
        wireBuild: 0,
        wireMessages: 0,
        transport: 0,
        transportPages: 0,
        transportBytes: 0,
        apply: 0,
        lkgSnapshot: 0,
    };
}

function formatRustPassLog(args: {
    decision: string;
    reason: string;
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
    elapsedMs: number;
    moduleElapsedMs: number;
    timings?: RustPassTimings;
}): string {
    const timings = args.timings ?? emptyRustPassTimings();
    const measured =
        timings.prefixGuard +
        timings.ordinalResolve +
        timings.stateSync +
        timings.clone +
        timings.wireBuild +
        timings.transport +
        timings.apply +
        timings.lkgSnapshot;
    const unattributed = Math.max(0, args.elapsedMs - measured);
    return `rust pass: decision=${args.decision} reason=${args.reason} served_from=${args.servedFrom} in=${args.inputCount} out=${args.outputCount} applied=${args.applied} elapsed=${args.elapsedMs.toFixed(1)} ms module=${args.moduleElapsedMs.toFixed(1)} ms stages=prefix_guard:${timings.prefixGuard.toFixed(1)} ordinal_resolve:${timings.ordinalResolve.toFixed(1)} state_sync:${timings.stateSync.toFixed(1)} clone:${timings.clone.toFixed(1)} wire_build:${timings.wireBuild.toFixed(1)} wire_messages:${timings.wireMessages} transport:${timings.transport.toFixed(1)} transport_pages:${timings.transportPages} transport_bytes:${timings.transportBytes} apply:${timings.apply.toFixed(1)} lkg_snapshot:${timings.lkgSnapshot.toFixed(1)} other:${unattributed.toFixed(1)}`;
}

function isSyntheticUserMessage(message: MessageLike | undefined): boolean {
    if (!message || messageInfo(message).role !== "user" || !Array.isArray(message.parts)) {
        return false;
    }
    return (
        message.parts.length > 0 &&
        message.parts.every(
            (part) => isRecord(part) && (part.synthetic === true || part.ignored === true),
        )
    );
}

function observeSyntheticTurn(state: RustSessionState, messages: MessageLike[]): boolean {
    const newest = newestUserMessage(messages);
    const info = messageInfo(newest);
    const messageId = typeof info.id === "string" ? info.id : null;
    const synthetic = isSyntheticUserMessage(newest);
    const isNewMessage = messageId === null || messageId !== state.lastObservedUserMessageId;

    if (!synthetic) {
        state.syntheticTurnCount = 0;
        state.syntheticLoopBreakerLogged = false;
    } else if (isNewMessage) {
        state.syntheticTurnCount += 1;
    }
    state.lastObservedUserMessageId = messageId;
    return synthetic;
}

function assertNativeBoundary(output: unknown[], sessionId: string, boundaryId: string): void {
    const first = output.find((message) => messageInfo(message).role !== "system");
    const info = messageInfo(first);
    const parts = isRecord(first) && Array.isArray(first.parts) ? first.parts : [];
    const synthetic =
        parts.length > 0 && parts.every((part) => isRecord(part) && part.synthetic === true);
    if (info.role === "user" && info.sessionID === sessionId && synthetic) return;
    throw new Error(
        `rust transform wire invariant failed: boundary=${boundaryId} expected a synthetic m0 user message scoped to session ${sessionId}`,
    );
}

function responseValue(response: unknown): Record<string, unknown> {
    if (isRecord(response) && isRecord(response.result)) return response.result;
    if (isRecord(response)) return response;
    throw new Error("module transform returned a non-object response");
}

function noteDeliveryPassIds(response: Record<string, unknown>): string[] {
    if (!Array.isArray(response.note_deliveries)) return [];
    return [
        ...new Set(
            response.note_deliveries.flatMap((delivery) => {
                if (!isRecord(delivery)) return [];
                const passId = delivery.transform_pass_id;
                return typeof passId === "string" && passId.length > 0 ? [passId] : [];
            }),
        ),
    ];
}

function modelFromMessages(
    messages: MessageLike[],
): { providerID: string; modelID: string } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as Record<string, unknown> | undefined;
        const model = isRecord(info?.model) ? info.model : undefined;
        if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
            return { providerID: model.providerID, modelID: model.modelID };
        }
        if (
            typeof info?.providerID === "string" &&
            typeof info.modelID === "string" &&
            info.role === "assistant"
        ) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return undefined;
}

function ensureState(states: Map<string, RustSessionState>, sessionId: string): RustSessionState {
    let state = states.get(sessionId);
    if (!state) {
        state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            forceFullWire: false,
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
            memoryAuthorityProject: null,
            memoryAuthorityRoot: null,
            memoryAuthorityReady: false,
            authorityMemorySyncSkipLogged: false,
        };
        states.set(sessionId, state);
    }
    return state;
}

function getSessionDirectory(
    deps: TransformDeps,
    sessionId: string,
): Promise<{ directory: string; resolvedFromHost: boolean }> {
    const cached = deps.sessionDirectoryBySession?.get(sessionId);
    if (cached) return Promise.resolve({ directory: cached, resolvedFromHost: true });
    if (!deps.client)
        return Promise.resolve({
            directory: deps.directory ?? process.cwd(),
            resolvedFromHost: false,
        });
    return Promise.resolve().then(async () => {
        try {
            const response = await deps.client?.session
                ?.get({ path: { id: sessionId } })
                .catch(() => null);
            const directory = (response as { data?: { directory?: unknown } } | null)?.data
                ?.directory;
            if (typeof directory === "string" && directory.length > 0) {
                deps.sessionDirectoryBySession?.set(sessionId, directory);
                return { directory, resolvedFromHost: true };
            }
        } catch {
            // The launch directory is a safe non-fatal fallback for module routing.
        }
        return { directory: deps.directory ?? process.cwd(), resolvedFromHost: false };
    });
}

function readUpgradeState(db: TransformDeps["db"], sessionId: string): string {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1")
        .get(sessionId) as { count?: number } | undefined;
    return (row?.count ?? 0) > 0 ? "legacy" : "ready";
}

function passUsage(usage: ContextUsage, limit: number): Record<string, number> {
    return {
        input_tokens: usage.inputTokens,
        limit,
        current_total_input_tokens: usage.inputTokens,
        context_limit_tokens: limit,
    };
}

function directiveTextOf(response: Record<string, unknown>): string | undefined {
    const directives = isRecord(response.host_directives) ? response.host_directives : undefined;
    const channel2 = isRecord(directives?.channel2_nudge) ? directives.channel2_nudge : undefined;
    return typeof channel2?.text === "string" && channel2.text.length > 0
        ? channel2.text
        : undefined;
}

function isNeedFullSync(response: Record<string, unknown>): boolean {
    return response.status === "need_full_sync" || response.action === "NEED_FULL_SYNC";
}

function canonicalizeForChecksum(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalizeForChecksum(value[key])]),
    );
}

function checksumSeedRows(rows: readonly Record<string, unknown>[]): string {
    return createHash("sha256")
        .update(JSON.stringify(rows.map(canonicalizeForChecksum)))
        .digest("hex");
}

function authoritySeedRows(
    db: TransformDeps["db"],
    projectPath: string,
    domain: "memories" | "notes",
): Record<string, unknown>[] {
    const snapshots =
        domain === "memories"
            ? db
                  .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id ASC")
                  .all(projectPath)
            : db
                  .prepare(
                      `SELECT n.*
                         FROM notes n
                        WHERE n.project_path = ?
                           OR (n.project_path IS NULL AND EXISTS (
                               SELECT 1 FROM session_projects sp
                                WHERE sp.session_id = n.session_id AND sp.project_path = ?
                           ))
                        ORDER BY n.id ASC`,
                  )
                  .all(projectPath, projectPath);
    const memoryRows = snapshots.filter(isRecord);
    const mappings =
        domain === "memories"
            ? getMemoryVerifications(
                  db,
                  memoryRows.map((row) => Number(row.id)),
              )
            : new Map<number, { files: string[]; hasSentinel: boolean }>();
    return memoryRows.map((snapshot) => {
        const id = Number(snapshot.id);
        const mapping = mappings.get(id);
        const seededSnapshot =
            domain === "memories" && mapping
                ? { ...snapshot, mapping: mapping.hasSentinel ? null : mapping.files }
                : domain === "notes" && snapshot.project_path == null
                  ? { ...snapshot, project_path: projectPath }
                  : snapshot;
        return { source_row_id: snapshot.id, snapshot: seededSnapshot };
    });
}

async function prepareRustMemoryAuthority(args: {
    db: TransformDeps["db"];
    module: RustModeModuleClient;
    projectPath: string;
    projectRoot: string;
    state: RustSessionState;
    allowProtocolBypassForTests?: boolean;
    /** Fires after authority is ready so hosts can register per-project services. */
    onProjectPrepared?: (projectPath: string) => void;
}): Promise<void> {
    const { db, module, projectPath, projectRoot, state } = args;
    if (
        state.memoryAuthorityProject === projectPath &&
        state.memoryAuthorityRoot === projectRoot &&
        state.memoryAuthorityReady
    ) {
        return;
    }
    state.memoryAuthorityProject = projectPath;
    state.memoryAuthorityRoot = projectRoot;
    state.memoryAuthorityReady = false;
    if (!module.authorityStatus || !module.authorityPrepare || !module.authoritySeed) {
        if (args.allowProtocolBypassForTests === true) {
            state.memoryAuthorityReady = true;
            return;
        }
        throw new MemoryAuthorityUnavailableError(
            "the module does not expose authority.status, authority.prepare, and authority.seed",
        );
    }

    // Call through the module object on every invocation: these may be real class
    // methods whose implementations depend on their instance, so detaching them into
    // locals would sever `this` and only fail at runtime (test fakes are object
    // literals and cannot catch the difference).
    const authorityModule: AuthorityModuleClient = {
        authorityStatus: (request) => module.authorityStatus!({ ...request, projectRoot }),
        authorityPrepare: (request) => module.authorityPrepare!({ ...request, projectRoot }),
        authoritySeed: (request) => module.authoritySeed!({ ...request, projectRoot }),
        authorityDrain: module.authorityDrain
            ? (request) => module.authorityDrain!({ ...request, projectRoot })
            : undefined,
        mirrorPull: module.mirrorPull
            ? (request) => module.mirrorPull!({ ...request, projectRoot })
            : undefined,
    };
    const contextStoreUuid = ensureContextStoreUuid(db);
    const domains = ["memories", "notes"] as const;
    const statuses = new Map<
        (typeof domains)[number],
        Awaited<ReturnType<NonNullable<RustModeModuleClient["authorityStatus"]>>>["authority"]
    >();
    for (const domain of domains) {
        const current = await authorityModule.authorityStatus({
            context_store_uuid: contextStoreUuid,
            project: projectPath,
            domain,
        });
        statuses.set(domain, current.authority);
    }

    let resumedDrain = false;
    for (const domain of domains) {
        const current = statuses.get(domain);
        if (current?.state !== "DRAINING") continue;
        resumedDrain = true;
        let drained: Awaited<ReturnType<typeof drainAuthority>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            drained = await drainAuthority({
                db,
                projectPath,
                domain,
                module: authorityModule,
                checksum: () =>
                    checksumSeedRows(
                        db
                            .prepare(
                                `SELECT * FROM ${domain === "memories" ? "memories" : "notes"} WHERE project_path = ? ORDER BY id ASC`,
                            )
                            .all(projectPath)
                            .filter(isRecord),
                    ),
            });
            if (!("code" in drained)) break;
        }
        if (!drained) {
            throw new MemoryAuthorityUnavailableError("authority drain did not return a result");
        }
        if ("code" in drained) {
            throw new MemoryAuthorityUnavailableError(
                `${drained.code}; the next scheduled transform will resume the drain`,
            );
        }
        statuses.set(domain, null);
    }

    // Do not return before finishing authority restore: if some domains are still
    // DRAINING and others MODULE, reinstall the on-disk authority_managed marker and
    // re-apply write fences on remaining MODULE domains before any tools run.
    if (!resumedDrain) {
        for (const domain of domains) {
            const current = statuses.get(domain);
            if (current?.state !== "PREPARING") continue;
            await authorityModule.authorityPrepare({
                method: "authority.prepare",
                phase: "abort",
                context_store_uuid: contextStoreUuid,
                project: projectPath,
                domain,
                generation: current.generation,
            });
            statuses.set(domain, null);
        }
        const preparing = domains.filter((domain) => statuses.get(domain)?.state !== "MODULE");
        for (const domain of preparing) {
            const stateName = statuses.get(domain)?.state;
            if (stateName && stateName !== "TS") {
                throw new Error(`${domain} authority cannot prepare from ${stateName}`);
            }
        }
        if (preparing.length > 0) {
            await prepareAuthority({
                db,
                projectPath,
                domains: preparing,
                module: authorityModule,
                seedPages: async (domain) => authoritySeedRows(db, projectPath, domain),
                checksum: (_domain, rows) => checksumAuthoritySeedRows(rows),
            });
        }
    }

    await reconcileAuthorityProject({ db, projectPath, module: authorityModule });
    state.memoryAuthorityReady = true;
    args.onProjectPrepared?.(projectPath);
}

/** Single response-field seam for the parallel module encode-back contract. */
export function applyNativeMessagesVerbatim(
    output: { messages: unknown[] },
    response: Record<string, unknown>,
): unknown[] {
    const nativeMessages = response.native_messages;
    if (typeof nativeMessages === "string") {
        const parsed = JSON.parse(nativeMessages) as unknown;
        if (!Array.isArray(parsed))
            throw new Error("rust transform native_messages string was not an array");
        return replaceMessagesInPlace(output, parsed);
    }
    if (!Array.isArray(nativeMessages)) {
        throw new Error("rust transform response omitted native_messages");
    }
    // The module owns healing, ordering, and codec fidelity. Do not clone,
    // normalize, or otherwise inspect the returned native message array.
    return replaceMessagesInPlace(output, nativeMessages);
}

function buildTransformBody(args: {
    sessionId: string;
    input: unknown[];
    nativeMessages: unknown[];
    passInputs: Record<string, unknown>;
    usage: Record<string, number | boolean>;
    modelKey: string | null;
    providerId: string | null;
    systemPromptHash: string;
    upgradeState: string;
    midTurn: boolean;
    prevResponseCompletedAtMs?: number;
    requestObservedAtMs?: number;
    channel2NudgeState: string;
    emergencyRecoveryArmed: boolean;
    declaredTrim?: unknown;
    fullArrayFingerprint?: string;
    tailDelta?: {
        after: string;
        replaceFrom: number;
        nativeReplaceFrom: number;
    };
}): Record<string, unknown> {
    return {
        method: "transform",
        kind: "transform",
        v: 2,
        serializer_profile: "opencode-aisdk",
        serve_native: true,
        session_id: args.sessionId,
        // Model/provider and system-prompt changes are provider-cache eviction signals;
        // send the same identity inputs used by the TypeScript materializer instead of
        // leaving the native identity blank.
        render_config: [
            args.providerId ? `provider:${args.providerId}` : "",
            args.modelKey ? `model:${args.modelKey}` : "",
            args.systemPromptHash ? `system:${args.systemPromptHash}` : "",
        ]
            .filter(Boolean)
            .join("|"),
        system_prompt_hash: args.systemPromptHash,
        upgrade_state: args.upgradeState,
        is_subagent: args.passInputs.is_subagent === true,
        protected_tags: args.passInputs.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        messages: args.input,
        native_messages: args.nativeMessages,
        ...(args.fullArrayFingerprint ? { full_array_fingerprint: args.fullArrayFingerprint } : {}),
        ...(args.tailDelta
            ? {
                  tail_delta: {
                      after: args.tailDelta.after,
                      replace_from: args.tailDelta.replaceFrom,
                      native_replace_from: args.tailDelta.nativeReplaceFrom,
                  },
              }
            : {}),
        usage: args.usage,
        provider_error: args.passInputs.provider_error,
        mid_turn: args.midTurn,
        prev_response_completed_at_ms: args.prevResponseCompletedAtMs,
        request_observed_at_ms: args.requestObservedAtMs,
        channel2_nudge_state: args.channel2NudgeState,
        emergency_recovery_armed: args.emergencyRecoveryArmed,
        emergency_recovery_no_head_escape:
            args.passInputs.emergency_recovery_no_head_escape === true,
        detected_context_limit: args.passInputs.detected_context_limit,
        detected_context_limit_model_key: args.passInputs.detected_context_limit_model_key,
        model_key: args.modelKey,
        provider_id: args.providerId,
        tool_present: args.passInputs.tool_present === true,
        effective_execute_threshold: args.passInputs.effective_execute_threshold,
        history_budget_tokens: args.passInputs.history_budget_tokens,
        clear_reasoning_age: args.passInputs.clear_reasoning_age,
        caveman_enabled: args.passInputs.caveman_enabled === true,
        caveman_min_chars: args.passInputs.caveman_min_chars ?? 500,
        cache_ttl: args.passInputs.cache_ttl,
        pass_inputs: args.passInputs,
        declared_trim: args.declaredTrim,
    };
}

export function createRustModeTransform(
    deps: TransformDeps,
    options: RustModeTransformOptions,
): {
    run: (
        sessionId: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
    ) => Promise<void>;
    clearSession: (sessionId: string) => void;
    invalidateWireState: (sessionId: string) => void;
    getState: (sessionId: string) => Readonly<RustSessionState>;
} {
    const states = new Map<string, RustSessionState>();
    const wireCaches = new Map<string, RustWireCache>();
    const timeoutMs = Math.max(1, options.moduleTimeoutMs ?? RUST_SEND_TIMEOUT_MS);

    const logStage = (
        sessionId: string,
        stage: keyof RustPassTimings,
        startedAt: number,
        timings: RustPassTimings,
        extra?: string,
    ): void => {
        const elapsed = Math.max(0, performance.now() - startedAt);
        timings[stage] += elapsed;
        logTransformTiming(
            sessionId,
            `rust.${stage.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
            startedAt,
            extra,
        );
    };

    const callModule = async (
        args: Parameters<RustModeModuleClient["call"]>[0],
    ): Promise<unknown> => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new Error("rust module request timed out")),
            timeoutMs,
        );
        try {
            return await options.moduleClient.call({ ...args, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    const markFailure = (sessionId: string, state: RustSessionState, error: unknown): void => {
        state.consecutiveFailures += 1;
        state.failureCount += 1;
        sessionLog(sessionId, "rust transform failed; attempting LKG replay:", error);
        if (state.consecutiveFailures < RUST_FAILURE_PARK_THRESHOLD || state.parked) return;
        state.parked = true;
        state.parkCount += 1;
        state.passesSincePark = 0;
        state.warningSent = true;
        const warning =
            "Rust Magic Context is unavailable for this session; retry after the module recovers.";
        sessionLog(sessionId, "rust transform parked after three consecutive failures");
        options.notifyParked?.(sessionId, warning);
    };

    const resetOrdinalMemo = (state: RustSessionState): void => {
        state.idOrdinalMemo.clear();
        state.ordinalMemoAnchor = null;
        state.ordinalMemoStoredCount = null;
        state.ordinalMemoCanonicalCount = 0;
    };

    const invalidateWireState = (sessionId: string): void => {
        wireCaches.delete(sessionId);
        const state = states.get(sessionId);
        if (!state) return;
        resetOrdinalMemo(state);
        state.forceFullWire = true;
    };

    const replayLastGood = (
        sessionId: string,
        currentMessages: MessageLike[],
        output: { messages: unknown[] },
        systemPromptTokens: number,
    ): boolean => {
        const slot = getSlot(sessionId);
        if (!slot) {
            sessionLog(sessionId, "lkg_miss");
            return false;
        }
        if (isEmergencyRecoveryArmed(sessionId)) {
            sessionLog(sessionId, "lkg_emergency_armed");
            return false;
        }
        try {
            if (getOverflowState(deps.db, sessionId).needsEmergencyRecovery) {
                sessionLog(sessionId, "lkg_emergency_armed");
                return false;
            }
        } catch {
            return false;
        }
        let entry: LkgEntryNote | null = null;
        try {
            entry = noteEntry(sessionId, currentMessages);
        } catch (error) {
            sessionLog(sessionId, "rust LKG entry snapshot failed:", error);
            return false;
        }
        if (!entry) {
            dropSlot(sessionId, "lkg_invalidated_reshape");
            sessionLog(sessionId, "lkg_invalidated_reshape");
            return false;
        }
        const keys = resolveLkgModelKeys(currentMessages);
        const replay = replayLkg({
            sessionId,
            messages: currentMessages,
            modelKey: keys.modelKey,
            providerKey: keys.providerKey,
            entry,
        });
        if (!replay.ok) {
            sessionLog(sessionId, replay.reason);
            return false;
        }
        const replayModel =
            modelFromMessages(currentMessages) ?? findLastAssistantModelFromOpenCodeDb(sessionId);
        const trustedReplayLimit = replayModel
            ? resolveTrustedContextLimit(replayModel.providerID, replayModel.modelID, {
                  db: deps.db,
                  sessionID: sessionId,
              })
            : undefined;
        let detectedReplayLimit = 0;
        try {
            detectedReplayLimit = getOverflowState(
                deps.db,
                sessionId,
                keys.modelKey,
            ).detectedContextLimit;
        } catch {
            // A limit read failure cannot admit cached bytes whose size is now unknown.
            return false;
        }
        const replayLimit =
            trustedReplayLimit ?? (detectedReplayLimit > 0 ? detectedReplayLimit : undefined);
        if (replayLimit !== undefined && replayLimit > 0) {
            try {
                const estimate = estimateFinalWireInputTokens({
                    messages: replay.messages,
                    systemPromptTokens,
                    providerID: replayModel?.providerID,
                    modelID: replayModel?.modelID,
                    agentName: deps.getNotificationParams?.(sessionId)?.agent,
                });
                if (estimate.tokens > replayLimit) {
                    sessionLog(
                        sessionId,
                        `lkg_over_context_limit estimated=${estimate.tokens} limit=${replayLimit}`,
                    );
                    return false;
                }
            } catch {
                return false;
            }
        }
        replaceMessagesInPlace(output, replay.messages);
        sessionLog(sessionId, "lkg_replay_served");
        return true;
    };

    const captureRustResponse = (
        sessionId: string,
        input: MessageLike[],
        response: Record<string, unknown>,
    ): boolean => {
        const ids = input.map((message) => message.info.id);
        if (
            ids.some((id) => typeof id !== "string") ||
            new Set(ids).size !== ids.length ||
            ids.length === 0
        ) {
            return false;
        }
        const inputContentDigests = input.map((message) => lkgContentDigest(message));
        if (inputContentDigests.some((digest) => digest === null)) return false;
        const native = response.native_messages;
        const jsonPrefix = typeof native === "string" ? native : JSON.stringify(native);
        if (typeof jsonPrefix !== "string") return false;
        const keys = resolveLkgModelKeys(input);
        return captureSlot(sessionId, {
            jsonPrefix,
            inputIdSeq: ids as string[],
            inputContentDigests: inputContentDigests as string[],
            lastInputMessageId: ids[ids.length - 1] as string,
            modelKey: keys.modelKey,
            providerKey: keys.providerKey,
            capturedAt: Date.now(),
        });
    };

    const run = async (
        sessionId: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
    ): Promise<void> => {
        const passStartedAt = performance.now();
        const passObservedAtMs = Date.now();
        const state = ensureState(states, sessionId);
        const timings = emptyRustPassTimings();
        state.passCount += 1;
        const syntheticTurn = observeSyntheticTurn(state, messages);
        const syntheticLoopBlocked = syntheticTurn && state.syntheticTurnCount >= 3;
        if (syntheticLoopBlocked && !state.syntheticLoopBreakerLogged) {
            state.syntheticLoopBreakerLogged = true;
            sessionLog(
                sessionId,
                "RUST LOOP BREAKER: suppressing host directives after three consecutive synthetic turns until a real user message arrives",
            );
        }
        const inputCount = messages.length;
        let requestInputTokens = 0;
        let decision = "error";
        let materializeReason = "none";
        let servedFrom = "none";
        let moduleElapsedMs = 0;
        let appliedAt: number | undefined;
        let emergencyFailClosed = false;
        // Parking must not hide pressure from the recovery policy. Usage is cheap to read
        // and is the same value copied onto the module request when this pass runs.
        const passUsageSnapshot = loadContextUsage(deps.contextUsageMap, deps.db, sessionId);
        requestInputTokens = Math.max(0, Math.floor(passUsageSnapshot.inputTokens));
        let preflightError: unknown;
        let model = modelFromMessages(messages);
        if (!model) {
            try {
                model = findLastAssistantModelFromOpenCodeDb(sessionId) ?? undefined;
            } catch (error) {
                preflightError = error;
            }
        }
        const modelKey = model ? resolveModelKey(model.providerID, model.modelID) : null;
        let resolvedContextLimit: number | undefined;
        if (model) {
            try {
                resolvedContextLimit = resolveTrustedContextLimit(model.providerID, model.modelID, {
                    db: deps.db,
                    sessionID: sessionId,
                });
            } catch (error) {
                preflightError ??= error;
            }
        }
        let overflowState: ReturnType<typeof getOverflowState> | undefined;
        try {
            overflowState = getOverflowState(deps.db, sessionId, modelKey);
        } catch (error) {
            preflightError ??= error;
        }
        emergencyFailClosed =
            passUsageSnapshot.percentage >= 95 &&
            resolvedContextLimit !== undefined &&
            resolvedContextLimit > 0;
        if (overflowState) {
            const detectedLimitMatchesModel =
                overflowState.detectedContextLimitModelKey === null ||
                overflowState.detectedContextLimitModelKey === modelKey;
            const hasProviderProof =
                (overflowState.detectedContextLimit > 0 && detectedLimitMatchesModel) ||
                // An unknown persisted arm alone is not proof. A second provider rejection
                // while that arm is durable records the process-local reconfirmation.
                isProviderOverflowReconfirmed(sessionId);
            emergencyFailClosed ||=
                overflowState.needsEmergencyRecovery &&
                overflowState.emergencyRecoveryOrigin === "provider_overflow" &&
                hasProviderProof;
        }
        const finishPass = (applied: boolean, served = true): void => {
            const elapsedAt = applied && appliedAt !== undefined ? appliedAt : performance.now();
            const elapsedMs = Math.max(0, elapsedAt - passStartedAt);
            sessionLog(
                sessionId,
                formatRustPassLog({
                    decision,
                    reason: materializeReason,
                    servedFrom,
                    inputCount,
                    outputCount: output.messages.length,
                    applied,
                    elapsedMs,
                    moduleElapsedMs,
                    timings,
                }),
            );
            if (served) {
                writeRustTransformDecision({
                    sessionId,
                    decision,
                    materializeReason: materializeReason === "none" ? null : materializeReason,
                    inputTokens: requestInputTokens,
                    tsMs: passObservedAtMs,
                });
            }
        };
        const captureResponseTelemetry = (response: Record<string, unknown>): void => {
            decision =
                typeof response.decision === "string"
                    ? response.decision
                    : typeof response.action === "string"
                      ? response.action
                      : typeof response.status === "string"
                        ? response.status
                        : "unknown";
            servedFrom =
                typeof response.served_from === "string" ? response.served_from : "unknown";
            materializeReason =
                typeof response.materialize_reason === "string" &&
                response.materialize_reason.length > 0
                    ? response.materialize_reason
                    : "none";
            const timings = isRecord(response.timings) ? response.timings : undefined;
            const total = timings?.total;
            moduleElapsedMs = typeof total === "number" && Number.isFinite(total) ? total : 0;
            // A slow module pass earns its stage breakdown in the log: the pass line
            // only carries the module total, which cannot distinguish a tokenizer
            // stall from a store commit stall on large sessions.
            if (timings && moduleElapsedMs >= 1000) {
                const detail = Object.entries(timings)
                    .filter(([key, value]) => key !== "total" && typeof value === "number")
                    .map(([key, value]) => `${key}:${(value as number).toFixed(1)}`)
                    .join(" ");
                if (detail) sessionLog(sessionId, `rust module stages (slow pass): ${detail}`);
            }
        };
        if (state.parked) {
            state.passesSincePark += 1;
            // The fifth live pass is the first retry opportunity after the
            // three-failure park; later retries use the same global cadence.
            if (
                !emergencyFailClosed &&
                passUsageSnapshot.percentage < 90 &&
                state.passCount % RUST_PROBE_INTERVAL !== 0
            ) {
                decision = "parked";
                const replayed = replayLastGood(
                    sessionId,
                    messages,
                    output,
                    sessionMeta.systemPromptTokens,
                );
                if (replayed) {
                    servedFrom = "lkg";
                } else {
                    servedFrom = "raw";
                    replaceMessagesInPlace(output, messages);
                }
                finishPass(false);
                return;
            }
        }
        const reduceAvailability = resolveCtxReduceAvailability(sessionId);
        // A provisional fail-open verdict must not activate provider-visible bytes. The
        // first persisted user message freezes the verdict for all later transform passes.
        const toolPresent = reduceAvailability.frozen && reduceAvailability.callable;
        try {
            if (preflightError) throw preflightError;
            if (!overflowState) throw new Error("rust overflow state unavailable");
            const { directory } = await getSessionDirectory(deps, sessionId);
            if (model) deps.liveModelBySession?.set(sessionId, model);
            const usage = passUsageSnapshot;
            requestInputTokens = Math.max(0, Math.floor(usage.inputTokens));
            const contextLimit =
                resolvedContextLimit && resolvedContextLimit > 0
                    ? resolvedContextLimit
                    : usage.percentage > 0
                      ? Math.round(usage.inputTokens / (usage.percentage / 100))
                      : 128_000;
            const threshold = resolveExecuteThreshold(
                deps.executeThresholdPercentage ?? 65,
                modelKey ?? undefined,
                65,
                { tokensConfig: deps.executeThresholdTokens, contextLimit },
            );
            const historyBudgetTokens = resolveHistoryBudgetTokens(
                deps.historyBudgetPercentage,
                usage,
                deps.executeThresholdPercentage,
                modelKey ?? undefined,
                deps.executeThresholdTokens,
                resolvedContextLimit,
            );
            const midTurn = isMidTurn(deps, sessionId);
            const requestObservedAtMs = Date.now();
            const recoveryNoHeadEscape =
                overflowState.needsEmergencyRecovery &&
                loadProtectedTailMeta(deps.db, sessionId).recoveryNoEligibleHeadCount >=
                    RECOVERY_NO_HEAD_LIMIT;
            const passInputs: Record<string, unknown> = {
                now_ms: requestObservedAtMs,
                model_key: modelKey,
                provider_id: model?.providerID ?? null,
                usage: passUsage(usage, contextLimit),
                effective_execute_threshold: threshold,
                history_budget_tokens: historyBudgetTokens,
                clear_reasoning_age: deps.clearReasoningAge,
                caveman_enabled:
                    !sessionMeta.isSubagent && deps.cavemanTextCompression?.enabled === true,
                caveman_min_chars: deps.cavemanTextCompression?.minChars ?? 500,
                cache_ttl: sessionMeta.cacheTtl,
                mid_turn: midTurn,
                is_subagent: sessionMeta.isSubagent,
                system_prompt_hash: sessionMeta.systemPromptHash ?? "",
                upgrade_state: readUpgradeState(deps.db, sessionId),
                tool_present: toolPresent,
                protected_tags: deps.protectedTags ?? DEFAULT_PROTECTED_TAGS,
                temporal_awareness: deps.experimentalTemporalAwareness === true,
                channel2_nudge_state: getChannel2NudgeState(deps.db, sessionId),
                emergency_recovery_armed:
                    overflowState.needsEmergencyRecovery || isEmergencyRecoveryArmed(sessionId),
                emergency_recovery_no_head_escape: recoveryNoHeadEscape,
                detected_context_limit: overflowState.detectedContextLimit,
                detected_context_limit_model_key: overflowState.detectedContextLimitModelKey,
            };
            const previousWireCache = wireCaches.get(sessionId);
            let wireDelta:
                | {
                      rawStart: number;
                      wireStart: number;
                      after: string;
                      ckAfter: string;
                      nativeAfter: string;
                  }
                | undefined;
            if (
                !state.forceFullWire &&
                passInputs.emergency_recovery_armed !== true &&
                previousWireCache &&
                messages.length >= previousWireCache.rawCount
            ) {
                const appending = messages.length > previousWireCache.rawCount;
                const lastMessage = messages.at(-1);
                // Delta transport is only sound when the prefix the module would reuse is
                // byte-identical to what OpenCode holds NOW. Count/last-signature checks
                // cover the tail; this covers in-place mutation of an older message (an
                // ephemeral reminder wrapper, a late tool completion) which must force a
                // full send instead of riding a stale-prefix delta.
                const prefixGuardStartedAt = performance.now();
                const prefixIntact = prefixContentSnapshotsMatch(
                    messages,
                    previousWireCache,
                    Math.max(0, previousWireCache.rawCount - 1),
                );
                logStage(sessionId, "prefixGuard", prefixGuardStartedAt, timings);
                const lastChanged =
                    !appending && lastMessage !== undefined
                        ? messageCacheSignature(lastMessage) !== previousWireCache.rawLastSignature
                        : false;
                const replaceExistingTail =
                    lastChanged || (appending && previousWireCache.rawLastVisible);
                const rawStart = replaceExistingTail
                    ? Math.max(0, previousWireCache.rawCount - 1)
                    : previousWireCache.rawCount;
                const replaceExistingWireTail =
                    previousWireCache.rawLastVisible && (lastChanged || appending);
                const wireStart = replaceExistingWireTail
                    ? Math.max(0, previousWireCache.wireCount - 1)
                    : previousWireCache.wireCount;
                const ckAfter =
                    wireStart === previousWireCache.wireCount - 1
                        ? previousWireCache.ckPrefixFingerprintBeforeLast
                        : wireStart === previousWireCache.wireCount
                          ? previousWireCache.ckFingerprint
                          : undefined;
                const nativeAfter =
                    rawStart === previousWireCache.rawCount - 1
                        ? previousWireCache.nativePrefixFingerprintBeforeLast
                        : rawStart === previousWireCache.rawCount
                          ? previousWireCache.nativeFingerprint
                          : undefined;
                if (prefixIntact && ckAfter !== undefined && nativeAfter !== undefined) {
                    wireDelta = {
                        rawStart,
                        wireStart,
                        ckAfter,
                        nativeAfter,
                        after: previousWireCache.fingerprint,
                    };
                }
            }
            const cloneStartedAt = performance.now();
            const ordinalMessages = wireDelta ? messages.slice(wireDelta.rawStart) : messages;
            logStage(
                sessionId,
                "clone",
                cloneStartedAt,
                timings,
                wireDelta ? "mode=projection-tail" : "mode=projection-full",
            );
            const provisionalBase = wireDelta
                ? (() => {
                      for (let index = wireDelta.rawStart - 1; index >= 0; index -= 1) {
                          const priorId = messageIdOf(messages[index]);
                          if (!priorId) continue;
                          const prior = state.idOrdinalMemo.get(priorId);
                          if (prior !== undefined) return prior;
                      }
                      return state.ordinalMemoCanonicalCount;
                  })()
                : undefined;
            const ordinalStartedAt = performance.now();
            let resolved = await resolveOrdinalsForModule({
                sessionId,
                messages: ordinalMessages,
                generation: state.moduleGeneration,
                memoGeneration: state.idOrdinalMemoGeneration,
                memo: state.idOrdinalMemo,
                memoAnchor: state.ordinalMemoAnchor,
                memoStoredCount: state.ordinalMemoStoredCount,
                memoCanonicalCount: state.ordinalMemoCanonicalCount,
                provisionalBase,
            });
            logStage(sessionId, "ordinalResolve", ordinalStartedAt, timings);
            if (!resolved.ok) {
                // A removal or persistence race can invalidate every durable memo field.
                // Retry once from a clean full-array prime on both delta and full attempts.
                wireDelta = undefined;
                resetOrdinalMemo(state);
                const fullOrdinalStartedAt = performance.now();
                resolved = await resolveOrdinalsForModule({
                    sessionId,
                    messages,
                    generation: state.moduleGeneration,
                    memoGeneration: state.idOrdinalMemoGeneration,
                    memo: state.idOrdinalMemo,
                    memoAnchor: state.ordinalMemoAnchor,
                    memoStoredCount: state.ordinalMemoStoredCount,
                    memoCanonicalCount: state.ordinalMemoCanonicalCount,
                });
                logStage(
                    sessionId,
                    "ordinalResolve",
                    fullOrdinalStartedAt,
                    timings,
                    "fallback=clean_full",
                );
            }
            if (!resolved.ok) {
                throw new Error(
                    `rust ordinal ${resolved.reason}: messageId=${resolved.messageId ?? "unknown"} ` +
                        `index=${resolved.messageIndex ?? "unknown"} role=${resolved.messageRole ?? "unknown"}`,
                );
            }
            state.idOrdinalMemoGeneration = resolved.memoGeneration;
            state.ordinalMemoAnchor = resolved.memoAnchor;
            state.ordinalMemoStoredCount = resolved.memoStoredCount;
            state.ordinalMemoCanonicalCount = resolved.memoCanonicalCount;

            const syncPass = {
                db: deps.db,
                sessionId,
                projectPath:
                    deps.memoryConfig?.enabled && directory.length > 0
                        ? resolveProjectIdentity(directory)
                        : deps.projectPath,
                nowMs: Date.now(),
            };
            const projectRoot = options.projectRoot ?? directory;
            const memoryProjectPath =
                deps.memoryConfig?.enabled && directory.length > 0
                    ? resolveProjectIdentity(directory)
                    : deps.projectPath;
            const stateSyncStartedAt = performance.now();
            const authoritySeqAdoption = { used: false };
            let stateSyncRetryBusy = false;
            try {
                await prepareRustMemoryAuthority({
                    db: deps.db,
                    module: options.moduleClient,
                    projectPath: memoryProjectPath ?? projectRoot,
                    projectRoot,
                    state,
                    allowProtocolBypassForTests: options.allowAuthorityProtocolBypassForTests,
                    onProjectPrepared: options.onProjectPrepared,
                });
                if (options.memorySyncRequestedSessions?.delete(sessionId)) {
                    // A memory tool call can complete after the prior authority pass has
                    // acknowledged its watermarks. Rewind only memory watermarks so the
                    // next pass ships the mutation delta without reseeding compartments.
                    const watermarks = state.lastAckedWatermarks;
                    if (watermarks) {
                        state.lastAckedWatermarks = {
                            ...watermarks,
                            memory_id: 0,
                            memory_mutation_id: 0,
                        };
                    }
                }
                const stateSyncResult = await syncModuleState({
                    client: {
                        call: callModule,
                        stateSyncCapabilities: options.moduleClient.stateSyncCapabilities
                            ? (capabilityArgs) =>
                                  options.moduleClient.stateSyncCapabilities!(capabilityArgs)
                            : undefined,
                    },
                    state,
                    pass: syncPass,
                    projectRoot,
                    force: !state.initialized,
                    options: {
                        authority: true,
                        authorityState: state.memoryAuthorityReady ? "MODULE" : undefined,
                        authoritySeqAdoption,
                    },
                });
                stateSyncRetryBusy = stateSyncResult.status === "retry_busy";
            } finally {
                logStage(sessionId, "stateSync", stateSyncStartedAt, timings);
            }
            const wireBuildStartedAt = performance.now();
            const encodedInput = encodeOpenCodeMessagesToCk(resolved.annotatedInput);
            timings.wireMessages = wireDelta
                ? messages.length - wireDelta.rawStart
                : messages.length;
            let pendingWireCache: RustWireCache = (() => {
                const rawLast = messages.at(-1);
                if (!wireDelta || !previousWireCache) {
                    const ckFingerprint = buildWireFingerprint(encodedInput);
                    const nativeFingerprint = buildWireFingerprint(messages);
                    return {
                        rawCount: messages.length,
                        wireCount: encodedInput.length,
                        rawLastId: rawLast ? messageIdOf(rawLast) : null,
                        rawLastSignature: rawLast ? messageCacheSignature(rawLast) : null,
                        rawLastVisible:
                            rawLast !== undefined &&
                            encodedInput.some((entry) => entry.mid === messageIdOf(rawLast)),
                        ckFingerprint: ckFingerprint.fingerprint,
                        ckPrefixFingerprintBeforeLast: ckFingerprint.prefixFingerprintBeforeLast,
                        nativeFingerprint: nativeFingerprint.fingerprint,
                        nativePrefixFingerprintBeforeLast:
                            nativeFingerprint.prefixFingerprintBeforeLast,
                        rawContentSnapshots: contentSnapshotsFor(messages),
                        fingerprint: `${ckFingerprint.fingerprint}|${nativeFingerprint.fingerprint}`,
                    };
                }
                let ckFingerprint = wireDelta.ckAfter;
                let ckPrefixFingerprintBeforeLast = ckFingerprint;
                for (let index = 0; index < encodedInput.length; index += 1) {
                    if (index === encodedInput.length - 1)
                        ckPrefixFingerprintBeforeLast = ckFingerprint;
                    ckFingerprint = advanceWireFingerprint(ckFingerprint, encodedInput[index]);
                }
                const nativeMessages = messages.slice(wireDelta.rawStart);
                let nativeFingerprint = wireDelta.nativeAfter;
                let nativePrefixFingerprintBeforeLast = nativeFingerprint;
                for (let index = 0; index < nativeMessages.length; index += 1) {
                    if (index === nativeMessages.length - 1)
                        nativePrefixFingerprintBeforeLast = nativeFingerprint;
                    nativeFingerprint = advanceWireFingerprint(
                        nativeFingerprint,
                        nativeMessages[index],
                    );
                }
                const rawLastVisible =
                    rawLast !== undefined &&
                    encodedInput.some((entry) => entry.mid === messageIdOf(rawLast));
                return {
                    rawCount: messages.length,
                    wireCount: wireDelta.wireStart + encodedInput.length,
                    rawLastId: rawLast ? messageIdOf(rawLast) : null,
                    rawLastSignature: rawLast ? messageCacheSignature(rawLast) : null,
                    rawLastVisible,
                    ckFingerprint,
                    ckPrefixFingerprintBeforeLast,
                    nativeFingerprint,
                    nativePrefixFingerprintBeforeLast,
                    // Preserve snapshots for messages reused from the previous wire cache,
                    // and recompute them only for messages included in this request's suffix.
                    rawContentSnapshots: [
                        ...previousWireCache.rawContentSnapshots.slice(0, wireDelta.rawStart),
                        ...contentSnapshotsFor(messages.slice(wireDelta.rawStart)),
                    ],
                    fingerprint: `${ckFingerprint}|${nativeFingerprint}`,
                };
            })();
            // Final-wire estimation is only needed while the host's durable overflow
            // latch is armed. It can then clear that latch, never arm one, so normal
            // large-payload passes avoid an unnecessary full-wire tokenization.
            const finalWireEstimate =
                passInputs.emergency_recovery_armed === true
                    ? estimateFinalWireInputTokens({
                          messages,
                          systemPromptTokens: sessionMeta.systemPromptTokens,
                          providerID: model?.providerID,
                          modelID: model?.modelID,
                          agentName: deps.getNotificationParams?.(sessionId)?.agent,
                      })
                    : undefined;
            let body = buildTransformBody({
                sessionId,
                input: encodedInput,
                nativeMessages: wireDelta ? messages.slice(wireDelta.rawStart) : messages,
                fullArrayFingerprint: pendingWireCache.fingerprint,
                tailDelta: wireDelta
                    ? {
                          after: wireDelta.after,
                          replaceFrom: wireDelta.wireStart,
                          nativeReplaceFrom: wireDelta.rawStart,
                      }
                    : undefined,
                passInputs,
                usage: {
                    ...passUsage(usage, contextLimit),
                    final_wire_input_tokens: finalWireEstimate?.tokens ?? 0,
                    final_wire_trusted: finalWireEstimate?.trusted === true,
                },
                modelKey: modelKey ?? null,
                providerId: model?.providerID ?? null,
                systemPromptHash: sessionMeta.systemPromptHash ?? "",
                upgradeState: String(passInputs.upgrade_state ?? ""),
                midTurn,
                prevResponseCompletedAtMs:
                    sessionMeta.lastResponseTime > 0 ? sessionMeta.lastResponseTime : undefined,
                requestObservedAtMs,
                channel2NudgeState: String(passInputs.channel2_nudge_state ?? ""),
                emergencyRecoveryArmed: passInputs.emergency_recovery_armed === true,
            });
            const pages = buildPagedModuleTransformPayloads(body);
            logStage(
                sessionId,
                "wireBuild",
                wireBuildStartedAt,
                timings,
                wireDelta ? `mode=tail_delta input=${encodedInput.length}` : "mode=full",
            );
            let response: Record<string, unknown> | undefined;
            for (const [index, page] of pages.entries()) {
                timings.transportBytes += Buffer.byteLength(JSON.stringify(page));
                const transportStartedAt = performance.now();
                response = responseValue(
                    await callModule({
                        sessionId,
                        projectRoot,
                        method: "transform",
                        body: page,
                    }),
                );
                timings.transportPages += 1;
                logStage(
                    sessionId,
                    "transport",
                    transportStartedAt,
                    timings,
                    `page=${index + 1}/${pages.length}`,
                );
            }
            if (!response) throw new Error("rust module returned no transform response");
            captureResponseTelemetry(response);
            if (isNeedFullSync(response)) {
                // need_full_sync is a WIRE-layer miss: the module (often freshly
                // restarted, with its process-local Ready snapshot gone) cannot
                // reconstruct the array from a tail delta. It says nothing about
                // context.db state — the module's durable store survives restarts —
                // so this arm must NOT re-seed state. A full state re-seed here
                // cost 19-74s per pass on a live session (the SUBC loop) and
                // hammered the module hard enough to crash-loop it.
                state.forceFullWire = true;
                if (wireDelta) {
                    const retryOrdinalStartedAt = performance.now();
                    let retryResolved = await resolveOrdinalsForModule({
                        sessionId,
                        messages,
                        generation: state.moduleGeneration,
                        memoGeneration: state.idOrdinalMemoGeneration,
                        memo: state.idOrdinalMemo,
                        memoAnchor: state.ordinalMemoAnchor,
                        memoStoredCount: state.ordinalMemoStoredCount,
                        memoCanonicalCount: state.ordinalMemoCanonicalCount,
                    });
                    logStage(
                        sessionId,
                        "ordinalResolve",
                        retryOrdinalStartedAt,
                        timings,
                        "retry=full",
                    );
                    if (!retryResolved.ok) {
                        resetOrdinalMemo(state);
                        retryResolved = await resolveOrdinalsForModule({
                            sessionId,
                            messages,
                            generation: state.moduleGeneration,
                            memoGeneration: state.idOrdinalMemoGeneration,
                            memo: state.idOrdinalMemo,
                            memoAnchor: state.ordinalMemoAnchor,
                            memoStoredCount: state.ordinalMemoStoredCount,
                            memoCanonicalCount: state.ordinalMemoCanonicalCount,
                        });
                    }
                    if (!retryResolved.ok) {
                        throw new Error(`rust ordinal ${retryResolved.reason} during full retry`);
                    }
                    state.idOrdinalMemoGeneration = retryResolved.memoGeneration;
                    state.ordinalMemoAnchor = retryResolved.memoAnchor;
                    state.ordinalMemoStoredCount = retryResolved.memoStoredCount;
                    state.ordinalMemoCanonicalCount = retryResolved.memoCanonicalCount;
                    const retryEncodedInput = encodeOpenCodeMessagesToCk(
                        retryResolved.annotatedInput,
                    );
                    timings.wireMessages = messages.length;
                    const retryCkFingerprint = buildWireFingerprint(retryEncodedInput);
                    const retryNativeFingerprint = buildWireFingerprint(messages);
                    const retryRawLast = messages.at(-1);
                    pendingWireCache = {
                        rawCount: messages.length,
                        wireCount: retryEncodedInput.length,
                        rawLastId: retryRawLast ? messageIdOf(retryRawLast) : null,
                        rawLastSignature: retryRawLast ? messageCacheSignature(retryRawLast) : null,
                        rawLastVisible:
                            retryRawLast !== undefined &&
                            retryEncodedInput.some(
                                (entry) => entry.mid === messageIdOf(retryRawLast),
                            ),
                        ckFingerprint: retryCkFingerprint.fingerprint,
                        ckPrefixFingerprintBeforeLast:
                            retryCkFingerprint.prefixFingerprintBeforeLast,
                        nativeFingerprint: retryNativeFingerprint.fingerprint,
                        nativePrefixFingerprintBeforeLast:
                            retryNativeFingerprint.prefixFingerprintBeforeLast,
                        rawContentSnapshots: contentSnapshotsFor(messages),
                        fingerprint: `${retryCkFingerprint.fingerprint}|${retryNativeFingerprint.fingerprint}`,
                    };
                    const retryWireBuildStartedAt = performance.now();
                    body = buildTransformBody({
                        sessionId,
                        input: retryEncodedInput,
                        nativeMessages: messages,
                        fullArrayFingerprint: pendingWireCache.fingerprint,
                        passInputs,
                        usage: {
                            ...passUsage(usage, contextLimit),
                            final_wire_input_tokens: finalWireEstimate?.tokens ?? 0,
                            final_wire_trusted: finalWireEstimate?.trusted === true,
                        },
                        modelKey: modelKey ?? null,
                        providerId: model?.providerID ?? null,
                        systemPromptHash: sessionMeta.systemPromptHash ?? "",
                        upgradeState: String(passInputs.upgrade_state ?? ""),
                        midTurn,
                        prevResponseCompletedAtMs:
                            sessionMeta.lastResponseTime > 0
                                ? sessionMeta.lastResponseTime
                                : undefined,
                        requestObservedAtMs,
                        channel2NudgeState: String(passInputs.channel2_nudge_state ?? ""),
                        emergencyRecoveryArmed: passInputs.emergency_recovery_armed === true,
                    });
                    logStage(
                        sessionId,
                        "wireBuild",
                        retryWireBuildStartedAt,
                        timings,
                        "retry=full",
                    );
                }
                response = undefined;
                const retryWireBuildStartedAt = performance.now();
                const retryPages = buildPagedModuleTransformPayloads(body);
                logStage(sessionId, "wireBuild", retryWireBuildStartedAt, timings, "retry=full");
                for (const [index, page] of retryPages.entries()) {
                    timings.transportBytes += Buffer.byteLength(JSON.stringify(page));
                    const transportStartedAt = performance.now();
                    response = responseValue(
                        await callModule({
                            sessionId,
                            projectRoot,
                            method: "transform",
                            body: page,
                        }),
                    );
                    timings.transportPages += 1;
                    logStage(
                        sessionId,
                        "transport",
                        transportStartedAt,
                        timings,
                        `page=${index + 1}/${retryPages.length} retry=full`,
                    );
                }
                if (!response) throw new Error("rust module returned no retry transform response");
                captureResponseTelemetry(response);
                if (isNeedFullSync(response)) {
                    // The retry was a genuine full send; a second need_full_sync means
                    // the module cannot serve at all. Throwing routes this through the
                    // failure ladder (LKG replay now, park after three) instead of
                    // letting an empty-output response masquerade as a served pass.
                    throw new Error("rust module still requires full sync after a full-array send");
                }
            }
            const deliveryPassIds = noteDeliveryPassIds(response);
            const sendNoteDeliveryDisposition = async (
                method: "transform.ack" | "transform.nack",
            ) => {
                for (const transformPassId of deliveryPassIds) {
                    await callModule({
                        sessionId,
                        projectRoot,
                        method,
                        body: {
                            method,
                            v: 1,
                            session_id: sessionId,
                            transform_pass_id: transformPassId,
                        },
                    });
                }
            };
            let appliedMessages: unknown[];
            const applyStartedAt = performance.now();
            try {
                // Validate and postprocess the module result before touching the caller-owned
                // array. This keeps failure recovery O(1) on the steady path: no defensive
                // full-array clone is needed just in case boundary validation rejects it.
                appliedMessages = applyNativeMessagesVerbatim({ messages: [] }, response);
                runRustModePostprocess({
                    db: deps.db,
                    sessionId,
                    messages: appliedMessages as MessageLike[],
                    projectPath: memoryProjectPath,
                    fullFeatureMode: !sessionMeta.isSubagent,
                });
                const boundaryId = response.boundary_id;
                if (typeof boundaryId === "string" && boundaryId.length > 0) {
                    assertNativeBoundary(appliedMessages, sessionId, boundaryId);
                }
                logStage(sessionId, "apply", applyStartedAt, timings);
                const lkgSnapshotStartedAt = performance.now();
                const explicitDecision =
                    typeof response.decision === "string" ||
                    typeof response.action === "string" ||
                    typeof response.cache_bust === "boolean";
                const decisionUpper = decision.toUpperCase();
                const cacheBustingPass =
                    response.cache_bust === true ||
                    decisionUpper === "HARD" ||
                    decisionUpper === "MIGRATE_HARD" ||
                    decisionUpper === "EXECUTE" ||
                    // SOFT re-renders m1 (delta folds, coverage folds): the served
                    // bytes changed, so the previous LKG snapshot is already stale.
                    // Omitting SOFT here left the slot holding pre-fold bytes that
                    // failed anchor validation on the next failure — and the miss
                    // fell through to a 965K-token raw serve on a live session.
                    decisionUpper === "SOFT" ||
                    !explicitDecision;
                // Slots are process-memory: after a serve restart every session has
                // NO snapshot until its next busting pass, and any transport failure
                // in that window falls through LKG to a raw full-array serve. The
                // first applied pass of a process seeds the slot unconditionally.
                if (cacheBustingPass || !getSlot(sessionId)) {
                    const captured = captureRustResponse(sessionId, messages, response);
                    if (cacheBustingPass && !captured) {
                        dropSlot(sessionId, "lkg_refresh_declined");
                    }
                }
                logStage(
                    sessionId,
                    "lkgSnapshot",
                    lkgSnapshotStartedAt,
                    timings,
                    cacheBustingPass ? "captured=true" : "captured=false",
                );
                const applyReplaceStartedAt = performance.now();
                replaceMessagesInPlace(output, appliedMessages);
                logStage(sessionId, "apply", applyReplaceStartedAt, timings);
            } catch (error) {
                logStage(sessionId, "apply", applyStartedAt, timings, "failed=true");
                try {
                    await sendNoteDeliveryDisposition("transform.nack");
                } catch (nackError) {
                    sessionLog(sessionId, "rust note delivery nack failed (ignored):", nackError);
                }
                throw error;
            }
            if (deliveryPassIds.length > 0) {
                try {
                    await sendNoteDeliveryDisposition("transform.ack");
                } catch (ackError) {
                    // Leave the delivery unacknowledged when the acknowledgement transport
                    // fails; the module will re-serve those bytes on a later natural bust.
                    sessionLog(sessionId, "rust note delivery ack failed (will retry):", ackError);
                }
            }
            if (!stateSyncRetryBusy) {
                state.initialized = true;
                state.seedPassPending = false;
            }
            state.consecutiveFailures = 0;
            state.parked = false;
            state.passesSincePark = 0;
            state.warningSent = false;
            // An applied pass proves the module reconstructed the wire; delta
            // transport may resume on the next pass.
            state.forceFullWire = false;

            const directiveText = directiveTextOf(response);
            if (syntheticTurn) {
                // A pending lease must not escape the breaker through the terminal
                // event handler while synthetic turns are cascading.
                try {
                    casChannel2NudgeState(deps.db, sessionId, "pending", "");
                    deps.channel2DirectiveTextBySession?.delete(sessionId);
                } catch {
                    // The delivery lease remains authoritative if another sender owns it.
                }
            } else if (directiveText) {
                // The module only recommends Channel 2 here. Delivery must wait for the
                // terminal message.updated boundary, where the host's shared claim/CAS
                // path revalidates the lease and coalesces the synthetic user turn.
                try {
                    casChannel2NudgeState(deps.db, sessionId, "", "pending");
                    deps.channel2DirectiveTextBySession?.set(sessionId, directiveText);
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "rust channel2 pending-intent CAS failed (ignored):",
                        error,
                    );
                }
            }
            if (options.moduleClient.mirrorPull) {
                try {
                    await pullMemoryMirrorOnce({
                        db: deps.db,
                        module: options.moduleClient as AuthorityModuleClient,
                    });
                } catch (error) {
                    sessionLog(sessionId, "rust memory mirror-back failed (ignored):", error);
                }
            }
            if (options.moduleClient.getCompartmentsAfter) {
                try {
                    await mirrorModuleCompartments({
                        db: deps.db,
                        sessionId,
                        reader: {
                            getCompartmentsAfter: (mirroredSessionId, afterSequence) =>
                                options.moduleClient.getCompartmentsAfter!(
                                    mirroredSessionId,
                                    afterSequence,
                                ),
                        } satisfies ModuleCompartmentReader,
                    });
                } catch (error) {
                    sessionLog(sessionId, "rust compartment mirror-back failed (ignored):", error);
                }
            }
            // TS mode disarms overflow recovery when the historian publishes; in rust
            // mode publication happens module-side, so the applied pass that lands a
            // materialization is the equivalent proof the session recovered. Without
            // this clear the latch stays armed forever, and its side effects persist
            // (forced 95% pressure, LKG refusing to cover transport failures — the
            // 20:38Z incident escalated to a 1.6M-token raw serve exactly this way).
            if (
                materializeReason !== "none" &&
                passUsageSnapshot.percentage < 80 &&
                getOverflowState(deps.db, sessionId).needsEmergencyRecovery
            ) {
                try {
                    clearEmergencyRecovery(deps.db, sessionId);
                    sessionLog(
                        sessionId,
                        `rust pass disarmed emergency recovery after ${materializeReason} at ${passUsageSnapshot.percentage.toFixed(1)}% usage`,
                    );
                } catch {
                    // Best-effort: the next materializing pass retries the disarm.
                }
            }
            wireCaches.set(sessionId, pendingWireCache);
            appliedAt = performance.now();
            finishPass(true);
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.startsWith("rust transform wire invariant failed")
            ) {
                sessionLog(
                    sessionId,
                    "rust transform wire invariant failed; LKG replay required",
                    error,
                );
            }
            if (emergencyFailClosed) {
                // At 95% of a trusted limit, or while provider overflow recovery is armed,
                // any adapter failure aborts. Parking controls retry cadence, not fallback admission.
                markFailure(sessionId, state, error);
                finishPass(false, false);
                throw new EmergencyFailClosedError(
                    "Rust Magic Context was unavailable at a provider-proven context limit",
                    { cause: error },
                );
            }
            // Validation happens before the caller-owned array is replaced, so the
            // original live array is still available for fail-open replay.
            const replayed = replayLastGood(
                sessionId,
                messages,
                output,
                sessionMeta.systemPromptTokens,
            );
            if (!replayed) replaceMessagesInPlace(output, messages);
            servedFrom = replayed ? "lkg" : "raw";
            if (decision.toLowerCase() !== "need_full_sync") decision = "error";
            materializeReason = "none";
            markFailure(sessionId, state, error);
            finishPass(false);
            return;
        }
    };

    return {
        run,
        clearSession(sessionId: string): void {
            dropSlot(sessionId, "session-deleted");
            states.delete(sessionId);
            wireCaches.delete(sessionId);
            options.moduleClient.closeSession?.(sessionId);
        },
        invalidateWireState,
        getState(sessionId: string): Readonly<RustSessionState> {
            return {
                ...ensureState(states, sessionId),
                idOrdinalMemo: new Map(ensureState(states, sessionId).idOrdinalMemo),
            };
        },
    };
}

export async function runRustModeTransform(
    transform: ReturnType<typeof createRustModeTransform>,
    sessionId: string,
    messages: MessageLike[],
    output: { messages: unknown[] },
    sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
): Promise<void> {
    await transform.run(sessionId, messages, output, sessionMeta);
}

export const __rustModeTransformTest = {
    applyNativeMessagesVerbatim,
    contentSnapshotsFor,
    snapshotTags: {
        array: SNAPSHOT_ARRAY,
        object: SNAPSHOT_OBJECT,
        key: SNAPSHOT_KEY,
        string: SNAPSHOT_STRING,
        number: SNAPSHOT_NUMBER,
        boolean: SNAPSHOT_BOOLEAN,
        null: SNAPSHOT_NULL,
        undefined: SNAPSHOT_UNDEFINED,
    },
    messageContentSnapshot,
    messageMatchesContentSnapshot,
    buildTransformBody,
    formatRustPassLog,
    createRustModeTransform,
    directiveTextOf,
    prepareRustMemoryAuthority,
};
