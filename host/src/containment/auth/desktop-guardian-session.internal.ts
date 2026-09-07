
type ContainmentRole = string;

export type ContainmentCorrelation = Readonly<{
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
}>;

export type ContainmentDeadline = Readonly<{ deadlineUnixMs: number }>;
type ContainmentPrivateFrame = Readonly<{ privateFrame: Uint8Array }>;

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
}>;

export type DesktopGuardianSession = Readonly<{
  arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: ContainmentRole; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: ContainmentRole }>): Promise<GuardianAck>;
  close(): Promise<void>;
}>;
