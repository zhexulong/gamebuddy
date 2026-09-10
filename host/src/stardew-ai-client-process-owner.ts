// Public, redacted AI-client process ownership surface. Construction and all
// launch-registration authority are private to stardew-private-bootstrap-composer.

export type StardewAiClientProcessStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "ai_client_launch_pending" }
  | { readonly kind: "awaiting_ai_client_attestation" }
  | { readonly kind: "ai_client_stopped" };

export type AiClientOwnedProcessGeneration = Readonly<{
  /** Opaque launch generation; never an OS handle, PID, path, or identity secret. */
  readonly launchGeneration: string;
}> | null;

export type ReadOwnedAiClientGenerationResult = Readonly<{
  /** Only the generation of the single currently owned AI process, or null when none is owned. */
  readonly ownedGeneration: AiClientOwnedProcessGeneration;
}>;

export type LaunchAiClientInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
}>;

export type StopOwnedAiClientResult =
  | { readonly kind: "no_owned_ai_client"; readonly killed: false }
  | { readonly kind: "already_stopped"; readonly killed: false }
  | { readonly kind: "identity_probe_failed"; readonly killed: false }
  | { readonly kind: "identity_mismatch"; readonly killed: false }
  | { readonly kind: "termination_failed"; readonly killed: false }
  | { readonly kind: "terminated"; readonly killed: true };

const stardewAiClientLaunchReservationBrand: unique symbol = Symbol(
  "stardewAiClientLaunchReservation",
);
void stardewAiClientLaunchReservationBrand;

/**
 * A manager-minted nominal identity. At runtime it is a frozen empty object;
 * its trusted launch facts exist only in the closed composition's WeakMap.
 */
export type StardewAiClientLaunchReservation = Readonly<{
  readonly [stardewAiClientLaunchReservationBrand]: never;
}>;

export type StardewAiClientProcessOwner = Readonly<{
  readStatus(): StardewAiClientProcessStatus;
  /**
   * Read-only opaque generation of the single currently owned AI process, or
   * null when no AI process is owned. Never includes a PID, path, or handle.
   */
  readOwnedAiClientGeneration(): ReadOwnedAiClientGenerationResult;
  reserveAiClientLaunch(): StardewAiClientLaunchReservation;
  stopOwnedAiClient(): StopOwnedAiClientResult;
}>;

/** Raw OS dependencies accepted only by the explicitly named test support. */
export type StardewAiClientProcessSpawnResult = Readonly<{
  pid: number;
  kill(): boolean;
}>;

export type StardewAiClientProcessSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
) => StardewAiClientProcessSpawnResult;

export type StardewAiClientProcessProbeResult = Readonly<{
  pid: number;
  creationDate: string;
}> | null;

export type StardewAiClientProcessProbe = (
  pid: number,
) => StardewAiClientProcessProbeResult;
