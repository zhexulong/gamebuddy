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
  export type GameBuddyPlayerMemoryReadProjection = Readonly<{
    listMemories(input: Readonly<{ continuityId: string }>): Promise<readonly GameBuddyMemoryView[]>;
    getMemory(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<GameBuddyMemoryView>;
  }>;
  export function createGameBuddyPlayerMemoryReadProjection(
    args: Readonly<{ continuityId: string; runtimeCwd: string }>,
  ): GameBuddyPlayerMemoryReadProjection;
  export type GameBuddyPlayerMemoryEvidence = Readonly<{ operationCorrelation: string }>;
  export type GameBuddyPlayerMemoryCommitReceipt = Readonly<{
    operationCorrelation: string;
    committedMemoryMutationId: number;
  }>;
  export type GameBuddyPlayerMemoryMutationResult<T> = Readonly<{
    value: T;
    commitReceipt: GameBuddyPlayerMemoryCommitReceipt;
  }>;
  export type GameBuddyPlayerMemoryEvidenceFacade = Readonly<{
    createMemory(
      input: Readonly<{
        continuityId: string;
        content: string;
        category: GameBuddyMemoryCategory;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    updateMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        content: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    archiveMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    restoreMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    pinMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    unpinMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    mergeMemory(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        targetStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<GameBuddyMemoryView>>;
    deleteEntry(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<void>>;
    excludeSource(
      input: Readonly<{
        continuityId: string;
        stateToken: string;
        expectedStateToken: string;
        sourceRef?: string;
        evidence: GameBuddyPlayerMemoryEvidence;
      }>,
    ): Promise<GameBuddyPlayerMemoryMutationResult<void>>;
    close(): void;
  }>;
  export function createGameBuddyPlayerMemoryEvidenceFacade(
    args: Readonly<{
      continuityId: string;
      runtimeCwd: string;
      providerBinding: Readonly<{ sessionId: string; surface: "chat"; nonceSha256: string }>;
    }>,
  ): GameBuddyPlayerMemoryEvidenceFacade;
}
