type Role = "player_host" | "ai_client";

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
  role?: Role;
}>;

export type DesktopGuardianSession = Readonly<{
  arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: Role; privateFrame: Uint8Array }>): Promise<GuardianAck>;
  contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: Role }>): Promise<GuardianAck>;
  close(): Promise<void>;
}>;
