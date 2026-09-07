declare module "@cortexkit/pi-magic-context/internal/gamebuddy-authored-context-bridge" {
  export type TavernAuthoredContextRuntimeCapability = Readonly<{
    prepare(transientPreflightId: string): Readonly<{ sourceRefs: readonly Readonly<Record<string, string>>[]; stableTokenCount: number }>;
    assertInstall(durableTurnId: string, refs: readonly Readonly<Record<string, string>>[]): void;
    clear(): Promise<void>;
  }>;
  export function publishGameBuddyAuthoredStableCatalog(scope: Readonly<{
    continuityId: string; sessionId: string; surface: "tavern"; threadId: string;
    profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
  }>, catalog: unknown): TavernAuthoredContextRuntimeCapability;
}
