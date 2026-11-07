using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// Steps back one generation, using the pointer the installer left beside <c>current.json</c>.
///
/// The installer keeps the generation that was current before an upgrade and writes <c>rollback.json</c> holding that
/// generation's pointer. This is the other half of that: it validates the stored pointer exactly as a launch would -
/// schema, shape, generation directory, admission digest - and only then swaps the two files, so a rollback is a
/// selection the next launch will accept rather than a claim this code makes about one.
///
/// The swap, not a copy: after stepping back the pointer being replaced becomes the rollback target, so a player whose
/// new release turns out to be fine can step forward again. Both directions are bounded by the installer keeping exactly
/// two generations.
/// </summary>
internal static class InstalledGenerationRollback
{
    internal enum Result
    {
        /// <summary>The previous generation is now the selected one.</summary>
        Restored,
        /// <summary>Nothing was installed before this one, so there is nothing to step back to.</summary>
        NothingToRollBack,
        /// <summary>The stored pointer is absent, unreadable, or names a generation that is no longer present.</summary>
        TargetUnavailable,
        /// <summary>The selected pointer is held by a running instance; the swap is refused rather than raced.</summary>
        PointerBusy,
    }

    internal const string RollbackPointerFileName = "rollback.json";

    internal static Result Restore(string programRoot)
    {
        try
        {
            programRoot = InstalledGenerationPaths.CanonicalDirectory(programRoot);
            var currentPath = InstalledGenerationPaths.ChildFile(programRoot, "current.json");
            string rollbackPath;
            try
            {
                rollbackPath = InstalledGenerationPaths.ChildFile(programRoot, RollbackPointerFileName);
            }
            catch (GuardianLaunchUnavailableException)
            {
                return Result.NothingToRollBack;
            }

            var rollbackBytes = File.ReadAllBytes(rollbackPath);
            if (!SelectsAnInstalledGeneration(programRoot, rollbackBytes)) return Result.TargetUnavailable;

            var currentBytes = File.ReadAllBytes(currentPath);
            WriteThroughTemporary(currentPath, rollbackBytes);
            WriteThroughTemporary(rollbackPath, currentBytes);
            return Result.Restored;
        }
        catch (GuardianLaunchUnavailableException) { return Result.TargetUnavailable; }
        catch (UnauthorizedAccessException) { return Result.PointerBusy; }
        catch (IOException) { return Result.PointerBusy; }
    }

    /// <summary>
    /// Whether this pointer would actually start: the same facts a launch checks, checked here so a rollback cannot
    /// select a generation the next launch refuses.
    /// </summary>
    private static bool SelectsAnInstalledGeneration(string programRoot, byte[] pointer)
    {
        try
        {
            using var document = JsonDocument.Parse(pointer);
            var root = document.RootElement;
            if (!InstalledGenerationPaths.ExactProperties(root, "schema", "generation", "inventoryDigest", "runtimeAdmissionSha256"))
                return false;
            if (root.GetProperty("schema").GetString() != "gamebuddy-host-production-current/v2") return false;
            var generation = root.GetProperty("generation").GetString();
            if (!InstalledGenerationPaths.ValidGeneration(generation)) return false;
            if (!InstalledGenerationPaths.ValidDigest(root.GetProperty("inventoryDigest").GetString())) return false;
            var expectedAdmission = root.GetProperty("runtimeAdmissionSha256").GetString();
            if (!InstalledGenerationPaths.ValidDigest(expectedAdmission)) return false;

            var generationRoot = InstalledGenerationPaths.ChildDirectory(
                InstalledGenerationPaths.ChildDirectory(programRoot, "generations"), generation!);
            var admissionPath = InstalledGenerationPaths.ChildFile(generationRoot, "host-runtime-admission.json");
            var digest = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(admissionPath))).ToLowerInvariant();
            return string.Equals(digest, expectedAdmission, StringComparison.Ordinal);
        }
        catch (JsonException) { return false; }
        catch (KeyNotFoundException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (GuardianLaunchUnavailableException) { return false; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    /// <summary>
    /// Writes beside the target and renames over it, so a pointer is never observed half-written.
    ///
    /// `File.Move(..., overwrite: true)` is the rename; a temporary in the same directory keeps it on one volume, which
    /// is what makes the rename atomic.
    /// </summary>
    private static void WriteThroughTemporary(string destination, byte[] content)
    {
        var temporary = Path.Combine(
            Path.GetDirectoryName(destination)!,
            $".{Path.GetFileName(destination)}.{Guid.NewGuid():n}.tmp");
        try
        {
            File.WriteAllBytes(temporary, content);
            File.Move(temporary, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
