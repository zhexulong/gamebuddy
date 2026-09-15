/// <reference path="./magic-context-memory-facade.d.ts" />

declare module "@cortexkit/pi-magic-context/tavern" {
  export type GameBuddyAuthoredSourceKind = "persona" | "scenario" | "dialogue_examples" | "lorebook_constant";
  export type GameBuddyChatContextScope = Readonly<{
    continuityId: string;
    sessionId: string;
    surface: "tavern";
    threadId: string;
    profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
  }>;
  export type GameBuddyAuthoredStableSource = Readonly<{
    sourceId: string;
    kind: GameBuddyAuthoredSourceKind;
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
  }>;
  export type GameBuddyAuthoredVolatileSource = Readonly<{
    sourceId: string;
    kind: "lorebook_entry";
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
    selectionKeys: readonly string[];
  }>;
  export type GameBuddyAuthoredStableCatalog = Readonly<{
    version: "gamebuddy-authored-context-catalog/v2";
    scope: GameBuddyChatContextScope;
    canonicalHash: string;
    stableSources: readonly GameBuddyAuthoredStableSource[];
    volatileSources: readonly GameBuddyAuthoredVolatileSource[];
  }>;
  export type GameBuddyAuthoredStableSourceRef = Readonly<{
    sourceId: string;
    kind: GameBuddyAuthoredSourceKind;
    revision: string;
    canonicalHash: string;
    totalOrderKey: string;
  }>;
  export type GameBuddyAuthoredVolatileSourceRef = Readonly<{
    sourceId: string;
    kind: "lorebook_entry";
    revision: string;
    canonicalHash: string;
    totalOrderKey: string;
    provenance: string;
  }>;
  export type GameBuddyAuthoredVolatileSourceCandidate = GameBuddyAuthoredVolatileSource & Readonly<{
    selectionKeys: readonly string[];
  }>;
  export type GameBuddyAuthoredStablePlanProjection = Readonly<{
    sourceRefs: readonly GameBuddyAuthoredStableSourceRef[];
    stableTokenCount: number;
    volatileSourceRefs: readonly GameBuddyAuthoredVolatileSourceRef[];
    volatileSourceCandidates: readonly GameBuddyAuthoredVolatileSourceCandidate[];
    volatileTokenCount: number;
  }>;
  export type TavernAuthoredContextRuntimeCapability = Readonly<{
    prepare(transientPreflightId: string): GameBuddyAuthoredStablePlanProjection;
    assertInstall(durableTurnId: string, refs: readonly GameBuddyAuthoredStableSourceRef[], volatileRefs?: readonly GameBuddyAuthoredVolatileSourceRef[]): void;
    clearVolatileForTurn(durableTurnId: string): void;
    materializeVolatileForTurn(turnId: string, acceptedPlayerText: string, boundedVisibleTail: string): Readonly<{ refs: readonly GameBuddyAuthoredVolatileSourceRef[]; tokenCount: number }>;
    clear(): Promise<void>;
  }>;
  export type TavernProviderStartObservation = Readonly<{
    sessionId: string;
    statusClass: "success" | "error";
    schema?: string;
    observedAtMs?: number;
  }>;
  export function publishGameBuddyAuthoredStableCatalog(scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability;
  export function replaceGameBuddyAuthoredStableCatalog(currentCapability: TavernAuthoredContextRuntimeCapability, scope: GameBuddyChatContextScope, catalog: unknown): TavernAuthoredContextRuntimeCapability;
  export function registerTavernNarrativeGateMarker(value: Readonly<{ sessionId: string; nonceSha256: string }>): () => void;
  export function clearTavernNarrativeGateMarker(sessionId: string): void;
  export function registerGameOperationalGateMarker(value: Readonly<{ sessionId: string; nonceSha256: string; surface: "chat" | "game" }>): () => void;
  export function registerTavernProviderStartObserver(
    sessionId: string,
    onStart: (observation: Readonly<{ sessionId: string; statusClass: "success" | "error" }>) => void,
  ): () => void;
}
