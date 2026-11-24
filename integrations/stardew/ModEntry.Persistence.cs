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
    /// <summary>
    /// SMAPI global data, plus the write lease over the one document a journal reads and rewrites.
    ///
    /// <para>
    /// THE LEASE IS A NAMED SYSTEM MUTEX, because SMAPI decides where a global-data key lives and does not expose that
    /// path, so the Mod cannot take the <see cref="System.IO.FileShare.None"/> handle on a lease file beside it that
    /// <c>WindowsBodyProgramJournalStore.TryHoldScopeLease</c> takes for its own journal. The two are the same guarantee:
    /// ownership is the operating system's, not a file's existence, so a crashed owner releases it (an abandoned mutex is
    /// ACQUIRED here, because the process that held it is gone and its last write is all that is left) and it is never a
    /// permanent refusal. The name is per document, so two saves never contend while two processes on ONE save cannot both
    /// write it - which is the whole point, since a journal is a whole-payload rewrite and last-writer-wins would silently
    /// drop the other process's records.
    /// </para>
    /// </summary>
    private sealed class SmapiGlobalDataPersistence : IModGlobalDataPersistence, IModGlobalDataKeyLease
    {
        private readonly IDataHelper data;
        private readonly Dictionary<string, Mutex> leases = new(StringComparer.Ordinal);

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

        public bool TryClaim(string key, out bool ownedByAnotherProcess)
        {
            ownedByAnotherProcess = false;
            if (this.leases.ContainsKey(key))
                return true;

            Mutex? candidate = null;
            try
            {
                candidate = new Mutex(initiallyOwned: false, $"Local\\GameBuddy.journal.{key}");
                bool acquired;
                try
                {
                    acquired = candidate.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }

                if (!acquired)
                {
                    ownedByAnotherProcess = true;
                    return false;
                }

                // Ownership moves to the lease table, which is the process's lifetime.
                this.leases[key] = candidate;
                candidate = null;
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                candidate?.Dispose();
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
