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

const stardewPlayerHostLaunchReservationBrand: unique symbol = Symbol(
  "stardewPlayerHostLaunchReservation",
);
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

export type StardewPlayerHostProcessProbe = (
  pid: number,
) => StardewPlayerHostProcessProbeResult;
