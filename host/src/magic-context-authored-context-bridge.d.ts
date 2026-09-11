declare module "@cortexkit/pi-magic-context/internal/gamebuddy-authored-context-bridge" {
  import type { GameBuddyAuthoredStablePlanProjection, GameBuddyAuthoredStableSourceRef, GameBuddyChatContextScope } from "@cortexkit/pi-magic-context/internal/gamebuddy-stable-context-source";
  export type TavernAuthoredContextRuntimeCapability = Readonly<{
    prepare(transientPreflightId: string): GameBuddyAuthoredStablePlanProjection;
    assertInstall(durableTurnId: string, refs: readonly GameBuddyAuthoredStableSourceRef[]): void;
    clear(): Promise<void>;
  }>;
  export function publishGameBuddyAuthoredStableCatalog(scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability;
  export function replaceGameBuddyAuthoredStableCatalog(currentCapability: TavernAuthoredContextRuntimeCapability, scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability;
}
