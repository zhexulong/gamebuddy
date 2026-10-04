
type ContainmentRole = string;

export type ContainmentCorrelation = Readonly<{
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
}>;

export type ContainmentDeadline = Readonly<{ deadlineUnixMs: number }>;
export type ContainmentOperationWaitBudget = Readonly<{ operationWaitBudgetMs: number }>;
export type GuardianAck = Readonly<{
  operation: string;
  status: string;
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
  role?: ContainmentRole;
  /**
   * Present only on a recovery acknowledgement. The recovery wire identifies the
   * exact recovery actor instead of a containment role, so a recover ack carries
   * this field and never carries `role`.
   */
  recoveryInstanceId?: string;
}>;

/**
 * OS role token on the recovery wire. The native recovery ingress classifies
 * roles as `playerHost`/`aiClient` while arm/launch/contain speak
 * `player_host`/`ai_client`, so a recovery frame must never be validated
 * against the containment role spelling.
 */
export type GuardianRecoveryRole = "playerHost" | "aiClient";

/** Native classification of one recorded role; `contained` is the only containment result. */
export type GuardianRecoveryClassification = "unavailable" | "quarantined";

/**
 * Terminal acknowledgement of one bounded recovery conversation.
 *
 * The recovery wire answers with the same `unavailable` status both when the
 * Guardian refuses to open the gate at all and when a role cannot be classified
 * as contained. The outcome is therefore separated by the position the
 * conversation reached, never by the raw status text: `gate_held` means the
 * previous lease is still authority and no native recovery ran,
 * `role_classified` means the recovery ran and this exact role was not
 * contained, and `contained` is the only success.
 */
export type GuardianRecoveryAck =
  | Readonly<{ outcome: "gate_held" }>
  | Readonly<{ outcome: "role_classified"; role: GuardianRecoveryRole; classification: GuardianRecoveryClassification }>
  | Readonly<{ outcome: "contained" }>;

/**
 * One bounded recovery conversation.
 *
 * `beginRecovery` is a callback rather than an input: the durable recovering CAS
 * may only run while the Guardian holds the recovery gate, and the post-CAS
 * binding it produces is the frame the native ingress validates against that
 * exact gate. `roleContained` runs after the native classified one role
 * contained and before that role's CAS acknowledgement is written, so a role is
 * never acknowledged as contained before it is durably recorded.
 */
export type DesktopGuardianRecovery = Readonly<{
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
  operationWaitBudgetMs: number;
  recoveryInstanceId: string;
  /** Tokenless pre-CAS gate body: the exact lease binding the recovery gate must acquire. */
  preCasFrame: Uint8Array;
  /** Durable recovering CAS; returns the post-CAS binding frame. */
  beginRecovery: () => Promise<Uint8Array>;
  /** Durable per-role containment CAS, invoked once per role the native classified contained. */
  roleContained: (role: GuardianRecoveryRole) => Promise<void>;
}>;

/**
 * The two wire primitives one recovery conversation needs. A write is ordered
 * and is not answered on its own: the broker answers two written frames with one
 * acknowledgement, so `receive` must be installed before the frames it answers
 * are written.
 */
export type DesktopGuardianRecoveryTransport = Readonly<{
  write(frame: Readonly<Record<string, unknown>>): void;
  receive(): Promise<Record<string, unknown>>;
}>;

export type DesktopGuardianSession = Readonly<{
  arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: ContainmentRole; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; role: ContainmentRole }>): Promise<GuardianAck>;
  /**
   * Drives the complete bounded recovery conversation and reports its terminal
   * outcome. Recovery is a chain of durable transitions rather than one command,
   * so it is a single operation: a conversation that is refused or interrupted
   * reports `gate_held` or a role classification, never a containment it did not
   * earn.
   */
  recover(input: DesktopGuardianRecovery): Promise<GuardianRecoveryAck>;
  close(): Promise<void>;
}>;
