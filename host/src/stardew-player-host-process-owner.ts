// Public, redacted Player-Host process ownership surface. Construction and all
// launch-registration authority are private to stardew-private-bootstrap-composer.

export type StardewPlayerHostProcessStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "player_host_launch_pending" }
  | { readonly kind: "awaiting_player_host_attestation" }
  | { readonly kind: "player_host_stopped" };

export type LaunchPlayerHostInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
}>;

export type StopOwnedPlayerHostResult =
  | { readonly kind: "no_owned_player_host"; readonly killed: false }
  | { readonly kind: "already_stopped"; readonly killed: false }
  | { readonly kind: "identity_probe_failed"; readonly killed: false }
  | { readonly kind: "identity_mismatch"; readonly killed: false }
  | { readonly kind: "termination_failed"; readonly killed: false }
  | { readonly kind: "terminated"; readonly killed: true };

const stardewPlayerHostLaunchReservationBrand: unique symbol = Symbol("stardewPlayerHostLaunchReservation");
void stardewPlayerHostLaunchReservationBrand;

/**
 * A manager-minted nominal identity. At runtime it is a frozen empty object;
 * its trusted launch facts exist only in the closed composition's WeakMap.
 */
export type StardewPlayerHostLaunchReservation = Readonly<{
  readonly [stardewPlayerHostLaunchReservationBrand]: never;
}>;

export type StardewPlayerHostProcessOwner = Readonly<{
  readStatus(): StardewPlayerHostProcessStatus;
  reservePlayerHostLaunch(): StardewPlayerHostLaunchReservation;
  stopOwnedPlayerHost(): StopOwnedPlayerHostResult;
  /**
   * Records that the Player Host this owner launched has ENDED, so the attempt it belonged to does
   * not hold the one-shot launch reservation any more and the next attempt may reserve its own.
   *
   * It is deliberately not `stopOwnedPlayerHost`: nothing here kills, contains or probes anything,
   * and the ending it records is the Guardian's own `role_exited` report - an ending the Host did
   * not cause (ADR-0007). It advances only the CONTAINED shape, where this owner holds no pid of
   * its own; an owner that holds one answers for that process by probe, never by a claim.
   *
   * Idempotent, because the caller is a settle that may be asked twice by two presses.
   */
  notePlayerHostEnded(): void;
}>;

/** Raw OS dependencies accepted only by the explicitly named test support. */
export type StardewPlayerHostProcessSpawnResult = Readonly<{
  pid: number;
  kill(): boolean;
}>;

export type StardewPlayerHostProcessSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
) => StardewPlayerHostProcessSpawnResult;

export type StardewPlayerHostProcessProbeResult = Readonly<{
  pid: number;
  creationDate: string;
}> | null;

export type StardewPlayerHostProcessProbe = (pid: number) => StardewPlayerHostProcessProbeResult;
