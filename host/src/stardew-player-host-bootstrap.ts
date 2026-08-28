const stardewPlayerHostBootstrapClaimBrand: unique symbol = Symbol(
  "stardewPlayerHostBootstrapClaim",
);
void stardewPlayerHostBootstrapClaimBrand;

export type StardewPlayerHostBootstrapRequest = Readonly<{
  playerId: string;
  companionId: string;
  browserSessionId: string;
  expiresAtMs: number;
}>;

export type StardewPlayerHostBootstrapView = Readonly<{
  schemaVersion: 1;
  state: "pending" | "consumed" | "expired" | "revoked";
}>;

/**
 * A composition-minted nominal identity. At runtime it is a frozen empty
 * object; trusted bootstrap facts exist only in the closed composition WeakMap.
 */
export type StardewPlayerHostBootstrapClaim = Readonly<{
  readonly [stardewPlayerHostBootstrapClaimBrand]: never;
}>;

export type StardewPlayerHostBootstrapCapability = Readonly<{
  readView(): StardewPlayerHostBootstrapView;
  consume(browserSessionId: string): StardewPlayerHostBootstrapClaim;
  revoke(): void;
}>;

export type StardewPlayerHostBootstrapBroker = Readonly<{
  confirm(request: StardewPlayerHostBootstrapRequest): StardewPlayerHostBootstrapCapability;
  close(): void;
}>;
