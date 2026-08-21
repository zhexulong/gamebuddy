declare module "@cortexkit/pi-magic-context" {
  export type GameBuddyMemoryCategory = "semantic" | "interaction";
  export type GameBuddyMemoryStatus = "active" | "permanent" | "archived";
  export type GameBuddyMemoryView = Readonly<{
    stateToken: string;
    content: string;
    category: GameBuddyMemoryCategory;
    status: GameBuddyMemoryStatus;
  }>;
  export type GameBuddyPlayerMemoryReadProjection = Readonly<{
    listMemories(input: Readonly<{ continuityId: string }>): Promise<readonly GameBuddyMemoryView[]>;
    getMemory(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<GameBuddyMemoryView>;
  }>;
  export function createGameBuddyPlayerMemoryReadProjection(
    args: Readonly<{ continuityId: string; runtimeCwd: string }>,
  ): GameBuddyPlayerMemoryReadProjection;
  export type GameBuddyPlayerMemoryCrudFacade = GameBuddyPlayerMemoryReadProjection &
    Readonly<{
      create(input: Readonly<{ continuityId: string; content: string }>): Promise<GameBuddyMemoryView>;
      update(input: Readonly<{ continuityId: string; stateToken: string; content: string }>): Promise<GameBuddyMemoryView>;
      archive(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<void>;
    }>;
  export function createGameBuddyPlayerMemoryCrudFacade(
    args: Readonly<{ continuityId: string; runtimeCwd: string }>,
  ): GameBuddyPlayerMemoryCrudFacade;
}
