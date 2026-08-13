import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * TEST-ONLY, UNMOUNTED authority-routing persistence seam. It has no production
 * ingress, coordinator, backend, or bootstrap integration.
 */
export const CONTINUITY_AUTHORITY_ROUTING_PROTOCOL = 1 as const;
export const CONTINUITY_AUTHORITY_ROUTING_SCHEMA = 1 as const;

export type AuthorityRoutingState =
  | "LEGACY_ACTIVE"
  | "QUIESCING"
  | "LEGACY_SEALED"
  | "SEMANTIC_STAGED"
  | "SEMANTIC_ACTIVE"
  | "QUARANTINED";
export type Authority = "LEGACY" | "SEMANTIC";
export type ExactPrincipal = Readonly<{ continuityId: string; companionId: string; playerId: string }>;
export type RouteRecord = Readonly<{
  principal: ExactPrincipal;
  state: AuthorityRoutingState;
  activeAuthority: Authority | null;
  authorityGeneration: number;
  stagedSnapshotHash: string | null;
  sealManifestHash: string | null;
  projectionHash: string | null;
  readbackHash: string | null;
}>;
export type CutoverOperation = Readonly<{ operationId: string; payload: unknown }>;
export type CurrentRouteReceipt = Readonly<{ outcome: "current"; route: RouteRecord }>;
export type HistoricalRouteReceipt = Readonly<{ outcome: "historical"; historicalRoute: RouteRecord }>;
export type RouteOperationReceipt = CurrentRouteReceipt | HistoricalRouteReceipt;
export class ContinuityAuthorityRoutingError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ContinuityAuthorityRoutingError";
  }
}

export type ContinuityAuthorityRouting = Readonly<{
  initializeLegacy(principal: ExactPrincipal, operation: CutoverOperation): RouteOperationReceipt;
  beginQuiescing(
    principal: ExactPrincipal,
    expectedGeneration: number,
    operation: CutoverOperation,
  ): RouteOperationReceipt;
  cancelQuiescing(
    principal: ExactPrincipal,
    expectedGeneration: number,
    operation: CutoverOperation,
  ): RouteOperationReceipt;
  sealLegacy(
    principal: ExactPrincipal,
    expectedGeneration: number,
    sealManifestHash: string,
    operation: CutoverOperation,
  ): RouteOperationReceipt;
  stageSemantic(
    principal: ExactPrincipal,
    expectedGeneration: number,
    snapshotHash: string,
    operation: CutoverOperation,
  ): RouteOperationReceipt;
  activateSemantic(
    principal: ExactPrincipal,
    expectedGeneration: number,
    input: Readonly<{ snapshotHash: string; sealManifestHash: string; projectionHash: string; readbackHash: string }>,
    operation: CutoverOperation,
  ): RouteOperationReceipt;
  quarantine(principal: ExactPrincipal, expectedGeneration: number, operation: CutoverOperation): RouteOperationReceipt;
  readRoute(principal: ExactPrincipal): RouteRecord | null;
  close(): void;
}>;

type OperationKind =
  | "initializeLegacy"
  | "beginQuiescing"
  | "cancelQuiescing"
  | "sealLegacy"
  | "stageSemantic"
  | "activateSemantic"
  | "quarantine";

