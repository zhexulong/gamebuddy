using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// The two persists that write a config back to disk, kept out of the entry file.
///
/// Both are one mechanical move: the same call sites, the same authority, the same record copies. They live here
/// because <c>ModEntry.cs</c> has a line ceiling that only allows shrinking, and the entry file is the wrong owner
/// for "what gets written into the player's config" anyway - that question is answered in one place now.
/// </summary>
public sealed partial class ModEntry : Mod
{
    private sealed class SmapiGlobalDataPersistence : IModGlobalDataPersistence
    {
        private readonly IDataHelper data;

        internal SmapiGlobalDataPersistence(IDataHelper data)
        {
            this.data = data ?? throw new ArgumentNullException(nameof(data));
        }

        public FarmhandExecutionJournalState? Read(string key) => this.data.ReadGlobalData<FarmhandExecutionJournalState>(key);

        public bool TryWrite(string key, FarmhandExecutionJournalState state)
        {
            try
            {
                this.data.WriteGlobalData(key, state);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    private void PersistVerifiedFarmhandScope(FarmhandVerifiedScope scope)
    {
        this.config = this.config.WithVerifiedScope(scope.SaveId, scope.WorldId, scope.PlayerId, this.config.NativeLocalPlayerFixture);
        this.Helper.WriteConfig(this.config);
        this.Monitor.Log($"GameBuddy recorded the verified shared-world scope (save={scope.SaveId}, world={scope.WorldId}, player={scope.PlayerId}) so a bridge client can declare it.", LogLevel.Info);
    }
}
