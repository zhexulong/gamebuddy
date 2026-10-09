using StardewValley;
using StardewValley.SaveSerialization;

namespace GameBuddy.Stardew;

/// <summary>
/// The identity a save folder carries for its own world, read from the save
/// info file the game itself writes (<c>SaveGameInfo</c>) — the same file the
/// native save list shows. <see cref="SlotName"/> is the physical folder
/// basename the game assigned, in its own <c>{farm name}_{unique id}</c> form.
/// </summary>
internal readonly record struct WorldSaveIdentity(string SlotName, string FarmName, string PlayerName, string FavoriteThing);

/// <summary>
/// A read-only view of the worlds that already exist in the game's save folder.
/// It answers exactly one question — "has this request's own world already been
/// created?" — and nothing here writes, moves, deletes or claims a save folder:
/// a slot whose identity cannot be read is reported as unknown, never as this
/// request's own world.
/// </summary>
internal static class WorldSaveIndex
{
    /// <summary>The file the game writes beside a save to describe its farmer.</summary>
    private const string SaveGameInfo = "SaveGameInfo";

    /// <summary>
    /// The identity of every save folder the native save list would show, or
    /// <c>null</c> when the save folder itself could not be enumerated. Null
    /// means unknown, so a caller must never create a world on it.
    /// </summary>
    internal static IReadOnlyList<WorldSaveIdentity>? ReadAll()
    {
        try
        {
            string savesFolder = Program.GetSavesFolder();
            if (!Directory.Exists(savesFolder))
                return Array.Empty<WorldSaveIdentity>();
            var identities = new List<WorldSaveIdentity>();
            foreach (string directory in Directory.EnumerateDirectories(savesFolder))
            {
                string slotName = Path.GetFileName(directory);
                if (slotName.Length == 0)
                    continue;
                Farmer? farmer = ReadSaveInfo(Path.Combine(directory, SaveGameInfo));
                if (farmer is null)
                    continue;
                identities.Add(new WorldSaveIdentity(
                    slotName,
                    farmer.farmName.Value,
                    farmer.Name,
                    farmer.favoriteThing.Value));
            }
            return identities;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Read the farmer the game wrote beside a save, with the same backup
    /// fallback the native save list uses (<c>SaveGameInfo</c>, then its
    /// <c>_old</c> and <c>_STARDEWVALLEYSAVETMP</c> copies).
    /// </summary>
    private static Farmer? ReadSaveInfo(string path)
    {
        foreach (string candidate in new[] { path, path + SaveGame.BackupNameSuffix, path + SaveGame.TempNameSuffix })
        {
            try
            {
                if (!File.Exists(candidate))
                    continue;
                using FileStream stream = File.OpenRead(candidate);
                return SaveSerializer.Deserialize<Farmer>(stream);
            }
            catch (Exception)
            {
                // An unreadable candidate stays unknown; try the next one.
            }
        }
        return null;
    }
}
