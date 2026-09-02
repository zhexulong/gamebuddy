using GameBuddy.Stardew.Core.BodyPrograms;
using StardewModdingAPI;

namespace GameBuddy.Stardew;

/// <summary>
/// SMAPI global-data persistence for the complete Body Program journal. The Core
/// codec owns validation; this adapter only atomically replaces its opaque value.
/// </summary>
internal sealed class WindowsBodyProgramJournalStore : IBodyProgramJournalStore
{
    internal const string GlobalDataKey = "GameBuddy.body-program-journal-v1";
    private readonly IDataHelper data;

    internal WindowsBodyProgramJournalStore(IDataHelper data)
    {
        this.data = data ?? throw new ArgumentNullException(nameof(data));
    }

    public string? Read() => this.data.ReadGlobalData<string>(GlobalDataKey);

    public bool TryWrite(string encodedState)
    {
        ArgumentNullException.ThrowIfNull(encodedState);
        try
        {
            this.data.WriteGlobalData(GlobalDataKey, encodedState);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