export function openContinuityAuthorityRouting(
  db: DatabaseSync,
  versions: Readonly<{ protocol: number; schema: number }>,
): ContinuityAuthorityRouting {
  if (
    versions.protocol !== CONTINUITY_AUTHORITY_ROUTING_PROTOCOL ||
    versions.schema !== CONTINUITY_AUTHORITY_ROUTING_SCHEMA
  )
    throw fail("protocol_schema_mismatch");
  initialize(db);
  let closed = false;
  const open = () => {
    if (closed) throw fail("routing_closed");
  };
  const mutate = (
    kind: OperationKind,
    principal: ExactPrincipal,
    expectedGeneration: number | null,
    inputs: Record<string, unknown>,
    operation: CutoverOperation,
    transition: (row: RouteRecord | null) => Omit<RouteRecord, "principal">,
  ): RouteOperationReceipt => {
    open();
    validatePrincipal(principal);
    validateOperation(operation);
    if (expectedGeneration !== null && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1))
      throw fail("invalid_authority_generation");
    return transaction(db, () => {
      const identityHash = digest({ kind, principal, expectedGeneration, inputs, payload: operation.payload });
      const old = read(db, principal);
      const prior = db
        .prepare(
          "SELECT payload_hash, response_json FROM cutover_operation WHERE continuity_id=? AND companion_id=? AND player_id=? AND operation_id=?",
        )
        .get(principal.continuityId, principal.companionId, principal.playerId, operation.operationId) as
        | { payload_hash: string; response_json: string }
        | undefined;
      if (prior) {
        if (prior.payload_hash !== identityHash) throw fail("cutover_operation_payload_conflict");
        return historical(parseRecord(prior.response_json));
      }
      if (expectedGeneration !== null && (!old || old.authorityGeneration !== expectedGeneration))
        throw fail("authority_generation_conflict");
      const next = freezeRecord({ principal: Object.freeze({ ...principal }), ...transition(old) });
      validateRecord(next);
      db.prepare(
        "INSERT INTO authority_route (continuity_id, companion_id, player_id, state, authority_generation, staged_snapshot_hash, seal_manifest_hash, projection_hash, readback_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(continuity_id, companion_id, player_id) DO UPDATE SET state=excluded.state, authority_generation=excluded.authority_generation, staged_snapshot_hash=excluded.staged_snapshot_hash, seal_manifest_hash=excluded.seal_manifest_hash, projection_hash=excluded.projection_hash, readback_hash=excluded.readback_hash",
      ).run(
        principal.continuityId,
        principal.companionId,
        principal.playerId,
        next.state,
        next.authorityGeneration,
        next.stagedSnapshotHash,
        next.sealManifestHash,
        next.projectionHash,
        next.readbackHash,
      );
      db.prepare("INSERT INTO cutover_operation VALUES (?, ?, ?, ?, ?, ?)").run(
        principal.continuityId,
        principal.companionId,
        principal.playerId,
        operation.operationId,
        identityHash,
        JSON.stringify(next),
      );
      return current(next);
    });
  };
  return Object.freeze({
    initializeLegacy: (p, o) =>
      mutate("initializeLegacy", p, null, {}, o, (old) => {
        if (old) throw fail("route_already_initialized");
        return state("LEGACY_ACTIVE", 1);
      }),
    beginQuiescing: (p, g, o) =>
      mutate("beginQuiescing", p, g, {}, o, (old) => advance(old, "LEGACY_ACTIVE", "QUIESCING")),
    cancelQuiescing: (p, g, o) =>
      mutate("cancelQuiescing", p, g, {}, o, (old) => advance(old, "QUIESCING", "LEGACY_ACTIVE")),
    sealLegacy: (p, g, manifest, o) =>
      mutate("sealLegacy", p, g, { sealManifestHash: manifest }, o, (old) => {
        hash(manifest, "invalid_seal_manifest_hash");
        const next = advance(old, "QUIESCING", "LEGACY_SEALED");
        return { ...next, sealManifestHash: manifest };
      }),
    stageSemantic: (p, g, snapshot, o) =>
      mutate("stageSemantic", p, g, { snapshotHash: snapshot }, o, (old) => {
        hash(snapshot, "invalid_staged_snapshot_hash");
        const next = advance(old, "LEGACY_SEALED", "SEMANTIC_STAGED");
        return { ...next, stagedSnapshotHash: snapshot };
      }),
    activateSemantic: (p, g, input, o) =>
      mutate("activateSemantic", p, g, { ...input }, o, (old) => {
        if (!old || old.state !== "SEMANTIC_STAGED") throw fail("illegal_authority_transition");
        hash(input.snapshotHash, "invalid_activation_hash");
        hash(input.sealManifestHash, "invalid_activation_hash");
        hash(input.projectionHash, "invalid_activation_hash");
        hash(input.readbackHash, "invalid_activation_hash");
        if (
          old.stagedSnapshotHash !== input.snapshotHash ||
          old.sealManifestHash !== input.sealManifestHash ||
          input.projectionHash !== input.readbackHash
        )
          throw fail("semantic_activation_evidence_mismatch");
        return {
          ...state("SEMANTIC_ACTIVE", old.authorityGeneration + 1),
          stagedSnapshotHash: old.stagedSnapshotHash,
          sealManifestHash: old.sealManifestHash,
          projectionHash: input.projectionHash,
          readbackHash: input.readbackHash,
        };
      }),
    quarantine: (p, g, o) =>
      mutate("quarantine", p, g, {}, o, (old) => {
        if (!old || old.state === "QUARANTINED") throw fail("illegal_authority_transition");
        return {
          ...state("QUARANTINED", old.authorityGeneration + 1),
          stagedSnapshotHash: old.stagedSnapshotHash,
          sealManifestHash: old.sealManifestHash,
          projectionHash: old.projectionHash,
          readbackHash: old.readbackHash,
        };
      }),
    readRoute: (p) => {
      open();
      validatePrincipal(p);
      return read(db, p);
    },
    close: () => {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  });
}

