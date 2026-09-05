import { createHash } from "node:crypto";

const COMPANION_BOOTSTRAP_EVIDENCE_SCHEMA = "gamebuddy-companion-bootstrap-evidence/v1" as const;
export type CompanionBootstrapEvidence = Readonly<{
  schema: typeof COMPANION_BOOTSTRAP_EVIDENCE_SCHEMA;
  evidenceClass: "deterministic_bootstrap_composition";
  challengeSha256: string;
  protocolVersion: 1;
  launchBindingSha256: string;
  runtimeInstanceSha256: string;
  controlReady: true;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
/** Must match the launcher D0 deadline: attest-or-tear-down is bounded. */
const DETERMINISTIC_BOOTSTRAP_DELIVERY_DEADLINE_MS = 1_500;

/** Creates the redacted, source-owned D0 attestation; raw launch material and runtime values never cross this boundary. */
export function createCompanionBootstrapEvidence(
  input: Readonly<{ challengeSha256: string; launchBinding: string; runtimeInstanceId: string }>,
): CompanionBootstrapEvidence {
  if (!SHA256.test(input.challengeSha256) || !validOpaque(input.launchBinding) || !validOpaque(input.runtimeInstanceId))
    throw new Error("invalid_companion_bootstrap_evidence_input");
  return Object.freeze({
    schema: COMPANION_BOOTSTRAP_EVIDENCE_SCHEMA,
    evidenceClass: "deterministic_bootstrap_composition",
    challengeSha256: input.challengeSha256,
    protocolVersion: 1,
    launchBindingSha256: sha256(input.launchBinding),
    runtimeInstanceSha256: sha256(input.runtimeInstanceId),
    controlReady: true,
  });
}

/** Strictly accepts the sole public D0 evidence shape, with no extension or raw-evidence fields. */
export async function deliverCompanionBootstrapEvidence(
  send: (
    message: Readonly<{ schema: "gamebuddy-production-bootstrap-evidence/v1"; evidence: CompanionBootstrapEvidence }>,
    callback: (error: Error | null) => void,
  ) => boolean,
  evidence: CompanionBootstrapEvidence,
  deadlineMs = DETERMINISTIC_BOOTSTRAP_DELIVERY_DEADLINE_MS,
): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
    throw new Error("invalid_deterministic_bootstrap_delivery_deadline");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timeout = setTimeout(
      () => settle(new Error("deterministic_bootstrap_evidence_delivery_timeout")),
      deadlineMs,
    );
    try {
      if (
        !send(Object.freeze({ schema: "gamebuddy-production-bootstrap-evidence/v1", evidence }), (error) =>
          settle(error ?? undefined),
        )
      ) {
        settle(new Error("deterministic_bootstrap_evidence_ipc_unavailable"));
      }
    } catch (error) {
      settle(error instanceof Error ? error : new Error("deterministic_bootstrap_evidence_ipc_unavailable"));
    }
  });
}

export function parseCompanionBootstrapEvidence(value: unknown): CompanionBootstrapEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_companion_bootstrap_evidence");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "challengeSha256",
    "controlReady",
    "evidenceClass",
    "launchBindingSha256",
    "protocolVersion",
    "runtimeInstanceSha256",
    "schema",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new Error("invalid_companion_bootstrap_evidence");
  if (
    record.schema !== COMPANION_BOOTSTRAP_EVIDENCE_SCHEMA ||
    record.evidenceClass !== "deterministic_bootstrap_composition" ||
    record.protocolVersion !== 1 ||
    record.controlReady !== true ||
    !SHA256.test(String(record.challengeSha256)) ||
    !SHA256.test(String(record.launchBindingSha256)) ||
    !SHA256.test(String(record.runtimeInstanceSha256))
  )
    throw new Error("invalid_companion_bootstrap_evidence");
  return Object.freeze(record as unknown as CompanionBootstrapEvidence);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function validOpaque(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
