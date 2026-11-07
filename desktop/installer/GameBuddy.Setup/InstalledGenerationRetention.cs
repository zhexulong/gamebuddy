using System.Text.Json;

namespace GameBuddy.Setup;

/// <summary>
/// Keeps exactly one generation back, so a release that fails to start is recoverable.
///
/// The installer used to delete every generation the new payload did not contain. That is right for immutability and
/// wrong for recovery: after a bad update the player has no previous generation to start and no way to get one back
/// short of a reinstall, which installs the same bad release.
///
/// Retention is one, deliberately. Two generations on disk are enough to step back once, and a bounded collection needs
/// a drain: every install rewrites the rollback pointer to whatever was current before it, so anything older than the
/// previous version is pruned by the same rule that prunes the generations themselves.
/// </summary>
internal static class InstalledGenerationRetention
{
    /// <summary>The pointer a rollback would restore, written beside <c>current.json</c>.</summary>
    internal const string RollbackPointerFileName = "rollback.json";

    /// <summary>
    /// The generation the pointer names, or <c>null</c> when there is no readable pointer.
    ///
    /// Read before the payload is extracted, because the payload carries the new <c>current.json</c> and overwrites it
    /// entry by entry - after extraction the previous choice is gone.
    /// </summary>
    internal static string? ReadGeneration(byte[]? pointer)
    {
        if (pointer is null || pointer.Length == 0) return null;
        try
        {
            using var document = JsonDocument.Parse(pointer);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("schema", out var schema) ||
                schema.ValueKind != JsonValueKind.String ||
                schema.GetString() != SetupLayout.PointerSchema)
                return null;
            if (!root.TryGetProperty("generation", out var generation) || generation.ValueKind != JsonValueKind.String)
                return null;
            var value = generation.GetString();
            return string.IsNullOrEmpty(value) ? null : value;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Names the generation that must survive the prune, so a step back stays possible.
    ///
    /// A generation the new payload also contains needs no protection: it is staged, so it is kept either way, and the
    /// pointer would be a rollback to the same bytes.
    /// </summary>
    internal static string? GenerationToKeep(string? previousGeneration, IReadOnlyCollection<string> staged)
    {
        if (previousGeneration is null) return null;
        return staged.Contains(previousGeneration, StringComparer.Ordinal) ? null : previousGeneration;
    }

    /// <summary>
    /// Records the previous pointer, or clears a stale one.
    ///
    /// Written only when it names a different generation that is still on disk - a rollback pointer to a generation the
    /// prune removed would turn a recoverable state into a named failure at the worst possible moment.
    /// </summary>
    internal static void WriteRollbackPointer(
        string programRoot,
        byte[]? previousPointer,
        string? previousGeneration,
        IReadOnlyCollection<string> staged,
        string generationsRoot)
    {
        var rollbackPath = Path.Combine(programRoot, RollbackPointerFileName);
        var keep = GenerationToKeep(previousGeneration, staged);
        if (previousPointer is null || keep is null || !Directory.Exists(Path.Combine(generationsRoot, keep)))
        {
            // No previous version, or the same one again: a rollback here would restore the running release, which is
            // not a recovery.
            if (File.Exists(rollbackPath)) File.Delete(rollbackPath);
            return;
        }

        File.WriteAllBytes(rollbackPath, previousPointer);
    }
}