function current(route: RouteRecord): CurrentRouteReceipt {
  return Object.freeze({ outcome: "current", route });
}
function historical(historicalRoute: RouteRecord): HistoricalRouteReceipt {
  return Object.freeze({ outcome: "historical", historicalRoute });
}
function freezeRecord(route: RouteRecord): RouteRecord {
  return Object.freeze({ ...route, principal: Object.freeze({ ...route.principal }) });
}
function state(state: AuthorityRoutingState, authorityGeneration: number): Omit<RouteRecord, "principal"> {
  return {
    state,
    activeAuthority: active(state),
    authorityGeneration,
    stagedSnapshotHash: null,
    sealManifestHash: null,
    projectionHash: null,
    readbackHash: null,
  };
}
function advance(
  old: RouteRecord | null,
  from: AuthorityRoutingState,
  to: AuthorityRoutingState,
): Omit<RouteRecord, "principal"> {
  if (!old || old.state !== from) throw fail("illegal_authority_transition");
  return {
    ...state(to, old.authorityGeneration + 1),
    stagedSnapshotHash: old.stagedSnapshotHash,
    sealManifestHash: old.sealManifestHash,
    projectionHash: old.projectionHash,
    readbackHash: old.readbackHash,
  };
}
function active(state: AuthorityRoutingState): Authority | null {
  return state === "LEGACY_ACTIVE" ? "LEGACY" : state === "SEMANTIC_ACTIVE" ? "SEMANTIC" : null;
}
function initialize(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='routing_meta'").get();
  if (exists) {
    const meta = db.prepare("SELECT protocol, schema FROM routing_meta").all() as Array<{
      protocol: number;
      schema: number;
    }>;
    if (meta.length !== 1 || meta[0]?.protocol !== 1 || meta[0]?.schema !== 1) throw fail("protocol_schema_mismatch");
    return;
  }
  transaction(db, () =>
    db.exec(
      "CREATE TABLE routing_meta (protocol INTEGER NOT NULL CHECK(protocol=1), schema INTEGER NOT NULL CHECK(schema=1)); CREATE TABLE authority_route (continuity_id TEXT NOT NULL CHECK(length(continuity_id)>0), companion_id TEXT NOT NULL CHECK(length(companion_id)>0), player_id TEXT NOT NULL CHECK(length(player_id)>0), state TEXT NOT NULL CHECK(state IN ('LEGACY_ACTIVE','QUIESCING','LEGACY_SEALED','SEMANTIC_STAGED','SEMANTIC_ACTIVE','QUARANTINED')), authority_generation INTEGER NOT NULL CHECK(authority_generation>=1), staged_snapshot_hash TEXT, seal_manifest_hash TEXT, projection_hash TEXT, readback_hash TEXT, PRIMARY KEY(continuity_id,companion_id,player_id)); CREATE TABLE cutover_operation (continuity_id TEXT NOT NULL, companion_id TEXT NOT NULL, player_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(continuity_id,companion_id,player_id,operation_id)); INSERT INTO routing_meta VALUES (1,1);",
    ),
  );
}
function read(db: DatabaseSync, p: ExactPrincipal): RouteRecord | null {
  const row = db
    .prepare("SELECT * FROM authority_route WHERE continuity_id=? AND companion_id=? AND player_id=?")
    .get(p.continuityId, p.companionId, p.playerId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const result = freezeRecord({
    principal: Object.freeze({ ...p }),
    state: row.state as AuthorityRoutingState,
    activeAuthority: active(row.state as AuthorityRoutingState),
    authorityGeneration: row.authority_generation as number,
    stagedSnapshotHash: row.staged_snapshot_hash as string | null,
    sealManifestHash: row.seal_manifest_hash as string | null,
    projectionHash: row.projection_hash as string | null,
    readbackHash: row.readback_hash as string | null,
  });
  validateRecord(result);
  return result;
}
function validateRecord(r: RouteRecord): void {
  if (
    active(r.state) !== r.activeAuthority ||
    !Number.isSafeInteger(r.authorityGeneration) ||
    r.authorityGeneration < 1
  )
    throw fail("malformed_persisted_route");
  if (
    (r.state === "SEMANTIC_STAGED" || r.state === "SEMANTIC_ACTIVE") &&
    (!r.stagedSnapshotHash || !r.sealManifestHash)
  )
    throw fail("malformed_persisted_route");
  if (r.state === "SEMANTIC_ACTIVE" && (!r.projectionHash || r.projectionHash !== r.readbackHash))
    throw fail("malformed_persisted_route");
}
function parseRecord(json: string): RouteRecord {
  try {
    const parsed = JSON.parse(json) as RouteRecord;
    validatePrincipal(parsed.principal);
    const result = freezeRecord(parsed);
    validateRecord(result);
    return result;
  } catch {
    throw fail("malformed_persisted_operation");
  }
}
function validatePrincipal(p: ExactPrincipal): void {
  if (!p || !id(p.continuityId) || !id(p.companionId) || !id(p.playerId)) throw fail("exact_principal_required");
}
function validateOperation(o: CutoverOperation): void {
  if (!o || !id(o.operationId)) throw fail("invalid_cutover_operation");
}
function id(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}
function hash(v: unknown, code: string): asserts v is string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw fail(code);
}
function digest(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
function canonical(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype)
    throw fail("invalid_cutover_payload");
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no transaction */
    }
    throw e;
  }
}
function fail(code: string): ContinuityAuthorityRoutingError {
  return new ContinuityAuthorityRoutingError(code);
}
