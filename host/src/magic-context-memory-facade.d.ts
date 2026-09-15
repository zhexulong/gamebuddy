declare module "@cortexkit/pi-magic-context/memory" {
  export type GameBuddyMemoryCategory = "semantic" | "interaction";
  export type GameBuddyMemoryStatus = "active" | "permanent" | "archived";
  export type GameBuddyMemoryView = Readonly<{
    stateToken: string;
    content: string;
    category: GameBuddyMemoryCategory;
    status: GameBuddyMemoryStatus;
    sourceRefs?: readonly string[];
  }>;
  export type GameBuddyPlayerMemoryProfileBinding = Readonly<{
    continuityId: string;
    runtimeCwd: string;
    profileId: string;
    profileRevision: number;
    profileCanonicalHash: string;
  }>;
  export type GameBuddyPlayerMemoryReadInput = Readonly<{
    continuityId: string;
    profileId: string;
    profileRevision: number;
    profileCanonicalHash: string;
  }>;
  export type GameBuddyPlayerMemoryReadProjection = Readonly<{
    listMemories(input: GameBuddyPlayerMemoryReadInput): Promise<readonly GameBuddyMemoryView[]>;
    getMemory(input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string }>): Promise<GameBuddyMemoryView>;
  }>;
  export function createGameBuddyPlayerMemoryReadProjection(
    args: GameBuddyPlayerMemoryProfileBinding,
  ): GameBuddyPlayerMemoryReadProjection;
  export type GameBuddyPlayerMemoryCrudFacade = GameBuddyPlayerMemoryReadProjection &
    Readonly<{
      create(input: GameBuddyPlayerMemoryReadInput & Readonly<{ content: string }>): Promise<GameBuddyMemoryView>;
      update(input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string; content: string }>): Promise<GameBuddyMemoryView>;
      archive(input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string }>): Promise<void>;
    }>;
  export function createGameBuddyPlayerMemoryCrudFacade(
    args: GameBuddyPlayerMemoryProfileBinding,
  ): GameBuddyPlayerMemoryCrudFacade;
}
