declare module "@cortexkit/pi-magic-context" {
  export type GameBuddyMemoryCategory = "semantic" | "interaction";
  export type GameBuddyMemoryStatus = "active" | "permanent" | "archived";
  export type GameBuddyMemoryView = Readonly<{
    stateToken: string;
    content: string;
    category: GameBuddyMemoryCategory;
    status: GameBuddyMemoryStatus;
    sourceRefs?: readonly string[];
  }>;
  export type GameBuddyMemoryFacade = Readonly<{
    /** Only the Host's current-turn delegation adapter may call this. */
    createDelegatedInferredSemanticMemory(
      input: Readonly<{
        continuityId: string;
        operationId: string;
        content: string;
        sourceRefs?: readonly string[];
      }>,
    ): Promise<GameBuddyMemoryView>;
    listMemories(input: Readonly<{ continuityId: string }>): Promise<readonly GameBuddyMemoryView[]>;
    getMemory(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<GameBuddyMemoryView>;
    createMemory(
      input: Readonly<{
        continuityId: string;
        content: string;
        category: GameBuddyMemoryCategory;
        sourceRefs?: readonly string[];
      }>,
    ): Promise<GameBuddyMemoryView>;
    updateMemory(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string; content: string }>,
    ): Promise<GameBuddyMemoryView>;
    archiveMemory(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<GameBuddyMemoryView>;
    restoreMemory(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<GameBuddyMemoryView>;
    pinMemory(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<GameBuddyMemoryView>;
    unpinMemory(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<GameBuddyMemoryView>;
    mergeMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        targetStateToken: string;
      }>,
    ): Promise<GameBuddyMemoryView>;
    deleteEntry(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
    ): Promise<void>;
    excludeSource(
      input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string; sourceRef?: string }>,
    ): Promise<void>;
  }>;
  export function createGameBuddyMemoryFacade(
    args: Readonly<{
      continuityId: string;
      runtimeCwd: string;
    }>,
  ): GameBuddyMemoryFacade;
}
