using StardewModdingAPI;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeFarmhandChatFixture()
    {
        // No world Given: the chat deed only needs a LOBBY, which the launcher establishes by
        // starting the LAN server and having the farmhand join. Running after that state exists is
        // the given; nothing is mutated.
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log("GameBuddy host-automation chat fixture Given: lobby present; no world mutation.", LogLevel.Info);
    }
}
